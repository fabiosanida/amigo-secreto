import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';

let pool;
export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) throw new Error('Database is not configured');
    pool = new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
    pool.on('error', () => {});
    if (process.env.VERCEL) attachDatabasePool(pool);
  }
  return pool;
}
export const query = (sql, values = []) => getPool().query(sql, values);
export async function transaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function requireUUID(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(404, 'NOT_FOUND', 'Não encontramos esse registro.');
  }
  return value;
}
