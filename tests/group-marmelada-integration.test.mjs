import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import handler from '../api/index.js';
import { hashToken, newToken } from '../lib/auth.js';
import { getPool, query, transaction } from '../lib/db.js';

test('group Marmelada checks one announced pair using the drawn giver’s private token', {
  skip: process.env.RUN_DB_TESTS !== '1', timeout: 120000,
}, async t => {
  assert.match((await query('SELECT current_schema() AS name')).rows[0].name, /^as_test_/);
  const users = [], groups = [], children = [], fixture = randomUUID();
  const originalUrl = process.env.APP_URL;
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_URL = origin;
  const api = async (path, account, body) => {
    const response = await fetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-For': fixture,
        ...(account ? { Cookie: account.cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') };
  };
  const person = async firstName => {
    const id = randomUUID(), token = newToken(), email = `${firstName}-${fixture}@example.test`.toLowerCase();
    users.push(id);
    await query('INSERT INTO as_users(id,email,first_name,last_name) VALUES($1,$2,$3,$4)', [id, email, firstName, 'Fixture']);
    await query("INSERT INTO as_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), id]);
    return { id, email, cookie: `as_session=${token}` };
  };
  async function group(owner, people, childId, drawn = true) {
    const id = randomUUID(), ids = [];
    groups.push(id);
    await transaction(async client => {
      await client.query('INSERT INTO as_groups(id,organizer_id,name,event_date,budget,drawn_at) VALUES($1,$2,$3,current_date+20,100,$4)',
        [id, owner.id, 'Natal de teste', drawn ? new Date() : null]);
      for (const p of people) {
        const member = randomUUID(); ids.push(member);
        await client.query("INSERT INTO as_memberships(id,group_id,user_id,email,status,accepted_at) VALUES($1,$2,$3,$4,'accepted',now())", [member, id, p.id, p.email]);
      }
      const member = randomUUID(); ids.push(member);
      await client.query("INSERT INTO as_memberships(id,group_id,dependent_id,status,accepted_at) VALUES($1,$2,$3,'accepted',now())", [member, id, childId]);
      if (drawn) for (let i = 0; i < ids.length; i++) {
        await client.query('INSERT INTO as_draw_results(group_id,giver_id,receiver_id) VALUES($1,$2,$3)', [id, ids[i], ids[(i + 1) % ids.length]]);
      }
    });
    return { id, ids };
  }
  const path = (g, suffix = '') => `groups/${g.id}/marmelada${suffix}`;
  const issue = (g, account, membershipId) => api(path(g, '/token'), account, { membershipId });
  const check = (g, account, giverId, receiverId, token) => api(path(g, '/check'), account, { giverId, receiverId, token });

  try {
    const host = await person('Organizadora'), a = await person('Ana'), b = await person('Bruno'), outsider = await person('Fora');
    const child = randomUUID(); children.push(child);
    await query("INSERT INTO as_dependents(id,guardian_id,first_name,last_name) VALUES($1,$2,'Bia','Fixture')", [child, a.id]);
    const g = await group(host, [host, a, b], child), other = await group(host, [host, a, b], child), waiting = await group(host, [host, a, b], child, false);
    const [hostSlot, ana, bruno, bia] = g.ids;

    await t.test('only the actual creator sees the form and the account owner can issue their own token', async () => {
      assert.equal((await api(path(g))).status, 401);
      assert.equal((await api(path(g), a)).status, 404);
      assert.equal((await api(path(waiting), host)).status, 404);
      const page = await api(path(g), host);
      assert.equal(page.status, 200); assert.match(page.cache, /no-store/);
      assert.deepEqual(page.data.participants.map(p => p.id).sort(), [...g.ids].sort());
      assert.doesNotMatch(JSON.stringify(page.data), /receiver|token/);
      assert.equal((await issue(g, null, ana)).status, 401);
      assert.equal((await issue(g, host, ana)).status, 404);
      assert.equal((await issue(g, outsider, ana)).status, 404);
      assert.equal((await issue(g, a, other.ids[1])).status, 404);
      assert.equal((await issue(waiting, a, waiting.ids[1])).status, 404);
      assert.equal((await issue(g, b, bia)).status, 404);
      for (const [account, membershipId] of [[host, hostSlot], [a, bia]]) {
        const issued = await issue(g, account, membershipId);
        assert.equal(issued.status, 201);
        assert.match(issued.data.token, /^\d{8}$/);
        assert.match(issued.cache, /no-store/);
        const row = (await query('SELECT token_hash, failed_attempts FROM as_marmelada_tokens WHERE group_id=$1 AND giver_id=$2', [g.id, membershipId])).rows[0];
        assert.match(row.token_hash, /^[a-f0-9]{64}$/);
        assert.notEqual(row.token_hash, issued.data.token);
        assert.equal(row.failed_attempts, 0);
      }
    });

    await t.test('token belongs to the exact group and participant and either verdict consumes it', async () => {
      const code = (await issue(g, a, ana)).data.token;
      const otherCode = (await issue(other, a, other.ids[1])).data.token;
      assert.notEqual(otherCode, code);
      assert.equal((await check(g, a, ana, bruno, code)).status, 404);
      assert.equal((await check(g, outsider, ana, bruno, code)).status, 404);
      assert.equal((await check(other, host, other.ids[1], other.ids[2], code)).status, 422);
      assert.equal((await check(g, host, bruno, bia, code)).status, 422);
      assert.equal((await check(g, host, ana, other.ids[2], code)).status, 422);
      const wrong = await check(g, host, ana, hostSlot, code);
      assert.equal(wrong.status, 200);
      assert.deepEqual(wrong.data, { matches: false });
      assert.equal((await check(g, host, ana, bruno, code)).status, 422);
      const fresh = (await issue(g, a, ana)).data.token;
      assert.notEqual(fresh, code);
      const answers = await Promise.all([check(g, host, ana, bruno, fresh), check(g, host, ana, bruno, fresh)]);
      assert.deepEqual(answers.map(x => x.status).sort(), [200, 422]);
      assert.deepEqual(answers.find(x => x.status === 200).data, { matches: true });
    });

    await t.test('rotation, expiry and failed guesses stop disclosure', async () => {
      const old = (await issue(g, a, ana)).data.token, fresh = (await issue(g, a, ana)).data.token;
      assert.notEqual(old, fresh);
      for (let i = 0; i < 5; i++) assert.equal((await check(g, host, ana, bruno, old)).status, 422);
      assert.equal((await check(g, host, ana, bruno, fresh)).status, 422);
      const expired = (await issue(g, a, ana)).data.token;
      await query("UPDATE as_marmelada_tokens SET expires_at=now()-interval '1 minute' WHERE group_id=$1 AND giver_id=$2", [g.id, ana]);
      assert.equal((await check(g, host, ana, bruno, expired)).status, 422);
      assert.equal((await check(g, host, ana, bruno, '12')).status, 400);
      assert.equal((await check(waiting, host, waiting.ids[1], waiting.ids[2], expired)).status, 404);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (originalUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = originalUrl;
    await transaction(async client => {
      await client.query('DELETE FROM as_draw_results WHERE group_id=ANY($1::uuid[])', [groups]);
      await client.query('DELETE FROM as_groups WHERE id=ANY($1::uuid[])', [groups]);
      await client.query('DELETE FROM as_dependents WHERE id=ANY($1::uuid[])', [children]);
      await client.query('DELETE FROM as_users WHERE id=ANY($1::uuid[])', [users]);
    });
    await getPool().end();
  }
});
