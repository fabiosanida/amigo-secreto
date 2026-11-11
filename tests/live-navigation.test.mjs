import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { renderAuth, AUTH_ROUTES } from '../prototype/auth.js';
import { renderGroups, GROUP_ROUTES } from '../prototype/groups.js';
import { icon, brand, avatar, escapeHtml, setAvatarDirectory } from '../prototype/ui.js';

const source = readFileSync(new URL('../prototype/live.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const requests = [], listeners = {}, app = { innerHTML: '' }, location = { hash: '#welcome' };
  const noop = () => {};
  const context = {
    URLSearchParams, Date, Error, Map, Set, Promise, Number, String, Boolean, JSON, Math,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, location,
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
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
  vm.runInContext(`${source}\nglobalThis.navigationTest = { navigate, state };`, context);
  return { requests, location, app, ...context.navigationTest,
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
