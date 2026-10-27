const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS topups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('TOPUP', 'PAYMENT', 'REFUND')),
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reference TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (type, reference)
    );
  `);
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lockWallet(client, userId) {
  await client.query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const { rows } = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  return rows[0].balance;
}

async function applyMovement(client, { userId, type, amount, reference }) {
  const { rows } = await client.query(
    'UPDATE wallets SET balance = balance + $2, updated_at = now() WHERE user_id = $1 RETURNING balance',
    [userId, amount],
  );
  const balance = rows[0].balance;
  const inserted = await client.query(
    'INSERT INTO transactions (user_id, type, amount, balance_after, reference) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [userId, type, amount, balance, reference],
  );
  return inserted.rows[0];
}

async function findTransaction(client, type, reference) {
  const { rows } = await client.query('SELECT * FROM transactions WHERE type = $1 AND reference = $2', [type, reference]);
  return rows[0] || null;
}

module.exports = { pool, migrate, withTransaction, lockWallet, applyMovement, findTransaction };
