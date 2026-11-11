import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdmin } from '../prototype/admin.js';
import { renderMarmelada, renderMarmeladaResult, showMarmeladaResult } from '../prototype/marmelada.js';

test('Marmelada stays behind the administrative renderer and escapes selectable participant names', () => {
  const data = { group: { id: 'group', name: '<script>secret</script>' }, participants: [{ id: 'giver', name: '<img src=x onerror=alert(1)>' }] };
  assert.equal(renderAdmin('admin-marmelada', { user: { isAdmin: false }, marmeladaData: data }), '');
  const html = renderMarmelada({ marmeladaData: data });
  assert(!html.includes('<script>')); assert(!html.includes('<img src=x'));
  assert(html.includes('&lt;script&gt;secret&lt;/script&gt;')); assert(html.includes('name="giverId"')); assert(html.includes('name="receiverId"'));
});

test('presentation displays only the announced pair and treats only a positive server verdict as success', () => {
  const result = { matches: false, group: { name: '<b>Encontro</b>' }, giver: { name: 'Ana' }, receiver: { name: 'Bruno' }, actualReceiver: { name: 'Hidden recipient' }, results: ['Hidden draw mapping'] };
  const wrong = renderMarmeladaResult(result);
  assert(wrong.includes('É MARMELADA!')); assert(wrong.includes('Não confere com o sorteio original.'));
  assert(!wrong.includes('Hidden recipient')); assert(!wrong.includes('Hidden draw mapping'));
  assert(wrong.includes('&lt;b&gt;Encontro&lt;/b&gt;')); assert(!wrong.includes('<b>Encontro</b>'));
  assert(renderMarmeladaResult({ ...result, matches: 'true' }).includes('marmelada-wrong'));
  const correct = renderMarmeladaResult({ ...result, matches: true });
  assert(correct.includes('marmelada-correct')); assert(correct.includes('O amigo secreto é esse mesmo.'));
  assert(!correct.includes('É MARMELADA!'));
});

function presentationFixture({ fullscreenSupported = true } = {}) {
  const listeners = {}, documentListeners = {}, status = { textContent: '' }, button = { innerHTML: '' };
  let entries = 0, exits = 0, focused = false;
  const document = {
    fullscreenElement: null,
    querySelector: selector => selector === '#marmelada-result-dialog' ? dialog : null,
    addEventListener: (type, handler) => { documentListeners[type] = handler; },
    removeEventListener: type => { delete documentListeners[type]; },
    async exitFullscreen() { exits++; document.fullscreenElement = null; documentListeners.fullscreenchange?.(); },
  };
  const stage = fullscreenSupported ? { async requestFullscreen() { entries++; document.fullscreenElement = stage; documentListeners.fullscreenchange?.(); } } : {};
  const dialog = {
    innerHTML: '', open: false,
    querySelector: selector => ({ '.marmelada-stage': stage, '[data-marmelada-action="fullscreen"]': button, '[data-fullscreen-status]': status, '[data-marmelada-action="again"]': { focus() { focused = true; } } })[selector] || null,
    addEventListener: (type, handler) => { listeners[type] = handler; },
    removeEventListener: type => { delete listeners[type]; },
    showModal() { dialog.open = true; },
    close() { dialog.open = false; const close = listeners.close; delete listeners.close; close?.(); },
    replaceChildren() { dialog.innerHTML = ''; },
  };
  return { document, dialog, status, button, listeners, documentListeners,
    get entries() { return entries; }, get exits() { return exits; }, get focused() { return focused; },
    click(action) { return listeners.click({ target: { closest: () => ({ dataset: { marmeladaAction: action } }) } }); },
  };
}

test('presentation enters fullscreen only on request and clears private content and listeners when closed', async () => {
  const saved = globalThis.document, fixture = presentationFixture(); globalThis.document = fixture.document;
  try {
    showMarmeladaResult({ matches: true, group: { name: 'Private group' }, giver: { name: 'Ana' }, receiver: { name: 'Bruno' } });
    assert(fixture.dialog.open); assert(fixture.focused); assert.equal(fixture.entries, 0);
    await fixture.click('fullscreen'); assert.equal(fixture.entries, 1); assert(fixture.button.innerHTML.includes('Sair da tela cheia'));
    await fixture.click('again'); assert.equal(fixture.exits, 1); assert.equal(fixture.dialog.open, false);
    assert.equal(fixture.dialog.innerHTML, ''); assert.equal(fixture.listeners.click, undefined); assert.equal(fixture.documentListeners.fullscreenchange, undefined);
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; }
});

test('presentation remains usable when fullscreen is unavailable', async () => {
  const saved = globalThis.document, fixture = presentationFixture({ fullscreenSupported: false }); globalThis.document = fixture.document;
  try {
    showMarmeladaResult({ matches: false, giver: { name: 'Ana' }, receiver: { name: 'Bruno' } });
    await fixture.click('fullscreen'); assert(fixture.status.textContent.includes('não está disponível'));
    assert(fixture.dialog.open); await fixture.click('close'); assert.equal(fixture.dialog.open, false); assert.equal(fixture.dialog.innerHTML, '');
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; }
});
