import test from 'node:test';
import assert from 'node:assert/strict';
import { getPool } from '../lib/db.js';
import { drainOutbox } from '../lib/groups.js';

test('an idle maintenance check does not open worker transactions or send notifications', async () => {
  const previousURL = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
  const pool = getPool(), originalQuery = pool.query, originalConnect = pool.connect, originalFetch = globalThis.fetch;
  let reads = 0;
  pool.query = async () => { reads++; return { rows: [{ outbox_due: false, receipts_due: false }] }; };
  pool.connect = async () => { throw new Error('An idle drain must not open a worker transaction'); };
  globalThis.fetch = async () => { throw new Error('An idle drain must not contact the notification provider'); };
  try {
    assert.deepEqual(await drainOutbox(), { sent: 0, failed: 0, receipts: { checked: 0, updated: 0 } });
    assert.equal(reads, 1);
  } finally {
    pool.query = originalQuery; pool.connect = originalConnect; globalThis.fetch = originalFetch;
    if (previousURL === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousURL;
    await pool.end();
  }
});
