import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { asAppError } from './errors';

export type Tx = PoolClient;

export function createPool(connectionString: string): Pool {
  // pg parses BIGINT as string by default; keep it that way and convert with BigInt() explicitly.
  return new Pool({ connectionString, max: 20 });
}

export async function migrate(pool: Pool, dir = path.resolve(__dirname, '../migrations')): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // One migrator at a time across replicas.
    await client.query('SELECT pg_advisory_lock(74_311_001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(74_311_001)').catch(() => undefined);
    client.release();
  }
  return applied;
}

/** Short local transaction. Never hold one open across a gRPC/HTTP/AMQP call. */
export async function withTx<T>(pool: Pool, work: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Retry only for contention that rolled back with nothing committed (deadlock, serialization). */
export async function withRetry<T>(work: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const app = asAppError(error);
      if (app.code !== 'CONTENTION' || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20));
    }
  }
}

export const big = (value: string | number | bigint): bigint => BigInt(value);
