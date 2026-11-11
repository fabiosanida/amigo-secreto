import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL_UNPOOLED before migrating.');
if (new URL(connectionString).hostname.includes('-pooler')) throw new Error('Use the direct, unpooled database URL for migrations.');
const migrationDirectory = new URL('../migrations/', import.meta.url);
const files = (await readdir(migrationDirectory)).filter(name => /^\d+\.sql$/.test(name)).sort();
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15000, statement_timeout: 30000 });
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('amigo-secreto-migrations'))");
  await client.query('CREATE TABLE IF NOT EXISTS as_migrations (version text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = [];
  for (const file of files) {
    const version = file.slice(0, -4);
    const sql = await readFile(new URL(file, migrationDirectory), 'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query('SELECT digest FROM as_migrations WHERE version=$1', [version]);
    if (existing.rows.length && existing.rows[0].digest !== digest) throw new Error(`Migration ${version} has changed after application. Add a new migration instead.`);
    if (!existing.rows.length) {
      await client.query(sql);
      await client.query('INSERT INTO as_migrations(version,digest) VALUES($1,$2)', [version, digest]);
      applied.push(version);
    }
  }
  await client.query('COMMIT');
  console.log(applied.length ? `Migrations applied successfully: ${applied.join(', ')}.` : 'All migrations are already applied.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Migration failed:', error.code || 'check connection/schema');
  process.exitCode = 1;
} finally { await client.end(); }
