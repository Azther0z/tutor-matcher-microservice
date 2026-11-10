import type { Tx } from '../db';
import { MINUTE_MS } from '../time';
import { emitCancelled, emitConfirmed } from './events';
import { loadBooking, type BookingRow } from './model';
import { resolveOperation } from './operations';

/** Reminder offsets in minutes before the lesson starts. */
export const REMINDER_OFFSETS = [60, 10] as const;

/**
 * Charge known applied: confirm once. Slots become BOOKED, the meeting starts provisioning, reminders are scheduled
 * (only those still in the future, so a late confirmation never sends a missed reminder) and the event is saved
 * in the same transaction. Returns the fresh row.
 */
export async function confirmBooking(tx: Tx, row: BookingRow, paidAt: Date, now: Date): Promise<BookingRow> {
  await tx.query(
    `UPDATE bookings SET status = 'CONFIRMED', paid_at = $2, hold_expires_at = NULL, pending_operation_id = NULL, revision = revision + 1,
            meeting_state = 'PROVISIONING', meeting_changed_at = $3, updated_at = $3
     WHERE id = $1 AND status = 'PAYMENT_DUE'`,
    [row.id, paidAt, now],
  );
  await tx.query("UPDATE availability_slots SET state = 'BOOKED', revision = revision + 1, updated_at = $2 WHERE booking_id = $1 AND state = 'HELD'", [row.id, now]);
  for (const offset of REMINDER_OFFSETS) {
    const dueAt = new Date(row.starts_at.getTime() - offset * MINUTE_MS);
    if (dueAt.getTime() > now.getTime()) {
      await tx.query(
        'INSERT INTO reminders (booking_id, schedule_version, offset_minutes, due_at, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [row.id, row.schedule_version, offset, dueAt, now],
      );
    }
  }
  const fresh = (await loadBooking(tx, row.id)) as BookingRow;
  await emitConfirmed(tx, fresh, now);
  return fresh;
}

export interface Cancellation {
  by: 'STUDENT' | 'TUTOR' | 'EXPIRY';
  reason: string | null;
  /** Amount actually returned to the student; 0 when nothing was paid. */
  refundSatang: bigint;
  now: Date;
  /** Public operation to mark SUCCEEDED, when the cancellation was asynchronous. */
  operationId?: string;
}

/**
 * Terminal cancellation. Student cancellation and hold expiry reopen eligible future slots; tutor cancellation closes them
 * until the tutor reopens. Callers invoke this only once any refund outcome is known.
 */
export async function finalizeCancellation(tx: Tx, row: BookingRow, input: Cancellation): Promise<BookingRow> {
  const reopen = input.by !== 'TUTOR';
  await tx.query(
    `UPDATE availability_slots
     SET state = CASE WHEN $2 AND starts_at > $3 THEN 'OPEN' ELSE 'CLOSED' END, booking_id = NULL, revision = revision + 1, updated_at = $3
     WHERE booking_id = $1`,
    [row.id, reopen, input.now],
  );
  await tx.query(
    `UPDATE bookings SET status = 'CANCELLED', cancelled_at = $2, cancelled_by = $3, cancellation_reason = $4,
            hold_expires_at = NULL, pending_operation_id = NULL, revision = revision + 1, updated_at = $2
     WHERE id = $1 AND status IN ('PAYMENT_DUE', 'CONFIRMED')`,
    [row.id, input.now, input.by, input.reason],
  );
  if (input.operationId) await resolveOperation(tx, input.operationId, 'SUCCEEDED', input.now);
  const fresh = (await loadBooking(tx, row.id)) as BookingRow;
  await emitCancelled(tx, fresh, input.by, input.reason, input.refundSatang, input.now);
  return fresh;
}
