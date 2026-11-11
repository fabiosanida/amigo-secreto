import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, validatePassword, verifyPassword } from '../lib/passwords.js';
import { notificationContent } from '../lib/mail.js';

const password = 'Uma senha de teste com espaços 2026';

test('passwords require matching confirmation and enforce bounded length without trimming secrets', () => {
  assert.doesNotThrow(() => validatePassword(password, password));
  assert.doesNotThrow(() => validatePassword('x'.repeat(12), 'x'.repeat(12)));
  assert.doesNotThrow(() => validatePassword('x'.repeat(128), 'x'.repeat(128)));
  for (const value of ['', 'x'.repeat(11), 'x'.repeat(129), null, 123456789012, {}, []]) {
    assert.throws(() => validatePassword(value, value));
  }
  assert.throws(() => validatePassword(password, `${password} `));
  assert.throws(() => validatePassword(password));
});

test('password hashes are salted, verify only the exact password, and reject malformed stored hashes', async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second, 'Every password receives an independent salt');
  assert(!first.includes(password));
  assert(await verifyPassword(password, first));
  assert(await verifyPassword(password, second));
  assert.equal(await verifyPassword(`${password} `, first), false);
  assert.equal(await verifyPassword('Outra senha de teste 2026', first), false);
  for (const malformed of [null, '', 'invalid', first.slice(0, -5), 'scrypt$999999999$8$1$bad$hash']) {
    assert.equal(await verifyPassword(password, malformed), false);
  }
});


test('recovery email carries a six-digit code and branded image without a magic-login bypass', () => {
  const oldUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://amigosecreto.example.test';
  try {
    const challengeId = '123e4567-e89b-42d3-a456-426614174000';
    const code = '001234', invitation = 'x'.repeat(43), unusedToken = 'y'.repeat(43);
    const message = notificationContent({ kind: 'password-reset', code, challengeId, token: unusedToken, inviteToken: invitation,
      user: { firstName: '<Teste>', email: 'fixture@example.test' } });
    assert.match(message.subject, /senha.*Amigo Secreto/u);
    assert(message.text.includes(code)); assert(message.html.includes(code));
    assert.match(message.html, /https:\/\/amigosecreto\.example\.test\/assets\/mark\.png\?v=1/);
    assert(message.html.includes('&lt;Teste&gt;'));
    assert(!message.html.includes('#verify-link')); assert(!message.text.includes('#verify-link'));
    assert(!message.html.includes(unusedToken)); assert(!message.text.includes(unusedToken));
    const url = new URL(message.text.match(/https:\/\/\S+/)[0]);
    const query = new URLSearchParams(url.hash.split('?')[1]);
    assert.equal(query.get('purpose'), 'recover'); assert.equal(query.get('challengeId'), challengeId);
    assert.equal(query.get('invitation'), invitation); assert.equal(query.get('email'), 'fixture@example.test');
    assert.equal(query.get('code'), null); assert.equal(query.get('token'), null);
  } finally { if (oldUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = oldUrl; }
});
