import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import handler from '../api/index.js';
import { getPool, query, transaction } from '../lib/db.js';
import { flushOutbox, getGroup, syncDeliveryReceipts } from '../lib/groups.js';

test('real Neon API: verified identity, roster permissions, atomic draw and durable notification retry', { skip: process.env.RUN_DB_TESTS !== '1', timeout: 240000 }, async t => {
  assert(process.env.DATABASE_URL && process.env.AUTH_SECRET && process.env.NOTIFICATIONS_API_URL, 'Configure the isolated integration environment.');
  const fixture = `integration-${randomUUID()}`;
  const password = 'Fixture password for integration 2026';
  const emails = Array.from({ length: 7 }, (_, i) => `${fixture}-${i}@example.test`);
  const createdUsers = [], groups = [], captured = [], providerKeys = new Map();
  const providerReceipts = new Map(), receiptRequests = [];
  const originalFetch = globalThis.fetch, originalUrl = process.env.APP_URL, originalVercel = process.env.VERCEL;
  const providerURL = `${process.env.NOTIFICATIONS_API_URL.replace(/\/$/, '')}/api/v1/emails`;
  let failNextTo = null, ambiguousNextTo = null;
  // This interception is mandatory: the integration suite never sends a real email.
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(`${providerURL}/`) && (!options?.method || options.method === 'GET')) {
      const id = String(url).slice(providerURL.length + 1);
      receiptRequests.push(id);
      return providerReceipts.has(id) ? Response.json(providerReceipts.get(id)) : Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    if (String(url) !== providerURL) throw new Error('Integration test blocked an unexpected external request');
    const payload = JSON.parse(options.body);
    assert(emails.includes(payload.to), 'Only fixture recipients may reach the fake mail provider');
    captured.push(payload);
    if (providerKeys.has(payload.idempotencyKey)) return Response.json({ ...providerKeys.get(payload.idempotencyKey), duplicate: true });
    const result = { id: randomUUID(), status: failNextTo === payload.to ? 'failed' : 'sent', emailMessageId: randomUUID() };
    if (failNextTo === payload.to) failNextTo = null;
    providerKeys.set(payload.idempotencyKey, result);
    providerReceipts.set(result.id, { id: result.id, status: result.status });
    if (ambiguousNextTo === payload.to) { ambiguousNextTo = null; throw new TypeError('Simulated lost response after provider acceptance'); }
    return Response.json(result);
  };
  delete process.env.VERCEL;
  const server = createServer((req, res) => { handler(req, res).catch(() => { res.statusCode = 500; res.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_URL = origin;
  const api = async (path, { method = 'GET', body, cookie } = {}) => {
    const response = await originalFetch(`${origin}/api/${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-For': fixture, ...(cookie ? { Cookie: cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  };
  const lastEmail = email => captured.filter(message => message.to === email).at(-1);
  const codeOf = message => message.text.match(/código de acesso é (\d{6})/u)?.[1];
  const tokenOf = (message, kind = 'invitation') => message.text.match(new RegExp(`#${kind}\\?token=([A-Za-z0-9_-]{43})`))?.[1];
  const signUp = async (index, magic = false) => {
    const requested = await api('auth/register', { method: 'POST', body: { email: emails[index], firstName: `Fixture${index}`, lastName: fixture, password, passwordConfirm: password } });
    assert.equal(requested.status, 200);
    const message = lastEmail(emails[index]);
    assert(codeOf(message));
    const verification = { method: 'POST', body: magic ? { token: tokenOf(message, 'verify-link') } : { challengeId: requested.data.challengeId, code: codeOf(message) } };
    let verified;
    if (index === 2) {
      const concurrent = await Promise.all([api('auth/verify', verification), api('auth/verify', verification)]);
      assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 401], 'Concurrent verification must consume the challenge only once');
      verified = concurrent.find(response => response.status === 200);
    } else verified = await api('auth/verify', verification);
    assert.equal(verified.status, 200);
    assert(verified.cookie); createdUsers.push(verified.data.user.id);
    return { ...verified.data.user, cookie: verified.cookie, challengeId: requested.data.challengeId, code: codeOf(message) };
  };
  try {
    const owner = await signUp(0), member = await signUp(1, true), third = await signUp(2), outsider = await signUp(3);
    await t.test('OTP is single use, expires, and locks after five incorrect attempts', async () => {
      assert.equal((await api('auth/verify', { method: 'POST', body: { challengeId: owner.challengeId, code: owner.code } })).status, 401);
      assert.equal((await api('session', { cookie: owner.cookie })).data.user.id, owner.id);
      assert.equal((await api('session')).data.user, null);
      const pending = await api('auth/register', { method: 'POST', body: { email: emails[4], firstName: 'Pending', lastName: fixture, password, passwordConfirm: password } });
      const correct = codeOf(lastEmail(emails[4])), wrong = correct === '000000' ? '000001' : '000000';
      for (let i = 0; i < 5; i++) assert.equal((await api('auth/verify', { method: 'POST', body: { challengeId: pending.data.challengeId, code: wrong } })).data.error.code, 'INVALID_CODE');
      assert.equal((await api('auth/verify', { method: 'POST', body: { challengeId: pending.data.challengeId, code: correct } })).status, 401);
      assert.equal(Number((await query('SELECT attempts FROM as_auth_challenges WHERE id=$1', [pending.data.challengeId])).rows[0].attempts), 5);
      const expired = await api('auth/register', { method: 'POST', body: { email: emails[5], firstName: 'Expired', lastName: fixture, password, passwordConfirm: password } });
      await query("UPDATE as_auth_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.data.challengeId]);
      assert.equal((await api('auth/verify', { method: 'POST', body: { challengeId: expired.data.challengeId, code: codeOf(lastEmail(emails[5])) } })).data.error.code, 'EXPIRED_CODE');
      assert.equal((await api('auth/request', { method: 'POST', body: { email: emails[5], challengeId: expired.data.challengeId } })).status, 429);
      const sendsBeforeUnknown = captured.length;
      const unknown = await api('auth/request', { method: 'POST', body: { email: emails[6] } });
      assert(unknown.status >= 400, 'Resending requires a pending signup challenge, not an arbitrary mailbox');
      assert.equal(captured.length, sendsBeforeUnknown);
      assert.equal(Number((await query('SELECT count(*) FROM as_users WHERE email=$1', [emails[6]])).rows[0].count), 0);
    });
    const future = new Date(Date.now() + 86400000 * 40).toISOString().slice(0, 10);
    const created = await api('groups', { method: 'POST', cookie: owner.cookie, body: { name: fixture, date: future, budget: 120, location: 'Integration fixture', description: 'Integration fixture' } });
    assert.equal(created.status, 201); const groupId = created.data.group.id; groups.push(groupId);
    let tokens;
    await t.test('invitation failures retry with a new provider key; membership is email-bound', async () => {
      failNextTo = member.email;
      const sent = await api(`groups/${groupId}/invites`, { method: 'POST', cookie: owner.cookie, body: { emails: [member.email, third.email, outsider.email, member.email] } });
      assert.equal(sent.status, 200); assert.equal(sent.data.failed.length, 1); assert.equal(sent.data.sent.length, 2);
      const failedKey = lastEmail(member.email).idempotencyKey;
      const retry = await api(`groups/${groupId}/notifications/retry`, { method: 'POST', cookie: owner.cookie, body: {} });
      assert.equal(retry.status, 200); assert.equal(retry.data.notifications.sent, 1);
      assert.notEqual(lastEmail(member.email).idempotencyKey, failedKey);
      const receiptRows = (await query("SELECT o.id,o.provider_id,m.email FROM as_outbox o JOIN as_memberships m ON m.id=o.membership_id WHERE o.group_id=$1 AND o.state='sent'", [groupId])).rows;
      for (const row of receiptRows) providerReceipts.set(row.provider_id, { id: row.provider_id, status: row.email === member.email ? 'delivered' : row.email === outsider.email ? 'bounced' : 'sent', ...(row.email === member.email ? { deliveredAt: new Date().toISOString() } : {}) });
      await query('UPDATE as_outbox SET receipt_next_check_at=now() WHERE group_id=$1', [groupId]);
      const receiptSync = await syncDeliveryReceipts(groupId);
      assert.equal(receiptSync.checked, 3); assert.equal(receiptSync.updated, 3);
      const receiptMembers = (await api(`groups/${groupId}`, { cookie: owner.cookie })).data.participants;
      assert.equal(receiptMembers.find(p => p.email === member.email).status, 'delivered');
      assert.equal(receiptMembers.find(p => p.email === third.email).status, 'sent');
      assert.equal(receiptMembers.find(p => p.email === third.email).deliveredAt, null);
      assert.equal(receiptMembers.find(p => p.email === outsider.email).status, 'failed');
      assert.equal((await syncDeliveryReceipts(groupId)).checked, 0, 'Receipt polling is throttled in the database');
      const sendsBefore = captured.length;
      await flushOutbox(groupId, 30, true);
      assert.equal(captured.length, sendsBefore, 'Permanent bounces are not retried by the worker or bulk retry');
      tokens = [member, third, outsider].map(person => tokenOf(lastEmail(person.email)));
      assert(tokens.every(Boolean));
      const invitation = await api(`invitations/${tokens[0]}`);
      assert.equal(invitation.data.group.id, groupId); assert.equal(invitation.data.recipientEmail, member.email);
      assert.equal((await api(`invitations/${tokens[0]}` , { cookie: outsider.cookie })).data.currentUserInvited, true, 'Another invited account can accept its own membership from this group link');
      const pixel = lastEmail(member.email).html.match(/\/api\/track\/open\/([A-Za-z0-9_-]{43})/)[1];
      const tracked = await originalFetch(`${origin}/api/track/open/${pixel}`); assert.equal(tracked.headers.get('content-type'), 'image/png'); await tracked.arrayBuffer();
      assert.equal((await api(`groups/${groupId}`, { cookie: owner.cookie })).data.participants.find(p => p.email === member.email).status, 'opened');
      for (const [index, person] of [member, third].entries()) assert.equal((await api(`invitations/${tokens[index]}/accept`, { method: 'POST', cookie: person.cookie, body: {} })).status, 200);
      // A provider can deliver before a failed database acknowledgement. The
      // subsequent acceptance makes that invitation failure non-actionable.
      await query("UPDATE as_outbox SET state='failed',provider_status=NULL WHERE group_id=$1 AND membership_id=(SELECT id FROM as_memberships WHERE group_id=$1 AND email=$2)", [groupId, member.email]);
      assert.equal((await api(`groups/${groupId}`, { cookie: owner.cookie })).data.group.notificationFailures, 0, 'Accepted invitations and permanent bounces must not leave an unresolvable retry banner');
      await query('UPDATE as_outbox SET receipt_next_check_at=now() WHERE group_id=$1', [groupId]);
      const readsBefore = receiptRequests.length;
      assert.equal((await syncDeliveryReceipts(groupId)).checked, 0, 'Accepted recipients and terminal bounces stop polling');
      assert.equal(receiptRequests.length, readsBefore);
      assert.equal((await api(`groups/${groupId}`, { cookie: outsider.cookie })).status, 404);
      assert.equal((await api(`groups/${groupId}/draw`, { method: 'POST', cookie: member.cookie, body: {} })).status, 403);
      assert.equal((await api(`groups/${groupId}/invites`, { method: 'POST', cookie: member.cookie, body: { emails: [emails[4]] } })).status, 403);
      assert.equal((await api(`groups/${groupId}/notifications/retry`, { method: 'POST', cookie: member.cookie, body: {} })).status, 403);
    });
    await t.test('concurrent draw calls produce one immutable cycle and each user sees only their own result', async () => {
      const responses = await Promise.all([1, 2].map(() => api(`groups/${groupId}/draw`, { method: 'POST', cookie: owner.cookie, body: {} })));
      assert(responses.every(response => response.status === 200));
      const pairs = (await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [groupId])).rows;
      assert.equal(pairs.length, 3); assert.equal(new Set(pairs.map(p => p.receiver_id)).size, 3);
      const next = new Map(pairs.map(p => [p.giver_id, p.receiver_id]));
      for (const pair of pairs) { assert.notEqual(pair.giver_id, pair.receiver_id); assert.notEqual(next.get(pair.receiver_id), pair.giver_id); }
      const outbox = (await query("SELECT dedupe_key,state FROM as_outbox WHERE group_id=$1 AND kind='result'", [groupId])).rows;
      assert.equal(outbox.length, 3); assert(outbox.every(row => row.state === 'sent'));
      assert.equal(new Set(captured.filter(message => message.idempotencyKey.startsWith(`result:${groupId}:`)).map(message => message.idempotencyKey)).size, 3);
      const own = await api(`groups/${groupId}/result`, { cookie: member.cookie });
      assert.equal(own.status, 200); assert.notEqual(own.data.match.id, member.id);
      const forged = await api(`groups/${groupId}/result?userId=${owner.id}`, { cookie: member.cookie });
      assert.deepEqual(forged.data, own.data);
      const details = await api(`groups/${groupId}`, { cookie: member.cookie });
      assert.equal(details.data.role, 'member'); assert.equal(details.data.match, null, 'Group views do not refetch a private result before reveal');
      const pool = getPool(), originalQuery = pool.query;
      let groupReads = 0;
      pool.query = function (...args) { groupReads++; return originalQuery.apply(this, args); };
      try { await getGroup(member, groupId); } finally { pool.query = originalQuery; }
      assert.equal(groupReads, 2, 'An ordinary member view uses only the authorized group and participant queries');
      assert(!('results' in details.data) && !('assignments' in details.data));
      assert.equal((await api(`groups/${groupId}/result`, { cookie: outsider.cookie })).status, 404);
      assert.equal((await api(`invitations/${tokens[2]}/accept`, { method: 'POST', cookie: outsider.cookie, body: {} })).data.error.code, 'INVITATION_CLOSED');
      assert.equal((await api(`groups/${groupId}/invites`, { method: 'POST', cookie: owner.cookie, body: { emails: [emails[4]] } })).status, 409);
      await api(`groups/${groupId}/draw`, { method: 'POST', cookie: owner.cookie, body: {} });
      assert.deepEqual((await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [groupId])).rows, pairs);
    });
    await t.test('ambiguous delivery retries retain their key; acceptance racing a draw is atomic', async () => {
      const second = await api('groups', { method: 'POST', cookie: owner.cookie, body: { name: `${fixture}-race`, date: future, budget: 50 } });
      const id = second.data.group.id; groups.push(id);
      assert.equal((await api(`groups/${id}/draw`, { method: 'POST', cookie: owner.cookie, body: {} })).data.error.code, 'MIN_PARTICIPANTS');
      ambiguousNextTo = third.email;
      const invitationBatch = await api(`groups/${id}/invites`, { method: 'POST', cookie: owner.cookie, body: { emails: [member.email, third.email, outsider.email] } });
      assert.equal(invitationBatch.data.failed.length, 1);
      const uncertainKey = lastEmail(third.email).idempotencyKey;
      assert.equal((await api(`groups/${id}/notifications/retry`, { method: 'POST', cookie: owner.cookie, body: {} })).data.notifications.sent, 1);
      assert.equal(lastEmail(third.email).idempotencyKey, uncertainKey, 'A lost provider response must not cause another email');
      const pendingReceipts = (await query("SELECT id,provider_id FROM as_outbox WHERE group_id=$1 AND kind='invite' AND state='sent'", [id])).rows;
      for (const row of pendingReceipts) providerReceipts.delete(row.provider_id);
      await query('UPDATE as_outbox SET receipt_next_check_at=now() WHERE group_id=$1', [id]);
      const missingReceipts = await syncDeliveryReceipts(id);
      assert.equal(missingReceipts.checked, 3); assert.equal(missingReceipts.updated, 0, 'An unavailable receipt must not fabricate delivery or failure');
      assert.equal((await syncDeliveryReceipts(id)).checked, 0, 'Unavailable receipts back off');
      await query("UPDATE as_outbox SET sent_at=now()-interval '8 days',receipt_next_check_at=now() WHERE group_id=$1", [id]);
      assert.equal((await syncDeliveryReceipts(id)).checked, 0, 'Receipt polling stops after seven days');
      const invitations = [member, third, outsider].map(person => tokenOf(lastEmail(person.email)));
      for (const [index, person] of [member, third].entries()) await api(`invitations/${invitations[index]}/accept`, { method: 'POST', cookie: person.cookie, body: {} });
      const [accept, draw] = await Promise.all([
        api(`groups/${id}/accept`, { method: 'POST', cookie: outsider.cookie, body: {} }),
        api(`groups/${id}/draw`, { method: 'POST', cookie: owner.cookie, body: {} }),
      ]);
      assert.equal(draw.status, 200); assert([200, 409].includes(accept.status));
      const roster = (await query('SELECT status FROM as_memberships WHERE group_id=$1', [id])).rows;
      const resultCount = Number((await query('SELECT count(*) FROM as_draw_results WHERE group_id=$1', [id])).rows[0].count);
      assert.equal(resultCount, roster.filter(p => p.status === 'accepted').length);
      assert.equal(resultCount, accept.status === 200 ? 4 : 3);
    });
    await t.test('logout revokes the stored session', async () => {
      assert.equal((await api('auth/logout', { method: 'POST', cookie: owner.cookie, body: {} })).status, 200);
      assert.equal((await api('session', { cookie: owner.cookie })).data.user, null);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = originalUrl;
    if (originalVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = originalVercel;
    const rateKeys = [];
    for (const scope of ['auth-request-ip', 'auth-signup-ip', 'auth-verify-ip', 'public-invitations']) rateKeys.push([scope, fixture]);
    for (const email of emails) for (const scope of ['auth-request-email', 'auth-cooldown', 'auth-signup-email', 'auth-signup-cooldown']) rateKeys.push([scope, email]);
    for (const id of createdUsers) for (const scope of ['create-group', 'invite-people', 'draw-group', 'retry-notifications', 'resend-invite-user', 'profile']) rateKeys.push([scope, id]);
    await transaction(async client => {
      if (groups.length) { await client.query('DELETE FROM as_draw_results WHERE group_id=ANY($1::uuid[])', [groups]); await client.query('DELETE FROM as_groups WHERE id=ANY($1::uuid[])', [groups]); }
      await client.query('DELETE FROM as_auth_challenges WHERE email=ANY($1::text[])', [emails]);
      await client.query('DELETE FROM as_users WHERE email=ANY($1::text[])', [emails]);
      await client.query('DELETE FROM as_rate_limits WHERE key=ANY($1::text[])', [rateKeys.map(([scope, value]) => createHmac('sha256', process.env.AUTH_SECRET).update(`${scope}:${value}`).digest('hex'))]);
    });
    await getPool().end();
  }
});
