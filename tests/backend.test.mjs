import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createCycle, nextDeliveryKey, normalizeDeliveryReceipt, receiptPollingDelay, validateGroup } from '../lib/groups.js';
import { challengeIsUsable, hashCode, hashToken, newToken, normalizeEmail, readSessionToken, sealSecret, sessionCookie, unsealSecret, verifyCode } from '../lib/auth.js';
import { normalizeName, sanitizeAvatar } from '../lib/profile.js';
import { checkOrigin, verifyCron } from '../api/index.js';

process.env.AUTH_SECRET = 'test-only-secret-that-is-not-used-in-any-deployment-12345';

test('draw always forms one complete cycle, without self matches or reciprocal pairs', () => {
  for (const length of [3, 4, 5, 10, 50, 200]) {
    const people = Array.from({ length }, (_, id) => ({ id: String(id) }));
    for (let iteration = 0; iteration < 50; iteration++) {
      const cycle = createCycle(people);
      const next = new Map(cycle.map(pair => [pair.giver.id, pair.receiver.id]));
      assert.equal(next.size, length);
      assert.equal(new Set(next.values()).size, length);
      const visited = new Set(); let cursor = people[0].id;
      for (let step = 0; step < length; step++) {
        assert(!visited.has(cursor)); visited.add(cursor);
        assert.notEqual(next.get(cursor), cursor);
        assert.notEqual(next.get(next.get(cursor)), cursor);
        cursor = next.get(cursor);
      }
      assert.equal(cursor, people[0].id);
      assert.equal(visited.size, length);
      assert.deepEqual(people.map(p => p.id), Array.from({ length }, (_, id) => String(id)), 'caller roster is not mutated');
    }
  }
});
test('draw rejects insufficient or duplicated participants', () => {
  assert.throws(() => createCycle([{ id: 'a' }, { id: 'b' }]), { code: 'MIN_PARTICIPANTS' });
  assert.throws(() => createCycle([{ id: 'a' }, { id: 'a' }, { id: 'c' }]));
});
test('OTP hashes are bound to challenge and secret, and malformed values cannot verify', () => {
  const digest = hashCode('challenge-a', '001234');
  assert(verifyCode('challenge-a', '001234', digest));
  assert(!verifyCode('challenge-b', '001234', digest));
  assert(!verifyCode('challenge-a', '1234', digest));
  assert(!verifyCode('challenge-a', '001235', digest));
  assert(!verifyCode('challenge-a', '001234', 'invalid'));
  const previous = process.env.AUTH_SECRET; process.env.AUTH_SECRET += 'rotated';
  assert(!verifyCode('challenge-a', '001234', digest)); process.env.AUTH_SECRET = previous;
  assert(!digest.includes('001234'));
});
test('challenge expiry, attempt ceiling and one-time use are strict at their boundaries', () => {
  const now = 1000000, valid = { expires_at: new Date(now + 1), attempts: 4, used_at: null };
  assert(challengeIsUsable(valid, now));
  assert(!challengeIsUsable({ ...valid, expires_at: new Date(now) }, now));
  assert(!challengeIsUsable({ ...valid, attempts: 5 }, now));
  assert(!challengeIsUsable({ ...valid, used_at: new Date(now - 1) }, now));
  assert(!challengeIsUsable(null, now));
});
test('session tokens have 256 bits, hashes differ, and cookies cannot be read by JavaScript', () => {
  const first = newToken(), second = newToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first, 'base64url').length, 32);
  assert.notEqual(hashToken(first), hashToken(second));
  assert.equal(readSessionToken({ headers: { cookie: `other=hello; as_session=${first}` } }), first);
  assert.equal(readSessionToken({ headers: { cookie: 'as_session=bad' } }), null);
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const cookie = sessionCookie(first);
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Secure/);
  assert.match(sessionCookie('', true), /Max-Age=0/);
  if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
});
test('invitation context is authenticated encrypted data, not a plaintext link', () => {
  const token = newToken(), sealed = sealSecret(token);
  assert(!sealed.includes(token)); assert.equal(unsealSecret(sealed), token);
  const tampered = Buffer.from(sealed, 'base64url'); tampered[20] ^= 1;
  assert.equal(unsealSecret(tampered.toString('base64url')), null);
});
test('outbox retains the provider idempotency key after ambiguous failure, changes it only for a known rejection', () => {
  const message = { dedupe_key: 'result:group:person', delivery_key: 'result:group:person:retry:2', attempts: 2, provider_status: null };
  assert.equal(nextDeliveryKey(message), message.delivery_key);
  assert.equal(nextDeliveryKey({ ...message, provider_status: 'failed' }), 'result:group:person:retry:3');
});
test('delivery receipts never infer delivery from enqueueing or an estimated open', () => {
  for (const status of ['queued', 'processing', 'sent']) {
    const receipt = normalizeDeliveryReceipt({ status });
    assert.equal(receipt.status, 'sent'); assert.equal(receipt.deliveredAt, null);
  }
  const opened = normalizeDeliveryReceipt({ status: 'opened', openedAt: '2026-11-10T10:00:00Z' });
  assert.equal(opened.status, 'opened'); assert.equal(opened.deliveredAt, null);
  const delivered = normalizeDeliveryReceipt({ status: 'sent', deliveredAt: '2026-11-10T10:00:00Z' });
  assert.equal(delivered.status, 'delivered'); assert(delivered.deliveredAt);
  assert.equal(normalizeDeliveryReceipt({ status: 'unknown' }), null);
});
test('negative provider receipts are visible and permanent failures are never auto-retryable', () => {
  for (const status of ['bounced', 'complained', 'suppressed']) {
    const receipt = normalizeDeliveryReceipt({ status, deliveredAt: '2026-11-10T10:00:00Z' });
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.terminal, true); assert.equal(receipt.retryable, false);
  }
  assert.equal(normalizeDeliveryReceipt({ status: 'sent', complainedAt: '2026-11-10T10:00:00Z' }).providerStatus, 'complained');
  assert.equal(normalizeDeliveryReceipt({ status: 'failed' }).retryable, true);
});
test('receipt polling backs off with age and unavailable providers', () => {
  const now = Date.now();
  assert.equal(receiptPollingDelay(new Date(now), false, false, now), 300);
  assert.equal(receiptPollingDelay(new Date(now), true, false, now), 1800);
  assert.equal(receiptPollingDelay(new Date(now), false, true, now), 1800);
  assert.equal(receiptPollingDelay(new Date(now - 2 * 86400000), false, false, now), 21600);
});
test('JSON mutations reject untrusted browser origins', () => {
  const previousUrl = process.env.APP_URL, previousVercel = process.env.VERCEL;
  process.env.APP_URL = 'https://example.test'; process.env.VERCEL = '1';
  assert.doesNotThrow(() => checkOrigin({ headers: { origin: 'https://example.test', 'sec-fetch-site': 'same-origin' } }));
  assert.throws(() => checkOrigin({ headers: { origin: 'https://attacker.test' } }), { code: 'INVALID_ORIGIN' });
  assert.throws(() => checkOrigin({ headers: { origin: 'https://example.test', 'sec-fetch-site': 'cross-site' } }), { code: 'INVALID_ORIGIN' });
  assert.throws(() => checkOrigin({ headers: { origin: 'http://localhost:8000' } }), { code: 'INVALID_ORIGIN' });
  if (previousUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = previousUrl;
  if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
});
test('scheduled draining requires the exact server-side bearer secret', () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-cron-secret-at-least-32-bytes-long';
  assert.doesNotThrow(() => verifyCron({ headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  assert.throws(() => verifyCron({ headers: {} }), { code: 'UNAUTHORIZED' });
  assert.throws(() => verifyCron({ headers: { authorization: 'Bearer incorrect' } }), { code: 'UNAUTHORIZED' });
  if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous;
});
test('profile and group validation reject malformed values before persistence', () => {
  assert.equal(normalizeEmail(' Person@Example.com '), 'person@example.com');
  assert.throws(() => normalizeEmail('Person\r\n@example.com'), { code: 'INVALID_EMAIL' });
  assert.equal(normalizeName('  Ana   Maria  ', 'nome', 80), 'Ana Maria');
  assert.throws(() => normalizeName('a\u0000b', 'nome', 80));
  const future = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);
  const group = { name: 'Natal', date: future, budget: 100.125 };
  assert.equal(validateGroup(group).budget, 100.13);
  for (const budget of [true, [], {}, '', null, -1, 100001, Infinity]) assert.throws(() => validateGroup({ ...group, budget }), { code: 'INVALID_BUDGET' });
  assert.throws(() => validateGroup({ ...group, date: '2099-02-30' }), { code: 'INVALID_DATE' });
});
test('avatars are decoded and re-encoded to a bounded WebP, never accepted as arbitrary data URLs', async () => {
  const input = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#ee775b' } }).png().toBuffer();
  const result = await sanitizeAvatar(`data:image/png;base64,${input.toString('base64')}`);
  assert.match(result, /^data:image\/webp;base64,/);
  const metadata = await sharp(Buffer.from(result.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.width, 256); assert.equal(metadata.height, 256); assert.equal(metadata.format, 'webp');
  await assert.rejects(sanitizeAvatar('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), { code: 'INVALID_AVATAR' });
  const disguisedSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>').toString('base64');
  await assert.rejects(sanitizeAvatar(`data:image/png;base64,${disguisedSvg}`), { code: 'INVALID_AVATAR' });
  await assert.rejects(sanitizeAvatar('data:image/png;base64,' + Buffer.from('not an image').toString('base64')), { code: 'INVALID_AVATAR' });
  await assert.rejects(sanitizeAvatar('a'.repeat(350001)), { code: 'INVALID_AVATAR' });
});
