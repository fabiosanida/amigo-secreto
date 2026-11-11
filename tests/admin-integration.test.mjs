import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import handler from '../api/index.js';
import { getPool, query, transaction } from '../lib/db.js';
import { hashToken, newToken } from '../lib/auth.js';

test('private administration and creator deletion enforce server identity, full cleanup and confirmation', {
  skip: process.env.RUN_DB_TESTS !== '1', timeout: 180000,
}, async t => {
  assert.match((await query('SELECT current_schema() AS name')).rows[0].name, /^as_test_/, 'Admin fixtures must run in a dedicated test schema, never production');
  const fixture = `admin-${randomUUID()}`, users = [], groups = [], sessions = [];
  const savedUrl = process.env.APP_URL, savedVercel = process.env.VERCEL, originalFetch = globalThis.fetch;
  delete process.env.VERCEL;
  globalThis.fetch = async () => { throw new Error('Admin integration must never send an email'); };
  const server = createServer((req, res) => { handler(req, res).catch(() => { res.statusCode = 500; res.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; process.env.APP_URL = origin;
  const api = async (path, { cookie, body, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const response = await originalFetch(`${origin}/api/${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-For': fixture, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') };
  };
  const person = async (name, email = `${fixture}-${name.toLowerCase()}@example.test`) => {
    const id = randomUUID(), token = newToken(); users.push(id); sessions.push(hashToken(token));
    await query('INSERT INTO as_users(id,email,first_name,last_name,password_hash,avatar) VALUES($1,$2,$3,$4,$5,$6)', [id, email, name, fixture, 'secret-password-hash', 'secret-avatar-payload']);
    await query("INSERT INTO as_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), id]);
    return { id, email, name, cookie: `as_session=${token}` };
  };
  const makeGroup = async (name, owner, people = [], drawn = false) => {
    const id = randomUUID(); groups.push(id);
    await query('INSERT INTO as_groups(id,organizer_id,name,event_date,budget,drawn_at) VALUES($1,$2,$3,current_date+10,100,$4)', [id, owner.id, name, drawn ? new Date() : null]);
    const members = [];
    for (const user of [owner, ...people]) {
      const memberId = randomUUID(); members.push({ id: memberId, user });
      await query("INSERT INTO as_memberships(id,group_id,user_id,email,status,accepted_at) VALUES($1,$2,$3,$4,'accepted',now())", [memberId, id, user.id, user.email]);
    }
    if (drawn) for (let index = 0; index < members.length; index++) {
      await query('INSERT INTO as_draw_results(group_id,giver_id,receiver_id) VALUES($1,$2,$3)', [id, members[index].id, members[(index + 1) % members.length].id]);
    }
    const inviteToken = newToken(), pendingId = randomUUID();
    await query("INSERT INTO as_memberships(id,group_id,email,invite_token_hash,invite_expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')", [pendingId, id, `${fixture}-pending@example.test`, hashToken(inviteToken)]);
    await query("INSERT INTO as_outbox(id,group_id,membership_id,kind,dedupe_key,delivery_key,payload,state) VALUES($1,$2,$3,'invite',$4,$4,$5,'pending')", [randomUUID(), id, pendingId, `${fixture}:${id}`, { inviteToken, private: 'secret-notification-payload' }]);
    return { id, name, members, inviteToken };
  };
  try {
    const admin = await person('Administrador', 'fabiosanida@gmail.com'), owner = await person('Criador'), member = await person('Convidado'), outsider = await person('Outro');
    const drawn = await makeGroup(`${fixture} sorteado`, owner, [member, outsider], true);
    const pending = await makeGroup(`${fixture} aberto`, owner, [member]);
    const race = await makeGroup(`${fixture} exclusão`, owner);
    await t.test('every admin endpoint rejects anonymous and other accounts, including spoofed principal flags', async () => {
      for (const endpoint of ['admin/overview', 'admin/groups', `admin/groups/${drawn.id}`, 'admin/users', `admin/users/${owner.id}`]) {
        assert.equal((await api(endpoint)).status, 401);
        assert.equal((await api(`${endpoint}?email=fabiosanida%40gmail.com&isAdmin=true`, { cookie: owner.cookie })).status, 403);
      }
      assert.equal((await api('session', { cookie: admin.cookie })).data.user.isAdmin, true);
      assert.equal((await api('session', { cookie: owner.cookie })).data.user.isAdmin, false);
    });
    await t.test('admin lists paginate and expose only required fields; ordinary group access keeps results private', async () => {
      const overview = await api('admin/overview', { cookie: admin.cookie }); assert.equal(overview.status, 200); assert(overview.cache.includes('no-store'));
      assert(overview.data.summary.groups >= 3); assert(overview.data.summary.drawnGroups >= 1);
      const list = await api(`admin/groups?search=${encodeURIComponent(fixture)}&limit=1`, { cookie: admin.cookie });
      assert.equal(list.data.groups.length, 1); assert.equal(list.data.pagination.total, 3); assert.equal(list.data.pagination.totalPages, 3);
      assert.equal(list.data.groups[0].organizer.id, owner.id);
      const next = await api(`admin/groups?search=${encodeURIComponent(fixture)}&limit=1&page=2`, { cookie: admin.cookie });
      assert.notEqual(next.data.groups[0].id, list.data.groups[0].id);
      const accounts = await api(`admin/users?search=${encodeURIComponent(fixture)}&limit=1`, { cookie: admin.cookie }); assert.equal(accounts.data.users.length, 1); assert(accounts.data.pagination.total >= 4);
      const detail = await api(`admin/groups/${drawn.id}`, { cookie: admin.cookie });
      assert.equal(detail.data.participants.length, 4); assert.equal(detail.data.results.length, 3);
      assert.equal(new Set(detail.data.results.map(row => row.giver.userId)).size, 3);
      assert(!JSON.stringify([list.data, accounts.data, detail.data]).match(/password_hash|token_hash|inviteToken|secret-avatar|secret-notification|secret-password/));
      const personal = await api(`groups/${drawn.id}`, { cookie: owner.cookie });
      assert.equal(personal.status, 200); assert.equal(personal.data.match, null); assert.equal(personal.data.results, undefined);
      const privateResult = await api(`groups/${drawn.id}/result`, { cookie: owner.cookie });
      assert.equal(privateResult.status, 200); assert.equal(privateResult.data.match.id, member.id); assert.equal(privateResult.data.results, undefined);
      const user = await api(`admin/users/${owner.id}?limit=1`, { cookie: admin.cookie });
      assert.equal(user.data.user.createdCount, 3); assert.equal(user.data.groupsCreated.length, 1); assert.equal(user.data.createdPagination.totalPages, 3);
      assert.equal(user.data.user.participatingCount, 3); assert.equal(user.data.groupsParticipating.length, 1);
      assert.equal((await api('admin/groups?limit=500', { cookie: admin.cookie })).status, 400);
    });
    await t.test('only the creator can delete and the exact name must be confirmed', async () => {
      assert.equal((await api(`groups/${pending.id}/delete`, { body: { confirmation: pending.name } })).status, 401);
      assert.equal((await api(`groups/${pending.id}/delete`, { cookie: member.cookie, body: { confirmation: pending.name } })).status, 403);
      assert.equal((await api(`groups/${pending.id}/delete`, { cookie: admin.cookie, body: { confirmation: pending.name } })).status, 404, 'Admin read access does not grant creator deletion authority');
      assert.equal((await api(`groups/${pending.id}/delete`, { cookie: owner.cookie, body: { confirmation: '' } })).data.error.code, 'CONFIRMATION_REQUIRED');
      assert.equal((await api(`groups/${pending.id}/delete`, { cookie: owner.cookie, body: { confirmation: pending.name + ' ' } })).status, 400);
      assert.equal(Number((await query('SELECT count(*) FROM as_groups WHERE id=$1', [pending.id])).rows[0].count), 1);
    });
    await t.test('active email delivery delays deletion; confirmed deletion removes memberships, queued messages and links', async () => {
      await query("UPDATE as_outbox SET state='sending',lease_until=now()+interval '1 minute' WHERE group_id=$1", [pending.id]);
      const blocked = await api(`groups/${pending.id}/delete`, { cookie: owner.cookie, body: { confirmation: pending.name } });
      assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'NOTIFICATIONS_IN_PROGRESS');
      await query("UPDATE as_outbox SET state='pending',lease_until=NULL WHERE group_id=$1", [pending.id]);
      const removed = await api(`groups/${pending.id}/delete`, { cookie: owner.cookie, body: { confirmation: pending.name } });
      assert.equal(removed.status, 200); assert.equal(removed.data.deletedId, pending.id);
      for (const table of ['as_groups', 'as_memberships', 'as_outbox']) assert.equal(Number((await query(`SELECT count(*) FROM ${table} WHERE ${table === 'as_groups' ? 'id' : 'group_id'}=$1`, [pending.id])).rows[0].count), 0);
      assert.equal((await api(`invitations/${pending.inviteToken}`)).status, 410);
      assert.equal((await api(`groups/${pending.id}`, { cookie: owner.cookie })).status, 404);
    });
    await t.test('drawn groups can be erased without removing people, and concurrent deletion stays atomic', async () => {
      assert.equal((await api(`groups/${drawn.id}/delete`, { cookie: owner.cookie, body: { confirmation: drawn.name } })).status, 200);
      assert.equal(Number((await query('SELECT count(*) FROM as_draw_results WHERE group_id=$1', [drawn.id])).rows[0].count), 0);
      assert.equal((await api(`admin/groups/${drawn.id}`, { cookie: admin.cookie })).status, 404);
      const replies = await Promise.all([1, 2].map(() => api(`groups/${race.id}/delete`, { cookie: owner.cookie, body: { confirmation: race.name } })));
      assert.deepEqual(replies.map(row => row.status).sort(), [200, 404]);
      assert.equal(Number((await query('SELECT count(*) FROM as_users WHERE id=ANY($1::uuid[])', [users])).rows[0].count), 4);
    });
  } finally {
    await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
    if (savedUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = savedUrl;
    if (savedVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = savedVercel;
    await transaction(async client => {
      await client.query('DELETE FROM as_draw_results WHERE group_id=ANY($1::uuid[])', [groups]);
      await client.query('DELETE FROM as_groups WHERE id=ANY($1::uuid[])', [groups]);
      await client.query('DELETE FROM as_users WHERE id=ANY($1::uuid[])', [users]);
      const key = createHmac('sha256', process.env.AUTH_SECRET).update(`public-invitations:${fixture}`).digest('hex');
      await client.query('DELETE FROM as_rate_limits WHERE key=$1', [key]);
    });
    await getPool().end();
  }
});
