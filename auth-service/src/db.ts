import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 2000 });

export async function migrate(db: Pool = pool): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const migrationDir=process.env.AUTH_MIGRATIONS_DIR ?? path.join(process.cwd(), 'migrations');
  const migrationFiles=(await readdir(migrationDir)).filter(name=>/^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort((a,b)=>Number(a.split('_')[0])-Number(b.split('_')[0]));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [741012661]);
    for(const file of migrationFiles){
      const version=Number(file.split('_')[0]);
      const applied=await client.query('SELECT 1 FROM schema_migrations WHERE version=$1',[version]);
      if(applied.rowCount)continue;
      await client.query(await readFile(path.join(migrationDir,file),'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING',[version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type UserRow = QueryResultRow & {
  id: string; email: string; first_name: string; last_name: string;
  password_hash: string; capabilities: string[]; status: string; revision: string;
  created_at: Date; synthetic: boolean;
};
