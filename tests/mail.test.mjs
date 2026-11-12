import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationContent, sendNotification, getDeliveryReceipt } from '../lib/mail.js';

test('email templates escape user data and use a public PNG brand', () => {
  process.env.APP_URL = 'https://amigosecreto.example';
  const message = notificationContent({ kind: 'invite', group: { name: '<script>alert(1)</script>', organizerName: 'Ana & Bia', date: '2026-12-24', budget: 100 }, inviteToken: 'personal-link' });
  assert(!message.html.includes('<script>'));
  assert(message.html.includes('&lt;script&gt;'));
  assert(message.html.includes('Ana &amp; Bia'));
  assert(message.html.includes('https://amigosecreto.example/assets/mark.png?v=1'));
  assert(message.html.includes('#invitation?token=personal-link'));
});

test('mail adapter requires provider acceptance and preserves idempotency', async () => {
  process.env.NOTIFICATIONS_API_URL = 'https://notifications.example';
  process.env.NOTIFICATIONS_API_KEY = 'test-only-not-a-credential';
  const original = globalThis.fetch;
  const payload = { kind: 'verify', to: 'fixture@example.test', user: { firstName: 'Fixture' }, code: '001234', token: 'one-time-token', idempotencyKey: 'test-message-unique' };
  try {
    globalThis.fetch = async (_url, options) => {
      const data = JSON.parse(options.body);
      assert.equal(data.idempotencyKey, payload.idempotencyKey);
      assert(data.html && data.text);
      return Response.json({ id: 'email-id', status: 'sent' });
    };
    assert.equal((await sendNotification(payload)).status, 'sent');
    globalThis.fetch = async () => Response.json({});
    await assert.rejects(sendNotification(payload), { code: 'EMAIL_SEND_FAILED' });
    globalThis.fetch = async () => Response.json({ id: 'email-id', status: 'failed' }, { status: 502 });
    await assert.rejects(sendNotification(payload), error => error.definitiveFailure && error.providerId === 'email-id');
    globalThis.fetch = async () => { throw new TypeError('Lost connection'); };
    await assert.rejects(sendNotification(payload), error => !error.definitiveFailure);
  } finally { globalThis.fetch = original; }
});

test('receipt lookup cannot accept an unrelated delivery', async () => {
  const original = globalThis.fetch;
  const id = '8754d5eb-3a28-4938-8c57-ea743ddbe80f';
  try {
    globalThis.fetch = async () => Response.json({ id: 'another-message', status: 'delivered' });
    await assert.rejects(getDeliveryReceipt(id));
    globalThis.fetch = async () => new Response('{}', { status: 404 });
    assert.equal(await getDeliveryReceipt(id), null);
  } finally { globalThis.fetch = original; }
});

test('dependent results identify the child and guardian without requesting a child email', () => {
  const message = notificationContent({ kind: 'result', user: { firstName: 'Responsável' }, dependent: { name: 'Bia <script>' },
    group: { id: 'group', name: 'Família', date: '2026-12-24', budget: 100 }, match: { name: 'Leo <b>', isDependent: true, responsibleName: 'Outra <pessoa>' } });
  assert.match(message.subject, /O amigo secreto de Bia/);
  assert.match(message.text, /Bia <script> tirou Leo <b>/);
  assert.match(message.text, /como responsável pelo dependente/);
  assert(message.html.includes('Bia &lt;script&gt;')); assert(!message.html.includes('<script>'));
  assert(message.html.includes('Outra &lt;pessoa&gt;')); assert(message.html.includes('Ver resultado do dependente'));
  assert(!message.text.includes('você tirou'));
});
