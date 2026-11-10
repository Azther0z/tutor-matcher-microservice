import type { Pool } from 'pg';
import type { Actor } from '../auth';
import type { Tx } from '../db';
import { notFound } from '../errors';
import { money } from '../money';
import { iso } from '../time';
import { operationRef } from './operations';

export type BookingStatus = 'PAYMENT_DUE' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
export type MeetingState = 'PROVISIONING' | 'MISSING' | 'READY';

/** A bookings row joined with its pending operation and ordered slot ids (see BOOKING_SELECT). */
export interface BookingRow {
  id: string;
  student_user_id: string;
  tutor_id: string;
  tutor_user_id: string;
  student_display_name: string;
  tutor_display_name: string;
  subject_id: string;
  subject_name: string;
  subject_description: string;
  subject_rate_satang: string;
  subject_revision: string;
  description: string;
  starts_at: Date;
  ends_at: Date;
  slot_count: number;
  amount_satang: string;
  status: BookingStatus;
  revision: string;
  hold_expires_at: Date | null;
  paid_at: Date | null;
  completed_at: Date | null;
  tutor_confirmed_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by: 'STUDENT' | 'TUTOR' | 'EXPIRY' | null;
  cancellation_reason: string | null;
  schedule_version: string;
  pending_operation_id: string | null;
  meeting_state: MeetingState;
  meeting_provider_ref: string | null;
  meeting_generated_url: string | null;
  meeting_custom_url: string | null;
  meeting_changed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  op_id?: string | null;
  op_status?: string | null;
  op_resource_type?: string | null;
  op_resource_id?: string | null;
  op_resource_url?: string | null;
  slot_ids?: string[] | null;
}

/** Selects bookings with the pending public operation and the covered slot ids in slot order. */
export const BOOKING_SELECT = `
  SELECT b.*,
         o.id AS op_id, o.status AS op_status, o.resource_type AS op_resource_type, o.resource_id AS op_resource_id, o.resource_url AS op_resource_url,
         (SELECT array_agg(bs.slot_id::text ORDER BY bs.position) FROM booking_slots bs WHERE bs.booking_id = b.id) AS slot_ids
  FROM bookings b
  LEFT JOIN booking_operations o ON o.id = b.pending_operation_id AND o.status = 'PENDING'`;

type Queryable = Pool | Tx;

export async function loadBooking(db: Queryable, id: string): Promise<BookingRow | null> {
  const { rows } = await db.query<BookingRow>(`${BOOKING_SELECT} WHERE b.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Row lock for a lifecycle decision. Always taken after any slot locks. */
export async function lockBooking(tx: Tx, id: string): Promise<BookingRow> {
  const { rows } = await tx.query<BookingRow>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('NOT_FOUND', 'Booking not found');
  const full = await loadBooking(tx, id);
  return full as BookingRow;
}

export const isParticipant = (row: BookingRow, userId: string): boolean => row.student_user_id === userId || row.tutor_user_id === userId;

/** Participant-only read; anyone else receives 404 so an identifier grants nothing. */
export function requireParticipant(row: BookingRow | null, actor: Actor): BookingRow {
  if (!row || !isParticipant(row, actor.userId)) throw notFound('NOT_FOUND', 'Booking not found');
  return row;
}

export const toIso = (value: Date | null): string | null => (value ? iso(value) : null);

/** The meeting access a participant may see right now. URLs are null whenever access is closed or not yet available. */
export function meetingView(row: BookingRow, viewerUserId: string, now: Date) {
  const base = {
    providerReference: row.meeting_provider_ref,
    changedAt: toIso(row.meeting_changed_at),
  };
  const ended = now.getTime() >= row.ends_at.getTime();
  // A paid booking with an unresolved action is mid-cancellation: no joining and no edits until the outcome is known.
  const settling = row.status === 'CONFIRMED' && Boolean(row.op_id) && row.op_status === 'PENDING';
  if (row.status === 'CANCELLED' || row.status === 'COMPLETED' || (row.status === 'CONFIRMED' && (ended || settling))) {
    return { state: 'CLOSED' as const, ...base, generatedUrl: null, customMeetingUrl: null, effectiveUrl: null, canJoin: false, canEdit: false };
  }
  if (row.status === 'PAYMENT_DUE') {
    return { state: 'PROVISIONING' as const, ...base, generatedUrl: null, customMeetingUrl: null, effectiveUrl: null, canJoin: false, canEdit: false };
  }
  const generated = row.meeting_state === 'READY' ? row.meeting_generated_url : null;
  const custom = row.meeting_custom_url;
  const effective = custom ?? generated;
  const state = effective ? ('READY' as const) : row.meeting_state === 'PROVISIONING' ? ('PROVISIONING' as const) : ('MISSING' as const);
  return {
    state,
    ...base,
    generatedUrl: generated,
    customMeetingUrl: custom,
    effectiveUrl: effective,
    canJoin: Boolean(effective),
    canEdit: viewerUserId === row.tutor_user_id,
  };
}

export function bookingView(row: BookingRow, viewerUserId: string, now: Date) {
  const pending = row.op_id && row.op_status === 'PENDING'
    ? operationRef({ id: row.op_id, status: 'PENDING', resource_type: row.op_resource_type ?? null, resource_id: row.op_resource_id ?? null, resource_url: row.op_resource_url ?? null })
    : null;
  return {
    id: row.id,
    studentUserId: row.student_user_id,
    tutorId: row.tutor_id,
    tutorUserId: row.tutor_user_id,
    subject: {
      id: row.subject_id,
      tutorId: row.tutor_id,
      tutorUserId: row.tutor_user_id,
      name: row.subject_name,
      description: row.subject_description,
      hourlyRate: money(BigInt(row.subject_rate_satang)).amount,
      format: 'ONLINE' as const,
      revision: row.subject_revision,
    },
    availabilityIds: row.slot_ids ?? [],
    description: row.description,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    amount: money(BigInt(row.amount_satang)),
    status: row.status,
    revision: String(row.revision),
    holdExpiresAt: row.status === 'PAYMENT_DUE' ? toIso(row.hold_expires_at) : null,
    paidAt: toIso(row.paid_at),
    completedAt: toIso(row.completed_at),
    cancelledAt: toIso(row.cancelled_at),
    cancellationReason: row.cancellation_reason,
    pendingOperation: pending,
    meeting: meetingView(row, viewerUserId, now),
    canReview: row.status === 'COMPLETED' && row.student_user_id === viewerUserId,
    studentDisplayName: row.student_display_name,
    tutorDisplayName: row.tutor_display_name,
  };
}

export const etag = (revision: string | bigint | number): string => `"${revision}"`;
