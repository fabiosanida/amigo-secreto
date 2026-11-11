import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { renderAuth, AUTH_ROUTES } from '../prototype/auth.js';
import { renderGroups, GROUP_ROUTES } from '../prototype/groups.js';
import { icon, brand, avatar, escapeHtml, setAvatarDirectory } from '../prototype/ui.js';

const source = readFileSync(new URL('../prototype/live.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ hash = '#welcome', stored = new Map() } = {}) {
  const requests = [], listeners = {}, app = { innerHTML: '' }, location = { hash };
  const storage = new Map(stored);
  const noop = () => {};
  const context = {
    URLSearchParams, Date, Error, Map, Set, Promise, Number, String, Boolean, JSON, Math,
    FormData: class { constructor(form) { this.values = form.values; } get(name) { return this.values[name] ?? null; } },
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, location,
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    history: { pushState(a, b, hash) { location.hash = hash; }, replaceState(a, b, hash) { location.hash = hash; } },
    document: { body: { dataset: {}, style: {} }, querySelector: selector => selector === '#app' ? app : null, querySelectorAll: () => [], addEventListener: noop },
    window: { scrollTo: noop, addEventListener(type, listener) { listeners[type] = listener; } },
    renderAuth, AUTH_ROUTES, renderGroups, GROUP_ROUTES, icon, brand, avatar, escapeHtml, setAvatarDirectory,
    setupInviteFields: noop, setInviteFieldsBusy: noop, setupGroupFields: noop, parseBudget: Number, setupOTP: noop,
    openProfileEditor: noop, setupPhotoInputs: noop, getSignupAvatar: () => null, resetSignupAvatar: noop,
    fetch(path, options) {
      return new Promise(resolve => requests.push({ path, body: options.body ? JSON.parse(options.body) : null,
        respond(payload, status = 200) { resolve({ ok: status < 400, status, headers: new Headers(), json: async () => payload }); } }));
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.navigationTest = { navigate, state, action, submit };`, context);
  return { requests, location, app, storage, ...context.navigationTest,
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
