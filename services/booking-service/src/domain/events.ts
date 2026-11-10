import type { Tx } from '../db';
import { money } from '../money';
import { HOUR_MS, iso } from '../time';
import { enqueueEvent } from './outbox';
import type { BookingRow } from './model';

const participants = (row: Pick<BookingRow, 'student_user_id' | 'tutor_user_id'>) => ({
  kind: 'USERS' as const,
  userIds: [row.student_user_id, row.tutor_user_id],
});

const aggregate = (row: Pick<BookingRow, 'id' | 'revision'>) => ({ type: 'booking', id: row.id, version: String(row.revision) });

/** booking.confirmed: the charge is known applied. Written in the same transaction as the confirmation. */
export function emitConfirmed(tx: Tx, row: BookingRow, now: Date) {
  return enqueueEvent(tx, {
    type: 'booking.confirmed', aggregate: aggregate(row), targets: participants(row), group: 'BOOKING_UPDATES', now,
    dedupeKey: `confirmed:${row.id}`,
    data: { bookingId: row.id, scheduleVersion: row.schedule_version, startsAt: iso(row.starts_at), endsAt: iso(row.ends_at) },
  });
}

/** booking.cancelled: refund is the amount actually returned (0.00 when nothing was paid). */
export function emitCancelled(tx: Tx, row: BookingRow, cancelledBy: 'STUDENT' | 'TUTOR' | 'EXPIRY', reason: string | null, refundSatang: bigint, now: Date) {
  return enqueueEvent(tx, {
    type: 'booking.cancelled', aggregate: aggregate(row), targets: participants(row), group: 'BOOKING_UPDATES', now,
    dedupeKey: `cancelled:${row.id}`,
    data: { bookingId: row.id, cancelledBy, reason, refund: money(refundSatang) },
  });
}

/** booking.completed: carries the original confirmation time, never a retry time. */
export function emitCompleted(tx: Tx, row: BookingRow, tutorConfirmedAt: Date, now: Date) {
  return enqueueEvent(tx, {
    type: 'booking.completed', aggregate: aggregate(row), targets: participants(row), group: 'BOOKING_UPDATES', now,
    dedupeKey: `completed:${row.id}`,
    data: { bookingId: row.id, tutorConfirmedAt: iso(tutorConfirmedAt), clearingDueAt: iso(new Date(tutorConfirmedAt.getTime() + 24 * HOUR_MS)) },
  });
}

/** booking.meeting-updated: only the state, never the URL. Sent to the student. */
export function emitMeetingUpdated(tx: Tx, row: BookingRow, state: 'MISSING' | 'READY', changedAt: Date, now: Date) {
  return enqueueEvent(tx, {
    type: 'booking.meeting-updated', aggregate: aggregate(row), targets: { kind: 'USERS', userIds: [row.student_user_id] }, group: 'BOOKING_UPDATES', now,
    dedupeKey: `meeting:${row.id}:${row.revision}:${state}`,
    data: { bookingId: row.id, state, changedAt: iso(changedAt) },
  });
}

/** booking.reminder-due: stable identity per schedule version and offset, so a retried sweep cannot send a second one. */
export function emitReminder(tx: Tx, row: BookingRow, offsetMinutes: 60 | 10, now: Date) {
  return enqueueEvent(tx, {
    type: 'booking.reminder-due', aggregate: aggregate(row), targets: participants(row), group: 'LESSON_REMINDERS', now,
    dedupeKey: `reminder:${row.id}:${row.schedule_version}:${offsetMinutes}`,
    data: { bookingId: row.id, scheduleVersion: row.schedule_version, offsetMinutes, startsAt: iso(row.starts_at) },
  });
}
