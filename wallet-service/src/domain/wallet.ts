import type { Pool } from 'pg';
import type { Actor } from '../auth';
import { notFound } from '../errors';
import { money } from '../money';
import { bangkokMonthStart } from '../time';
import { readWallet } from './ledger';
import { pageMeta, type Page } from './reply';

interface LedgerRow {
  id: string; user_id: string; type: string; direction: string; amount_satang: string; balance_after_satang: string;
  operation_id: string; booking_id: string | null; payout_account_id: string | null; created_at: Date;
}

export function transactionView(row: LedgerRow) {
  return {
    id: row.id,
    type: row.type,
    amount: money(BigInt(row.amount_satang)),
    direction: row.direction,
    balanceAfter: money(BigInt(row.balance_after_satang)),
    operationId: row.operation_id,
    bookingId: row.booking_id,
    payoutAccountId: row.payout_account_id,
    createdAt: row.created_at.toISOString(),
  };
}

export async function walletOverview(pool: Pool, actor: Actor, now: Date) {
  const wallet = await readWallet(pool, actor.userId);
  const sum = async (sql: string, params: unknown[]) => BigInt((await pool.query(sql, params)).rows[0].total);
  // Pending earnings live on financial records; they are never part of the spendable balance.
  const pending = await sum("SELECT COALESCE(SUM(pending_earning_satang), 0) AS total FROM financial_records WHERE tutor_user_id = $1 AND status = 'COMPLETED'", [actor.userId]);
  const thisMonth = await sum("SELECT COALESCE(SUM(amount_satang), 0) AS total FROM ledger_entries WHERE user_id = $1 AND type = 'LESSON_EARNING' AND created_at >= $2", [actor.userId, bangkokMonthStart(now)]);
  const paidOut = await sum("SELECT COALESCE(SUM(amount_satang), 0) AS total FROM ledger_entries WHERE user_id = $1 AND type = 'PAYOUT'", [actor.userId]);
  // Wallet only knows bookings whose payment attempt was declined and whose hold is still open. Booking owns the full list.
  const due = await pool.query<{ booking_id: string }>(
    "SELECT booking_id FROM financial_records WHERE student_user_id = $1 AND status = 'UNPAID' AND payment_gate = 'OPEN' AND hold_expires_at > $2 ORDER BY hold_expires_at, booking_id",
    [actor.userId, now],
  );
  return {
    userId: actor.userId,
    postedBalance: money(wallet.posted),
    reservedPayouts: money(wallet.reserved),
    availableBalance: money(wallet.available),
    pendingEarnings: money(pending),
    earningsThisMonth: money(thisMonth),
    totalPaidOut: money(paidOut),
    paymentDueBookings: due.rows.map((r) => ({ type: 'booking', id: r.booking_id, url: `/api/bookings/${r.booking_id}` })),
  };
}

export async function listTransactions(pool: Pool, userId: string, type: string | undefined, page: Page) {
  const params: unknown[] = [userId];
  let where = 'WHERE user_id = $1';
  if (type) { params.push(type); where += ` AND type = $${params.length}`; }
  const total = Number((await pool.query(`SELECT count(*) FROM ledger_entries ${where}`, params)).rows[0].count);
  const { rows } = await pool.query<LedgerRow>(
    `SELECT * FROM ledger_entries ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.pageSize, page.offset],
  );
  return { items: rows.map(transactionView), pagination: pageMeta(page, total) };
}

export async function getTransaction(pool: Pool, userId: string, id: string) {
  const { rows } = await pool.query<LedgerRow>('SELECT * FROM ledger_entries WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows[0]) throw notFound('NOT_FOUND', 'Transaction not found');
  return transactionView(rows[0]);
}
