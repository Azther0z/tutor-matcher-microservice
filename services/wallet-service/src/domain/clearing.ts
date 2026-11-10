import type { Pool } from 'pg';
import { withRetry, withTx } from '../db';
import { derivedId } from '../ids';
import { money } from '../money';
import type { Clock } from '../time';
import { bumpRecord, lockRecord } from './financial';
import { lockWallet, postMovement } from './ledger';
import { enqueueEvent } from './outbox';

export type ClearResult = 'CLEARED' | 'SKIPPED';

/**
 * Releases one pending earning under the booking's financial-record lock. It rechecks every condition
 * inside the lock, so a dispute that committed first (hold) or a refund that already removed the earning wins.
 * The ledger's (type, operation_id) uniqueness plus a deterministic operation ID make it safe to repeat.
 */
export async function clearEarning(pool: Pool, clock: Clock, bookingId: string): Promise<ClearResult> {
  return withRetry(() => withTx(pool, async (tx) => {
    const now = clock.now();
    const record = await lockRecord(tx, bookingId);
    if (!record) return 'SKIPPED';
    const pending = BigInt(record.pending_earning_satang);
    const due = record.clearing_due_at !== null && record.clearing_due_at.getTime() <= now.getTime();
    if (record.status !== 'COMPLETED' || record.dispute_held || !due || pending <= 0n) return 'SKIPPED';

    await lockWallet(tx, record.tutor_user_id, now);
    const operationId = derivedId(`earning:${bookingId}`);
    const moved = await postMovement(tx, { userId: record.tutor_user_id, type: 'LESSON_EARNING', direction: 'IN', amount: pending, operationId, bookingId, now });
    const updated = await bumpRecord(tx, bookingId, "pending_earning_satang = 0, status = 'SETTLED'", [], now);
    await enqueueEvent(tx, {
      type: 'wallet.earning-cleared', aggregate: { type: 'booking-financial-record', id: bookingId, version: updated.revision },
      targets: { kind: 'USERS', userIds: [record.tutor_user_id] }, group: 'WALLET_PAYMENTS',
      data: { bookingId, transactionId: moved.id, amount: money(pending) }, dedupeKey: `earning:${bookingId}`, now,
    });
    return 'CLEARED';
  }));
}

/** One sweep. Due work is found from the database, never from an in-memory timer, so a restart loses nothing. */
export async function clearDueEarnings(pool: Pool, clock: Clock, limit = 50): Promise<{ cleared: number; skipped: number }> {
  const { rows } = await pool.query<{ booking_id: string }>(
    `SELECT booking_id FROM financial_records
     WHERE status = 'COMPLETED' AND dispute_held = false AND pending_earning_satang > 0 AND clearing_due_at <= $1
     ORDER BY clearing_due_at, booking_id LIMIT $2`,
    [clock.now(), limit],
  );
  let cleared = 0;
  let skipped = 0;
  for (const { booking_id } of rows) {
    const result = await clearEarning(pool, clock, booking_id);
    if (result === 'CLEARED') cleared += 1; else skipped += 1;
  }
  return { cleared, skipped };
}
