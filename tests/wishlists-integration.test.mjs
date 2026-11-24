import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import handler from '../api/index.js';
import { getPool, query, transaction } from '../lib/db.js';
import { hashToken, newToken } from '../lib/auth.js';
import { adminDeleteUser, adminDeleteGroup } from '../lib/admin-delete.js';

test('gift suggestions are isolated by group, identity and the actual private draw assignment', {
  skip: process.env.RUN_DB_TESTS !== '1', timeout: 180000,
}, async t => {
  assert.match((await query('SELECT current_schema() AS name')).rows[0].name, /^as_test_/);
  const fixture = `wishlist-${randomUUID()}`, users = [], groups = [];
  const originalFetch = globalThis.fetch, originalUrl = process.env.APP_URL, originalVercel = process.env.VERCEL;
  let notificationAttempts = 0;
  globalThis.fetch = async () => { notificationAttempts++; throw new Error('Wishlist tests must never send notifications'); };
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
    return { id, email, name: `${name} Fixture`, cookie: `as_session=${token}` };
  };
  const group = async (owner, people) => {
    const id = randomUUID(); groups.push(id); const members = new Map();
    await query("INSERT INTO as_groups(id,organizer_id,name,event_date,budget) VALUES($1,$2,$3,current_date+30,100)", [id, owner.id, fixture]);
    for (const p of people) {
      const member = randomUUID(); members.set(p.id, member);
      await query("INSERT INTO as_memberships(id,group_id,user_id,email,status,accepted_at) VALUES($1,$2,$3,$4,'accepted',now())", [member, id, p.id, p.email]);
    }
    return { id, members };
  };
  const dependent = async (guardian, name) => {
    const id = randomUUID();
    await query('INSERT INTO as_dependents(id,guardian_id,first_name,last_name) VALUES($1,$2,$3,$4)', [id, guardian.id, name, 'Fixture']);
    return { id, name: `${name} Fixture` };
  };
  const activate = async (g, child, guardian) => {
    const result = await api(`groups/${g.id}/dependents/${child.id}`, { cookie: guardian.cookie, body: { active: true } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    g.members.set(child.id, result.data.dependent.membershipId);
  };
  const item = (text, url = '') => ({ id: randomUUID(), text, url });
  const list = (g, p, child, cursor) => api(`groups/${g.id}/wishlist?${new URLSearchParams({ ...(child ? { dependentId: child.id } : {}), ...(cursor ? { cursor } : {}) })}`, { cookie: p.cookie });
  const save = (g, p, upserts = [], deletedIds = [], child) => api(`groups/${g.id}/wishlist`, { cookie: p.cookie, body: { upserts, deletedIds, ...(child ? { dependentId: child.id } : {}) } });
  const assigned = (g, p, child, extra = {}) => api(`groups/${g.id}/result/wishlist?${new URLSearchParams({ ...(child ? { dependentId: child.id } : {}), ...extra })}`, { cookie: p.cookie });
  const shared = (g, p, membershipId, cursor) => api(
    `groups/${g.id}/participants/${membershipId}/wishlist${cursor ? `?cursor=${cursor}` : ''}`, { cookie: p?.cookie });
  try {
    const owner = await person('owner'), a = await person('guardian-a'), b = await person('guardian-b'), outsider = await person('outsider'), pending = await person('pending');
    const g = await group(owner, [owner, a, b]), other = await group(a, [a, b]), pendingGroup = await group(owner, [owner]);
    await query("INSERT INTO as_memberships(id,group_id,email,status,invite_token_hash,invite_expires_at) VALUES($1,$2,$3,'sent',$4,now()+interval '1 day')", [randomUUID(), pendingGroup.id, pending.email, hashToken(newToken())]);
    const pendingMemberId = randomUUID();
    await query("INSERT INTO as_memberships(id,group_id,email,status) VALUES($1,$2,$3,'sent')", [pendingMemberId, g.id, pending.email]);
    const child = await dependent(a, 'Lia'), inactive = await dependent(a, 'Inativa'), foreign = await dependent(b, 'Caio');
    await activate(g, child, a); await activate(g, foreign, b); await activate(other, child, a);
    const own = item('Um livro de mistério', 'https://example.test/livro'), childWish = item('Blocos de montar'), bWish = item('Uma caneca azul'), otherWish = item('Somente no outro grupo');

    await t.test('requires login and accepted participation; lists never accept caller-controlled user or membership selection', async () => {
      assert.equal((await api(`groups/${g.id}/wishlist`)).status, 401);
      assert.equal((await api(`groups/${g.id}/wishlist`, { body: { upserts: [own] } })).status, 401);
      assert([403, 404].includes((await list(g, outsider)).status));
      assert([403, 404].includes((await save(g, outsider, [own])).status));
      assert([403, 404].includes((await list(pendingGroup, pending)).status));
      assert([403, 404].includes((await save(pendingGroup, pending, [own])).status));
      const empty = await list(g, a); assert.equal(empty.status, 200); assert(empty.cache.includes('no-store'));
      assert.equal(empty.data.owner.membershipId, g.members.get(a.id)); assert.equal(empty.data.items.length, 0);
      const attempt = await api(`groups/${g.id}/wishlist?userId=${b.id}&membershipId=${g.members.get(b.id)}`, { cookie: a.cookie });
      assert.equal(attempt.status, 200); assert.equal(attempt.data.owner.membershipId, g.members.get(a.id));
      assert.equal((await assigned(g, a)).status, 409);
      const target = g.members.get(b.id);
      assert.equal((await shared(g, a, target)).status, 409);
      assert.equal((await shared(g, owner, target)).status, 409);
      assert.equal((await shared(g, null, target)).status, 401);
      assert.equal((await shared(g, pending, target)).status, 404);
      assert.equal((await shared(g, outsider, target)).status, 404);
      const beforeDraw = await api(`groups/${g.id}`, { cookie: owner.cookie });
      assert.equal(beforeDraw.status, 200);
      assert(!('drawGuide' in beforeDraw.data));
    });

    await t.test('persists separate adult and dependent lists with guardian-only management', async () => {
      assert.equal((await save(g, a, [own])).status, 200);
      assert.equal((await save(g, a, [childWish], [], child)).status, 200);
      assert.equal((await save(g, b, [bWish])).status, 200);
      assert.equal((await save(other, a, [otherWish])).status, 200);
      assert.equal((await list(g, a)).data.items[0].text, own.text);
      assert.equal((await list(other, a)).data.items[0].text, otherWish.text);
      const children = await list(g, a, child); assert.equal(children.status, 200); assert.equal(children.data.owner.dependentId, child.id); assert.equal(children.data.items[0].text, childWish.text);
      assert([403, 404].includes((await list(g, b, child)).status));
      assert([403, 404].includes((await save(g, b, [item('intruder')], [], child)).status));
      assert([403, 404].includes((await list(g, a, inactive)).status));
      assert([403, 404].includes((await save(g, a, [item('inactive')], [], inactive)).status));
      assert.equal((await list(g, owner)).data.items.length, 0, 'Organizer cannot see another member wishes by default');
      const update = { ...own, text: 'Livro de mistério, edição de bolso', url: '' };
      assert.equal((await save(g, a, [update])).status, 200); assert.equal((await list(g, a)).data.items[0].text, update.text);
    });

    await t.test('rejects unsafe input and foreign item mutations atomically without leaking other lists', async () => {
      for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///private/test', 'https://user:pass@example.test/', 'https://example.test/\nsecret']) {
        assert.equal((await save(g, a, [item('Invalid link', url)])).status, 400, url);
      }
      for (const text of ['', '  ', 'a'.repeat(2001)]) assert.equal((await save(g, a, [item(text)])).status, 400);
      assert.equal((await save(g, a, [item('Too long URL', `https://example.test/${'a'.repeat(2049)}`)])).status, 400);
      const countBefore = Number((await query('SELECT count(*) FROM as_wishlist_items WHERE membership_id=$1', [g.members.get(a.id)])).rows[0].count);
      const attack = await save(g, a, [item('Must roll back'), { ...bWish, text: 'Stolen ID' }]); assert([400, 403, 404, 409].includes(attack.status));
      assert([400, 403, 404, 409].includes((await save(g, a, [], [bWish.id])).status));
      assert([400, 403, 404, 409].includes((await save(g, a, [{ ...otherWish, text: 'Cross group' }])).status));
      assert.equal(Number((await query('SELECT count(*) FROM as_wishlist_items WHERE membership_id=$1', [g.members.get(a.id)])).rows[0].count), countBefore);
      assert.equal((await list(g, b)).data.items[0].text, bWish.text);
    });

    await t.test('supports arbitrarily many total items through bounded batches and stable pagination', async () => {
      const many = Array.from({ length: 120 }, (_, n) => item(`Sugestão ${n + 1}`));
      for (let offset = 0; offset < many.length; offset += 50) assert.equal((await save(g, a, many.slice(offset, offset + 50))).status, 200);
      assert.equal((await save(g, a, many.slice(0, 50))).status, 200, 'Retrying a saved batch does not duplicate entries');
      let cursor, pages = 0; const entries = [];
      do {
        const page = await list(g, a, null, cursor); assert.equal(page.status, 200); assert(page.data.items.length <= 50);
        entries.push(...page.data.items); cursor = page.data.nextCursor; pages++; assert(pages < 10);
      } while (cursor);
      assert.equal(entries.length, 121); assert.equal(new Set(entries.map(i => i.id)).size, 121); assert.equal(pages, 3);
      assert(entries.some(i => i.id === own.id));
      assert.equal((await save(g, a, [], many.slice(0, 50).map(i => i.id))).status, 200);
      assert.equal((await query('SELECT count(*) FROM as_wishlist_items WHERE membership_id=$1', [g.members.get(a.id)])).rows[0].count, '71');
      assert.equal((await api(`groups/${g.id}/wishlist?cursor=not-a-cursor`, { cookie: a.cookie })).status, 400);
    });

    await t.test('the private draw endpoint still resolves only the actual assignment, including owned dependents', async () => {
      // Deterministic cycle in this isolated fixture: owner -> a -> b -> child -> foreign -> owner.
      const ordered = [owner.id, a.id, b.id, child.id, foreign.id].map(id => g.members.get(id));
      await transaction(async client => {
        await client.query('UPDATE as_groups SET drawn_at=now() WHERE id=$1', [g.id]);
        for (let n = 0; n < ordered.length; n++) await client.query('INSERT INTO as_draw_results(group_id,giver_id,receiver_id) VALUES($1,$2,$3)', [g.id, ordered[n], ordered[(n + 1) % ordered.length]]);
      });
      const adultResult = await assigned(g, a, null, { receiverId: g.members.get(owner.id), userId: owner.id });
      assert.equal(adultResult.status, 200); assert(adultResult.cache.includes('no-store'));
      assert.equal(adultResult.data.owner.membershipId, g.members.get(b.id)); assert.equal(adultResult.data.items[0].text, bWish.text);
      const childResult = await assigned(g, a, child); assert.equal(childResult.status, 200); assert.equal(childResult.data.owner.dependentId, foreign.id); assert.equal(childResult.data.items.length, 0);
      const receivedChild = await assigned(g, b); assert.equal(receivedChild.data.owner.dependentId, child.id); assert.equal(receivedChild.data.items[0].text, childWish.text);
      assert([403, 404].includes((await assigned(g, a, foreign)).status));
      assert([403, 404].includes((await assigned(g, outsider)).status));
      assert([403, 404].includes((await assigned(g, pending)).status));
      const edited = { ...bWish, text: 'Caneca azul, tamanho grande' };
      assert.equal((await save(g, b, [edited])).status, 200, 'Editing after draw is allowed');
      assert.equal((await assigned(g, a)).data.items[0].text, edited.text);
      assert.equal(notificationAttempts, 0);
    });

    await t.test('group members can browse other participants and dependents without reading draw pairs', async () => {
      const target = g.members.get(a.id);
      const page = await shared(g, owner, target);
      assert.equal(page.status, 200); assert.match(page.cache, /no-store/);
      assert.deepEqual(Object.keys(page.data).sort(), ['items', 'nextCursor', 'owner']);
      assert.equal(page.data.owner.membershipId, target); assert.equal(page.data.items.length, 50);
      assert(!/giver|receiver|match/i.test(JSON.stringify(page.data)));
      const nextPage = await shared(g, owner, target, page.data.nextCursor);
      assert.equal(nextPage.status, 200); assert.equal(nextPage.data.items.length, 21);
      assert.equal(nextPage.data.nextCursor, null);
      assert.equal(new Set([...page.data.items, ...nextPage.data.items].map(i => i.id)).size, 71);
      assert.equal((await shared(g, owner, target, 'invalid')).status, 400);
      const childPage = await shared(g, owner, g.members.get(child.id));
      assert.equal(childPage.status, 200); assert.equal(childPage.data.owner.dependentId, child.id);
      assert.deepEqual(childPage.data.items, [childWish]);
      assert.equal((await shared(g, a, other.members.get(b.id))).status, 404);
      assert.equal((await shared(g, owner, pendingMemberId)).status, 404);
      assert.equal((await shared(g, pending, target)).status, 404);
      assert.equal((await shared(g, outsider, target)).status, 404);
      assert.equal((await shared(g, null, target)).status, 401);
      assert.equal((await shared(g, b, target)).status, 200);

      const creatorPage = await api(`groups/${g.id}`, { cookie: owner.cookie });
      assert.equal(creatorPage.status, 200); assert.equal(creatorPage.data.match, null);
      assert.deepEqual(creatorPage.data.drawGuide, { status: 'single', starters: [g.members.get(foreign.id), target, g.members.get(b.id)] });
      assert(!/giver_id|receiver_id|draw_edges/.test(JSON.stringify(creatorPage.data)));
      const memberPage = await api(`groups/${g.id}`, { cookie: a.cookie });
      assert.equal(memberPage.status, 200); assert.equal(memberPage.data.match, null);
      assert(!('drawGuide' in memberPage.data));
    });

    await t.test('legacy draws with multiple cycles have no starter suggestions and are preserved', async () => {
      const legacy = await group(owner, [owner, a, b, outsider]);
      await activate(legacy, child, a); await activate(legacy, foreign, b);
      const cycles = [[owner.id, a.id, child.id], [b.id, outsider.id, foreign.id]];
      await transaction(async client => {
        await client.query('UPDATE as_groups SET drawn_at=now() WHERE id=$1', [legacy.id]);
        for (const cycle of cycles) {
          for (const [n, giver] of cycle.entries()) {
            await client.query('INSERT INTO as_draw_results(group_id,giver_id,receiver_id) VALUES($1,$2,$3)',
              [legacy.id, legacy.members.get(giver), legacy.members.get(cycle[(n + 1) % cycle.length])]);
          }
        }
      });
      const getStored = async () => (await query('SELECT * FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [legacy.id])).rows;
      const stored = await getStored();
      const page = await api(`groups/${legacy.id}`, { cookie: owner.cookie });
      assert.equal(page.status, 200);
      assert.deepEqual(page.data.drawGuide, { status: 'multiple' });
      assert.deepEqual(await getStored(), stored);
      assert.equal((await shared(legacy, a, legacy.members.get(owner.id))).status, 200);
    });

    await t.test('removing an inactive-before-draw membership cascades its list; account deletion erases personal wishes and preserves other draw pairs', async () => {
      assert.equal((await save(other, a, [item('Outra lista da criança')], [], child)).status, 200);
      const oldMembership = other.members.get(child.id);
      assert.equal((await api(`groups/${other.id}/dependents/${child.id}`, { cookie: a.cookie, body: { active: false } })).status, 200);
      assert.equal((await query('SELECT count(*) FROM as_wishlist_items WHERE membership_id=$1', [oldMembership])).rows[0].count, '0');
      const originalPairs = (await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [g.id])).rows;
      const admin = { id: owner.id, email: 'fabiosanida@gmail.com' };
      await adminDeleteUser(admin, a.id, { confirmation: a.email });
      assert.deepEqual((await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [g.id])).rows, originalPairs);
      assert.equal((await query('SELECT count(*) FROM as_wishlist_items WHERE membership_id=ANY($1::uuid[])', [[g.members.get(a.id), g.members.get(child.id), other.members.get(a.id)]])).rows[0].count, '0');
      assert.equal((await query('SELECT count(*) FROM as_groups WHERE id=$1', [other.id])).rows[0].count, '0');
      assert.equal((await list(g, a)).status, 401);
      assert.equal((await shared(g, b, g.members.get(a.id))).status, 404);
      assert.equal((await shared(g, b, g.members.get(child.id))).status, 404);
      const removed = await assigned(g, b); assert([200, 404].includes(removed.status));
      if (removed.status === 200) { assert.equal(removed.data.items.length, 0); assert(!JSON.stringify(removed.data).includes(child.name)); }
      await adminDeleteGroup(admin, g.id, { confirmation: fixture });
      assert.equal((await query('SELECT count(*) FROM as_wishlist_items WHERE id=$1', [bWish.id])).rows[0].count, '0');
      assert.equal(notificationAttempts, 0);
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
