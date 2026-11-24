import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRecipientWishlist, renderWishlists, renderWishlistCard, wishlistDirty, validateWishlistItem } from '../prototype/wishlist.js';

const owner = { membershipId: 'membership-1', name: 'Pessoa de Teste', firstName: 'Pessoa', lastName: 'de Teste', avatar: null };
const group = { id: 'group-1', name: 'Encontro de teste', budget: 50 };
const item = { id: 'item-1', text: 'Um livro de mistério', url: '' };

test('recipient suggestions render as escaped text and only safe external reference links', () => {
  const html = renderRecipientWishlist({ owner: { ...owner, firstName: '<script>name</script>' }, items: [
    { ...item, text: '<img src=x onerror="alert(1)">', url: 'javascript:alert(1)' },
    { ...item, id: 'item-2', text: 'Referência', url: 'https://example.test/produto?cor=verde&ref=presente' },
    { ...item, id: 'item-3', text: 'Sem credenciais', url: 'https://user:pass@example.test/' },
  ], nextCursor: null }, { groupName: group.name });
  assert(!html.includes('<script>')); assert(!html.includes('<img src=x')); assert(html.includes('&lt;img'));
  assert(!html.includes('href="javascript:')); assert(!html.includes('href="https://user:pass'));
  assert(html.includes('target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"'));
  assert(html.includes('https://example.test/produto?cor=verde&amp;ref=presente'));
  assert(!html.includes('textarea')); assert(!html.includes('data-form="wishlist-save"'));
});

test('group wishlist entry is available only for the current accepted member and is emphasized after draw', () => {
  const state = { production: true, group, user: { id: 'user-1' }, participants: [{ userId: 'user-1', status: 'accepted' }], drawn: false };
  assert(renderWishlistCard(state).includes('Minhas sugestões'));
  assert(!renderWishlistCard(state).includes('is-featured'));
  assert(renderWishlistCard({ ...state, drawn: true }).includes('is-featured'));
  assert.equal(renderWishlistCard({ ...state, participants: [{ userId: 'user-1', status: 'sent' }] }), '');
  assert.equal(renderWishlistCard({ ...state, participants: [{ userId: 'someone-else', status: 'accepted' }] }), '');
});

test('editor retains per-person context and exposes no dependent without active group participation', () => {
  const html = renderWishlists('wishlist', { group, ownDependents: [
    { id: 'active-child', firstName: 'Lia', name: 'Lia Teste', active: true },
    { id: 'inactive-child', firstName: 'Nãoexibir', name: 'Nãoexibir Teste', active: false },
  ], wishlist: { owner, items: [item], originals: { [item.id]: { ...item } }, deletedIds: [], dependentId: null } });
  assert(html.includes(group.name)); assert(html.includes('apenas para este amigo secreto')); assert(html.includes('Lia Teste'));
  assert(!html.includes('Nãoexibir')); assert(html.includes('Link do presente')); assert(html.includes('opcional'));
  assert(!html.includes('type="number"')); assert(html.includes('Adicionar sugestão'));
});

test('unsaved draft detection includes removals, added empty rows and text changes', () => {
  const list = { items: [{ ...item }], originals: { [item.id]: { ...item } }, deletedIds: [] };
  assert.equal(wishlistDirty(list), false);
  assert.equal(wishlistDirty({ ...list, deletedIds: ['removed-item'] }), true);
  assert.equal(wishlistDirty({ ...list, items: [...list.items, { id: 'new', text: '', url: '' }] }), true);
  list.items[0].text = 'Outra ideia'; assert.equal(wishlistDirty(list), true);
  assert(validateWishlistItem({ text: '', url: '' }));
  assert(validateWishlistItem({ text: 'Uma ideia', url: 'javascript:alert(1)' }));
  assert.equal(validateWishlistItem({ text: 'Uma ideia', url: 'https://example.test/' }), '');
});

test('gift directory includes confirmed people and participating dependents after the draw', () => {
  const participants = [
    { id: 'me', userId: 'user-1', name: 'Ana', status: 'accepted' },
    { id: 'child', name: '<Lia>', isDependent: true, status: 'accepted' },
    { id: 'pending', name: 'Convidada pendente', status: 'sent' },
    { id: 'removed', name: 'Participante removido', status: 'accepted', isRemoved: true },
  ];
  const state = { production: true, group, user: { id: 'user-1' }, participants, drawn: true };
  const html = renderWishlists('gift-ideas', state);
  assert.match(html, /Sugestões do grupo/);
  assert.match(html, /data-membership-id="child"/);
  assert.match(html, /&lt;Lia&gt;/);
  assert.match(html, /Dependente/);
  assert.doesNotMatch(html, /Convidada pendente|Participante removido|reveal/i);
  assert.equal(renderWishlists('gift-ideas', { ...state, drawn: false }), '');
  assert.equal(renderWishlists('gift-ideas', { ...state, user: { id: 'foreign' } }), '');
  assert.match(renderWishlistCard(state), /gift-ideas\?id=group-1/);
});

test('group wishes use the selected list and editor links use the same safe rendering', () => {
  const withLink = { ...item, url: 'https://example.test/livro' };
  const editor = renderWishlists('wishlist', { group, wishlist: { owner, items: [withLink] } });
  assert.match(editor, /Nome ou descrição do presente/);
  assert.match(editor, /Os participantes deste grupo podem ver estas sugestões após o sorteio/);
  assert.match(editor, /href="https:\/\/example.test\/livro" target="_blank" rel="noopener noreferrer"/);
  const dialog = renderRecipientWishlist({ owner, items: [item, withLink] }, { membershipId: 'membership-1', groupName: group.name });
  assert.match(dialog, /Voltar às sugestões do grupo/);
  assert.equal((dialog.match(/class="wl-product-link"/g) || []).length, 1);
  const retry = renderRecipientWishlist(null, { membershipId: 'membership-1', error: 'Falha temporária' });
  assert.match(retry, /data-action="wishlist-participant" data-membership-id="membership-1"/);
});
