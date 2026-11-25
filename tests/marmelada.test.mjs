import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdmin } from '../prototype/admin.js';
import { renderGroups } from '../prototype/groups.js';
import { renderMarmelada, renderMarmeladaResult, renderMarmeladaTokenDialog, renderMarmeladaTokenList, showMarmeladaResult, syncGroupMarmeladaForm } from '../prototype/marmelada.js';

test('Marmelada stays behind the administrative renderer and escapes selectable participant names', () => {
  const data = { group: { id: 'group', name: '<script>secret</script>' }, participants: [{ id: 'giver', name: '<img src=x onerror=alert(1)>' }] };
  assert.equal(renderAdmin('admin-marmelada', { user: { isAdmin: false }, marmeladaData: data }), '');
  const html = renderMarmelada({ marmeladaData: data });
  assert(!html.includes('<script>')); assert(!html.includes('<img src=x'));
  assert(html.includes('&lt;script&gt;secret&lt;/script&gt;')); assert(html.includes('name="giverId"')); assert(html.includes('name="receiverId"'));
});

test('the creator’s delegated view allows verification after selecting two people and entering the token', () => {
  const group = { id: 'group', name: 'Natal', organizerId: 'owner' };
  const state = { production: true, drawn: true, group, user: { id: 'owner' }, viewAs: {}, role: 'organizer',
    groupMarmelada: { group, participants: [
      { id: 'giver', name: 'ANA BEZERRA', avatar: 'data:image/webp;base64,VGVzdGU=' },
      { id: 'receiver', name: 'GUSTAVO COSTA' },
    ] } };
  assert.match(renderGroups('group', state), /data-route="group-marmelada" data-group-id="group">Conferir/);
  assert.doesNotMatch(renderGroups('group', { ...state, user: { id: 'member' }, role: 'member' }), /group-marmelada-promo/);
  assert.doesNotMatch(renderGroups('group', { ...state, drawn: false }), /group-marmelada-promo/);
  const html = renderGroups('group-marmelada', state);
  assert.match(html, /Esta conferência também consome o token/);
  assert.match(html, /type="radio" name="giverId" value="giver" data-person-name="Ana Bezerra"/);
  assert.match(html, /type="radio" name="receiverId" value="receiver" data-person-name="Gustavo Costa"/);
  assert.match(html, /<img src="data:image\/webp;base64,VGVzdGU="/);
  assert.doesNotMatch(html, /<select|ANA BEZERRA|GUSTAVO COSTA/);

  const button = { disabled: false };
  const tokenOwner = {};
  const giverFieldset = {}, receiverFieldset = {};
  const giver = { value: 'giver' }, receiver = { value: 'receiver', dataset: { personName: 'Gustavo Costa' } };
  const samePerson = { value: giver.value };
  const elements = { token: { value: '' } };
  const selectors = {
    'input[name="giverId"]:checked': giver, 'input[name="receiverId"]:checked': receiver,
    '#group-marmelada-giver': giverFieldset, '#group-marmelada-receiver': receiverFieldset,
    '[data-token-owner]': tokenOwner, '[type="submit"]': button,
  };
  const form = { elements, getAttribute: () => null,
    querySelector: selector => selectors[selector], querySelectorAll: () => [samePerson, receiver] };
  syncGroupMarmeladaForm(form);
  assert.equal(giverFieldset.disabled, false);
  assert.equal(receiverFieldset.disabled, false);
  assert.equal(samePerson.disabled, true);
  assert.equal(receiver.disabled, false);
  assert.equal(tokenOwner.textContent, 'Token de Gustavo Costa');
  assert.equal(elements.token.disabled, false);
  assert.equal(button.disabled, true);
  elements.token.value = '12345678';
  syncGroupMarmeladaForm(form);
  assert.equal(button.disabled, false);
  delete selectors['input[name="receiverId"]:checked'];
  syncGroupMarmeladaForm(form);
  assert.equal(elements.token.disabled, true);
  assert.equal(button.disabled, true);
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

test('the group header shows a personal token or opens a single list for the holder and dependents', () => {
  const user = { id: 'guardian' }, group = { id: 'group', name: 'Natal' };
  const holder = { id: 'member-1', userId: user.id, name: 'ANA BEZERRA', status: 'accepted' };
  const child = { id: 'member-2', guardianId: user.id, name: 'BIA BEZERRA', isDependent: true, status: 'accepted' };
  const state = { production: true, drawn: true, role: 'member', user, group, participants: [holder] };
  const solo = renderGroups('group', state);
  assert.match(solo, /class="group-detail-status"[\s\S]*Sorteio realizado[\s\S]*data-marmelada-tokens="inline"/);
  assert.doesNotMatch(solo, /Ver tokens da troca/);
  const family = renderGroups('group', { ...state, participants: [child, holder] });
  assert.match(family, /class="group-detail-status"[\s\S]*Sorteio realizado[\s\S]*Ver tokens da troca/);
  assert.doesNotMatch(family, /data-marmelada-tokens="inline"/);
  const delegatedSolo = renderGroups('group', { ...state, viewAs: {} });
  assert.match(delegatedSolo, /Sorteio realizado[\s\S]*Meu token da troca[\s\S]*Código visível na própria conta/);
  assert.doesNotMatch(delegatedSolo, /data-marmelada-tokens="inline"/);
  assert.match(renderGroups('group', { ...state, viewAs: {}, participants: [child, holder] }), /Ver tokens da troca/);
  const delegatedList = renderMarmeladaTokenDialog([child, holder]);
  assert.match(delegatedList, /Ana Bezerra[\s\S]*Privado[\s\S]*Bia Bezerra[\s\S]*Privado/);
  assert.doesNotMatch(delegatedList, /data-marmelada-tokens|marmelada-token-code/);
  const html = renderMarmeladaTokenList([child, holder], new Map([[holder.id, { token: '01234567' }], [child.id, { used: true }]]));
  assert.match(html, /Ana Bezerra[\s\S]*0123 4567[\s\S]*Bia Bezerra[\s\S]*Token já usado/);
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
