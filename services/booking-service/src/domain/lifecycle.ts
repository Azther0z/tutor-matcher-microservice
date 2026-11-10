import { actorAdmission, type Actor } from '../auth';
import type { CallContext, CompletionCommand } from '../clients';
import { withRetry, withTx } from '../db';
import { conflict, forbidden, notFound, revisionMismatch, unprocessable } from '../errors';
import type { IdempotencyScope } from '../http/idempotency';
import { derivedId, newId } from '../ids';
import { backoffMs } from '../outbox/publisher';
import { iso } from '../time';
import type { Ctx } from './context';
import { emitCompleted, emitMeetingUpdated, emitReminder } from './events';
import { bookingView, loadBooking, lockBooking, requireParticipant, type BookingRow } from './model';
import type { Reply } from './reply';

const ATTENTION_AFTER = 10;
const LEASE_MS = 30_000;

const ok = (ctx: Ctx, row: BookingRow, viewer: string): Reply => {
  const view = bookingView(row, viewer, ctx.clock.now());
  return { status: 200, body: view, headers: { ETag: `"${view.revision}"` } };
};

export interface Conditional {
  bookingId: string;
  /** Revision from If-Match. */
  ifMatch: string;
  scope: IdempotencyScope;
}

/**
 * Tutor confirms the lesson, at or after its scheduled end. The completed state, the first confirmation time and the
 * durable Wallet handoff are written together; every retry sends that same original time.
 */
export function completeBooking(ctx: Ctx, actor: Actor, input: Conditional): Promise<Reply> {
  return ctx.idem.run({ ...input.scope, now: ctx.clock.now() }, async (tx) => {
    const row = await lockBooking(tx, input.bookingId);
    requireParticipant(row, actor);
    if (row.tutor_user_id !== actor.userId) throw forbidden('TUTOR_ONLY', 'Only the assigned tutor can confirm completion');
    if (String(row.revision) !== input.ifMatch) throw revisionMismatch('REVISION_MISMATCH', 'This booking changed; reload it and try again');
    if (row.status !== 'CONFIRMED' || (row.op_id && row.op_status === 'PENDING')) throw conflict('BOOKING_NOT_CONFIRMED', 'Only a confirmed lesson with no pending action can be completed');
    const now = ctx.clock.now();
    if (now.getTime() < row.ends_at.getTime()) throw conflict('LESSON_NOT_ENDED', 'The lesson has not ended yet');

    await tx.query(
      `UPDATE bookings SET status = 'COMPLETED', completed_at = $2, tutor_confirmed_at = $2, revision = revision + 1, updated_at = $2
       WHERE id = $1 AND status = 'CONFIRMED'`,
      [row.id, now],
    );
    const fresh = (await loadBooking(tx, row.id)) as BookingRow;
    const command: CompletionCommand = {
      sourceOperationId: derivedId(`completion:${row.id}`),
      bookingVersion: String(fresh.revision),
      tutorConfirmedAt: iso(now),
      admission: actorAdmission(actor),
    };
    await tx.query(
      `INSERT INTO completion_handoffs (booking_id, operation_id, command, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, $4) ON CONFLICT (booking_id) DO NOTHING`,
      [row.id, command.sourceOperationId, JSON.stringify(command), now],
    );
    await emitCompleted(tx, fresh, now, now);
    return ok(ctx, fresh, actor.userId);
  });
}

/** Sends the saved completion command (original confirmation time) to Wallet until it is acknowledged. */
export async function recoverCompletions(ctx: Ctx, batch = 10): Promise<number> {
  const now = ctx.clock.now();
  const claimed = await ctx.pool.query<{ booking_id: string; command: CompletionCommand; fence: string; attempts: number }>(
    `UPDATE completion_handoffs SET lease_until = $1, fence = fence + 1
     WHERE booking_id IN (
       SELECT booking_id FROM completion_handoffs
       WHERE status = 'PENDING' AND next_attempt_at <= $2 AND (lease_until IS NULL OR lease_until <= $2)
       ORDER BY next_attempt_at LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING booking_id, command, fence, attempts`,
    [new Date(now.getTime() + LEASE_MS), now, batch],
  );
  for (const item of claimed.rows) {
    try {
      await ctx.peers.wallet.recordLessonCompletion(item.booking_id, item.command, { requestId: newId() });
      await ctx.pool.query("UPDATE completion_handoffs SET status = 'DONE', lease_until = NULL, updated_at = $3 WHERE booking_id = $1 AND fence = $2", [item.booking_id, item.fence, ctx.clock.now()]);
    } catch (error) {
      const attempts = item.attempts + 1;
      await ctx.pool.query(
        `UPDATE completion_handoffs SET attempts = $3, lease_until = NULL, next_attempt_at = $4, last_error = $5, needs_attention = needs_attention OR $6
         WHERE booking_id = $1 AND fence = $2 AND status = 'PENDING'`,
        [item.booking_id, item.fence, attempts, new Date(ctx.clock.now().getTime() + backoffMs(attempts)), String((error as Error).message).slice(0, 500), attempts >= ATTENTION_AFTER],
      );
    }
  }
  return claimed.rows.length;
}

/** Tutor sets, replaces or removes an HTTPS meeting link until the scheduled end. Removing restores the generated link. */
export function putMeetingOverride(ctx: Ctx, actor: Actor, input: Conditional & { body: unknown }): Promise<Reply> {
  const body = ctx.contracts.assertDef<{ customMeetingUrl: string | null }>('MeetingWrite', input.body, '/body');
  return ctx.idem.run({ ...input.scope, now: ctx.clock.now() }, async (tx) => {
    const row = await lockBooking(tx, input.bookingId);
    requireParticipant(row, actor);
    if (row.tutor_user_id !== actor.userId) throw forbidden('TUTOR_ONLY', 'Only the assigned tutor can change the meeting link');
    const now = ctx.clock.now();
    if (String(row.revision) !== input.ifMatch) throw revisionMismatch('REVISION_MISMATCH', 'This booking changed; reload it and try again');
    if (row.status !== 'CONFIRMED' || now.getTime() >= row.ends_at.getTime() || (row.op_id && row.op_status === 'PENDING')) {
      throw conflict('MEETING_EDIT_CLOSED', 'The meeting link can no longer be changed');
    }
    await tx.query('UPDATE bookings SET meeting_custom_url = $2, meeting_changed_at = $3, revision = revision + 1, updated_at = $3 WHERE id = $1', [row.id, body.customMeetingUrl, now]);
    const fresh = (await loadBooking(tx, row.id)) as BookingRow;
    const hasLink = Boolean(fresh.meeting_custom_url || (fresh.meeting_state === 'READY' && fresh.meeting_generated_url));
    await emitMeetingUpdated(tx, fresh, hasLink ? 'READY' : 'MISSING', now, now);
    return ok(ctx, fresh, actor.userId);
  });
}

const generatedUrl = (providerRef: string) => `https://meet.example.test/lesson/${providerRef}`;

/** The simulated meeting provider: a CONFIRMED booking with no provider reference gets a generated synthetic link. */
export async function provisionMeetings(ctx: Ctx, batch = 20): Promise<number> {
  const due = await ctx.pool.query<{ id: string }>(
    `SELECT id FROM bookings WHERE status = 'CONFIRMED' AND meeting_state = 'PROVISIONING' AND meeting_provider_ref IS NULL ORDER BY updated_at LIMIT $1`, [batch]);
  for (const { id } of due.rows) {
    await withRetry(() => withTx(ctx.pool, async (tx) => {
      const row = await lockBooking(tx, id);
      if (row.status !== 'CONFIRMED' || row.meeting_state !== 'PROVISIONING' || row.meeting_provider_ref) return;
      const now = ctx.clock.now();
      const ref = derivedId(`meeting:${id}`);
      await tx.query(
        "UPDATE bookings SET meeting_state = 'READY', meeting_provider_ref = $2, meeting_generated_url = $3, meeting_changed_at = $4, revision = revision + 1, updated_at = $4 WHERE id = $1",
        [id, ref, generatedUrl(ref), now],
      );
      await emitMeetingUpdated(tx, (await loadBooking(tx, id)) as BookingRow, 'READY', now, now);
    }));
  }
  return due.rows.length;
}

/**
 * Admin-only synthetic meeting outcome (ADMIN + DEMO_MODE + both participants on `.test` addresses). Provider failure
 * never reverses payment: it only changes meeting access.
 */
export async function setDemoOutcome(ctx: Ctx, actor: Actor, input: { bookingId: string; body: unknown; scope: IdempotencyScope; context: CallContext }): Promise<Reply> {
  if (!ctx.config.demoMode) throw forbidden('DEMO_DISABLED', 'Demo provider controls are disabled');
  const body = ctx.contracts.assertDef<{ outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; providerReference: string }>('DemoOutcome', input.body, '/body');
  const replay = await ctx.idem.peek(input.scope);
  if (replay) return replay;
  const existing = await loadBooking(ctx.pool, input.bookingId);
  if (!existing) throw notFound('NOT_FOUND', 'Booking not found');
  const accounts = await ctx.peers.auth.lookupAccounts([existing.student_user_id, existing.tutor_user_id], input.context);
  if (accounts.length !== 2 || accounts.some((a) => !a.email.endsWith('.test'))) throw forbidden('RESOURCE_NOT_SYNTHETIC', 'Only synthetic bookings can use demo controls');

  return ctx.idem.run({ ...input.scope, now: ctx.clock.now() }, async (tx) => {
    const row = await lockBooking(tx, input.bookingId);
    const now = ctx.clock.now();
    if (row.status !== 'CONFIRMED' || now.getTime() >= row.ends_at.getTime()) throw conflict('PROVIDER_OUTCOME_CONFLICT', 'The meeting provider outcome can only change for a confirmed, unfinished lesson');
    if (row.meeting_provider_ref && row.meeting_provider_ref !== body.providerReference && body.outcome === 'SUCCEEDED' && row.meeting_state === 'READY') {
      throw conflict('PROVIDER_OUTCOME_CONFLICT', 'A different provider reference already succeeded');
    }
    const state = body.outcome === 'SUCCEEDED' ? 'READY' : body.outcome === 'FAILED' ? 'MISSING' : 'PROVISIONING';
    await tx.query(
      `UPDATE bookings SET meeting_state = $2, meeting_provider_ref = $3, meeting_generated_url = $4, meeting_changed_at = $5, revision = revision + 1, updated_at = $5 WHERE id = $1`,
      [row.id, state, body.providerReference, body.outcome === 'SUCCEEDED' ? generatedUrl(body.providerReference) : null, now],
    );
    const fresh = (await loadBooking(tx, row.id)) as BookingRow;
    if (state !== 'PROVISIONING') await emitMeetingUpdated(tx, fresh, state === 'READY' ? 'READY' : 'MISSING', now, now);
    return ok(ctx, fresh, actor.userId);
  });
}

/** Turns due reminder rows into events. A reminder for a lesson that is no longer upcoming is dropped, not sent. */
export async function sweepReminders(ctx: Ctx, batch = 50): Promise<number> {
  return withRetry(() => withTx(ctx.pool, async (tx) => {
    const now = ctx.clock.now();
    const due = await tx.query<{ booking_id: string; schedule_version: string; offset_minutes: 60 | 10 }>(
      `SELECT booking_id, schedule_version, offset_minutes FROM reminders WHERE status = 'PENDING' AND due_at <= $1 ORDER BY due_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, batch],
    );
    for (const reminder of due.rows) {
      const row = await loadBooking(tx, reminder.booking_id);
      if (row && row.status === 'CONFIRMED' && row.schedule_version === reminder.schedule_version && now.getTime() < row.starts_at.getTime()) {
        await emitReminder(tx, row, reminder.offset_minutes, now);
      }
      await tx.query("UPDATE reminders SET status = 'QUEUED' WHERE booking_id = $1 AND schedule_version = $2 AND offset_minutes = $3", [reminder.booking_id, reminder.schedule_version, reminder.offset_minutes]);
    }
    return due.rows.length;
  }));
}

// ---- gRPC evidence (read-only, participant identities and times only) ----

export async function bookingEvidence(ctx: Ctx, bookingId: string) {
  const row = await loadBooking(ctx.pool, bookingId);
  if (!row) throw notFound('NOT_FOUND', 'Booking not found');
  return {
    bookingId: row.id,
    status: row.status,
    studentUserId: row.student_user_id,
    tutorUserId: row.tutor_user_id,
    subjectId: row.subject_id,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null,
    revision: String(row.revision),
  };
}

export async function reviewEligibility(ctx: Ctx, bookingId: string) {
  const row = await loadBooking(ctx.pool, bookingId);
  if (!row) throw notFound('NOT_FOUND', 'Booking not found');
  return {
    bookingId: row.id,
    studentUserId: row.student_user_id,
    tutorId: row.tutor_id,
    tutorUserId: row.tutor_user_id,
    subjectId: row.subject_id,
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    bookingRevision: String(row.revision),
    eligible: row.status === 'COMPLETED',
  };
}

/** Notification asks right before delivery. Cancelled, completed, stale or already-started lessons suppress the reminder. */
export async function reminderEligibility(ctx: Ctx, request: { bookingId: string; scheduleVersion: string; offsetMinutes: number }) {
  const row = await loadBooking(ctx.pool, request.bookingId);
  const now = ctx.clock.now();
  const verdict = (eligible: boolean, reason: string | null) => ({ bookingId: request.bookingId, eligible, reason, checkedAt: iso(now) });
  if (!row) return verdict(false, 'BOOKING_NOT_FOUND');
  if (row.schedule_version !== request.scheduleVersion) return verdict(false, 'STALE_SCHEDULE');
  if (row.status === 'CANCELLED') return verdict(false, 'CANCELLED');
  if (row.status === 'COMPLETED') return verdict(false, 'COMPLETED');
  if (row.status === 'PAYMENT_DUE') return verdict(false, 'NOT_CONFIRMED');
  if (row.op_id && row.op_status === 'PENDING') return verdict(false, 'CANCELLATION_PENDING');
  if (now.getTime() >= row.starts_at.getTime()) return verdict(false, 'STARTED');
  return verdict(true, null);
}

export { unprocessable };
