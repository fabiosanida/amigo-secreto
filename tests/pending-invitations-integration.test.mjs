import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import handler from '../api/index.js';
import { getPool, query, transaction } from '../lib/db.js';
import { hashToken, newToken } from '../lib/auth.js';

test('dashboard invitations are email-bound, token-free to the client and accepted only by the authenticated invitee', {
  skip: process.env.RUN_DB_TESTS !== '1', timeout: 180000,
}, async t => {
  assert.match((await query('SELECT current_schema() AS name')).rows[0].name, /^as_test_/, 'Invitation fixtures require a dedicated test schema');
  const fixture = `pending-${randomUUID()}`, users = [], groups = [], tokens = [];
  const originalFetch = globalThis.fetch, originalUrl = process.env.APP_URL, originalVercel = process.env.VERCEL;
  let attemptedEmails = 0;
  globalThis.fetch = async () => { attemptedEmails++; throw new Error('Pending invitation tests must not send email'); };
  delete process.env.VERCEL;
  const server = createServer((req, res) => { handler(req, res).catch(() => { res.statusCode = 500; res.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; process.env.APP_URL = origin;
  const api = async (path, { cookie, body } = {}) => {
    const response = await originalFetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-For': fixture, ...(cookie ? { Cookie: cookie } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') };
  };
  const person = async name => {
    const id = randomUUID(), token = newToken(), email = `${fixture}-${name}@example.test`; users.push(id);
    await query('INSERT INTO as_users(id,email,first_name,last_name) VALUES($1,$2,$3,$4)', [id, email, name, 'Fixture']);
    await query("INSERT INTO as_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), id]);
    return { id, email, cookie: `as_session=${token}` };
  };
  const invite = async (owner, recipient, suffix, { status = 'sent', userId = null, expires = true, expired = false, revoked = false, drawn = false } = {}) => {
    const id = randomUUID(), memberId = randomUUID(), token = newToken(), tracking = newToken(); groups.push(id); tokens.push(token, tracking);
    await query('INSERT INTO as_groups(id,organizer_id,name,event_date,budget,description,drawn_at) VALUES($1,$2,$3,current_date+15,100,$4,$5)', [id, owner.id, `${fixture} ${suffix}`, 'Convite de teste', drawn ? new Date() : null]);
    await query("INSERT INTO as_memberships(id,group_id,user_id,email,status,accepted_at) VALUES($1,$2,$3,$4,'accepted',now())", [randomUUID(), id, owner.id, owner.email]);
    await query('INSERT INTO as_memberships(id,group_id,user_id,email,status,invite_token_hash,tracking_token_hash,invite_expires_at,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [memberId, id, userId, recipient.email, status, revoked ? null : hashToken(token), hashToken(tracking), expires ? new Date(Date.now() + (expired ? -60000 : 3600000)) : null, status === 'accepted' ? new Date() : null]);
    return { id, memberId, token, tracking, name: `${fixture} ${suffix}` };
  };
  try {
    const owner = await person('owner'), target = await person('target'), stranger = await person('stranger'), inactiveOwner = await person('inactive-owner');
    const eligible = await invite(owner, target, 'ativo');
    const failed = await invite(owner, target, 'falha', { status: 'failed', userId: target.id });
    const expired = await invite(owner, target, 'expirado', { expired: true });
    const revoked = await invite(owner, target, 'revogado', { revoked: true });
    const drawn = await invite(owner, target, 'sorteado', { drawn: true });
    const another = await invite(owner, stranger, 'outra pessoa');
    const wronglyLinked = await invite(owner, target, 'vinculo incorreto', { userId: stranger.id });
    const noExpiry = await invite(owner, target, 'sem validade', { expires: false });
    const accepted = await invite(owner, target, 'participando', { status: 'accepted', userId: target.id, expired: true });
    const inactive = await invite(inactiveOwner, target, 'organizador inativo');
    await query('UPDATE as_users SET deleted_at=now() WHERE id=$1', [inactiveOwner.id]);

    await t.test('the dashboard lists only current eligible invitations for the session email and leaks no invite secrets', async () => {
      assert.equal((await api('groups')).status, 401);
      const result = await api(`groups?email=${encodeURIComponent(stranger.email)}&userId=${stranger.id}`, { cookie: target.cookie });
      assert.equal(result.status, 200); assert(result.cache.includes('no-store'));
      assert.deepEqual(result.data.pendingInvitations.map(item => item.group.id).sort(), [eligible.id, failed.id].sort());
      assert.equal(result.data.groups.length, 1); assert.equal(result.data.groups[0].id, accepted.id);
      const item = result.data.pendingInvitations.find(item => item.group.id === eligible.id);
      assert.equal(item.id, eligible.memberId); assert.equal(item.invitationId, eligible.memberId);
      assert.equal(item.group.name, eligible.name); assert.equal(item.group.organizerName, 'owner Fixture');
      assert(item.invitedAt); assert(item.expiresAt);
      const serialized = JSON.stringify(result.data.pendingInvitations);
      assert(!serialized.match(/invite_token|tracking_token|token_hash|inviteToken|trackingToken|avatar|password|receiver|results/));
      for (const token of tokens) { assert(!serialized.includes(token)); assert(!serialized.includes(hashToken(token))); }
      assert(!serialized.includes(stranger.email));
      const other = await api('groups', { cookie: stranger.cookie });
      assert.deepEqual(other.data.pendingInvitations.map(item => item.group.id), [another.id]);
    });

    await t.test('acceptance requires the current account’s eligible invitation and never trusts a supplied identity', async () => {
      assert.equal((await api(`groups/${eligible.id}/accept`, { body: {} })).status, 401);
      const forged = await api(`groups/${eligible.id}/accept`, { cookie: stranger.cookie, body: { userId: target.id, email: target.email, invitationId: eligible.memberId } });
      assert.equal(forged.status, 403); assert.equal(forged.data.error.code, 'EMAIL_MISMATCH');
      const linked = await api(`groups/${wronglyLinked.id}/accept`, { cookie: target.cookie, body: {} });
      assert([403, 404].includes(linked.status));
      const untouched = (await query('SELECT user_id,status FROM as_memberships WHERE id=$1', [eligible.memberId])).rows[0];
      assert.equal(untouched.user_id, null); assert.equal(untouched.status, 'sent');
      assert.equal((await api(`groups/${randomUUID()}/accept`, { cookie: target.cookie, body: {} })).status, 404);
    });

    await t.test('expired, revoked, closed or inactive-owner invitations cannot be accepted from a remembered dashboard card', async () => {
      const cases = [[expired, 410, 'INVITATION_EXPIRED'], [revoked, 404, 'INVITATION_EXPIRED'], [drawn, 409, 'INVITATION_CLOSED'], [noExpiry, 410, 'INVITATION_EXPIRED']];
      for (const [invitation, status, code] of cases) {
        const result = await api(`groups/${invitation.id}/accept`, { cookie: target.cookie, body: {} });
        assert.equal(result.status, status); assert.equal(result.data.error.code, code);
      }
      assert([403, 404, 410].includes((await api(`groups/${inactive.id}/accept`, { cookie: target.cookie, body: {} })).status));
      for (const invitation of [expired, revoked, drawn, noExpiry, inactive]) assert.notEqual((await query('SELECT status FROM as_memberships WHERE id=$1', [invitation.memberId])).rows[0].status, 'accepted');
    });

    await t.test('a verified invitee accepts without the email token, sees the joined group and can safely repeat the request', async () => {
      const concurrent = await Promise.all([1, 2].map(() => api(`groups/${eligible.id}/accept`, { cookie: target.cookie, body: {} })));
      assert(concurrent.every(result => result.status === 200));
      assert(concurrent.every(result => result.data.group.id === eligible.id));
      const membership = (await query('SELECT user_id,status,accepted_at FROM as_memberships WHERE id=$1', [eligible.memberId])).rows[0];
      assert.equal(membership.user_id, target.id); assert.equal(membership.status, 'accepted'); assert(membership.accepted_at);
      const repeat = await api(`groups/${eligible.id}/accept`, { cookie: target.cookie, body: {} }); assert.equal(repeat.status, 200);
      assert.equal(new Date((await query('SELECT accepted_at FROM as_memberships WHERE id=$1', [eligible.memberId])).rows[0].accepted_at).getTime(), new Date(membership.accepted_at).getTime());
      const dashboard = await api('groups', { cookie: target.cookie });
      assert(dashboard.data.groups.some(group => group.id === eligible.id));
      assert(!dashboard.data.pendingInvitations.some(item => item.group.id === eligible.id));
      const failedAcceptance = await api(`groups/${failed.id}/accept`, { cookie: target.cookie, body: {} });
      assert.equal(failedAcceptance.status, 200, 'Delivery failure does not revoke a valid invitation');
      assert.equal((await api('groups', { cookie: target.cookie })).data.pendingInvitations.length, 0);
      await query('UPDATE as_groups SET drawn_at=now() WHERE id=$1', [eligible.id]);
      assert.equal((await api(`groups/${eligible.id}/accept`, { cookie: target.cookie, body: {} })).status, 200, 'An accepted membership remains idempotent after a draw');
      assert.equal(attemptedEmails, 0, 'Dashboard acceptance never triggers another email');
    });
  } finally {
    await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = originalUrl;
    if (originalVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = originalVercel;
    await transaction(async client => {
      await client.query('DELETE FROM as_draw_results WHERE group_id=ANY($1::uuid[])', [groups]);
      await client.query('DELETE FROM as_groups WHERE id=ANY($1::uuid[])', [groups]);
      await client.query('DELETE FROM as_users WHERE id=ANY($1::uuid[])', [users]);
    });
    await getPool().end();
  }
});
