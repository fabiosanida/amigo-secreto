import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateWishlistChanges, validateWishlistURL, WISHLIST_MUTATION_SIZE } from '../lib/wishlists.js';

test('gift references allow HTTP(S), normalize whitespace and reject active or credential-bearing links', () => {
  assert.equal(validateWishlistURL(' https://example.test/presente?q=azul#detalhes '), 'https://example.test/presente?q=azul#detalhes');
  assert.equal(validateWishlistURL('http://example.test'), 'http://example.test/');
  assert.equal(validateWishlistURL(''), '');
  assert.equal(validateWishlistURL(undefined), '');
  for (const value of ['javascript:alert(1)', 'data:text/html,secret', '//example.test/a', 'https://user:password@example.test', 'https://example.test/a\nb', 'https:\\example.test', 'https://example.test/a b', 'https://example.test/' + 'a'.repeat(2048), 42, {}]) {
    assert.throws(() => validateWishlistURL(value), { code: 'INVALID_GIFT_URL' });
  }
});

test('gift item batches require useful text and unique identifiers, preserving multiline free text', () => {
  const id = randomUUID(), deleted = randomUUID(), dependentId = randomUUID();
  assert.deepEqual(validateWishlistChanges({ dependentId, upserts: [{ id, text: '  Livro de suspense.\nPode ser usado.  ' }], deletedIds: [deleted] }), {
    dependentId, upserts: [{ id, text: 'Livro de suspense.\nPode ser usado.', url: '' }], deletedIds: [deleted],
  });
  for (const text of ['', '   ', 'a'.repeat(2001), 'bad\u0000text']) {
    assert.throws(() => validateWishlistChanges({ upserts: [{ id, text }] }), { code: 'INVALID_GIFT_TEXT' });
  }
  assert.throws(() => validateWishlistChanges({ upserts: [{ id, text: 'Livro' }, { id: id.toUpperCase(), text: 'Caneca' }] }), { code: 'INVALID_WISHLIST' });
  assert.throws(() => validateWishlistChanges({ upserts: [{ id, text: 'Livro' }], deletedIds: [id] }), { code: 'INVALID_WISHLIST' });
  assert.throws(() => validateWishlistChanges({ upserts: {} }), { code: 'INVALID_WISHLIST' });
  assert.throws(() => validateWishlistChanges({ deletedIds: 'all' }), { code: 'INVALID_WISHLIST' });
});

test('write size is bounded per request without imposing a total list limit', () => {
  const upserts = Array.from({ length: WISHLIST_MUTATION_SIZE }, (_, i) => ({ id: randomUUID(), text: `Presente ${i}` }));
  assert.equal(validateWishlistChanges({ upserts }).upserts.length, WISHLIST_MUTATION_SIZE);
  assert.throws(() => validateWishlistChanges({ upserts, deletedIds: [randomUUID()] }), { code: 'INVALID_WISHLIST' });
  assert.deepEqual(validateWishlistChanges({}), { dependentId: null, upserts: [], deletedIds: [] });
});
