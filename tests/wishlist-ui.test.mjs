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
