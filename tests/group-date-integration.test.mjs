import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import handler from '../api/index.js';
import { getPool, query, transaction } from '../lib/db.js';
import { hashToken, newToken } from '../lib/auth.js';

test('only the creator can reschedule a group without changing its draw or sending notifications', {
  skip: process.env.RUN_DB_TESTS !== '1', timeout: 120000,
}, async t => {
  assert.match((await query('SELECT current_schema() AS name')).rows[0].name, /^as_test_/);
  const fixture = `group-date-${randomUUID()}`, users = [], groupIds = [];
  const originalFetch = globalThis.fetch, originalUrl = process.env.APP_URL, originalVercel = process.env.VERCEL;
  let notificationAttempts = 0;
  globalThis.fetch = async () => { notificationAttempts++; throw new Error('Date edits must not send notifications'); };
  delete process.env.VERCEL;
  const server = createServer((req, res) => { handler(req, res).catch(() => { res.statusCode = 500; res.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; process.env.APP_URL = origin;
  const request = async (path, { cookie, body } = {}) => {
    const response = await originalFetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-For': fixture, ...(cookie ? { Cookie: cookie } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') };
  };
  const dateIn = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const originalDate = dateIn(30), nextDate = dateIn(45);
  const person = async (name, admin = false) => {
    const id = randomUUID(), token = newToken(), email = admin ? 'fabiosanida@gmail.com' : `${fixture}-${name}@example.test`; users.push(id);
    await query('INSERT INTO as_users(id,email,first_name,last_name) VALUES($1,$2,$3,$4)', [id, email, name, 'Fixture']);
    await query("INSERT INTO as_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), id]);
    return { id, email, cookie: `as_session=${token}` };
  };
  const makeGroup = async (owner, people, drawn = false) => {
    const id = randomUUID(), members = []; groupIds.push(id);
    await query('INSERT INTO as_groups(id,organizer_id,name,event_date,budget,location,description,drawn_at) VALUES($1,$2,$3,$4,75,$5,$6,$7)',
      [id, owner.id, fixture, originalDate, 'Local preservado', 'Recado preservado', drawn ? new Date() : null]);
    for (const p of people) {
      const membershipId = randomUUID(); members.push(membershipId);
      await query("INSERT INTO as_memberships(id,group_id,user_id,email,status,accepted_at) VALUES($1,$2,$3,$4,'accepted',now())", [membershipId, id, p.id, p.email]);
    }
    if (drawn) for (let n = 0; n < members.length; n++) await query('INSERT INTO as_draw_results(group_id,giver_id,receiver_id) VALUES($1,$2,$3)', [id, members[n], members[(n + 1) % members.length]]);
    return { id, members };
  };
  const edit = (group, account, body = { date: nextDate }) => request(`groups/${group.id}/date`, { cookie: account?.cookie, body });
  const snapshot = async group => ({
    details: (await query("SELECT to_jsonb(g)-'event_date' AS value FROM as_groups g WHERE id=$1", [group.id])).rows[0].value,
    memberships: (await query('SELECT to_jsonb(m) AS value FROM as_memberships m WHERE group_id=$1 ORDER BY id', [group.id])).rows,
    results: (await query('SELECT to_jsonb(r) AS value FROM as_draw_results r WHERE group_id=$1 ORDER BY giver_id', [group.id])).rows,
  });
  try {
    const owner = await person('owner'), member = await person('member'), third = await person('third'), outsider = await person('outsider'), admin = await person('admin', true);
    const group = await makeGroup(owner, [owner, member, third]), drawn = await makeGroup(owner, [owner, member, third], true);
    const before = await snapshot(group), drawnBefore = await snapshot(drawn);
    await t.test('requires a session and the actual creator; membership, admin status and supplied owner IDs grant no editing rights', async () => {
      assert.equal((await edit(group)).status, 401);
      assert.equal((await edit(group, member)).status, 403);
      for (const account of [outsider, admin]) assert([403, 404].includes((await edit(group, account)).status));
      assert.equal((await edit(group, member, { date: nextDate, organizerId: owner.id, userId: owner.id, role: 'organizer' })).status, 403);
      assert.equal((await query("SELECT to_char(event_date,'YYYY-MM-DD') AS date FROM as_groups WHERE id=$1", [group.id])).rows[0].date, originalDate);
      assert.deepEqual(await snapshot(group), before);
    });
    await t.test('rejects past, malformed and nonexistent dates without altering the existing schedule', async () => {
      const futureYear = new Date().getUTCFullYear() + 2;
      for (const value of ['', null, 20301225, [], {}, '2000-01-01', `${futureYear}-02-30`, `${futureYear}-13-01`, `${futureYear}-01-00`, `${futureYear}-1-01`, `${futureYear}-12-01T12:00:00Z`]) {
        const result = await edit(group, owner, { date: value });
        assert.equal(result.status, 400, JSON.stringify({ value, response: result.data }));
      }
      assert.equal((await edit(group, owner, {})).status, 400);
      assert.equal((await query("SELECT to_char(event_date,'YYYY-MM-DD') AS date FROM as_groups WHERE id=$1", [group.id])).rows[0].date, originalDate);
    });
    await t.test('reschedules before draw and returns the saved date without accepting unrelated changes or triggering email work', async () => {
      const pendingId = randomUUID();
      await query("INSERT INTO as_memberships(id,group_id,email,status,invite_token_hash,invite_expires_at) VALUES($1,$2,$3,'sent',$4,now()+interval '1 day')",
        [pendingId, group.id, `${fixture}-pending@example.test`, hashToken(newToken())]);
      const outbox = randomUUID();
      await query("INSERT INTO as_outbox(id,group_id,membership_id,kind,dedupe_key,delivery_key,payload) VALUES($1,$2,$3,'invite',$4,$4,$5)",
        [outbox, group.id, pendingId, `${fixture}-queued`, JSON.stringify({ to: `${fixture}-pending@example.test`, group: { id: group.id, date: originalDate } })]);
      const afterInvite = await snapshot(group);
      const result = await edit(group, owner, { date: nextDate, name: 'Must not change', budget: 1, organizerId: outsider.id });
      assert.equal(result.status, 200, JSON.stringify(result.data)); assert(result.cache.includes('no-store'));
      assert.deepEqual(result.data, { group: { id: group.id, date: nextDate } });
      assert.deepEqual(await snapshot(group), afterInvite);
      assert.equal((await query("SELECT to_char(event_date,'YYYY-MM-DD') AS date FROM as_groups WHERE id=$1", [group.id])).rows[0].date, nextDate);
      const viewed = await request(`groups/${group.id}`, { cookie: member.cookie });
      assert.equal(viewed.status, 200); assert.equal(viewed.data.group.date, nextDate);
      const listed = await request('groups', { cookie: owner.cookie });
      assert.equal(listed.data.groups.find(g => g.id === group.id).date, nextDate);
      assert.equal(notificationAttempts, 0);
      const queued = (await query('SELECT state,attempts FROM as_outbox WHERE id=$1', [outbox])).rows[0];
      assert.deepEqual(queued, { state: 'pending', attempts: 0 });
    });
    await t.test('reschedules after draw and repeated saves preserve every original assignment and participant', async () => {
      for (let n = 0; n < 2; n++) {
        const result = await edit(drawn, owner); assert.equal(result.status, 200); assert.equal(result.data.group.date, nextDate);
      }
      assert.deepEqual(await snapshot(drawn), drawnBefore);
      const result = await request(`groups/${drawn.id}/result`, { cookie: member.cookie });
      assert.equal(result.status, 200); assert.equal(result.data.match.id, third.id);
      assert.equal(notificationAttempts, 0);
    });
  } finally {
    await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = originalUrl;
    if (originalVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = originalVercel;
    await transaction(async client => {
      await client.query('DELETE FROM as_draw_results WHERE group_id=ANY($1::uuid[])', [groupIds]);
      await client.query('DELETE FROM as_groups WHERE id=ANY($1::uuid[])', [groupIds]);
      await client.query('DELETE FROM as_users WHERE id=ANY($1::uuid[])', [users]);
    });
    await getPool().end();
  }
});
