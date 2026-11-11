import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdmin, requireAdmin } from '../lib/admin-access.js';
import { adminPagination } from '../lib/admin.js';
import { publicUser } from '../lib/profile.js';

test('administrative access is bound to the exact session email, not role flags or similar addresses', () => {
  for (const user of [null, {}, { isAdmin: true }, { email: 'other@example.test', isAdmin: true }, { email: 'fabiosanida@gmail.com.attacker.test' }, { email: 'fabiosanida+admin@gmail.com' }]) {
    assert.equal(isAdmin(user), false); assert.throws(() => requireAdmin(user), { code: 'FORBIDDEN' });
  }
  assert.equal(isAdmin({ email: 'fabiosanida@gmail.com' }), true);
  assert.equal(publicUser({ id: 'fixture', email: 'fabiosanida@gmail.com', password_hash: 'must-not-leak' }).isAdmin, true);
  const normal = publicUser({ id: 'fixture', email: 'other@example.test', isAdmin: true, password_hash: 'must-not-leak' });
  assert.equal(normal.isAdmin, false); assert(!JSON.stringify(normal).includes('must-not-leak'));
});

test('administrative lists bound pagination and treat search wildcard characters literally', () => {
  assert.deepEqual(adminPagination({}), { page: 1, pageSize: 25, offset: 0, search: '' });
  assert.deepEqual(adminPagination({ page: '2', limit: '10', search: '  100%_test  ' }), { page: 2, pageSize: 10, offset: 10, search: '100\\%\\_test' });
  for (const input of [{ page: -1 }, { page: 1.5 }, { page: '1abc' }, { limit: 51 }, { limit: -5 }, { search: 'x'.repeat(101) }]) {
    assert.throws(() => adminPagination(input), { code: 'INVALID_FILTER' });
  }
});
