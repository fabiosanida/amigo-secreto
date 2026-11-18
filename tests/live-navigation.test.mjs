import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { renderAuth, AUTH_ROUTES } from '../prototype/auth.js';
import { renderGroups, GROUP_ROUTES } from '../prototype/groups.js';
import { renderDependents, DEPENDENT_ROUTES } from '../prototype/dependents.js';
import { WISHLIST_ROUTES, renderWishlists, renderRecipientWishlist, wishlistDirty, validateWishlistItem, emptyWishlistItem } from '../prototype/wishlist.js';
import { renderAdmin, renderAdminDeletePreview, ADMIN_ROUTES } from '../prototype/admin.js';
import { icon, brand, avatar, escapeHtml, setAvatarDirectory } from '../prototype/ui.js';

const source = readFileSync(new URL('../prototype/live.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ hash = '#welcome', stored = new Map(), selectors = {} } = {}) {
  const requests = [], presentations = [], discards = [], listeners = {}, app = { innerHTML: '' }, location = { hash };
  const storage = new Map(stored);
  const noop = () => {};
  const context = {
    URLSearchParams, TextEncoder, Date, Error, Map, Set, Promise, Number, String, Boolean, JSON, Math, crypto: { randomUUID },
    FormData: class { constructor(form) { this.values = form.values; } get(name) { return this.values[name] ?? null; } },
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, location,
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    history: { pushState(a, b, hash) { location.hash = hash; }, replaceState(a, b, hash) { location.hash = hash; } },
    document: { body: { dataset: {}, style: {} }, querySelector: selector => selector === '#app' ? app : selectors[selector] || null, querySelectorAll: () => [], addEventListener: noop },
    window: { scrollTo: noop, addEventListener(type, listener) { listeners[type] = listener; } },
    renderAuth, AUTH_ROUTES, renderGroups, GROUP_ROUTES, renderDependents, DEPENDENT_ROUTES, WISHLIST_ROUTES, renderWishlists, renderRecipientWishlist, wishlistDirty, validateWishlistItem, emptyWishlistItem, renderAdmin, renderAdminDeletePreview, ADMIN_ROUTES, icon, brand, avatar, escapeHtml, setAvatarDirectory,
    showMarmeladaResult: result => { presentations.push(result); },
    setupWishlistFields: noop, showWishlistDiscard: callback => discards.push(callback),
    setupInviteFields: noop, setInviteFieldsBusy: noop, setupGroupFields: noop, parseBudget: Number, setupOTP: noop,
    openProfileEditor: noop, setupPhotoInputs: noop, getSignupAvatar: () => null, resetSignupAvatar: noop,
    fetch(path, options) {
      return new Promise((resolve, reject) => requests.push({ path, reject, body: options.body ? JSON.parse(options.body) : null,
        respond(payload, status = 200) { resolve({ ok: status < 400, status, headers: new Headers(), json: async () => payload }); } }));
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.navigationTest = { navigate, state, action, submit };`, context);
  return { requests, presentations, discards, location, app, storage, ...context.navigationTest,
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

function groupDateDialogFixture() {
  const listeners = {}, attributes = new Map(), input = { value: invitedGroup.date, disabled: false };
  const button = { disabled: false, textContent: '', innerHTML: '' }, error = { textContent: '', scrollIntoView() {} };
  const form = { elements: { date: input }, reportValidity: () => true,
    getAttribute: key => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value),
    querySelector: selector => selector === 'button[type="submit"]' ? button : selector === '.form-error' ? error : null,
    querySelectorAll: () => [button, input], addEventListener: (event, listener) => { listeners[event] = listener; },
  };
  const calendar = { open: false, close() { this.open = false; } };
  const dialog = { innerHTML: '', open: false, showModal() { this.open = true; }, close() { this.open = false; },
    querySelector: selector => selector === 'form' ? form : selector === '[data-calendar-dialog]' ? calendar : selector === '[aria-busy="true"]' && attributes.get('aria-busy') === 'true' ? form : null,
  };
  return { dialog, form, button, input, error, calendar, listeners };
}

function rosterDialogFixture() {
  const listeners = {}, attributes = new Map(), button = { disabled: false, textContent: '', innerHTML: '' };
  const firstName = { value: '  Nova  ', disabled: false }, lastName = { value: '  Pessoa  ', disabled: false };
  const error = { textContent: '', scrollIntoView() {} };
  const form = { elements: { firstName, lastName }, reportValidity: () => true,
    getAttribute: key => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value),
    querySelector: selector => selector === 'button[type="submit"]' ? button : selector === '.form-error' ? error : null,
    querySelectorAll: selector => selector === 'button' ? [button] : selector === 'input' ? [firstName, lastName] : [button, firstName, lastName],
    addEventListener: (event, listener) => { listeners[event] = listener; },
  };
  let html = '';
  const dialog = { get innerHTML() { return html; }, set innerHTML(value) { html = value; if (value) { attributes.clear(); button.disabled = false; } },
    open: false, showModal() { this.open = true; }, close() { this.open = false; },
    querySelector: selector => selector === 'form' ? form : selector === '[aria-busy="true"]' && attributes.get('aria-busy') === 'true' ? form : null,
  };
  return { dialog, form, button, firstName, lastName, error, listeners };
}

async function rosterHarness({ drawn = false, creator = true } = {}) {
  const removal = rosterDialogFixture(), creation = rosterDialogFixture();
  const h = harness({ hash: '#group?id=group-1', selectors: { '#remove-participant-dialog': removal.dialog, '#add-group-dependent-dialog': creation.dialog } });
  h.requests[0].respond({ user: signedInUser }); await tick();
  const group = { ...invitedGroup, drawn, organizerId: creator ? signedInUser.id : 'another-owner' };
  const participants = [
    { id: 'owner-member', userId: signedInUser.id, email: signedInUser.email, name: 'Pessoa Conectada', status: 'accepted', isOrganizer: creator },
    { id: 'guardian-member', userId: 'guardian-user', name: 'Outra Pessoa', email: 'guardian@example.test', status: 'accepted' },
    { id: 'guardian-child-member', dependentId: 'guardian-child', guardianId: 'guardian-user', isDependent: true, name: 'Filho de Outra Pessoa', responsibleName: 'Outra Pessoa', status: 'accepted' },
    { id: 'own-child-member', dependentId: 'own-child', guardianId: signedInUser.id, isDependent: true, name: 'Meu Dependente', responsibleName: 'Pessoa Conectada', status: 'accepted' },
  ];
  const ownDependents = [{ id: 'own-child', firstName: 'Meu', lastName: 'Dependente', name: 'Meu Dependente', active: true, membershipId: 'own-child-member' }];
  const payload = { group, role: creator ? 'organizer' : 'member', participants, ownDependents };
  h.requests.find(request => request.path === '/api/groups/group-1').respond(payload); await tick();
  return { ...h, removal, creation, group, payload };
}

test('roster management is creator-only before draw and opening or cancelling a confirmation never changes membership', async () => {
  for (const options of [{ creator: false }, { drawn: true }]) {
    const h = await rosterHarness(options); h.state.role = 'organizer';
    await h.action('remove-participant', { dataset: { participantId: 'guardian-member' } });
    await h.action('add-group-dependent', {});
    assert(!h.removal.dialog.open); assert(!h.creation.dialog.open);
    assert(!h.app.innerHTML.includes('data-action="remove-participant"')); assert(!h.app.innerHTML.includes('data-action="add-group-dependent"'));
  }
  const h = await rosterHarness(), before = h.requests.length;
  await h.action('remove-participant', { dataset: { participantId: 'owner-member' } }); assert(!h.removal.dialog.open);
  await h.action('remove-participant', { dataset: { participantId: 'guardian-member' } });
  assert(h.removal.dialog.open); assert(h.removal.dialog.innerHTML.includes('Filho de Outra Pessoa')); assert(!h.removal.dialog.innerHTML.includes('Meu Dependente'));
  await h.action('close-dialog', { closest: () => h.removal.dialog });
  await h.action('add-group-dependent', {}); assert(h.creation.dialog.open);
  assert(!h.creation.dialog.innerHTML.includes('name="email"')); assert(!h.creation.dialog.innerHTML.includes('name="password"'));
  await h.action('close-dialog', { closest: () => h.creation.dialog });
  assert.equal(h.requests.length, before); assert.equal(h.state.participants.length, 4);
});

test('confirmed guardian removal submits all affected slots once and updates roster counts without another read', async () => {
  const h = await rosterHarness(); h.state.groups = [h.group];
  await h.action('remove-participant', { dataset: { participantId: 'guardian-member' } });
  const removing = h.removal.listeners.submit({ preventDefault() {} });
  await h.removal.listeners.submit({ preventDefault() {} });
  const writes = h.requests.filter(request => request.body); assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/groups/group-1/participants/guardian-member/remove');
  assert.deepEqual(writes[0].body, { confirm: true, participantIds: ['guardian-member', 'guardian-child-member'] });
  assert.equal(h.state.participants.length, 4); assert(h.removal.button.disabled);
  await h.action('close-dialog', { closest: () => h.removal.dialog }); assert(h.removal.dialog.open);
  writes[0].respond({ removedIds: ['guardian-child-member', 'guardian-member'] }); await removing;
  assert.equal(h.state.participants.length, 2); assert.equal(h.state.group.acceptedCount, 2); assert.equal(h.state.groups[0].participantCount, 2);
  assert.equal(h.state.ownDependents[0].active, true); assert(!h.removal.dialog.open); assert.equal(h.requests.length, 3);
  await h.action('toggle-dependent', { dataset: { dependentId: 'own-child' } });
  assert(h.removal.dialog.open, 'Creator withdrawal of own dependent also requires confirmation');
  const withdrawing = h.removal.listeners.submit({ preventDefault() {} });
  h.requests.at(-1).respond({ removedIds: ['own-child-member'] }); await withdrawing;
  assert.equal(h.state.ownDependents[0].active, false); assert.equal(h.state.ownDependents[0].membershipId, null);
  assert.equal(h.state.participants.length, 1);
});

test('a changed removal preview reloads participants and requires a fresh confirmation', async () => {
  const h = await rosterHarness();
  await h.action('remove-participant', { dataset: { participantId: 'guardian-member' } });
  const removing = h.removal.listeners.submit({ preventDefault() {} });
  h.requests.at(-1).respond({ error: { code: 'PARTICIPANTS_CHANGED', message: 'A lista mudou.' } }, 409); await tick();
  assert(!h.removal.dialog.open); assert.equal(h.removal.dialog.innerHTML, '');
  const refreshed = { ...h.payload, participants: [...h.payload.participants, { id: 'new-child-member', dependentId: 'new-child', guardianId: 'guardian-user', isDependent: true, name: 'Novo Dependente', status: 'accepted' }] };
  h.requests.at(-1).respond(refreshed); await removing;
  assert.equal(h.requests.filter(request => request.body).length, 1); assert.equal(h.state.participants.length, 5);
  await h.action('remove-participant', { dataset: { participantId: 'guardian-member' } });
  assert(h.removal.dialog.innerHTML.includes('Novo Dependente'));
});

test('dependent creation retries an uncertain result with the same identity and includes the confirmed child once', async () => {
  const h = await rosterHarness(); h.state.groups = [h.group];
  await h.action('add-group-dependent', {});
  const creating = h.creation.listeners.submit({ preventDefault() {} });
  await h.creation.listeners.submit({ preventDefault() {} });
  const first = h.requests.at(-1); assert.equal(first.path, '/api/groups/group-1/dependents');
  assert.equal(first.body.firstName, 'Nova'); assert.equal(first.body.lastName, 'Pessoa'); assert.match(first.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(h.requests.filter(request => request.body).length, 1);
  first.reject(new Error('Connection lost')); await creating;
  assert(h.creation.dialog.open); assert(h.creation.firstName.disabled); assert(h.creation.lastName.disabled); assert(!h.creation.button.disabled);
  assert(h.creation.button.innerHTML.includes('Conferir inclusão')); assert.equal(h.state.participants.length, 4);
  const retry = h.creation.listeners.submit({ preventDefault() {} });
  const second = h.requests.at(-1); assert.deepEqual(second.body, first.body);
  const dependent = { ...first.body, name: 'Nova Pessoa', active: true, membershipId: 'new-child-member' };
  second.respond({ dependent, active: true }); await retry;
  assert(!h.creation.dialog.open); assert.equal(h.state.participants.length, 5); assert.equal(h.state.group.acceptedCount, 5);
  assert.equal(h.state.ownDependents.filter(item => item.id === dependent.id).length, 1);
  assert.equal(h.state.dependents.filter(item => item.id === dependent.id).length, 1);
  assert.equal(h.state.participants.find(item => item.id === 'new-child-member').guardianId, signedInUser.id);
  assert.equal(h.requests.length, 4, 'No group reload or email request follows successful creation');
});

test('late roster mutation responses cannot restore group or dependent data after logout', async () => {
  for (const kind of ['removal', 'creation']) {
    const h = await rosterHarness();
    await h.action(kind === 'removal' ? 'remove-participant' : 'add-group-dependent', { dataset: { participantId: 'guardian-member' } });
    const fixture = h[kind], saving = fixture.listeners.submit({ preventDefault() {} }), write = h.requests.at(-1);
    const leaving = h.action('logout', {}); h.requests.at(-1).respond({ ok: true }); await leaving;
    write.respond(kind === 'removal' ? { removedIds: ['guardian-member', 'guardian-child-member'] } : { dependent: { ...write.body, active: true, membershipId: 'late-child' } }); await saving;
    assert.equal(h.state.user, null); assert.equal(h.state.group, null); assert.equal(h.state.participants.length, 0);
    assert.equal(h.state.ownDependents.length, 0); assert.equal(h.state.dependents.length, 0); assert.equal(fixture.dialog.innerHTML, '');
  }
});

test('dependent pagination preserves the registration draft, deduplicates rows and uses the current group cursor', async () => {
  const selectors = {}, h = harness({ hash: '#dependents', selectors });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.at(-1).respond({ dependents: [childOne], nextCursor: 'catalog-cursor' }); await tick();
  selectors['[data-form="create-dependent"]'] = fixtureForm('create-dependent', { firstName: 'Rascunho', lastName: 'Preservado' });
  let markup = h.app.innerHTML;
  Object.defineProperty(h.app, 'innerHTML', { get: () => markup, set(value) { markup = value; selectors['[data-form="create-dependent"]'] = fixtureForm('create-dependent', { firstName: '', lastName: '' }); } });
  const loading = h.action('dependents-more', {}); await h.action('dependents-more', {});
  assert.equal(h.requests.length, 3); assert.equal(h.requests.at(-1).path, '/api/dependents?cursor=catalog-cursor');
  h.requests.at(-1).respond({ dependents: [childOne, childTwo], nextCursor: null }); await loading;
  assert.deepEqual(Array.from(h.state.dependents, item => item.id), [childOne.id, childTwo.id]);
  assert.equal(selectors['[data-form="create-dependent"]'].elements.firstName.value, 'Rascunho');
  assert.equal(selectors['[data-form="create-dependent"]'].elements.lastName.value, 'Preservado');
  assert.equal(h.state.dependentsNextCursor, null);

  const roster = await rosterHarness(); roster.state.ownDependentsNextCursor = 'group-cursor';
  const more = roster.action('group-dependents-more', {});
  const request = roster.requests.at(-1); assert.equal(request.path, '/api/dependents?cursor=group-cursor&groupId=group-1');
  const duplicate = { ...roster.state.ownDependents[0] };
  request.respond({ dependents: [duplicate, childTwo], nextCursor: null }); await more;
  assert.equal(roster.state.ownDependents.length, 2); assert.equal(roster.state.ownDependents[0].active, true);
  assert.equal(roster.state.ownDependentsNextCursor, null);
});

test('a dependent page arriving after logout cannot repopulate the catalog', async () => {
  const h = await rosterHarness(); h.state.ownDependentsNextCursor = 'group-cursor';
  const loading = h.action('group-dependents-more', {}), pending = h.requests.at(-1);
  const leaving = h.action('logout', {}); h.requests.at(-1).respond({ ok: true }); await leaving;
  pending.respond({ dependents: [childTwo], nextCursor: 'more-private-data' }); await loading;
  assert.equal(h.state.ownDependents.length, 0); assert.equal(h.state.ownDependentsNextCursor, null);
  assert.equal(h.state.groupDependentsLoadingMore, false); assert(!h.app.innerHTML.includes(childTwo.name));
});

test('an older dependent page cannot reactivate a child removed while that page was loading', async () => {
  const h = await rosterHarness();
  const unseen = { id: 'page-two-child', firstName: 'Página', lastName: 'Dois', name: 'Página Dois', active: true, membershipId: 'page-two-member' };
  h.state.participants.push({ id: unseen.membershipId, dependentId: unseen.id, guardianId: signedInUser.id,
    name: unseen.name, isDependent: true, status: 'accepted', responsibleName: 'Pessoa Conectada' });
  h.state.ownDependentsNextCursor = 'group-cursor';
  const loading = h.action('group-dependents-more', {}), page = h.requests.at(-1);
  await h.action('remove-participant', { dataset: { participantId: unseen.membershipId } });
  const removing = h.removal.listeners.submit({ preventDefault() {} });
  h.requests.at(-1).respond({ removedIds: [unseen.membershipId] }); await removing;
  assert(!h.state.participants.some(person => person.id === unseen.membershipId));
  page.respond({ dependents: [unseen], nextCursor: null }); await loading;
  const catalogEntry = h.state.ownDependents.find(person => person.id === unseen.id);
  assert(catalogEntry); assert.equal(catalogEntry.active, false); assert.equal(catalogEntry.membershipId, null);
  assert.equal(h.state.groupDependentsLoadingMore, false); assert.equal(h.state.ownDependentsNextCursor, null);
  assert(h.app.innerHTML.includes('Incluir Página Dois neste grupo'));
});

async function dateEditorHarness({ drawn = false, creator = true } = {}) {
  const fixture = groupDateDialogFixture(), h = harness({ hash: '#group?id=group-1', selectors: { '#group-date-dialog': fixture.dialog } });
  h.requests[0].respond({ user: signedInUser }); await tick();
  const group = { ...invitedGroup, drawn, organizerId: creator ? signedInUser.id : 'other-person', location: 'Local preservado', description: 'Recado preservado' };
  h.requests.find(request => request.path === '/api/groups/group-1').respond({ group, role: creator ? 'organizer' : 'member', participants: [] }); await tick();
  return { ...h, fixture, group };
}

test('the date editor is available only to the actual creator, before and after draw; cancel never saves', async () => {
  const member = await dateEditorHarness({ creator: false });
  assert(!member.app.innerHTML.includes('data-action="edit-group-date"'));
  member.state.role = 'organizer';
  await member.action('edit-group-date', {}); assert(!member.fixture.dialog.open, 'A forged UI role cannot enable the editor');
  for (const drawn of [false, true]) {
    const h = await dateEditorHarness({ drawn }), before = h.requests.length;
    assert(h.app.innerHTML.includes('data-action="edit-group-date"'));
    await h.action('edit-group-date', {}); assert(h.fixture.dialog.open);
    assert(h.fixture.dialog.innerHTML.includes('data-calendar-dialog'));
    assert.equal(h.requests.length, before, 'Opening the editor uses the group already loaded');
    h.fixture.input.value = '2030-12-20';
    await h.action('close-dialog', { closest: () => h.fixture.dialog });
    assert(!h.fixture.dialog.open); assert.equal(h.requests.length, before);
    assert.equal(h.state.group.date, invitedGroup.date);
  }
});

test('saving a date posts once and refreshes group and dashboard dates while preserving revealed results', async () => {
  const h = await dateEditorHarness({ drawn: true }), { fixture } = h;
  h.state.groups = [h.group, { ...h.group, id: 'other-group' }];
  h.state.invitation = { group: h.group };
  h.state.match = { id: 'private-recipient', name: 'Resultado preservado' };
  h.state.dependentResults = [{ dependent: childOne, match: { id: 'child-recipient' } }];
  const results = JSON.stringify({ match: h.state.match, dependentResults: h.state.dependentResults });
  await h.action('edit-group-date', {});
  fixture.input.value = '2030-12-20';
  const saving = fixture.listeners.submit({ preventDefault() {} });
  await fixture.listeners.submit({ preventDefault() {} });
  const writes = h.requests.filter(request => request.body); assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/groups/group-1/date'); assert.deepEqual(writes[0].body, { date: '2030-12-20' });
  assert(fixture.button.disabled); assert(fixture.input.disabled);
  await h.action('close-dialog', { closest: () => fixture.dialog }); assert(fixture.dialog.open, 'Cannot dismiss while saving');
  assert.equal(h.state.group.date, invitedGroup.date, 'Keep the saved date until the server confirms it');
  writes[0].respond({ group: { id: h.group.id, date: '2030-12-20' } }); await saving;
  assert(!fixture.dialog.open); assert.equal(fixture.dialog.innerHTML, '');
  assert.equal(h.state.group.date, '2030-12-20'); assert.equal(h.state.groups[0].date, '2030-12-20');
  assert.equal(h.state.invitation.group.date, '2030-12-20'); assert.equal(h.state.groups[1].date, invitedGroup.date);
  assert.equal(h.state.group.location, h.group.location); assert.equal(h.state.group.budget, h.group.budget);
  assert.equal(JSON.stringify({ match: h.state.match, dependentResults: h.state.dependentResults }), results);
  assert.equal(h.requests.length, 3, 'Saving does not reload the group or results');
});

test('a rejected date remains editable and does not replace the existing schedule', async () => {
  const h = await dateEditorHarness(), { fixture } = h;
  await h.action('edit-group-date', {}); fixture.input.value = '2030-02-30';
  const saving = fixture.listeners.submit({ preventDefault() {} });
  h.requests.find(request => request.path.endsWith('/date')).respond({ error: { code: 'VALIDATION', message: 'Escolha uma data válida.' } }, 400);
  await saving;
  assert(fixture.dialog.open); assert(!fixture.button.disabled); assert(!fixture.input.disabled);
  assert.equal(fixture.error.textContent, 'Escolha uma data válida.'); assert.equal(h.state.group.date, invitedGroup.date);
  fixture.input.value = '2030-12-20';
  const retry = fixture.listeners.submit({ preventDefault() {} });
  h.requests.filter(request => request.path.endsWith('/date')).at(-1).respond({ group: { id: h.group.id, date: '2030-12-20' } }); await retry;
  assert.equal(h.state.group.date, '2030-12-20'); assert(!fixture.dialog.open);
});

test('a date response arriving after logout cannot restore private group state', async () => {
  const h = await dateEditorHarness(), { fixture } = h;
  await h.action('edit-group-date', {}); fixture.input.value = '2030-12-20';
  const saving = fixture.listeners.submit({ preventDefault() {} });
  const logout = h.action('logout', {}); h.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await logout;
  assert(!fixture.dialog.open); assert.equal(fixture.dialog.innerHTML, '');
  h.requests.find(request => request.path.endsWith('/date')).respond({ group: { id: h.group.id, date: '2030-12-20' } }); await saving;
  assert.equal(h.state.user, null); assert.equal(h.state.group, null); assert.equal(h.state.groups.length, 0);
  assert(!h.app.innerHTML.includes(h.group.name)); assert.equal(fixture.dialog.innerHTML, '');
});

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
  assert(fixture.dialog.innerHTML.includes('as participações da conta e dos seus dependentes ficarão anônimas para preservar os pares do sorteio'));
  assert(fixture.dialog.innerHTML.includes('os dependentes cadastrados'));
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

const childOne = { id: 'child-1', firstName: 'Lia', lastName: 'Teste', name: 'Lia Teste', createdAt: '2026-11-12T10:00:00Z' };
const childTwo = { id: 'child-2', firstName: 'Caio', lastName: 'Teste', name: 'Caio Teste', createdAt: '2026-11-12T11:00:00Z' };
const dependentGroupPayload = ({ drawn = false, active = false } = {}) => ({
  group: { ...invitedGroup, drawn, role: 'member', participantCount: active ? 4 : 3, acceptedCount: active ? 4 : 3 },
  role: 'member', participants: [{ ...signedInUser, id: 'own-membership', userId: signedInUser.id, name: 'Pessoa Conectada', status: 'accepted' },
    ...(active ? [{ id: 'child-membership', userId: null, dependentId: childOne.id, guardianId: signedInUser.id, isDependent: true,
      name: childOne.name, email: '', responsibleName: 'Pessoa Conectada', status: 'accepted' }] : [])],
  ownDependents: [{ ...childOne, active, membershipId: active ? 'child-membership' : null }, { ...childTwo, active: false, membershipId: null }], match: null,
});
const familyResults = {
  match: { id: 'adult-recipient', name: 'Destino privado do responsável', email: 'adult-secret@example.test' },
  dependentResults: [{ dependent: childOne, match: { id: 'child-recipient', name: 'Destino privado de Lia', email: 'child-secret@example.test' } }],
};

test('dependent catalog loads only the current account list and creates a name without automatically joining a group', async () => {
  const h = harness({ hash: '#dependents' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].path, '/api/dependents'); assert.equal(h.requests[1].body, null);
  h.requests[1].respond({ dependents: [childOne] }); await tick();
  assert(h.app.innerHTML.includes(childOne.name)); assert(h.app.innerHTML.includes('Cadastrar não inclui a pessoa automaticamente nos grupos'));
  assert(!h.app.innerHTML.includes('name="email"')); assert(!h.app.innerHTML.includes('name="password"'));
  const form = fixtureForm('create-dependent', { firstName: '  Caio  ', lastName: '  Teste  ', guardianId: 'someone-else', active: true });
  const creating = h.submit({ preventDefault() {}, currentTarget: form });
  await h.submit({ preventDefault() {}, currentTarget: form });
  const mutations = h.requests.filter(request => request.body); assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, '/api/dependents'); assert.deepEqual(mutations[0].body, { firstName: 'Caio', lastName: 'Teste' });
  mutations[0].respond({ dependent: childTwo }); await creating;
  assert.equal(h.state.dependents.length, 2); assert(h.app.innerHTML.includes(childTwo.name));
  assert.equal(h.requests.filter(request => request.path.startsWith('/api/groups')).length, 0);
  assert.equal(h.state.ownDependents.length, 0); assert.equal(h.storage.size, 0);
});

test('creating a dependent from a group returns to its roster without activating participation', async () => {
  const h = harness({ hash: '#dependents?group=group-1' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/dependents').respond({ dependents: [] }); await tick();
  assert(h.app.innerHTML.includes('volta ao grupo para escolher se este dependente participa'));
  const creating = h.submit({ preventDefault() {}, currentTarget: fixtureForm('create-dependent', { firstName: 'Lia', lastName: 'Teste' }) });
  h.requests.find(request => request.path === '/api/dependents' && request.body).respond({ dependent: childOne }); await tick();
  const roster = h.requests.find(request => request.path === '/api/groups/group-1'); assert(roster); assert.equal(roster.body, null);
  roster.respond(dependentGroupPayload()); await creating;
  assert.equal(h.location.hash, '#group?id=group-1'); assert.equal(h.state.ownDependents[0].active, false);
  assert(h.app.innerHTML.includes('Incluir Lia Teste neste grupo'));
  assert.equal(h.requests.filter(request => request.path.startsWith('/api/groups') && request.body).length, 0);
});

test('dependent participation changes only after an explicit current-group action and blocks duplicate requests while saving', async () => {
  const h = harness({ hash: '#group?id=group-1' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/groups/group-1').respond(dependentGroupPayload()); await tick();
  assert.equal(h.requests.filter(request => request.body).length, 0);
  await h.action('toggle-dependent', { dataset: { dependentId: 'not-my-dependent' } });
  assert.equal(h.requests.filter(request => request.body).length, 0);
  const activating = h.action('toggle-dependent', { dataset: { dependentId: childOne.id, groupId: 'wrong-group', dependentActive: 'false' } });
  await h.action('toggle-dependent', { dataset: { dependentId: childOne.id } });
  await h.action('toggle-dependent', { dataset: { dependentId: childTwo.id } });
  const writes = h.requests.filter(request => request.body); assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/groups/group-1/dependents/child-1'); assert.deepEqual(writes[0].body, { active: true });
  assert.equal(h.state.dependentBusyId, childOne.id); assert.equal(h.state.ownDependents[0].active, false);
  assert(h.app.innerHTML.includes('Salvando…'));
  writes[0].respond({ ok: true }); await tick();
  h.requests.filter(request => request.path === '/api/groups/group-1').at(-1).respond(dependentGroupPayload({ active: true })); await activating;
  assert.equal(h.state.dependentBusyId, ''); assert.equal(h.state.ownDependents[0].active, true);
  assert(h.app.innerHTML.includes('Retirar Lia Teste deste grupo'));
  const removing = h.action('toggle-dependent', { dataset: { dependentId: childOne.id, dependentActive: 'true' } });
  const removal = h.requests.filter(request => request.body).at(-1); assert.deepEqual(removal.body, { active: false });
  removal.respond({ ok: true }); await tick();
  h.requests.filter(request => request.path === '/api/groups/group-1').at(-1).respond(dependentGroupPayload()); await removing;
  assert.equal(h.state.ownDependents[0].active, false);
  const reopening = h.navigate('group', { id: invitedGroup.id });
  h.requests.filter(request => request.path === '/api/groups/group-1').at(-1).respond(dependentGroupPayload({ drawn: true })); await reopening;
  const before = h.requests.length;
  await h.action('toggle-dependent', { dataset: { dependentId: childOne.id } });
  assert.equal(h.requests.length, before); assert(!h.app.innerHTML.includes('data-action="toggle-dependent"'));
});

test('family results are fetched only on reveal and hidden results are cleared from both state and rendered content', async () => {
  const h = harness({ hash: '#reveal?id=group-1' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/groups/group-1').respond(dependentGroupPayload({ drawn: true, active: true })); await tick();
  assert.equal(h.requests.filter(request => request.path.endsWith('/result')).length, 0);
  assert.equal(h.state.dependentResults.length, 0); assert.equal(h.state.match, null);
  assert(h.app.innerHTML.includes('Revelar nossos amigos secretos')); assert(!h.app.innerHTML.includes('Destino privado'));
  const revealing = h.action('reveal', {});
  const result = h.requests.find(request => request.path === '/api/groups/group-1/result'); assert(result); assert.equal(result.body, null);
  assert.equal(h.state.revealed, false); assert(!h.app.innerHTML.includes('Destino privado'));
  result.respond(familyResults); await revealing;
  assert.equal(h.state.dependentResults.length, 1); assert.equal(h.state.revealed, true);
  assert(h.app.innerHTML.includes(familyResults.match.name)); assert(h.app.innerHTML.includes(familyResults.dependentResults[0].match.name));
  assert(h.app.innerHTML.includes('As surpresas dos seus dependentes')); assert.equal(h.storage.size, 0);
  const beforeHide = h.requests.length;
  await h.action('hide-result', {});
  assert.equal(h.requests.length, beforeHide); assert.equal(h.state.match, null); assert.equal(h.state.dependentResults.length, 0); assert.equal(h.state.revealed, false);
  assert(!h.app.innerHTML.includes('Destino privado')); assert(!h.app.innerHTML.includes('adult-secret@example.test')); assert(!h.app.innerHTML.includes('child-secret@example.test'));
  const revealingAgain = h.action('reveal', {});
  h.requests.filter(request => request.path.endsWith('/result')).at(-1).respond(familyResults); await revealingAgain;
  assert.equal(h.state.dependentResults.length, 1); assert(h.app.innerHTML.includes('Destino privado de Lia'));
  const leaving = h.action('logout', {}); h.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await leaving;
  assert.equal(h.state.user, null); assert.equal(h.state.match, null); assert.equal(h.state.dependentResults.length, 0); assert.equal(h.state.ownDependents.length, 0);
  assert(!h.app.innerHTML.includes('Destino privado')); assert.equal(h.storage.size, 0);
});

test('logout clears the dependent catalog, participation and results, and a late reveal cannot restore them', async () => {
  const h = harness({ hash: '#reveal?id=group-1' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/groups/group-1').respond(dependentGroupPayload({ drawn: true, active: true })); await tick();
  h.state.dependents = [childOne, childTwo];
  const revealing = h.action('reveal', {}), response = h.requests.find(request => request.path.endsWith('/result'));
  const leaving = h.action('logout', {}); h.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await leaving;
  assert.equal(h.state.user, null); assert.equal(h.state.dependents.length, 0); assert.equal(h.state.ownDependents.length, 0);
  assert.equal(h.state.dependentResults.length, 0); assert.equal(h.state.match, null); assert.equal(h.state.dependentsReturnGroupId, '');
  const requestCount = h.requests.length;
  response.respond(familyResults); await revealing;
  assert.equal(h.requests.length, requestCount); assert.equal(h.state.user, null); assert.equal(h.state.dependentResults.length, 0); assert.equal(h.state.match, null);
  assert(!h.app.innerHTML.includes('Destino privado')); assert(!h.app.innerHTML.includes(childOne.name)); assert.equal(h.storage.size, 0);
});

test('a late dependent creation or participation response cannot repopulate state after logout', async () => {
  const catalog = harness({ hash: '#dependents' });
  catalog.requests[0].respond({ user: signedInUser }); await tick();
  catalog.requests.find(request => request.path === '/api/dependents').respond({ dependents: [] }); await tick();
  const creating = catalog.submit({ preventDefault() {}, currentTarget: fixtureForm('create-dependent', { firstName: childOne.firstName, lastName: childOne.lastName }) });
  const createResponse = catalog.requests.find(request => request.path === '/api/dependents' && request.body);
  const leavingCatalog = catalog.action('logout', {}); catalog.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await leavingCatalog;
  createResponse.respond({ dependent: childOne }); await creating;
  assert.equal(catalog.state.dependents.length, 0); assert.equal(catalog.state.user, null); assert(!catalog.app.innerHTML.includes(childOne.name));

  const roster = harness({ hash: '#group?id=group-1' });
  roster.requests[0].respond({ user: signedInUser }); await tick();
  roster.requests.find(request => request.path === '/api/groups/group-1').respond(dependentGroupPayload()); await tick();
  const toggling = roster.action('toggle-dependent', { dataset: { dependentId: childOne.id } });
  const toggleResponse = roster.requests.find(request => request.path.endsWith('/dependents/child-1'));
  const leavingRoster = roster.action('logout', {}); roster.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await leavingRoster;
  const requestCount = roster.requests.length;
  toggleResponse.respond({ ok: true }); await toggling;
  assert.equal(roster.requests.length, requestCount, 'A late mutation must not refresh an authenticated roster after logout');
  assert.equal(roster.state.ownDependents.length, 0); assert.equal(roster.state.dependentBusyId, ''); assert.equal(roster.state.user, null);
  assert(!roster.app.innerHTML.includes(childOne.name));
});

const ownWishlistItem = { id: 'gift-1', text: 'Uma ideia particular de presente', url: 'https://example.test/presente' };
const ownWishlistPayload = (extra = {}) => ({ owner: { membershipId: 'own-membership', firstName: 'Pessoa', lastName: 'Conectada', name: 'Pessoa Conectada' }, items: [{ ...ownWishlistItem }], nextCursor: null, ...extra });
async function loadedWishlist(extra = {}) {
  const h = harness({ hash: '#wishlist?id=group-1' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/groups/group-1').respond(dependentGroupPayload({ active: true })); await tick();
  h.requests.find(request => request.path === '/api/groups/group-1/wishlist').respond(ownWishlistPayload(extra)); await tick();
  return h;
}
function recipientDialogFixture() {
  const listeners = {}, body = { scrollTop: 0 };
  const dialog = { open: false, innerHTML: '', querySelector: selector => selector === '.wl-dialog-body' ? body : null,
    addEventListener(type, listener) { listeners[type] = listener; },
    showModal() { this.open = true; },
    close() { const wasOpen = this.open; this.open = false; if (wasOpen) listeners.close?.(); },
  };
  return { dialog, listeners };
}

test('opening a group never loads wishes, and a late editor response cannot restore them after logout', async () => {
  const group = harness({ hash: '#group?id=group-1' });
  group.requests[0].respond({ user: signedInUser }); await tick();
  group.requests.find(request => request.path === '/api/groups/group-1').respond(dependentGroupPayload()); await tick();
  assert.equal(group.requests.length, 2); assert(group.app.innerHTML.includes('Minhas sugestões'));
  assert.equal(group.requests.filter(request => request.path.includes('wishlist')).length, 0);

  const h = harness({ hash: '#wishlist?id=group-1' });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/groups/group-1').respond(dependentGroupPayload()); await tick();
  const listRequest = h.requests.find(request => request.path === '/api/groups/group-1/wishlist'); assert(listRequest);
  const leaving = h.action('logout', {}); h.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await leaving;
  listRequest.respond(ownWishlistPayload()); await tick();
  assert.equal(h.state.user, null); assert.equal(h.state.wishlist, null); assert.equal(h.state.recipientWishlist, null);
  assert(!h.app.innerHTML.includes(ownWishlistItem.text)); assert.equal(h.storage.size, 0);
});

test('wishlist edits validate every row and require an explicit discard before navigation', async () => {
  const h = await loadedWishlist();
  assert(h.app.innerHTML.includes(ownWishlistItem.text));
  await h.action('wishlist-add', {}); assert.equal(h.state.wishlist.items.length, 2);
  await h.submit({ preventDefault() {}, currentTarget: fixtureForm('wishlist-save', {}) });
  assert.equal(h.requests.filter(request => request.body).length, 0, 'Empty added rows cannot be silently dropped on save');
  assert(h.state.wishlist.items[1].error);
  await h.navigate('dashboard'); assert.equal(h.discards.length, 1); assert.equal(h.location.hash, '#wishlist?id=group-1');
  assert.equal(h.requests.filter(request => request.path === '/api/groups').length, 0);
  h.discards[0](); await tick();
  h.requests.find(request => request.path === '/api/groups').respond({ groups: [], pendingInvitations: [] }); await tick();
  assert.equal(h.state.wishlist, null); assert.equal(h.location.hash, '#dashboard');
});

test('wishlist pagination preserves dirty drafts and deduplicates already loaded entries', async () => {
  const h = await loadedWishlist({ nextCursor: '50' });
  h.state.wishlist.items[0].text = 'Alteração que ainda não salvei';
  const loading = h.action('wishlist-more', {});
  await h.action('wishlist-more', {});
  const pages = h.requests.filter(request => request.path.includes('cursor=50')); assert.equal(pages.length, 1);
  pages[0].respond(ownWishlistPayload({ items: [{ ...ownWishlistItem }, { id: 'gift-2', text: 'Mais uma ideia', url: '' }], nextCursor: null })); await loading;
  assert.equal(h.state.wishlist.items.length, 2); assert.equal(h.state.wishlist.items[0].text, 'Alteração que ainda não salvei');
  assert.equal(h.state.wishlist.originals[ownWishlistItem.id].text, ownWishlistItem.text); assert.equal(h.state.wishlist.nextCursor, null);
});

test('partial wishlist saves retain only pending operations for retry and never resend successful batches', async () => {
  const h = await loadedWishlist({ items: [] });
  h.state.wishlist.items = Array.from({ length: 55 }, (_, index) => ({ id: `gift-${index}`, text: `Ideia ${index}`, url: '' }));
  const saving = h.submit({ preventDefault() {}, currentTarget: fixtureForm('wishlist-save', {}) });
  const first = h.requests.find(request => request.path === '/api/groups/group-1/wishlist' && request.body); assert.equal(first.body.upserts.length, 50);
  await h.submit({ preventDefault() {}, currentTarget: fixtureForm('wishlist-save', {}) });
  assert.equal(h.requests.filter(request => request.body).length, 1, 'A concurrent save is ignored');
  first.respond({ ok: true, items: first.body.upserts }); await tick();
  const second = h.requests.filter(request => request.body).at(-1); assert.equal(second.body.upserts.length, 5);
  second.respond({ error: { code: 'TEMPORARY_ERROR', message: 'Falha temporária.' } }, 503); await saving;
  assert.equal(h.state.wishlist.busy, false); assert.equal(Object.keys(h.state.wishlist.originals).length, 50);
  assert(h.state.wishlist.error.includes('Suas alterações pendentes continuam aqui'));
  const retrying = h.submit({ preventDefault() {}, currentTarget: fixtureForm('wishlist-save', {}) });
  const retry = h.requests.filter(request => request.body).at(-1); assert.equal(retry.body.upserts.length, 5);
  assert(retry.body.upserts.every(item => Number(item.id.slice(5)) >= 50));
  retry.respond({ ok: true, items: retry.body.upserts }); await tick();
  h.requests.filter(request => request.path === '/api/groups/group-1').at(-1).respond(dependentGroupPayload()); await retrying;
  assert.equal(h.location.hash, '#group?id=group-1'); assert.equal(h.state.wishlist, null); assert.equal(h.storage.size, 0);
});

test('recipient wishes load only on explicit reveal-screen actions and late closed-dialog responses remain private', async () => {
  const fixture = recipientDialogFixture(), h = harness({ hash: '#reveal?id=group-1', selectors: { '#wishlist-recipient-dialog': fixture.dialog } });
  h.requests[0].respond({ user: signedInUser }); await tick();
  h.requests.find(request => request.path === '/api/groups/group-1').respond(dependentGroupPayload({ drawn: true, active: true })); await tick();
  await h.action('wishlist-recipient', { dataset: {} }); assert.equal(h.requests.filter(request => request.path.includes('wishlist')).length, 0);
  const revealing = h.action('reveal', {}); h.requests.find(request => request.path.endsWith('/result')).respond(familyResults); await revealing;
  assert(h.app.innerHTML.includes('Ver sugestões de presentes')); assert(!h.app.innerHTML.includes('O que faria você sorrir'));
  assert.equal(h.requests.filter(request => request.path.includes('wishlist')).length, 0, 'Revealing a match does not fetch their list yet');
  await h.action('wishlist-recipient', { dataset: { dependentId: 'someone-else-child' } });
  assert.equal(h.requests.filter(request => request.path.includes('wishlist')).length, 0);
  const opening = h.action('wishlist-recipient', { dataset: { dependentId: childOne.id } });
  const request = h.requests.find(request => request.path === '/api/groups/group-1/result/wishlist?dependentId=child-1'); assert(request); assert(fixture.dialog.open);
  await h.action('close-dialog', { closest: () => fixture.dialog }); assert.equal(h.state.recipientWishlist, null); assert.equal(fixture.dialog.innerHTML, '');
  request.respond({ owner: { name: 'Segredo do dependente', firstName: 'Segredo' }, items: [{ id: 'private-item', text: 'Ideia secreta do destinatário', url: '' }], nextCursor: null }); await opening;
  assert.equal(h.state.recipientWishlist, null); assert.equal(fixture.dialog.open, false); assert.equal(fixture.dialog.innerHTML, '');
  const reopening = h.action('wishlist-recipient', { dataset: {} });
  const ownRequest = h.requests.find(request => request.path === '/api/groups/group-1/result/wishlist'); assert(ownRequest);
  const leaving = h.action('logout', {}); h.requests.find(request => request.path === '/api/auth/logout').respond({ ok: true }); await leaving;
  ownRequest.respond(ownWishlistPayload()); await reopening;
  assert.equal(h.state.user, null); assert.equal(h.state.recipientWishlist, null); assert.equal(h.state.wishlist, null);
  assert.equal(fixture.dialog.innerHTML, ''); assert.equal(fixture.dialog.open, false); assert.equal(h.storage.size, 0);
});

test('removing a newly submitted wish after a lost response explicitly deletes the possibly committed item', async () => {
  const h = await loadedWishlist({ items: [] });
  const wish = { id: 'possibly-committed-gift', text: 'Uma ideia nova', url: '' };
  h.state.wishlist.items = [{ ...wish }];
  const saving = h.submit({ preventDefault() {}, currentTarget: fixtureForm('wishlist-save', {}) });
  const request = h.requests.find(request => request.path.endsWith('/wishlist') && request.body); assert(request);
  // The server may already have committed this item when its response is lost.
  request.reject(new Error('Connection interrupted after commit')); await saving;
  assert.equal(h.state.wishlist.originals[wish.id], undefined); assert.equal(h.state.wishlist.busy, false);
  await h.action('wishlist-remove', { dataset: { itemId: wish.id } });
  assert.equal(h.state.wishlist.items.length, 0); assert(h.state.wishlist.deletedIds.includes(wish.id));
  const retrying = h.submit({ preventDefault() {}, currentTarget: fixtureForm('wishlist-save', {}) });
  const deletion = h.requests.filter(request => request.body).at(-1);
  assert.deepEqual(deletion.body.deletedIds, [wish.id]); assert.equal(deletion.body.upserts.length, 0);
  deletion.respond({ ok: true, items: [] }); await tick();
  h.requests.filter(request => request.path === '/api/groups/group-1').at(-1).respond(dependentGroupPayload()); await retrying;
  assert.equal(h.state.wishlist, null); assert.equal(h.location.hash, '#group?id=group-1');
});

test('reverting an edited wish after a lost response still saves the intended original value', async () => {
  const h = await loadedWishlist();
  h.state.wishlist.items[0].text = 'Valor que o servidor pode ter salvo';
  const saving = h.submit({ preventDefault() {}, currentTarget: fixtureForm('wishlist-save', {}) });
  const request = h.requests.find(request => request.path.endsWith('/wishlist') && request.body); assert.equal(request.body.upserts[0].text, 'Valor que o servidor pode ter salvo');
  request.reject(new Error('Connection interrupted after commit')); await saving;
  h.state.wishlist.items[0].text = ownWishlistItem.text;
  assert.equal(wishlistDirty(h.state.wishlist), true, 'An unconfirmed write remains dirty even after reverting to its old baseline');
  await h.navigate('dashboard'); assert.equal(h.discards.length, 1); assert.equal(h.location.hash, '#wishlist?id=group-1');
  const retrying = h.submit({ preventDefault() {}, currentTarget: fixtureForm('wishlist-save', {}) });
  const writes = h.requests.filter(request => request.path.endsWith('/wishlist') && request.body); assert.equal(writes.length, 2);
  const retry = writes.at(-1); assert.equal(retry.body.upserts[0].text, ownWishlistItem.text); assert.equal(retry.body.upserts[0].id, ownWishlistItem.id);
  retry.respond({ ok: true, items: retry.body.upserts }); await tick();
  h.requests.filter(request => request.path === '/api/groups/group-1').at(-1).respond(dependentGroupPayload()); await retrying;
  assert.equal(h.state.wishlist, null); assert.equal(h.location.hash, '#group?id=group-1');
});

test('long Unicode suggestions are split by UTF-8 payload size as well as item count', async () => {
  const h = await loadedWishlist({ items: [] });
  const urlPrefix = 'https://example.test/';
  const ideas = Array.from({ length: 50 }, (_, index) => ({ id: `large-gift-${index}`, text: '礼'.repeat(2000), url: urlPrefix + 'a'.repeat(2048 - urlPrefix.length) }));
  assert(ideas.every(item => validateWishlistItem(item) === ''));
  assert(Buffer.byteLength(JSON.stringify({ upserts: ideas, deletedIds: [] })) > 400000, 'The fixture must exceed the server request limit when sent as one count-only batch');
  h.state.wishlist.items = ideas;
  const saving = h.submit({ preventDefault() {}, currentTarget: fixtureForm('wishlist-save', {}) });
  const responded = new Set(), written = [];
  while (written.length < ideas.length) {
    const request = h.requests.find(candidate => candidate.path.endsWith('/wishlist') && candidate.body && !responded.has(candidate));
    assert(request, 'Every remaining suggestion must have a request'); responded.add(request);
    assert(request.body.upserts.length + request.body.deletedIds.length <= 50);
    assert(Buffer.byteLength(JSON.stringify(request.body)) < 400000, 'UTF-8 bytes must fit the API body limit');
    written.push(...request.body.upserts); request.respond({ ok: true, items: request.body.upserts }); await tick();
  }
  assert(responded.size > 1, 'Valid large Unicode values require more than one batch');
  assert.equal(written.length, ideas.length); assert.equal(new Set(written.map(item => item.id)).size, ideas.length);
  assert.deepEqual(written.map(item => item.id), ideas.map(item => item.id));
  h.requests.filter(request => request.path === '/api/groups/group-1').at(-1).respond(dependentGroupPayload()); await saving;
  assert.equal(h.location.hash, '#group?id=group-1'); assert.equal(h.state.wishlist, null);
});
