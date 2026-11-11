import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import handler from '../api/index.js';
import { getPool, query, transaction } from '../lib/db.js';
import { hashToken, newToken } from '../lib/auth.js';
import { createGroup } from '../lib/groups.js';
import { updateProfile } from '../lib/profile.js';

test('private administration and creator deletion enforce server identity, full cleanup and confirmation', {
  skip: process.env.RUN_DB_TESTS !== '1', timeout: 300000,
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
    return { id, name, members, inviteToken, pendingId };
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
    const performance = await makeGroup(`${fixture} conferência`, owner, [member, outsider], true);
    const otherPerformance = await makeGroup(`${fixture} outra conferência`, owner, [member, outsider], true);
    const notDrawn = await makeGroup(`${fixture} sem sorteio`, owner, [member]);
    await t.test('Marmelada is private and offers only drawn groups and actual draw participants', async () => {
      for (const endpoint of ['admin/marmelada/groups', `admin/marmelada/groups/${performance.id}`]) {
        assert.equal((await api(endpoint)).status, 401);
        assert.equal((await api(`${endpoint}?isAdmin=true&email=fabiosanida%40gmail.com`, { cookie: member.cookie })).status, 403);
      }
      const list = await api(`admin/marmelada/groups?search=${encodeURIComponent(fixture)}&limit=1`, { cookie: admin.cookie });
      assert.equal(list.status, 200); assert.equal(list.data.groups.length, 1);
      assert.equal(list.data.pagination.total, 2); assert.equal(list.data.pagination.totalPages, 2);
      const second = await api(`admin/marmelada/groups?search=${encodeURIComponent(fixture)}&limit=1&page=2`, { cookie: admin.cookie });
      assert.notEqual(second.data.groups[0].id, list.data.groups[0].id);
      assert(![...list.data.groups, ...second.data.groups].some(group => group.id === notDrawn.id));
      const detail = await api(`admin/marmelada/groups/${performance.id}`, { cookie: admin.cookie });
      assert.equal(detail.status, 200); assert.equal(detail.data.group.id, performance.id);
      assert.equal(detail.data.participants.length, 3);
      assert.deepEqual(detail.data.participants.map(person => person.id).sort(), performance.members.map(person => person.id).sort());
      assert(!detail.data.participants.some(person => person.id === performance.pendingId));
      assert(!JSON.stringify(detail.data).match(/@|results|receiver|giver|password|token|secret-avatar/), 'The selection response exposes names, not contact data or the secret mapping');
      assert([400, 404, 409].includes((await api(`admin/marmelada/groups/${notDrawn.id}`, { cookie: admin.cookie })).status));
    });
    await t.test('Marmelada compares the stored pair, refuses unrelated participants and never changes a draw', async () => {
      const body = { groupId: performance.id, giverId: performance.members[0].id, receiverId: performance.members[1].id };
      const before = (await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [performance.id])).rows;
      assert.equal((await api('admin/marmelada/check', { body })).status, 401);
      assert.equal((await api('admin/marmelada/check', { cookie: owner.cookie, body: { ...body, isAdmin: true, email: admin.email } })).status, 403);
      const correct = await api('admin/marmelada/check', { cookie: admin.cookie, body });
      assert.equal(correct.status, 200); assert.equal(correct.data.matches, true);
      assert.equal(correct.data.giver.id, body.giverId); assert.equal(correct.data.receiver.id, body.receiverId);
      const wrong = await api('admin/marmelada/check', { cookie: admin.cookie, body: { ...body, receiverId: performance.members[2].id } });
      assert.equal(wrong.status, 200); assert.equal(wrong.data.matches, false);
      assert.equal(wrong.data.receiver.id, performance.members[2].id);
      assert(!JSON.stringify(wrong.data).includes(performance.members[1].id), 'A wrong guess must not expose the real receiver');
      assert(!JSON.stringify(wrong.data).includes(member.email));
      assert(!JSON.stringify(wrong.data).includes(member.name));
      for (const invalid of [
        { ...body, groupId: notDrawn.id },
        { ...body, giverId: otherPerformance.members[0].id },
        { ...body, receiverId: otherPerformance.members[1].id },
        { ...body, giverId: performance.pendingId },
        { ...body, receiverId: performance.pendingId },
        { ...body, groupId: 'not-a-group' },
      ]) assert([400, 404, 409].includes((await api('admin/marmelada/check', { cookie: admin.cookie, body: invalid })).status));
      const after = (await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [performance.id])).rows;
      assert.deepEqual(after, before);
    });
    await t.test('admin previews and can delete another creator’s group, with exact confirmation and active-delivery protection', async () => {
      const foreign = await makeGroup(`${fixture} exclusão administrativa`, owner, [member, outsider], true);
      const previewPath = `admin/groups/${foreign.id}/delete-preview`, deletePath = `admin/groups/${foreign.id}/delete`;
      assert.equal((await api(previewPath)).status, 401);
      assert.equal((await api(previewPath, { cookie: owner.cookie })).status, 403);
      assert.equal((await api(deletePath, { body: { confirmation: foreign.name } })).status, 401);
      assert.equal((await api(deletePath, { cookie: owner.cookie, body: { confirmation: foreign.name, isAdmin: true } })).status, 403);
      const preview = await api(previewPath, { cookie: admin.cookie });
      assert.equal(preview.status, 200); assert.equal(preview.data.canDelete, true); assert.equal(preview.data.group.name, foreign.name);
      assert.equal(preview.data.effects.groupsDeleted, 1); assert.equal(preview.data.effects.membershipsDeleted, 4); assert.equal(preview.data.effects.resultsDeleted, 3);
      assert.equal(preview.data.effects.notificationsDeleted, 1);
      assert.equal(Number((await query('SELECT count(*) FROM as_groups WHERE id=$1', [foreign.id])).rows[0].count), 1, 'Preview is read-only');
      for (const confirmation of [undefined, '', foreign.name + ' ']) {
        const invalid = await api(deletePath, { cookie: admin.cookie, body: { confirmation } });
        assert.equal(invalid.status, 400); assert.equal(invalid.data.error.code, 'CONFIRMATION_REQUIRED');
      }
      await query("UPDATE as_outbox SET state='sending',lease_until=now()+interval '1 minute' WHERE group_id=$1", [foreign.id]);
      const blocked = await api(deletePath, { cookie: admin.cookie, body: { confirmation: foreign.name } });
      assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'NOTIFICATIONS_IN_PROGRESS');
      await query("UPDATE as_outbox SET state='pending',lease_until=NULL WHERE group_id=$1", [foreign.id]);
      const deleted = await api(deletePath, { cookie: admin.cookie, body: { confirmation: foreign.name } });
      assert.equal(deleted.status, 200); assert.equal(deleted.data.deletedId, foreign.id);
      for (const table of ['as_groups', 'as_memberships', 'as_draw_results', 'as_outbox']) {
        assert.equal(Number((await query(`SELECT count(*) FROM ${table} WHERE ${table === 'as_groups' ? 'id' : 'group_id'}=$1`, [foreign.id])).rows[0].count), 0);
      }
      assert.equal((await api(`invitations/${foreign.inviteToken}`)).status, 410);
      assert.equal((await api(deletePath, { cookie: admin.cookie, body: { confirmation: foreign.name } })).status, 404);
    });
    await t.test('user deletion is admin-only, previews its impact and cannot erase the sole administrative account', async () => {
      const path = `admin/users/${admin.id}`;
      assert.equal((await api(`${path}/delete-preview`)).status, 401);
      assert.equal((await api(`${path}/delete-preview`, { cookie: member.cookie })).status, 403);
      assert.equal((await api(`${path}/delete`, { body: { confirmation: admin.email } })).status, 401);
      assert.equal((await api(`${path}/delete`, { cookie: owner.cookie, body: { confirmation: admin.email, isAdmin: true } })).status, 403);
      const preview = await api(`${path}/delete-preview`, { cookie: admin.cookie });
      assert.equal(preview.status, 200); assert.equal(preview.data.canDelete, false); assert(preview.data.blockedReason);
      const blocked = await api(`${path}/delete`, { cookie: admin.cookie, body: { confirmation: admin.email } });
      assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'ADMIN_ACCOUNT_PROTECTED');
      assert.equal((await api('session', { cookie: admin.cookie })).data.user.id, admin.id);
    });
    await t.test('confirmed user deletion removes identity and credentials while preserving unrelated drawn cycles anonymously', async () => {
      const target = await person('Remover');
      const stalePrincipal = { id: target.id, email: target.email, firstName: target.name, lastName: fixture, avatar: 'secret-avatar-payload' };
      const owned = await makeGroup(`${fixture} grupo do removido`, target, [member]);
      const sharedDraw = await makeGroup(`${fixture} sorteio preservado`, owner, [target, member], true);
      const sharedOpen = await makeGroup(`${fixture} aberto preservado`, owner, [target]);
      await query('UPDATE as_memberships SET email=$2 WHERE id=$1', [notDrawn.pendingId, target.email]);
      await query('UPDATE as_memberships SET email=$2 WHERE id=$1', [otherPerformance.pendingId, target.email]);
      const secretInvite = newToken(), secretTrack = newToken();
      await query('UPDATE as_memberships SET invite_token_hash=$2,tracking_token_hash=$3,invite_expires_at=now()+interval \'1 day\' WHERE id=$1', [sharedDraw.members[1].id, hashToken(secretInvite), hashToken(secretTrack)]);
      const outboxId = randomUUID();
      await query("INSERT INTO as_outbox(id,group_id,membership_id,kind,dedupe_key,delivery_key,payload,state,next_attempt_at) VALUES($1,$2,$3,'result',$4,$4,$5,'pending',now()+interval '1 day')", [outboxId, sharedDraw.id, sharedDraw.members[0].id, `${fixture}:receiver-cleanup`, { user: { id: owner.id, email: owner.email }, match: { id: target.id, name: target.name, email: target.email, avatar: 'secret-avatar-payload' } }]);
      const ownOutbox = randomUUID();
      await query("INSERT INTO as_outbox(id,group_id,membership_id,kind,dedupe_key,delivery_key,payload,state,next_attempt_at) VALUES($1,$2,$3,'result',$4,$4,$5,'pending',now()+interval '1 day')", [ownOutbox, sharedDraw.id, sharedDraw.members[1].id, `${fixture}:recipient-cleanup`, { user: { id: target.id, email: target.email, firstName: target.name }, private: 'secret-recipient-payload' }]);
      const resetToken = newToken();
      await query("INSERT INTO as_password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(resetToken), target.id]);
      for (const userId of [target.id, null]) {
        await query("INSERT INTO as_auth_challenges(id,email,user_id,first_name,last_name,password_hash,avatar,code_hash,token_hash,expires_at,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour','signup')", [randomUUID(), target.email, userId, target.name, fixture, 'secret-password-hash', 'secret-avatar-payload', '0'.repeat(64), hashToken(newToken())]);
      }
      const pairSnapshot = (await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [sharedDraw.id])).rows;
      const path = `admin/users/${target.id}`;
      const preview = await api(`${path}/delete-preview`, { cookie: admin.cookie });
      assert.equal(preview.status, 200); assert.equal(preview.data.canDelete, true); assert.equal(preview.data.user.email, target.email);
      assert.equal(preview.data.effects.groupsDeleted, 1); assert(preview.data.effects.membershipsRemoved >= 3);
      assert.equal(preview.data.effects.drawnParticipationsAnonymized, 1);
      assert.equal((await api('session', { cookie: target.cookie })).data.user.id, target.id, 'Preview does not revoke the user');
      for (const confirmation of [undefined, '', target.email + ' ']) {
        const invalid = await api(`${path}/delete`, { cookie: admin.cookie, body: { confirmation } });
        assert.equal(invalid.status, 400); assert.equal(invalid.data.error.code, 'CONFIRMATION_REQUIRED');
      }
      await query("UPDATE as_outbox SET state='sending',lease_until=now()+interval '1 minute' WHERE id=$1", [ownOutbox]);
      const busy = await api(`${path}/delete`, { cookie: admin.cookie, body: { confirmation: target.email } });
      assert.equal(busy.status, 409); assert.equal(busy.data.error.code, 'NOTIFICATIONS_IN_PROGRESS');
      assert.equal((await api('session', { cookie: target.cookie })).data.user.id, target.id, 'Rejected deletion is atomic');
      await query("UPDATE as_outbox SET state='pending',lease_until=NULL WHERE id=$1", [ownOutbox]);
      const deleted = await api(`${path}/delete`, { cookie: admin.cookie, body: { confirmation: target.email } });
      assert.equal(deleted.status, 200); assert.equal(deleted.data.deletedId, target.id);
      assert.equal((await api('session', { cookie: target.cookie })).data.user, null);
      assert.equal((await api('groups', { cookie: target.cookie })).status, 401);
      const tombstone = (await query('SELECT email,first_name,last_name,avatar,password_hash,deleted_at FROM as_users WHERE id=$1', [target.id])).rows[0];
      assert(tombstone?.deleted_at); assert.notEqual(tombstone.email, target.email);
      assert.equal(tombstone.password_hash, null); assert.equal(tombstone.avatar, null);
      assert(!JSON.stringify(tombstone).includes(target.name));
      for (const [table, filter, values] of [
        ['as_sessions', 'user_id=$1', [target.id]],
        ['as_password_resets', 'user_id=$1', [target.id]],
        ['as_auth_challenges', 'user_id=$1 OR email=$2', [target.id, target.email]],
        ['as_memberships', 'email=$1 OR invite_token_hash=$2 OR tracking_token_hash=$3', [target.email, hashToken(secretInvite), hashToken(secretTrack)]],
      ]) assert.equal(Number((await query(`SELECT count(*) FROM ${table} WHERE ${filter}`, values)).rows[0].count), 0, `${table} retains no access or original identity`);
      assert.equal(Number((await query('SELECT count(*) FROM as_groups WHERE id=$1', [owned.id])).rows[0].count), 0);
      assert.equal(Number((await query('SELECT count(*) FROM as_groups WHERE id=ANY($1::uuid[])', [[sharedOpen.id, sharedDraw.id]])).rows[0].count), 2);
      assert.equal(Number((await query('SELECT count(*) FROM as_memberships WHERE group_id=$1 AND user_id=$2', [sharedOpen.id, target.id])).rows[0].count), 0);
      assert.deepEqual((await query('SELECT giver_id,receiver_id FROM as_draw_results WHERE group_id=$1 ORDER BY giver_id', [sharedDraw.id])).rows, pairSnapshot);
      const historical = await api(`admin/groups/${sharedDraw.id}`, { cookie: admin.cookie });
      assert.equal(historical.status, 200); assert.equal(historical.data.results.length, 3);
      assert(!JSON.stringify(historical.data).includes(target.email)); assert(!JSON.stringify(historical.data).includes(target.name));
      const anonymousParticipant = historical.data.participants.find(person => person.id === sharedDraw.members[1].id);
      assert(anonymousParticipant); assert(!anonymousParticipant.email); assert.equal(anonymousParticipant.userId, null);
      const result = await api(`groups/${sharedDraw.id}/result`, { cookie: owner.cookie });
      assert.equal(result.status, 200); assert(result.data.match); assert(!JSON.stringify(result.data).includes(target.email)); assert(!JSON.stringify(result.data).includes(target.name));
      assert(!result.data.match.email, 'An anonymized result exposes no synthetic internal email address');
      const payloads = (await query('SELECT payload FROM as_outbox WHERE group_id=$1', [sharedDraw.id])).rows;
      assert(!JSON.stringify(payloads).includes(target.email)); assert(!JSON.stringify(payloads).includes(target.name)); assert(!JSON.stringify(payloads).includes('secret-recipient-payload'));
      assert.equal((await api(path, { cookie: admin.cookie })).status, 404);
      const listed = await api(`admin/users?search=${encodeURIComponent(target.email)}`, { cookie: admin.cookie });
      assert.equal(listed.data.users.length, 0);
      const available = await api('auth/account', { body: { email: target.email } });
      assert.equal(available.status, 200); assert.equal(available.data.exists, false);
      await assert.rejects(updateProfile(stalePrincipal, { firstName: 'Restored', lastName: 'Identity' }), error => [401, 403, 404, 410].includes(error.status));
      let staleCreationError;
      try {
        const created = await createGroup(stalePrincipal, { name: `${fixture} stale forbidden`, date: '2099-12-20', budget: 100 });
        if (created?.group?.id) groups.push(created.group.id);
      } catch (error) { staleCreationError = error; }
      assert(staleCreationError && [401, 403, 404, 410].includes(staleCreationError.status), 'A principal captured before deletion cannot create another group');
      assert(!(await query('SELECT first_name FROM as_users WHERE id=$1', [target.id])).rows[0].first_name.includes('Restored'));
      const replacement = await person('NovaConta', target.email);
      assert.equal((await api(`groups/${sharedDraw.id}`, { cookie: replacement.cookie })).status, 404);
      assert.equal((await api('groups', { cookie: replacement.cookie })).data.groups.length, 0);
      assert.equal((await api(`invitations/${secretInvite}`, { cookie: replacement.cookie })).status, 410);
      assert.equal((await api(`invitations/${notDrawn.inviteToken}`, { cookie: replacement.cookie })).status, 410);
      assert.equal((await api(`invitations/${otherPerformance.inviteToken}`, { cookie: replacement.cookie })).status, 410);
      assert.equal((await api('session', { cookie: target.cookie })).data.user, null, 'Reusing the original email cannot revive the deleted session');
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
