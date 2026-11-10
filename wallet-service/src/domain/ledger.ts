import { newId } from '../ids';
import type { Tx } from '../db';

export type LedgerType = 'TOP_UP' | 'LESSON_PAYMENT' | 'LESSON_EARNING' | 'REFUND' | 'PAYOUT';

export interface WalletBalance {
  posted: bigint;
  reserved: bigint;
  available: bigint;
}

function balance(row: { posted_satang: string; reserved_satang: string }): WalletBalance {
  const posted = BigInt(row.posted_satang);
  const reserved = BigInt(row.reserved_satang);
  return { posted, reserved, available: posted - reserved };
}

/** Creates the wallet lazily (one wallet per account) and takes its row lock. */
export async function lockWallet(tx: Tx, userId: string, now: Date): Promise<WalletBalance> {
  await tx.query('INSERT INTO wallets (user_id, created_at, updated_at) VALUES ($1, $2, $2) ON CONFLICT (user_id) DO NOTHING', [userId, now]);
  const { rows } = await tx.query('SELECT posted_satang, reserved_satang FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  return balance(rows[0]);
}

export async function readWallet(tx: Pick<Tx, 'query'>, userId: string): Promise<WalletBalance> {
  const { rows } = await tx.query('SELECT posted_satang, reserved_satang FROM wallets WHERE user_id = $1', [userId]);
  return rows[0] ? balance(rows[0]) : { posted: 0n, reserved: 0n, available: 0n };
}

export interface Movement {
  userId: string;
  type: LedgerType;
  direction: 'IN' | 'OUT';
  amount: bigint;
  operationId: string;
  bookingId?: string | null;
  payoutAccountId?: string | null;
  now: Date;
  /** Payout success consumes the reservation in the same statement as the posted debit. */
  releaseReservation?: bigint;
}

/**
 * Posts one completed movement. The caller must already hold the wallet lock and have checked
 * available funds; the table checks are a last line of defence, not the business rule.
 * (type, operation_id) is unique, so a repeated operation cannot post twice.
 */
export async function postMovement(tx: Tx, movement: Movement): Promise<{ id: string; balanceAfter: bigint }> {
  const delta = movement.direction === 'IN' ? movement.amount : -movement.amount;
  const release = movement.releaseReservation ?? 0n;
  const updated = await tx.query(
    `UPDATE wallets SET posted_satang = posted_satang + $2, reserved_satang = reserved_satang - $3, updated_at = $4
     WHERE user_id = $1 RETURNING posted_satang`,
    [movement.userId, delta, release, movement.now],
  );
  const balanceAfter = BigInt(updated.rows[0].posted_satang);
  const id = newId();
  await tx.query(
    `INSERT INTO ledger_entries (id, user_id, type, direction, amount_satang, balance_after_satang, operation_id, booking_id, payout_account_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, movement.userId, movement.type, movement.direction, movement.amount, balanceAfter, movement.operationId,
      movement.bookingId ?? null, movement.payoutAccountId ?? null, movement.now],
  );
  return { id, balanceAfter };
}

export async function adjustReservation(tx: Tx, userId: string, delta: bigint, now: Date): Promise<void> {
  await tx.query('UPDATE wallets SET reserved_satang = reserved_satang + $2, updated_at = $3 WHERE user_id = $1', [userId, delta, now]);
}
