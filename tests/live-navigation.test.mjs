import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { renderAuth, AUTH_ROUTES } from '../prototype/auth.js';
import { renderGroups, GROUP_ROUTES } from '../prototype/groups.js';
import { renderAdmin, renderAdminDeletePreview, ADMIN_ROUTES } from '../prototype/admin.js';
import { icon, brand, avatar, escapeHtml, setAvatarDirectory } from '../prototype/ui.js';

const source = readFileSync(new URL('../prototype/live.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ hash = '#welcome', stored = new Map(), selectors = {} } = {}) {
  const requests = [], presentations = [], listeners = {}, app = { innerHTML: '' }, location = { hash };
  const storage = new Map(stored);
  const noop = () => {};
  const context = {
    URLSearchParams, Date, Error, Map, Set, Promise, Number, String, Boolean, JSON, Math,
    FormData: class { constructor(form) { this.values = form.values; } get(name) { return this.values[name] ?? null; } },
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, location,
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    history: { pushState(a, b, hash) { location.hash = hash; }, replaceState(a, b, hash) { location.hash = hash; } },
    document: { body: { dataset: {}, style: {} }, querySelector: selector => selector === '#app' ? app : selectors[selector] || null, querySelectorAll: () => [], addEventListener: noop },
    window: { scrollTo: noop, addEventListener(type, listener) { listeners[type] = listener; } },
    renderAuth, AUTH_ROUTES, renderGroups, GROUP_ROUTES, renderAdmin, renderAdminDeletePreview, ADMIN_ROUTES, icon, brand, avatar, escapeHtml, setAvatarDirectory,
    showMarmeladaResult: result => { presentations.push(result); },
    setupInviteFields: noop, setInviteFieldsBusy: noop, setupGroupFields: noop, parseBudget: Number, setupOTP: noop,
    openProfileEditor: noop, setupPhotoInputs: noop, getSignupAvatar: () => null, resetSignupAvatar: noop,
    fetch(path, options) {
      return new Promise(resolve => requests.push({ path, body: options.body ? JSON.parse(options.body) : null,
        respond(payload, status = 200) { resolve({ ok: status < 400, status, headers: new Headers(), json: async () => payload }); } }));
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.navigationTest = { navigate, state, action, submit };`, context);
  return { requests, presentations, location, app, storage, ...context.navigationTest,
    pairedHistory(hash) { location.hash = hash; listeners.popstate(); listeners.hashchange(); },
    verifyRequests() { return requests.filter(request => request.path === '/api/auth/verify'); },
  };
}

test('bootstrap consumes the latest magic link once despite paired history and concurrent navigation', async () => {
  const h = harness();
  assert.equal(h.requests[0].path, '/api/session');
  h.pairedHistory('#verify-link?token=old-link');
  h.pairedHistory('#verify-link?token=current-link');
  assert.equal(h.verifyRequests().length, 0, 'verification waits for the initial session response');
  h.requests[0].respond({ user: null });
  await tick();
  assert.equal(h.verifyRequests().length, 1);
  assert.equal(h.verifyRequests()[0].body.token, 'current-link');
  h.pairedHistory(h.location.hash);
  const concurrent = h.navigate('verify-link?token=current-link', { replace: true });
  assert.equal(h.verifyRequests().length, 1, 'same pending token shares one request');
  h.verifyRequests()[0].respond({ user: { id: 'user-1', firstName: 'Pessoa', lastName: 'Teste', email: 'person@example.test' } });
  await tick();
  h.requests.find(request => request.path === '/api/groups').respond({ groups: [] });
  await concurrent;
  assert.equal(h.state.user.id, 'user-1');
  assert.equal(h.location.hash, '#dashboard');
  assert.equal(h.verifyRequests().length, 1);
});

test('paired events do not retry a failed link, and an explicit later retry is not served from cache', async () => {
  const h = harness();
  h.requests[0].respond({ user: null });
  await tick();
  h.pairedHistory('#verify-link?token=expired-link');
  assert.equal(h.verifyRequests().length, 1);
  h.pairedHistory(h.location.hash);
  assert.equal(h.verifyRequests().length, 1);
  h.verifyRequests()[0].respond({ error: { code: 'EXPIRED_CODE', message: 'Expired' } }, 401);
  await tick();
  assert.equal(h.location.hash, '#login');
  assert.equal(h.state.user, null);
  h.pairedHistory('#login');
  assert.equal(h.verifyRequests().length, 1, 'settled error does not cause an event retry');
  h.pairedHistory('#verify-link?token=expired-link');
  assert.equal(h.verifyRequests().length, 2, 'only pending work is deduplicated; expired results are not reused');
  h.verifyRequests()[1].respond({ error: { code: 'EXPIRED_CODE', message: 'Expired' } }, 401);
  await tick();
  assert.equal(h.location.hash, '#login');
  assert.equal(h.state.user, null);
});


const inviteToken = 'i'.repeat(43);
const invitedGroup = { id: 'group-1', name: 'Grupo de teste', date: '2026-12-24', budget: 20, drawn: false };
const signedInUser = { id: 'user-2', firstName: 'Pessoa', lastName: 'Conectada', email: 'connected@example.test' };
const invitationPayload = extra => ({ group: invitedGroup, recipientEmail: 'recipient@example.test', status: 'pending', currentUserInvited: false, currentUserAccepted: false, ...extra });
const dashboardInvitation = { id: 'membership-1', invitationId: 'membership-1', group: { ...invitedGroup, organizerName: 'Pessoa Organizadora' }, invitedAt: '2026-11-12T10:00:00Z', expiresAt: '2027-01-12T10:00:00Z' };

function fixtureForm(type, values) {
  const attributes = new Map();
  return { dataset: { form: type }, values, isConnected: false, reportValidity: () => true,
    getAttribute: key => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value),
    querySelectorAll: () => [], elements: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }])),
  };
}

test('an invitation offers anonymous visitors explicit sign-in and sign-up choices without accepting it', () => {
  const html = renderAuth('invitation-new', { production: true, verified: false, group: invitedGroup, invitation: invitationPayload({ accountExists: true }) });
  assert.match(html, /data-action="login-invited"[^>]*>Já tenho conta/);
  assert.match(html, /data-action="register-invited"[^>]*>Criar conta/);
  assert(!html.includes('data-action="accept-invite"'));
});

test('an uninvited signed-in account sees its identity and switch-account action even when the recipient already accepted', () => {
  const html = renderAuth('invitation', { production: true, verified: true, user: signedInUser, group: invitedGroup,
    invitation: invitationPayload({ status: 'accepted', currentUserEmail: signedInUser.email }) });
  assert(html.includes('Pessoa Conectada')); assert(html.includes(signedInUser.email));
  assert(html.includes('não recebeu convite para este grupo'));
  assert(html.includes('data-action="switch-account"'));
  assert(!html.includes('data-action="accept-invite"'));
  assert(!html.includes('Sua participação está confirmada.'));
});

test('a different invited account receives explicit confirmation for its own identity', () => {
  const html = renderAuth('invitation', { production: true, verified: true, user: signedInUser, group: invitedGroup,
    invitation: invitationPayload({ currentUserInvited: true, currentUserEmail: signedInUser.email }) });
  assert(html.includes(signedInUser.email)); assert(html.includes('recipient@example.test'));
  assert(html.includes('Quer confirmar sua participação com esta conta?'));
  assert(html.includes('data-action="accept-invite"'));
  assert(html.includes('Sim, quero participar'));
  assert(!html.includes('não recebeu convite para este grupo'));
});

test('dashboard shows pending invitations even with no joined groups and never accepts them automatically', async () => {
  const h = harness({ hash: '#dashboard' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/groups').respond({ groups: [], pendingInvitations: [dashboardInvitation] }); await tick();
  assert(h.app.innerHTML.includes('Convites para você')); assert(h.app.innerHTML.includes('Pessoa Organizadora'));
  assert(h.app.innerHTML.includes(signedInUser.email)); assert(h.app.innerHTML.includes('Aceitar convite para Grupo de teste'));
  assert(h.app.innerHTML.includes('Seu próximo encontro está aqui.'));
  assert.equal(h.state.pendingInvitations.length, 1); assert.equal(h.state.groups.length, 0);
  assert.equal(h.requests.filter(request => request.path.endsWith('/accept')).length, 0);
  assert.equal(h.state.inviteToken, ''); assert.equal(h.storage.size, 0);
});

test('explicit dashboard acceptance uses only the selected group and current session, refreshes the list and opens the joined group', async () => {
  const h = harness({ hash: '#dashboard' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/groups').respond({ groups: [], pendingInvitations: [dashboardInvitation] }); await tick();
  await h.action('accept-dashboard-invite', { dataset: { groupId: 'not-in-the-list' } });
  assert.equal(h.requests.filter(request => request.path.endsWith('/accept')).length, 0);
  const accepting = h.action('accept-dashboard-invite', { dataset: { groupId: invitedGroup.id } });
  await h.action('accept-dashboard-invite', { dataset: { groupId: invitedGroup.id } });
  const mutations = h.requests.filter(request => request.path.endsWith('/accept')); assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, '/api/groups/group-1/accept'); assert.deepEqual(mutations[0].body, {});
  assert(h.app.innerHTML.includes('Aceitando convite…')); assert.equal(h.state.acceptingInvitationId, invitedGroup.id);
  mutations[0].respond({ group: invitedGroup }); await tick();
  const refresh = h.requests.filter(request => request.path === '/api/groups').at(-1);
  assert.notEqual(refresh, h.requests[1]); refresh.respond({ groups: [invitedGroup], pendingInvitations: [] }); await tick();
  const detail = h.requests.find(request => request.path === '/api/groups/group-1'); assert(detail);
  detail.respond({ group: { ...invitedGroup, role: 'member' }, role: 'member', participants: [{ ...signedInUser, name: 'Pessoa Conectada', status: 'accepted' }], match: null }); await accepting;
  assert.equal(h.location.hash, '#group?id=group-1'); assert.equal(h.state.pendingInvitations.length, 0); assert.equal(h.state.acceptingInvitationId, '');
  assert(h.state.groups.some(group => group.id === invitedGroup.id)); assert.equal(h.storage.size, 0);
  assert.equal(h.requests.filter(request => request.path.startsWith('/api/invitations')).length, 0, 'No email token is consulted');
});

test('dashboard refreshes an invitation that expired before acceptance instead of retaining a broken action', async () => {
  const h = harness({ hash: '#dashboard' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/groups').respond({ groups: [], pendingInvitations: [dashboardInvitation] }); await tick();
  const accepting = h.action('accept-dashboard-invite', { dataset: { groupId: invitedGroup.id } });
  h.requests.find(request => request.path.endsWith('/accept')).respond({ error: { code: 'INVITATION_EXPIRED', message: 'Convite expirado.' } }, 410); await tick();
  h.requests.filter(request => request.path === '/api/groups').at(-1).respond({ groups: [], pendingInvitations: [] }); await accepting;
  assert.equal(h.location.hash, '#dashboard'); assert.equal(h.state.pendingInvitations.length, 0); assert.equal(h.state.acceptingInvitationId, '');
  assert(!h.app.innerHTML.includes('data-action="accept-dashboard-invite"'));
});

test('logout clears pending invitations and a late acceptance cannot restore another account’s dashboard', async () => {
  const h = harness({ hash: '#dashboard' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/groups').respond({ groups: [], pendingInvitations: [dashboardInvitation] }); await tick();
  const accepting = h.action('accept-dashboard-invite', { dataset: { groupId: invitedGroup.id } });
  const mutation = h.requests.find(request => request.path.endsWith('/accept'));
  const leaving = h.action('logout', {}); h.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await leaving;
  mutation.respond({ group: invitedGroup }); await accepting;
  assert.equal(h.state.user, null); assert.equal(h.state.pendingInvitations.length, 0); assert.equal(h.state.acceptingInvitationId, '');
  assert(!h.app.innerHTML.includes(invitedGroup.name));
  assert.equal(h.requests.filter(request => request.path === '/api/groups').length, 1, 'A late response must not start authenticated refreshes after logout');
});

test('switching accounts keeps the invitation and returns to anonymous choices rather than accepting the recipient membership', async () => {
  const h = harness({ hash: `#invitation?token=${inviteToken}` });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === `/api/invitations/${inviteToken}`).respond(invitationPayload({ status: 'accepted', currentUserEmail: signedInUser.email }));
  await tick();
  assert(h.location.hash.startsWith('#invitation?'));
  assert(h.app.innerHTML.includes('não recebeu convite para este grupo'));
  const switching = h.action('switch-account', {});
  const logout = h.requests.find(request => request.path === '/api/auth/logout'); assert(logout); logout.respond({ ok: true });
  await tick();
  h.requests.filter(request => request.path === `/api/invitations/${inviteToken}`).at(-1).respond(invitationPayload({ status: 'accepted' }));
  await switching;
  assert.equal(h.state.user, null);
  assert.equal(h.state.inviteToken, inviteToken);
  assert.equal(h.storage.get('amigo-secreto:invitation'), inviteToken);
  assert(h.app.innerHTML.includes('Já tenho conta')); assert(h.app.innerHTML.includes('Criar conta'));
  assert.equal(h.requests.filter(request => request.path.endsWith('/accept')).length, 0);
});

test('an emailed recovery link restores its invitation and submits the code only to the password recovery endpoint', async () => {
  const challengeId = '123e4567-e89b-42d3-a456-426614174000';
  const hash = `#verify?purpose=recover&challengeId=${challengeId}&email=recipient%40example.test&invitation=${inviteToken}`;
  const h = harness({ hash });
  h.requests[0].respond({ user: null }); await tick();
  assert.equal(h.state.authMode, 'recover'); assert.equal(h.state.challenge.challengeId, challengeId);
  assert.equal(h.state.inviteToken, inviteToken);
  assert.equal(h.storage.get('amigo-secreto:invitation'), inviteToken);
  const saved = JSON.parse(h.storage.get('amigo-secreto:challenge'));
  assert.equal(saved.purpose, 'recover'); assert.equal(saved.email, 'recipient@example.test');
  const submitting = h.submit({ preventDefault() {}, currentTarget: fixtureForm('verify', { code: '001234' }) });
  const proof = h.requests.find(request => request.path === '/api/auth/password/verify'); assert(proof);
  assert.equal(proof.body.challengeId, challengeId); assert.equal(proof.body.code, '001234');
  assert.equal(h.verifyRequests().length, 0, 'Recovery proof must never use account-verification or magic-login routes');
  const resetToken = 'r'.repeat(43); proof.respond({ resetToken, email: 'recipient@example.test' });
  await submitting;
  assert.equal(h.state.user, null); assert.equal(h.location.hash, '#reset-password'); assert.equal(h.state.resetToken, resetToken);
  assert.equal(h.storage.has('amigo-secreto:challenge'), false);
  assert(![...h.storage.values()].some(value => value.includes(resetToken)), 'A password reset grant stays only in memory');
  assert.equal(h.storage.get('amigo-secreto:invitation'), inviteToken);
});

test('reloading after recovery preserves the invitation but requires a new code when the in-memory reset grant is gone', async () => {
  const stored = new Map([['amigo-secreto:invitation', inviteToken]]);
  const h = harness({ hash: '#reset-password', stored });
  h.requests[0].respond({ user: null }); await tick();
  h.requests.find(request => request.path === `/api/invitations/${inviteToken}`).respond(invitationPayload());
  await tick();
  assert.equal(h.location.hash, '#recover-password'); assert.equal(h.state.resetToken, '');
  assert.equal(h.state.inviteToken, inviteToken); assert.equal(h.state.authEmail, 'recipient@example.test');
  assert(h.app.innerHTML.includes('Seu convite para')); assert(h.app.innerHTML.includes('Grupo de teste'));
  assert.equal(h.requests.filter(request => request.path.endsWith('/accept')).length, 0);
});

const administrator = { ...signedInUser, id: 'admin-1', email: 'fabiosanida@gmail.com', isAdmin: true };
const emptyAdminSummary = { summary: { groups: 0, drawnGroups: 0, users: 0, participants: 0, pendingInvitations: 0 } };
const emptyAdminList = { groups: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } };

test('private routes never request admin data or expose navigation for a regular account', async () => {
  for (const route of ['admin', 'admin-group?id=private-group', 'admin-user?id=private-user', 'admin-marmelada', 'admin-marmelada?id=private-group']) {
    const h = harness({ hash: `#${route}` });
    h.requests[0].respond({ user: signedInUser }); await tick();
    assert.equal(h.requests.filter(request => request.path.startsWith('/api/admin')).length, 0);
    h.requests.find(request => request.path === '/api/groups').respond({ groups: [] }); await tick();
    assert(h.location.hash.startsWith('#dashboard'));
    assert(!h.app.innerHTML.includes('data-route="admin"'));
    assert.equal(renderAdmin('admin-group', { user: signedInUser, adminData: { group: { name: 'PRIVATE' } } }), '');
  }
});

test('anonymous private navigation goes to login without loading private data', async () => {
  const h = harness({ hash: '#admin-group?id=private-group' });
  h.requests[0].respond({ user: null }); await tick();
  assert(h.location.hash.startsWith('#login'));
  assert.equal(h.requests.length, 1);
  assert.equal(h.state.adminData, null);
});

test('admin pagination fetches only the selected page and logout clears private data without storage', async () => {
  const h = harness({ hash: '#admin?tab=groups&page=2&search=Family' });
  h.requests[0].respond({ user: administrator }); await tick();
  h.requests.find(request => request.path === '/api/admin/overview').respond(emptyAdminSummary);
  const list = h.requests.find(request => request.path.startsWith('/api/admin/groups?'));
  assert(list.path.includes('page=2')); assert(list.path.includes('limit=25')); assert(list.path.includes('search=Family'));
  list.respond({ ...emptyAdminList, groups: [{ id: 'secret-group', name: 'Private gathering', date: '2026-12-24', organizer: administrator, acceptedCount: 3, participantCount: 3 }] }); await tick();
  assert(h.app.innerHTML.includes('Private gathering')); assert(h.app.innerHTML.includes('data-route="admin"'));
  assert.equal(h.storage.size, 0, 'Private dashboard data stays only in memory');
  const leaving = h.action('logout', {});
  h.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await leaving;
  assert.equal(h.state.adminData, null); assert.equal(h.state.adminOverview, null); assert.equal(h.state.user, null);
  assert(!h.app.innerHTML.includes('Private gathering'));
});

test('a late private response cannot repopulate state after logout', async () => {
  const h = harness({ hash: '#admin-group?id=secret-group' });
  h.requests[0].respond({ user: administrator }); await tick();
  const detail = h.requests.find(request => request.path === '/api/admin/groups/secret-group'); assert(detail);
  const leaving = h.action('logout', {});
  h.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await leaving;
  detail.respond({ group: { name: 'Private gathering' }, participants: [], results: [] }); await tick();
  assert.equal(h.state.adminData, null); assert.equal(h.state.user, null);
  assert(!h.app.innerHTML.includes('Private gathering'));
});

function deletionDialogFixture() {
  const listeners = {}, attributes = new Map(), button = { disabled: true, textContent: '' };
  const input = { value: '', disabled: false, addEventListener: (event, listener) => { listeners[event] = listener; } };
  const form = { elements: { confirmation: input }, isConnected: true, reportValidity: () => true,
    getAttribute: key => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value),
    querySelector: selector => selector === 'button[type="submit"]' ? button : null, querySelectorAll: () => [button, input],
    addEventListener: (event, listener) => { listeners[event] = listener; },
  };
  const dialog = { innerHTML: '', open: false, showModal() { this.open = true; }, close() { this.open = false; }, replaceChildren() { form.isConnected = false; },
    querySelector: selector => selector === 'form' ? form : selector === '[aria-busy="true"]' && attributes.get('aria-busy') === 'true' ? form : null,
  };
  return { dialog, form, button, input, listeners };
}

test('only organizers see deletion, opening and cancelling sends no deletion request', async () => {
  const member = renderGroups('group', { production: true, user: signedInUser, role: 'member', group: invitedGroup, participants: [] });
  assert(!member.includes('data-action="delete-group"'));
  const owner = renderGroups('group', { production: true, user: signedInUser, role: 'organizer', group: invitedGroup, participants: [] });
  assert(owner.includes('data-action="delete-group"'));
  const fixture = deletionDialogFixture(), h = harness({ selectors: { '#delete-group-dialog': fixture.dialog } });
  h.requests[0].respond({ user: null }); await tick();
  h.state.user = signedInUser; h.state.group = invitedGroup; h.state.role = 'organizer';
  await h.action('delete-group', {}); assert(fixture.dialog.open); assert(fixture.button.disabled);
  await h.action('close-dialog', { closest: () => fixture.dialog }); assert(!fixture.dialog.open);
  assert.equal(h.requests.filter(request => request.path.endsWith('/delete')).length, 0);
  assert.equal(h.state.group.id, invitedGroup.id);
});

test('deletion requires the exact group name, posts once and clears stale results before returning to groups', async () => {
  const fixture = deletionDialogFixture(), h = harness({ selectors: { '#delete-group-dialog': fixture.dialog } });
  h.requests[0].respond({ user: null }); await tick();
  h.state.user = administrator; h.state.group = invitedGroup; h.state.role = 'organizer'; h.state.match = { name: 'Private match' };
  h.state.adminData = { results: ['Private result'] }; h.state.adminOverview = emptyAdminSummary;
  await h.action('delete-group', {});
  fixture.input.value = 'wrong name'; fixture.listeners.input(); assert(fixture.button.disabled);
  await fixture.listeners.submit({ preventDefault() {} });
  assert.equal(h.requests.filter(request => request.path.endsWith('/delete')).length, 0);
  fixture.input.value = invitedGroup.name; fixture.listeners.input(); assert(!fixture.button.disabled);
  const deleting = fixture.listeners.submit({ preventDefault() {} });
  await fixture.listeners.submit({ preventDefault() {} });
  const requests = h.requests.filter(request => request.path.endsWith('/delete')); assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/groups/group-1/delete'); assert.equal(requests[0].body.confirmation, invitedGroup.name);
  requests[0].respond({ ok: true, deletedId: invitedGroup.id }); await tick();
  assert.equal(h.state.group, null); assert.equal(h.state.match, null); assert.equal(h.state.adminData, null); assert.equal(h.state.adminOverview, null);
  h.requests.find(request => request.path === '/api/groups').respond({ groups: [] }); await deleting;
  assert.equal(h.location.hash, '#dashboard'); assert(!fixture.dialog.open);
});

test('Marmelada loads only the selected draw and presents the server verdict without storing results', async () => {
  const h = harness({ hash: '#admin-marmelada?id=drawn-group' });
  h.requests[0].respond({ user: administrator }); await tick();
  const selection = h.requests.find(request => request.path === '/api/admin/marmelada/groups/drawn-group'); assert(selection);
  assert.equal(h.requests.length, 2, 'Opening the game does not fetch the admin overview or other draws');
  selection.respond({ group: { id: 'drawn-group', name: 'Private event' }, participants: [{ id: 'giver', name: 'Ana' }, { id: 'receiver', name: 'Bruno' }] }); await tick();
  assert(h.app.innerHTML.includes('Quem vai revelar?')); assert(h.app.innerHTML.includes('Private event'));
  assert.equal(h.presentations.length, 0);
  const checking = h.submit({ preventDefault() {}, currentTarget: fixtureForm('marmelada-check', { giverId: 'giver', receiverId: 'receiver' }) });
  const request = h.requests.find(request => request.path === '/api/admin/marmelada/check'); assert(request);
  assert.deepEqual(request.body, { groupId: 'drawn-group', giverId: 'giver', receiverId: 'receiver' });
  request.respond({ matches: false, giver: { id: 'giver', name: 'Ana' }, receiver: { id: 'receiver', name: 'Bruno' }, group: { id: 'drawn-group', name: 'Private event' } });
  await checking;
  assert.equal(h.presentations.length, 1); assert.equal(h.presentations[0].matches, false);
  assert.equal(h.storage.size, 0); assert.equal(h.state.marmeladaData.results, undefined);
  assert.equal(h.requests.filter(request => request.path.endsWith('/draw')).length, 0, 'Checking a declaration cannot trigger another draw');
});

test('Marmelada ignores an answer received after logout and clears its private state', async () => {
  const h = harness({ hash: '#admin-marmelada?id=drawn-group' });
  h.requests[0].respond({ user: administrator }); await tick();
  h.requests.find(request => request.path === '/api/admin/marmelada/groups/drawn-group').respond({ group: { id: 'drawn-group', name: 'Private event' }, participants: [] }); await tick();
  const checking = h.submit({ preventDefault() {}, currentTarget: fixtureForm('marmelada-check', { giverId: 'giver', receiverId: 'receiver' }) });
  const answer = h.requests.find(request => request.path === '/api/admin/marmelada/check');
  const leaving = h.action('logout', {}); h.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await leaving;
  answer.respond({ matches: true, group: { name: 'Private event' }, giver: { name: 'Ana' }, receiver: { name: 'Bruno' } }); await checking;
  assert.equal(h.presentations.length, 0); assert.equal(h.state.marmeladaData, null); assert.equal(h.state.user, null);
  assert(!h.app.innerHTML.includes('Private event'));
});

test('administrative deletion previews the impact before asking for confirmation and cancellation sends no mutation', async () => {
  const fixture = deletionDialogFixture(), h = harness({ selectors: { '#admin-delete-dialog': fixture.dialog } });
  h.requests[0].respond({ user: null }); await tick();
  h.state.user = signedInUser; h.state.adminData = { group: invitedGroup };
  await h.action('admin-delete-group', {}); assert.equal(h.requests.length, 1, 'A regular account cannot request deletion previews');
  h.state.user = administrator;
  const opening = h.action('admin-delete-group', {});
  const preview = h.requests.find(request => request.path === `/api/admin/groups/${invitedGroup.id}/delete-preview`); assert(preview);
  assert.equal(fixture.dialog.open, false, 'Confirmation waits for concrete server effects');
  preview.respond({ group: invitedGroup, canDelete: true, effects: { groupsDeleted: 1, membershipsDeleted: 6, resultsDeleted: 6, notificationsDeleted: 4 } }); await opening;
  assert(fixture.dialog.open); assert(fixture.button.disabled); assert(fixture.dialog.innerHTML.includes('Pares do sorteio que serão apagados'));
  await h.action('close-dialog', { closest: () => fixture.dialog }); assert.equal(fixture.dialog.open, false);
  assert.equal(h.requests.filter(request => request.path.endsWith('/delete')).length, 0);
});

test('administrative user deletion requires the exact email, submits once and clears all private caches', async () => {
  const fixture = deletionDialogFixture(), h = harness({ selectors: { '#admin-delete-dialog': fixture.dialog } });
  h.requests[0].respond({ user: null }); await tick();
  const target = { id: 'delete-user', name: 'Another person', email: 'another@example.test' };
  h.state.user = administrator; h.state.adminData = { user: target }; h.state.marmeladaData = { group: { name: 'Private draw' } }; h.state.match = { name: 'Secret match' };
  const opening = h.action('admin-delete-user', {});
  h.requests.find(request => request.path === '/api/admin/users/delete-user/delete-preview').respond({ user: target, canDelete: true, effects: { groupsDeleted: 2, membershipsRemoved: 3, drawnParticipationsAnonymized: 1, notificationsDeleted: 5 } }); await opening;
  assert(fixture.dialog.innerHTML.includes('participação ficará anônima'));
  fixture.input.value = target.email + ' '; fixture.listeners.input(); assert(fixture.button.disabled);
  await fixture.listeners.submit({ preventDefault() {} }); assert.equal(h.requests.filter(request => request.path.endsWith('/delete')).length, 0);
  fixture.input.value = target.email; fixture.listeners.input(); assert(!fixture.button.disabled);
  const deleting = fixture.listeners.submit({ preventDefault() {} });
  await fixture.listeners.submit({ preventDefault() {} });
  const mutations = h.requests.filter(request => request.path.endsWith('/delete')); assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, '/api/admin/users/delete-user/delete'); assert.equal(mutations[0].body.confirmation, target.email);
  mutations[0].respond({ ok: true, deletedId: target.id }); await tick();
  assert.equal(h.state.adminData, null); assert.equal(h.state.marmeladaData, null); assert.equal(h.state.match, null);
  h.requests.find(request => request.path === '/api/admin/overview').respond(emptyAdminSummary);
  h.requests.find(request => request.path.startsWith('/api/admin/users?')).respond({ users: [], pagination: emptyAdminList.pagination }); await deleting;
  assert.equal(h.location.hash, '#admin?tab=users'); assert.equal(fixture.dialog.open, false);
});
