import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import handler from '../api/index.js';
import { getPool, query, transaction } from '../lib/db.js';
import { hashToken, newToken } from '../lib/auth.js';

test('organizers manage their roster and create included dependents without changing other groups or completed draws', {
  skip: process.env.RUN_DB_TESTS !== '1', timeout: 180000,
}, async t => {
  assert.match((await query('SELECT current_schema() AS name')).rows[0].name, /^as_test_/);
  const fixture = `roster-${randomUUID()}`, users = [], groups = [];
  const originalFetch = globalThis.fetch, originalUrl = process.env.APP_URL, originalVercel = process.env.VERCEL;
  let notifications = 0;
  globalThis.fetch = async () => { notifications++; throw new Error('Roster edits must not send notifications'); };
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
  const person = async (name, admin = false) => {
    const id = randomUUID(), token = newToken(), email = admin ? 'fabiosanida@gmail.com' : `${fixture}-${name}@example.test`; users.push(id);
    await query('INSERT INTO as_users(id,email,first_name,last_name) VALUES($1,$2,$3,$4)', [id, email, name, 'Fixture']);
    await query("INSERT INTO as_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), id]);
    return { id, email, cookie: `as_session=${token}` };
  };
  const makeGroup = async (owner, people = [owner], drawn = false) => {
    const id = randomUUID(), members = new Map(); groups.push(id);
    await query('INSERT INTO as_groups(id,organizer_id,name,event_date,budget,drawn_at) VALUES($1,$2,$3,current_date+30,50,$4)', [id, owner.id, fixture, drawn ? new Date() : null]);
    for (const p of people) {
      const memberId = randomUUID(); members.set(p.id, memberId);
      await query("INSERT INTO as_memberships(id,group_id,user_id,email,status,accepted_at) VALUES($1,$2,$3,$4,'accepted',now())", [memberId, id, p.id, p.email]);
    }
    if (drawn) {
      const slots = [...members.values()];
      for (let index = 0; index < slots.length; index++) await query('INSERT INTO as_draw_results(group_id,giver_id,receiver_id) VALUES($1,$2,$3)', [id, slots[index], slots[(index + 1) % slots.length]]);
    }
    return { id, members };
  };
  const child = async (guardian, name = 'Criança') => {
    const id = randomUUID();
    await query('INSERT INTO as_dependents(id,guardian_id,first_name,last_name) VALUES($1,$2,$3,$4)', [id, guardian.id, name, 'Fixture']);
    return { id, firstName: name, lastName: 'Fixture' };
  };
  const include = async (group, dependent) => {
    const id = randomUUID();
    await query("INSERT INTO as_memberships(id,group_id,dependent_id,status,accepted_at) VALUES($1,$2,$3,'accepted',now())", [id, group.id, dependent.id]);
    return id;
  };
  const wish = async memberId => {
    const id = randomUUID();
    await query('INSERT INTO as_wishlist_items(id,membership_id,text) VALUES($1,$2,$3)', [id, memberId, 'Preservar apenas nos outros grupos']); return id;
  };
  const outbox = async (group, memberId, { state = 'pending', leased = false } = {}) => {
    const id = randomUUID();
    await query("INSERT INTO as_outbox(id,group_id,membership_id,kind,dedupe_key,delivery_key,payload,state,lease_until,next_attempt_at) VALUES($1,$2,$3,'invite',$4,$4,$5,$6,$7,now()+interval '1 day')", [id, group.id, memberId, id, JSON.stringify({ fixture }), state, leased ? new Date(Date.now() + 300000) : null]); return id;
  };
  const remove = (group, memberId, account, ids = [memberId], extra = {}) => api(`groups/${group.id}/participants/${memberId}/remove`, {
    cookie: account?.cookie, body: { confirm: true, participantIds: ids, ...extra },
  });
  const createIncluded = (group, account, body = { id: randomUUID(), firstName: 'Nova', lastName: 'Criança' }) => api(`groups/${group.id}/dependents`, { cookie: account?.cookie, body });
  const count = async (table, column, id) => Number((await query(`SELECT count(*) FROM ${table} WHERE ${column}=$1`, [id])).rows[0].count);
  try {
    const owner = await person('owner'), guardian = await person('guardian'), other = await person('other'), outsider = await person('outsider'), admin = await person('admin', true);
    const group = await makeGroup(owner, [owner, guardian, other]), elsewhere = await makeGroup(guardian, [guardian, owner, other]);
    const guardianMember = group.members.get(guardian.id), ownerMember = group.members.get(owner.id);
    const a = await child(guardian, 'Ana'), b = await child(guardian, 'Bia'), ownerChild = await child(owner, 'Lia');
    const aMember = await include(group, a), bMember = await include(group, b), ownerChildMember = await include(group, ownerChild);
    const elsewhereChildMember = await include(elsewhere, a), elsewhereWish = await wish(elsewhereChildMember);
    const adultWish = await wish(guardianMember), childWish = await wish(aMember), unrelatedWish = await wish(ownerChildMember);
    const guardianMessage = await outbox(group, guardianMember), otherMessage = await outbox(group, group.members.get(other.id));

    await t.test('only the actual creator can remove members; confirmation, membership scope and creator identity are enforced', async () => {
      assert.equal((await remove(group, guardianMember)).status, 401);
      for (const account of [guardian, other, outsider, admin]) assert([403, 404].includes((await remove(group, guardianMember, account, [guardianMember, aMember, bMember])).status));
      assert.equal((await remove(group, guardianMember, owner, [guardianMember, aMember, bMember], { confirm: false })).status, 400);
      assert.equal((await remove(group, guardianMember, owner, [guardianMember, aMember, bMember], { confirm: 'true' })).status, 400);
      assert([403, 409].includes((await remove(group, ownerMember, owner)).status));
      assert.equal((await remove(group, elsewhere.members.get(guardian.id), owner)).status, 404);
      assert.equal((await remove(group, guardianMember, guardian, [guardianMember, aMember, bMember], { organizerId: owner.id, userId: owner.id })).status, 403);
      assert.equal(await count('as_memberships', 'group_id', group.id), 6);
    });

    await t.test('a stale removal list never silently removes dependents omitted from confirmation', async () => {
      const stale = await remove(group, guardianMember, owner, [guardianMember, aMember]);
      assert.equal(stale.status, 409, JSON.stringify(stale.data));
      assert.equal(await count('as_memberships', 'group_id', group.id), 6);
      assert.equal(await count('as_wishlist_items', 'id', adultWish), 1);
      const unrelated = await remove(group, guardianMember, owner, [guardianMember, aMember, bMember, ownerChildMember]);
      assert.equal(unrelated.status, 409); assert.equal(await count('as_memberships', 'id', ownerChildMember), 1);
    });

    await t.test('removing a guardian removes only their group slots, wishes and queued messages, retaining accounts and other groups', async () => {
      const removed = await remove(group, guardianMember, owner, [bMember, guardianMember, aMember]);
      assert.equal(removed.status, 200, JSON.stringify(removed.data)); assert(removed.cache.includes('no-store'));
      assert.deepEqual([...removed.data.removedIds].sort(), [guardianMember, aMember, bMember].sort());
      for (const memberId of [guardianMember, aMember, bMember]) assert.equal(await count('as_memberships', 'id', memberId), 0);
      for (const id of [adultWish, childWish]) assert.equal(await count('as_wishlist_items', 'id', id), 0);
      assert.equal(await count('as_outbox', 'id', guardianMessage), 0);
      assert.equal(await count('as_outbox', 'id', otherMessage), 1);
      assert.equal(await count('as_wishlist_items', 'id', unrelatedWish), 1);
      assert.equal(await count('as_wishlist_items', 'id', elsewhereWish), 1);
      assert.equal(await count('as_users', 'id', guardian.id), 1);
      assert.equal(await count('as_dependents', 'guardian_id', guardian.id), 2);
      assert.equal(await count('as_memberships', 'id', elsewhereChildMember), 1);
      assert.equal((await api(`groups/${group.id}`, { cookie: guardian.cookie })).status, 404);
      assert.equal((await api('dependents', { cookie: guardian.cookie })).status, 200);
      const restore = await api(`groups/${group.id}/dependents/${a.id}`, { cookie: guardian.cookie, body: { active: true } });
      assert([403, 404].includes(restore.status)); assert.equal(notifications, 0);
    });

    await t.test('removing one dependent preserves its guardian, catalog and other group participation', async () => {
      const result = await remove(group, ownerChildMember, owner);
      assert.equal(result.status, 200); assert.deepEqual(result.data.removedIds, [ownerChildMember]);
      assert.equal(await count('as_memberships', 'id', ownerMember), 1);
      assert.equal(await count('as_dependents', 'id', ownerChild.id), 1);
      assert.equal(await count('as_wishlist_items', 'id', unrelatedWish), 0);
      const repeated = await remove(group, ownerChildMember, owner);
      assert([200, 404].includes(repeated.status));
    });

    await t.test('active email delivery blocks removal; removing a pending invitation invalidates its link and cancels queued work', async () => {
      const inviteId = randomUUID(), token = newToken();
      await query("INSERT INTO as_memberships(id,group_id,email,status,invite_token_hash,invite_expires_at) VALUES($1,$2,$3,'sent',$4,now()+interval '1 day')", [inviteId, group.id, `${fixture}-pending@example.test`, hashToken(token)]);
      const delivery = await outbox(group, inviteId, { state: 'sending', leased: true });
      const blocked = await remove(group, inviteId, owner);
      assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'NOTIFICATIONS_IN_PROGRESS');
      assert.equal(await count('as_memberships', 'id', inviteId), 1);
      await query("UPDATE as_outbox SET state='pending',lease_until=NULL WHERE id=$1", [delivery]);
      assert.equal((await remove(group, inviteId, owner)).status, 200);
      assert.equal(await count('as_outbox', 'id', delivery), 0);
      assert([404, 410].includes((await api(`invitations/${token}`)).status));
      assert.equal(notifications, 0);
    });

    await t.test('a completed draw rejects removal and new participants without altering any pair', async () => {
      const drawn = await makeGroup(owner, [owner, guardian, other], true);
      const pairs = (await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [drawn.id])).rows;
      const failedId = randomUUID();
      assert.equal((await remove(drawn, drawn.members.get(guardian.id), owner)).status, 409);
      assert.equal((await createIncluded(drawn, owner, { id: failedId, firstName: 'Tardia', lastName: 'Fixture' })).status, 409);
      assert.equal(await count('as_dependents', 'id', failedId), 0);
      assert.deepEqual((await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [drawn.id])).rows, pairs);
    });

    await t.test('creator creation is atomic, identity-bound and safe to retry without email or verification', async () => {
      const id = randomUUID(), body = { id, firstName: 'Criança', lastName: 'Incluída' };
      assert.equal((await createIncluded(group, null, body)).status, 401);
      for (const account of [other, outsider, admin]) assert([403, 404].includes((await createIncluded(group, account, body)).status));
      assert.equal(await count('as_dependents', 'id', id), 0);
      const results = await Promise.all([createIncluded(group, owner, body), createIncluded(group, owner, body)]);
      assert(results.every(result => [200, 201].includes(result.status)), JSON.stringify(results));
      assert.equal(await count('as_dependents', 'id', id), 1);
      assert.equal(await count('as_memberships', 'dependent_id', id), 1);
      const row = (await query('SELECT d.guardian_id,m.id,m.email,m.user_id,m.status,m.invite_token_hash FROM as_dependents d JOIN as_memberships m ON m.dependent_id=d.id WHERE d.id=$1', [id])).rows[0];
      assert.equal(row.guardian_id, owner.id); assert.equal(row.status, 'accepted'); assert.equal(row.email, null); assert.equal(row.user_id, null); assert.equal(row.invite_token_hash, null);
      assert.equal(await count('as_users', 'id', id), 0);
      assert.equal(notifications, 0);
      assert.equal((await createIncluded(group, owner, { ...body, firstName: 'Outra identidade' })).status, 409);
      const foreign = await createIncluded(group, owner, { ...body, id: a.id });
      assert([404, 409].includes(foreign.status)); assert.equal((await query('SELECT guardian_id FROM as_dependents WHERE id=$1', [a.id])).rows[0].guardian_id, guardian.id);
      const invalid = randomUUID();
      assert.equal((await createIncluded(group, owner, { id: invalid, firstName: '', lastName: 'Fixture' })).status, 400);
      assert.equal(await count('as_dependents', 'id', invalid), 0);
    });

    await t.test('a full group rolls back dependent creation instead of leaving a partial registration', async () => {
      const full = await makeGroup(owner), ids = Array.from({ length: 199 }, () => randomUUID());
      await query("INSERT INTO as_memberships(id,group_id,email,status) SELECT id,$1,id::text || '@example.test','sent' FROM unnest($2::uuid[]) AS id", [full.id, ids]);
      const id = randomUUID(), result = await createIncluded(full, owner, { id, firstName: 'Sem', lastName: 'Vaga' });
      assert.equal(result.status, 400); assert.equal(result.data.error.code, 'GROUP_FULL');
      assert.equal(await count('as_dependents', 'id', id), 0); assert.equal(await count('as_memberships', 'group_id', full.id), 200);
    });

    await t.test('catalogs beyond twenty dependents remain paginated, private and available for inclusion', async () => {
      const many = await person('large-catalog'), manyGroup = await makeGroup(many), ids = Array.from({ length: 55 }, () => randomUUID());
      await query("INSERT INTO as_dependents(id,guardian_id,first_name,last_name) SELECT id,$1,'Pessoa','Fixture' FROM unnest($2::uuid[]) AS id", [many.id, ids]);
      const added = await api('dependents', { cookie: many.cookie, body: { firstName: 'Mais', lastName: 'Uma' } });
      assert.equal(added.status, 201, JSON.stringify(added.data));
      const expected = [...ids, added.data.dependent.id].sort();
      const seen = [], cursors = new Set(); let cursor = '';
      do {
        const result = await api(`dependents${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: many.cookie });
        assert.equal(result.status, 200); assert(result.data.dependents.length <= 50);
        seen.push(...result.data.dependents.map(item => item.id));
        cursor = result.data.nextCursor || '';
        if (cursor) { assert(!cursors.has(cursor)); cursors.add(cursor); }
      } while (cursor);
      assert.deepEqual(seen.sort(), expected); assert.equal(new Set(seen).size, seen.length);
      const catalogCursor = [...cursors][0];
      assert.equal((await api(`dependents?cursor=${encodeURIComponent(catalogCursor)}`, { cookie: owner.cookie })).status, 400);
      assert.equal((await api(`dependents?groupId=${manyGroup.id}&cursor=${encodeURIComponent(catalogCursor)}`, { cookie: many.cookie })).status, 400);
      const roster = await api(`groups/${manyGroup.id}`, { cookie: many.cookie });
      assert.equal(roster.status, 200); assert(roster.data.ownDependents.length <= 50); assert(roster.data.ownDependentsNextCursor);
      const rest = await api(`dependents?groupId=${manyGroup.id}&cursor=${encodeURIComponent(roster.data.ownDependentsNextCursor)}`, { cookie: many.cookie });
      assert.equal(rest.status, 200); assert.equal(rest.data.nextCursor, null);
      assert.deepEqual([...roster.data.ownDependents, ...rest.data.dependents].map(item => item.id).sort(), expected);
      assert([403, 404].includes((await api(`dependents?groupId=${manyGroup.id}`, { cookie: outsider.cookie })).status));
      assert.equal((await api('dependents?cursor=invalid', { cookie: many.cookie })).status, 400);
      const foreign = await api(`dependents?guardianId=${many.id}`, { cookie: outsider.cookie });
      assert.equal(foreign.status, 200); assert.equal(foreign.data.dependents.length, 0);
    });

    await t.test('concurrent guardian removal and inclusion cannot leave an orphan dependent in the group', async () => {
      const concurrent = await makeGroup(owner, [owner, guardian]), dependent = await child(guardian, 'Concorrente');
      const guardianId = concurrent.members.get(guardian.id);
      const results = await Promise.all([
        remove(concurrent, guardianId, owner),
        api(`groups/${concurrent.id}/dependents/${dependent.id}`, { cookie: guardian.cookie, body: { active: true } }),
      ]);
      assert(results.every(result => [200, 403, 404, 409].includes(result.status)), JSON.stringify(results));
      const parentPresent = await count('as_memberships', 'id', guardianId);
      const childPresent = Number((await query('SELECT count(*) FROM as_memberships WHERE group_id=$1 AND dependent_id=$2', [concurrent.id, dependent.id])).rows[0].count);
      if (!parentPresent) assert.equal(childPresent, 0);
      else {
        assert.equal(results[0].status, 409, 'Newly included child requires updated confirmation');
        const ids = (await query('SELECT m.id FROM as_memberships m LEFT JOIN as_dependents d ON d.id=m.dependent_id WHERE m.group_id=$1 AND (m.user_id=$2 OR d.guardian_id=$2)', [concurrent.id, guardian.id])).rows.map(row => row.id);
        assert.equal((await remove(concurrent, guardianId, owner, ids)).status, 200);
      }
      assert.equal(notifications, 0);
    });

    await t.test('inclusion waiting on a group lock rechecks guardian participation after a committed removal', async () => {
      const locked = await makeGroup(owner, [owner, guardian]), dependent = await child(guardian, 'Em espera');
      const blocker = await getPool().connect(); let inclusion;
      try {
        await blocker.query('BEGIN');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await blocker.query('SELECT id FROM as_groups WHERE id=$1 FOR UPDATE', [locked.id]);
        inclusion = api(`groups/${locked.id}/dependents/${dependent.id}`, { cookie: guardian.cookie, body: { active: true } });
        let waiting = false;
        for (let attempt = 0; attempt < 30 && !waiting; attempt++) {
          waiting = (await query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert(waiting, 'The inclusion must be waiting on the held group row before removing the guardian');
        // Match the removal transaction while holding its group lock: removing
        // membership does not update the group tuple, so its old snapshot is unsafe.
        await blocker.query('DELETE FROM as_memberships WHERE id=$1', [locked.members.get(guardian.id)]);
        await blocker.query('COMMIT');
        const result = await inclusion;
        assert.equal(result.status, 403, JSON.stringify(result.data));
        assert.equal(result.data.error.code, 'NOT_PARTICIPATING');
        assert.equal(Number((await query('SELECT count(*) FROM as_memberships WHERE group_id=$1 AND dependent_id=$2', [locked.id, dependent.id])).rows[0].count), 0);
      } finally {
        await blocker.query('ROLLBACK'); blocker.release();
        if (inclusion) await inclusion;
      }
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
