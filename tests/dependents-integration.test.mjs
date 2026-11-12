import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import handler from '../api/index.js';
import { getPool, query, transaction } from '../lib/db.js';
import { hashToken, newToken } from '../lib/auth.js';
import { adminGroup } from '../lib/admin.js';
import { adminDeleteUser, adminUserDeletePreview } from '../lib/admin-delete.js';
import { marmeladaGroup, checkMarmelada } from '../lib/admin-marmelada.js';

test('dependents have independent draw slots with guardian-only management and results', {
  skip: process.env.RUN_DB_TESTS !== '1', timeout: 180000,
}, async t => {
  assert.match((await query('SELECT current_schema() AS name')).rows[0].name, /^as_test_/);
  const fixture = `dependent-${randomUUID()}`, users = [], groups = [], captured = [];
  const originalFetch = globalThis.fetch, originalUrl = process.env.APP_URL, originalVercel = process.env.VERCEL;
  const allowedEmails = new Set();
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `${process.env.NOTIFICATIONS_API_URL.replace(/\/$/, '')}/api/v1/emails`);
    const payload = JSON.parse(options.body);
    assert(allowedEmails.has(payload.to), 'Messages must be addressed only to adult test accounts');
    captured.push(payload); return Response.json({ id: randomUUID(), status: 'sent' });
  };
  delete process.env.VERCEL;
  const server = createServer((req, res) => { handler(req, res).catch(() => { res.statusCode = 500; res.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; process.env.APP_URL = origin;
  const api = async (path, { cookie, body } = {}) => {
    const res = await originalFetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-For': fixture, ...(cookie ? { Cookie: cookie } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json(), cache: res.headers.get('cache-control') };
  };
  const person = async name => {
    const id = randomUUID(), token = newToken(), email = `${fixture}-${name}@example.test`; users.push(id); allowedEmails.add(email);
    await query('INSERT INTO as_users(id,email,first_name,last_name) VALUES($1,$2,$3,$4)', [id, email, name, 'Fixture']);
    await query("INSERT INTO as_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), id]);
    return { id, email, cookie: `as_session=${token}` };
  };
  const group = async (owner, people) => {
    const id = randomUUID(); groups.push(id);
    await query("INSERT INTO as_groups(id,organizer_id,name,event_date,budget) VALUES($1,$2,$3,current_date+30,100)", [id, owner.id, fixture]);
    for (const p of people) await query("INSERT INTO as_memberships(id,group_id,user_id,email,status,accepted_at) VALUES($1,$2,$3,$4,'accepted',now())", [randomUUID(), id, p.id, p.email]);
    return id;
  };
  const add = async (guardian, firstName) => {
    const result = await api('dependents', { cookie: guardian.cookie, body: { firstName, lastName: 'Fixture' } });
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.dependent;
  };
  const toggle = (gid, dep, guardian, active) => api(`groups/${gid}/dependents/${dep.id}`, { cookie: guardian.cookie, body: { active } });
  try {
    const owner = await person('owner'), a = await person('guardian-a'), b = await person('guardian-b'), outsider = await person('outsider');
    const gid = await group(owner, [owner, a, b]);
    const ownGroup = await group(a, [a]);
    const inviteOnlyGroup = await group(owner, [owner]);
    await query("INSERT INTO as_memberships(id,group_id,email,status,invite_token_hash,invite_expires_at) VALUES($1,$2,$3,'sent',$4,now()+interval '1 day')", [randomUUID(), inviteOnlyGroup, a.email, hashToken(newToken())]);
    let childA, childA2, inactive, childB;
    await t.test('only an authenticated guardian can create a dependent; no child account, email or verification is created', async () => {
      assert.equal((await api('dependents')).status, 401);
      assert.equal((await api('dependents', { body: { firstName: 'Child', lastName: 'Fixture' } })).status, 401);
      assert.equal((await api('dependents', { cookie: a.cookie, body: { firstName: '', lastName: 'Fixture' } })).status, 400);
      const count = Number((await query('SELECT count(*) FROM as_users WHERE email=ANY($1::text[])', [[...allowedEmails]])).rows[0].count);
      childA = await add(a, 'Ana'); childA2 = await add(a, 'Bia'); inactive = await add(a, 'Inativa'); childB = await add(b, 'Caio');
      assert.equal(Number((await query('SELECT count(*) FROM as_users WHERE email=ANY($1::text[])', [[...allowedEmails]])).rows[0].count), count);
      assert.equal((await query('SELECT count(*) FROM as_users WHERE id=ANY($1::uuid[])', [[childA.id, childA2.id, inactive.id, childB.id]])).rows[0].count, '0');
      const own = await api(`dependents?guardianId=${b.id}`, { cookie: a.cookie });
      assert.equal(own.status, 200); assert(own.cache.includes('no-store'));
      assert.deepEqual(own.data.dependents.map(d => d.id).sort(), [childA.id, childA2.id, inactive.id].sort());
      assert.deepEqual((await api('dependents', { cookie: b.cookie })).data.dependents.map(d => d.id), [childB.id]);
      assert.equal(captured.length, 0);
      assert.equal((await query('SELECT count(*) FROM as_auth_challenges WHERE email=ANY($1::text[])', [[...allowedEmails]])).rows[0].count, '0');
    });
    await t.test('participation is opt-in per group, ownership-bound, reversible before draw and idempotent', async () => {
      const before = await api(`groups/${gid}`, { cookie: a.cookie });
      assert.equal(before.data.ownDependents.length, 3); assert(before.data.ownDependents.every(d => !d.active));
      assert.equal(before.data.participants.length, 3);
      assert.equal((await toggle(gid, childA, b, true)).status, 404);
      assert([403, 404].includes((await toggle(inviteOnlyGroup, childA, a, true)).status));
      assert([403, 404].includes((await toggle(gid, childA, outsider, true)).status));
      assert.equal((await api(`groups/${gid}/dependents/${childA.id}`, { cookie: a.cookie, body: { active: 'true', guardianId: b.id } })).status, 400);
      const double = await Promise.all([toggle(gid, childA, a, true), toggle(gid, childA, a, true)]);
      assert(double.every(r => r.status === 200));
      assert.equal((await query('SELECT count(*) FROM as_memberships WHERE group_id=$1 AND dependent_id=$2', [gid, childA.id])).rows[0].count, '1');
      assert.equal((await toggle(gid, childA, a, false)).status, 200);
      assert.equal((await toggle(gid, childA, a, false)).status, 200);
      assert.equal((await toggle(gid, childA, a, true)).status, 200);
      assert.equal((await toggle(gid, childA2, a, true)).status, 200);
      assert.equal((await toggle(gid, childB, b, true)).status, 200);
      assert.equal((await toggle(ownGroup, childA, a, true)).status, 200);
      const roster = (await api(`groups/${gid}`, { cookie: a.cookie })).data;
      assert.equal(roster.group.acceptedCount, 6); assert.equal(roster.participants.length, 6);
      assert.equal(roster.ownDependents.filter(d => d.active).length, 2);
      const child = roster.participants.find(d => d.dependentId === childA.id);
      assert(child.isDependent); assert.equal(child.email, ''); assert.equal(child.userId, null);
      assert.equal(child.responsibleName, 'guardian-a Fixture');
      assert.equal((await query('SELECT email,user_id,invite_token_hash FROM as_memberships WHERE dependent_id=$1 AND group_id=$2', [childA.id, gid])).rows[0].email, null);
      assert.equal(captured.length, 0);
    });
    await t.test('draw includes active children in one full cycle and delivers each child result only to its guardian', async () => {
      assert.equal((await api(`groups/${gid}/result`, { cookie: a.cookie })).status, 409);
      const draw = await api(`groups/${gid}/draw`, { cookie: owner.cookie, body: {} }); assert.equal(draw.status, 200, JSON.stringify(draw.data));
      const rows = (await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1', [gid])).rows;
      assert.equal(rows.length, 6); const pairs = new Map(rows.map(r => [r.giver_id, r.receiver_id]));
      const visited = new Set(); let cursor = rows[0].giver_id;
      for (let i = 0; i < rows.length; i++) { assert(!visited.has(cursor)); visited.add(cursor); assert.notEqual(pairs.get(cursor), cursor); cursor = pairs.get(cursor); }
      assert.equal(cursor, rows[0].giver_id); assert.equal(visited.size, 6);
      assert.equal(captured.length, 6); assert.equal(captured.filter(m => m.to === a.email).length, 3); assert.equal(captured.filter(m => m.to === b.email).length, 2);
      const notifications = (await query("SELECT payload FROM as_outbox WHERE group_id=$1 AND kind='result'", [gid])).rows.map(r => r.payload);
      const childMessages = notifications.filter(m => m.dependent);
      assert.equal(childMessages.length, 3);
      for (const m of childMessages) { assert.equal(m.to, m.dependent.id === childB.id ? b.email : a.email); assert(m.user.id); }
      assert(captured.some(m => m.to === a.email && m.text.includes('Ana Fixture tirou')));
      assert(captured.some(m => m.to === a.email && m.text.includes('Bia Fixture tirou')));
      const resultA = await api(`groups/${gid}/result?guardianId=${b.id}&dependentId=${childB.id}`, { cookie: a.cookie });
      assert(resultA.data.match); assert.deepEqual(resultA.data.dependentResults.map(r => r.dependent.id).sort(), [childA.id, childA2.id].sort());
      const resultB = await api(`groups/${gid}/result`, { cookie: b.cookie }); assert.deepEqual(resultB.data.dependentResults.map(r => r.dependent.id), [childB.id]);
      assert.equal((await api(`groups/${gid}/result`, { cookie: owner.cookie })).data.dependentResults.length, 0);
      assert.equal((await api(`groups/${gid}/result`, { cookie: outsider.cookie })).status, 404);
      assert.equal((await toggle(gid, inactive, a, true)).status, 409);
      assert.equal((await toggle(gid, childA, a, false)).status, 409);
      assert.equal((await query('SELECT count(*) FROM as_draw_results WHERE group_id=$1', [gid])).rows[0].count, '6');
    });
    await t.test('administrative roster and Marmelada include child identities and retain cycle on guardian deletion', async () => {
      const admin = { id: owner.id, email: 'fabiosanida@gmail.com' };
      assert.equal((await api(`admin/groups/${gid}`, { cookie: owner.cookie })).status, 403);
      const details = await adminGroup(admin, gid); assert.equal(details.participants.length, 6); assert.equal(details.results.length, 6);
      const game = await marmeladaGroup(admin, gid); assert.equal(game.participants.length, 6);
      const childMember = details.participants.find(p => p.dependentId === childA.id);
      const pair = (await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 AND giver_id=$2', [gid, childMember.id])).rows[0];
      assert.equal((await checkMarmelada(admin, { groupId: gid, giverId: pair.giver_id, receiverId: pair.receiver_id })).matches, true);
      const originalPairs = (await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [gid])).rows;
      const preview = await adminUserDeletePreview(admin, a.id); assert.equal(preview.effects.groupsDeleted, 1);
      await adminDeleteUser(admin, a.id, { confirmation: a.email });
      assert.equal((await query('SELECT count(*) FROM as_groups WHERE id=$1', [ownGroup])).rows[0].count, '0');
      assert.deepEqual((await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [gid])).rows, originalPairs);
      assert.equal((await api('dependents', { cookie: a.cookie })).status, 401);
      const after = await adminGroup(admin, gid); assert.equal(after.results.length, 6); assert.equal(after.participants.length, 6);
      const serialized = JSON.stringify(after); assert(!serialized.includes('Ana Fixture')); assert(!serialized.includes('Bia Fixture')); assert(!serialized.includes(a.email));
      const pending = JSON.stringify((await query('SELECT payload FROM as_outbox WHERE group_id=$1', [gid])).rows);
      assert(!pending.includes('Ana Fixture')); assert(!pending.includes('Bia Fixture')); assert(!pending.includes(a.email));
      assert.equal((await marmeladaGroup(admin, gid)).participants.length, 6);
    });
  } finally {
    await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = originalUrl;
    if (originalVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = originalVercel;
    await transaction(async client => {
      await client.query('DELETE FROM as_draw_results WHERE group_id=ANY($1::uuid[])', [groups]);
      await client.query('DELETE FROM as_groups WHERE id=ANY($1::uuid[])', [groups]);
      await client.query('DELETE FROM as_dependents WHERE guardian_id=ANY($1::uuid[])', [users]);
      await client.query('DELETE FROM as_users WHERE id=ANY($1::uuid[])', [users]);
    });
    await getPool().end();
  }
});
