import { actorAdmission, type Actor } from '../auth';
import { PeerRefusal, type CallContext, type CloseReason, type PaymentCommand, type PaymentResult } from '../clients';
import { withRetry, withTx } from '../db';
import { conflict, forbidden, insufficientFunds, revisionMismatch } from '../errors';
import type { IdempotencyScope } from '../http/idempotency';
import { derivedId, newId } from '../ids';
import { money } from '../money';
import { backoffMs } from '../outbox/publisher';
import { iso } from '../time';
import type { Ctx } from './context';
import { canonicalHash } from './hash';
import { confirmBooking, finalizeCancellation } from './finalize';
import { bookingView, loadBooking, lockBooking, requireParticipant, type BookingRow } from './model';
import { createOperation, operationRef, resolveOperation } from './operations';
import type { Reply } from './reply';

/** What settlement needs from Wallet's answer. A synthesized CLOSED is used when Wallet says the payment gate is closed. */
export type Decision = Pick<PaymentResult, 'status' | 'transactionId' | 'reason' | 'decidedAt'>;

const ATTENTION_AFTER = 10;
const LEASE_MS = 30_000;

export function paymentCommand(row: BookingRow, operationId: string, admission: PaymentCommand['admission']): PaymentCommand {
  return {
    bookingId: row.id,
    sourceOperationId: operationId,
    studentUserId: row.student_user_id,
    tutorUserId: row.tutor_user_id,
    subjectId: row.subject_id,
    amount: money(BigInt(row.amount_satang)),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    holdExpiresAt: iso(row.hold_expires_at as Date),
    admission,
  };
}

export interface PayInput {
  bookingId: string;
  /** Revision from If-Match. */
  ifMatch: string;
  scope: IdempotencyScope;
  context: CallContext;
}

/**
 * Student payment from the wallet. Persist the attempt and its immutable command first, call Wallet outside any
 * transaction, then record the outcome. An unknown outcome stays PENDING for the recovery worker and is answered 202.
 */
export async function payBooking(ctx: Ctx, actor: Actor, input: PayInput): Promise<Reply> {
  const replay = await ctx.idem.peek(input.scope);
  if (replay) return replay;

  // One attempt identity per public action. A retry of the same Idempotency-Key reuses it.
  const attemptId = derivedId(`charge:${input.bookingId}:${input.scope.key}`);
  const operationId = derivedId(`operation:pay:${input.bookingId}:${input.scope.key}`);

  const command = await withRetry(() => withTx(ctx.pool, async (tx) => {
    const row = await lockBooking(tx, input.bookingId);
    requireParticipant(row, actor);
    if (row.student_user_id !== actor.userId) throw forbidden('STUDENT_ONLY', 'Only the booking student can pay');
    const existing = await tx.query<{ command: PaymentCommand }>('SELECT command FROM payment_attempts WHERE operation_id = $1', [attemptId]);
    if (existing.rows[0]) return existing.rows[0].command;

    const now = ctx.clock.now();
    if (String(row.revision) !== input.ifMatch) throw revisionMismatch('REVISION_MISMATCH', 'This booking changed; reload it and try again');
    if (row.status !== 'PAYMENT_DUE') throw conflict('BOOKING_NOT_PAYABLE', 'This booking is not waiting for payment');
    if (!row.hold_expires_at || now.getTime() >= row.hold_expires_at.getTime()) throw conflict('HOLD_EXPIRED', 'The payment hold has expired. Choose your lesson times again.');
    if (row.op_id && row.op_status === 'PENDING') throw conflict('OPERATION_IN_PROGRESS', 'A payment for this booking is already being processed');

    const built = paymentCommand(row, operationId, actorAdmission(actor));
    await createOperation(tx, {
      id: operationId, kind: 'PAY_BOOKING', initiatorUserId: actor.userId, affectedUserId: row.tutor_user_id,
      resourceType: 'booking', resourceId: row.id, resourceUrl: `/api/bookings/${row.id}`, now,
    });
    await tx.query(
      `INSERT INTO payment_attempts (operation_id, booking_id, booking_operation_id, command, command_hash, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [attemptId, row.id, operationId, JSON.stringify(built), canonicalHash(built), new Date(now.getTime() + 10_000), now],
    );
    await tx.query('UPDATE bookings SET pending_operation_id = $2, revision = revision + 1, updated_at = $3 WHERE id = $1', [row.id, operationId, now]);
    return built;
  }));

  // Outside any transaction: Wallet is the only judge of funds.
  const decision = await chargeOnce(ctx, attemptId, command, input.context);
  if (decision) await settleAttempt(ctx, attemptId, decision);

  return ctx.idem.run({ ...input.scope, now: ctx.clock.now() }, async (tx) => {
    const attempt = (await tx.query<{ status: string; booking_operation_id: string }>('SELECT status, booking_operation_id FROM payment_attempts WHERE operation_id = $1', [attemptId])).rows[0];
    if (attempt.status === 'DECLINED') throw insufficientFunds('INSUFFICIENT_BALANCE', 'Your wallet balance is too low for this lesson. Add funds and pay again before the hold expires.');
    if (attempt.status === 'CLOSED') throw conflict('HOLD_EXPIRED', 'The payment hold has expired. Choose your lesson times again.');
    if (attempt.status === 'APPLIED') {
      const row = (await loadBooking(tx, input.bookingId)) as BookingRow;
      const view = bookingView(row, actor.userId, ctx.clock.now());
      return { status: 200, body: view, headers: { ETag: `"${view.revision}"` } };
    }
    const op = (await tx.query('SELECT id, status, resource_type, resource_id, resource_url FROM booking_operations WHERE id = $1', [attempt.booking_operation_id])).rows[0];
    const ref = operationRef(op);
    return { status: 202, body: ref, headers: { Location: ref.statusUrl } };
  });
}

/** One Wallet charge call. A timeout or outage returns null: the outcome is unknown and the durable attempt stays PENDING. */
async function chargeOnce(ctx: Ctx, attemptId: string, command: PaymentCommand, context: CallContext): Promise<Decision | null> {
  try {
    return await ctx.peers.wallet.applyLessonCharge(attemptId, command, context);
  } catch (error) {
    if (error instanceof PeerRefusal && error.code === 'PAYMENT_GATE_CLOSED') return gateClosed(ctx);
    return null;
  }
}

const gateClosed = (ctx: Ctx): Decision => ({ status: 'CLOSED', transactionId: null, reason: 'PAYMENT_GATE_CLOSED', decidedAt: iso(ctx.clock.now()) });

/**
 * Records Wallet's answer for one attempt. Idempotent: a settled attempt is left alone, so the HTTP path and the
 * recovery worker can both call it. An APPLIED answer confirms the booking exactly once.
 */
export async function settleAttempt(ctx: Ctx, attemptId: string, decision: Decision): Promise<void> {
  const located = await ctx.pool.query<{ booking_id: string }>('SELECT booking_id FROM payment_attempts WHERE operation_id = $1', [attemptId]);
  if (!located.rows[0]) return;
  await withRetry(() => withTx(ctx.pool, async (tx) => {
    const row = await lockBooking(tx, located.rows[0].booking_id);
    const attempt = (await tx.query<{ status: string; booking_operation_id: string }>('SELECT status, booking_operation_id FROM payment_attempts WHERE operation_id = $1 FOR UPDATE', [attemptId])).rows[0];
    if (attempt.status !== 'PENDING') return;
    const now = ctx.clock.now();

    if (decision.status === 'APPLIED') {
      await tx.query("UPDATE payment_attempts SET status = 'APPLIED', transaction_id = $2, lease_until = NULL, updated_at = $3 WHERE operation_id = $1", [attemptId, decision.transactionId, now]);
      if (row.status === 'PAYMENT_DUE') {
        await confirmBooking(tx, row, new Date(decision.decidedAt), now);
      } else if (row.status !== 'CONFIRMED') {
        // A charge landed on a booking that already left PAYMENT_DUE. Never free the slots silently: flag it for the operator.
        await tx.query("UPDATE payment_attempts SET needs_attention = true, last_error = 'Charge applied after the booking left PAYMENT_DUE' WHERE operation_id = $1", [attemptId]);
      }
      await resolveOperation(tx, attempt.booking_operation_id, 'SUCCEEDED', now);
      return;
    }

    const declined = decision.status === 'DECLINED';
    await tx.query('UPDATE payment_attempts SET status = $2, reason = $3, lease_until = NULL, updated_at = $4 WHERE operation_id = $1', [attemptId, decision.status, decision.reason, now]);
    await resolveOperation(
      tx, attempt.booking_operation_id, 'REJECTED', now,
      declined
        ? insufficientFunds('INSUFFICIENT_BALANCE', 'Your wallet balance is too low for this lesson.')
        : conflict('HOLD_EXPIRED', 'The payment hold has expired.'),
    );
    await tx.query('UPDATE bookings SET pending_operation_id = NULL, revision = revision + 1, updated_at = $2 WHERE id = $1 AND pending_operation_id = $3', [row.id, now, attempt.booking_operation_id]);
  }));
}

interface ClaimedAttempt {
  operation_id: string;
  booking_id: string;
  command: PaymentCommand;
  fence: string;
  attempts: number;
}

/**
 * Recovery for attempts whose outcome is unknown. While the hold is live the same identity is repeated; once it has
 * expired (or the booking moved on) Wallet is asked to resolve-or-close, the only terminal answer, before anything is released.
 */
export async function recoverPayments(ctx: Ctx, batch = 10): Promise<number> {
  const now = ctx.clock.now();
  const claimed = await ctx.pool.query<ClaimedAttempt>(
    `UPDATE payment_attempts SET lease_until = $1, fence = fence + 1
     WHERE operation_id IN (
       SELECT operation_id FROM payment_attempts
       WHERE status = 'PENDING' AND next_attempt_at <= $2 AND (lease_until IS NULL OR lease_until <= $2)
       ORDER BY next_attempt_at LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING operation_id, booking_id, command, fence, attempts`,
    [new Date(now.getTime() + LEASE_MS), now, batch],
  );
  for (const attempt of claimed.rows) {
    const context: CallContext = { requestId: newId() };
    try {
      const booking = await loadBooking(ctx.pool, attempt.booking_id);
      const live = booking?.status === 'PAYMENT_DUE' && booking.hold_expires_at !== null && ctx.clock.now().getTime() < booking.hold_expires_at.getTime();
      let result: Decision;
      if (live) {
        result = await ctx.peers.wallet.applyLessonCharge(attempt.operation_id, attempt.command, context);
      } else {
        const reason: CloseReason = booking?.status === 'PAYMENT_DUE' ? 'HOLD_EXPIRED' : booking?.status === 'CONFIRMED' ? 'ABORT_PAYMENT' : 'CANCEL_REQUESTED';
        result = await ctx.peers.wallet.resolveOrCloseLessonCharge(attempt.operation_id, attempt.command, reason, context);
      }
      await settleAttempt(ctx, attempt.operation_id, result);
    } catch (error) {
      if (error instanceof PeerRefusal && error.code === 'PAYMENT_GATE_CLOSED') {
        await settleAttempt(ctx, attempt.operation_id, gateClosed(ctx));
        continue;
      }
      const attempts = attempt.attempts + 1;
      await ctx.pool.query(
        `UPDATE payment_attempts SET attempts = $3, lease_until = NULL, next_attempt_at = $4, last_error = $5, needs_attention = needs_attention OR $6
         WHERE operation_id = $1 AND fence = $2 AND status = 'PENDING'`,
        [attempt.operation_id, attempt.fence, attempts, new Date(ctx.clock.now().getTime() + backoffMs(attempts)),
          String((error as Error).message).slice(0, 500), attempts >= ATTENTION_AFTER],
      );
    }
  }
  return claimed.rows.length;
}

/**
 * Releases holds whose deadline has passed and that have no unresolved payment attempt. An unresolved attempt is left
 * to recoverPayments, which closes it at Wallet before any slot is freed. No Wallet call is needed here: a booking
 * with no pending attempt cannot be charged once it is cancelled, because payment locks and checks the booking row.
 */
export async function expireHolds(ctx: Ctx, batch = 20): Promise<number> {
  const due = await ctx.pool.query<{ id: string }>(
    `SELECT b.id FROM bookings b
     WHERE b.status = 'PAYMENT_DUE' AND b.hold_expires_at <= $1
       AND NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.booking_id = b.id AND a.status = 'PENDING')
     ORDER BY b.hold_expires_at LIMIT $2`,
    [ctx.clock.now(), batch],
  );
  let expired = 0;
  for (const { id } of due.rows) {
    await withRetry(() => withTx(ctx.pool, async (tx) => {
      const row = await lockBooking(tx, id);
      const now = ctx.clock.now();
      const pending = await tx.query("SELECT 1 FROM payment_attempts WHERE booking_id = $1 AND status = 'PENDING'", [id]);
      if (row.status !== 'PAYMENT_DUE' || !row.hold_expires_at || row.hold_expires_at.getTime() > now.getTime() || pending.rowCount) return;
      await finalizeCancellation(tx, row, { by: 'EXPIRY', reason: 'The payment hold expired before payment was completed', refundSatang: 0n, now });
      expired += 1;
    }));
  }
  return expired;
}
