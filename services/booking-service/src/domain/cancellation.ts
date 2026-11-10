import { actorAdmission, type Actor } from '../auth';
import { PeerRefusal, type CallContext, type PaymentCommand, type RefundCommand } from '../clients';
import { withRetry, withTx } from '../db';
import { conflict, forbidden, revisionMismatch } from '../errors';
import type { IdempotencyScope } from '../http/idempotency';
import { derivedId, newId } from '../ids';
import { money, seventyPercent } from '../money';
import { backoffMs } from '../outbox/publisher';
import { HOUR_MS, iso, MINUTE_MS } from '../time';
import type { Ctx } from './context';
import { finalizeCancellation } from './finalize';
import { bookingView, loadBooking, lockBooking, requireParticipant, type BookingRow } from './model';
import { createOperation, operationRef, resolveOperation } from './operations';
import type { Reply } from './reply';
import { settleAttempt } from './payments';

export const POLICY_VERSION = '2026-11-06.v1';
const QUOTE_TTL_MS = 5 * MINUTE_MS;
const FULL_REFUND_WINDOW_MS = 24 * HOUR_MS;
const ATTENTION_AFTER = 10;
const LEASE_MS = 30_000;

export type CancelActor = 'STUDENT' | 'TUTOR';

interface QuoteRow {
  id: string;
  booking_id: string;
  actor: CancelActor;
  actor_user_id: string;
  booking_revision: string;
  policy_version: string;
  refund_satang: string;
  fee_satang: string;
  late: boolean;
  requires_warning: boolean;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  operation_id: string | null;
  reason: string | null;
}

interface Terms {
  refund: bigint;
  fee: bigint;
  late: boolean;
  requiresWarning: boolean;
}

/**
 * The server-calculated cancellation terms. A student gets 100% when the lesson starts more than 24 hours after
 * admission and 70% at exactly 24 hours or less; a tutor cancellation always refunds 100%. Nothing paid means nothing refunded.
 */
export function cancellationTerms(row: Pick<BookingRow, 'status' | 'starts_at' | 'amount_satang'>, actor: CancelActor, admittedAt: Date): Terms {
  const paid = row.status === 'CONFIRMED' ? BigInt(row.amount_satang) : 0n;
  const within24h = row.starts_at.getTime() - admittedAt.getTime() <= FULL_REFUND_WINDOW_MS;
  if (actor === 'TUTOR') return { refund: paid, fee: 0n, late: within24h, requiresWarning: within24h };
  const refund = within24h ? seventyPercent(paid) : paid;
  return { refund, fee: paid - refund, late: within24h && paid > 0n, requiresWarning: within24h && paid > 0n };
}

function guard(row: BookingRow, actor: Actor, as: CancelActor, now: Date): void {
  requireParticipant(row, actor);
  if (as === 'STUDENT' && row.student_user_id !== actor.userId) throw forbidden('STUDENT_ONLY', 'Only the booking student can cancel this way');
  if (as === 'TUTOR' && row.tutor_user_id !== actor.userId) throw forbidden('TUTOR_ONLY', 'Only the assigned tutor can cancel this way');
  if ((row.status !== 'PAYMENT_DUE' && row.status !== 'CONFIRMED') || now.getTime() >= row.starts_at.getTime()) {
    throw conflict('CANCELLATION_NOT_ALLOWED', 'This booking can no longer be cancelled');
  }
  // A pending payment on an unpaid booking is exactly what an unpaid cancellation must close; a pending action on a paid one is a cancellation.
  if (row.status === 'CONFIRMED' && row.op_id && row.op_status === 'PENDING') throw conflict('OPERATION_IN_PROGRESS', 'Another action on this booking is still being processed');
}

const view = (q: QuoteRow) => ({
  quoteId: q.id,
  bookingId: q.booking_id,
  actor: q.actor,
  refund: money(BigInt(q.refund_satang)),
  fee: money(BigInt(q.fee_satang)),
  late: q.late,
  requiresWarning: q.requires_warning,
  bookingRevision: String(q.booking_revision),
  policyVersion: q.policy_version,
  issuedAt: iso(q.issued_at),
  expiresAt: iso(q.expires_at),
});

/**
 * Issues a stored quote bound to actor, booking revision, policy and amounts. It expires after five minutes, at the
 * lesson start, or at the next 24-hour policy boundary, whichever comes first, so a boundary crossing forces a fresh quote.
 */
export async function issueQuote(ctx: Ctx, actor: Actor, bookingId: string, as: CancelActor) {
  const row = await loadBooking(ctx.pool, bookingId);
  const now = ctx.clock.now();
  if (!row) requireParticipant(null, actor);
  guard(row as BookingRow, actor, as, now);
  const booking = row as BookingRow;
  const terms = cancellationTerms(booking, as, actor.admittedAt);
  const boundary = booking.starts_at.getTime() - FULL_REFUND_WINDOW_MS;
  let expires = Math.min(now.getTime() + QUOTE_TTL_MS, booking.starts_at.getTime());
  if (now.getTime() < boundary) expires = Math.min(expires, boundary);
  const quote: QuoteRow = {
    id: newId(), booking_id: booking.id, actor: as, actor_user_id: actor.userId, booking_revision: String(booking.revision), policy_version: POLICY_VERSION,
    refund_satang: terms.refund.toString(), fee_satang: terms.fee.toString(), late: terms.late, requires_warning: terms.requiresWarning,
    issued_at: now, expires_at: new Date(expires), consumed_at: null, operation_id: null, reason: null,
  };
  await ctx.pool.query(
    `INSERT INTO cancellation_quotes (id, booking_id, actor, actor_user_id, booking_revision, policy_version, refund_satang, fee_satang, late, requires_warning, issued_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [quote.id, quote.booking_id, quote.actor, quote.actor_user_id, quote.booking_revision, quote.policy_version, quote.refund_satang, quote.fee_satang, quote.late, quote.requires_warning, quote.issued_at, quote.expires_at],
  );
  return view(quote);
}

export interface CancelInput {
  bookingId: string;
  as: CancelActor;
  /** Revision from If-Match. */
  ifMatch: string;
  body: { quoteId: string; reason?: string };
  scope: IdempotencyScope;
  context: CallContext;
}

type Plan =
  | { kind: 'DONE' }
  | { kind: 'CLOSE' }
  | { kind: 'REFUND'; refundOperationId: string; command: RefundCommand };

/**
 * Cancels with a quote. Unpaid: close the payment gate first (no refund command), then finalize. Paid: persist the
 * refund command, call Wallet outside any transaction, and finalize and release slots only once the refund outcome is
 * known. An unknown outcome leaves the cancellation pending (202) for the recovery workers, which repeat the same identity.
 */
export async function cancelBooking(ctx: Ctx, actor: Actor, input: CancelInput): Promise<Reply> {
  const replay = await ctx.idem.peek(input.scope);
  if (replay) return replay;
  const operationId = derivedId(`operation:cancel:${input.bookingId}:${input.scope.key}`);

  const plan = await withRetry(() => withTx(ctx.pool, async (tx): Promise<Plan> => {
    const row = await lockBooking(tx, input.bookingId);
    const now = ctx.clock.now();
    const quote = (await tx.query<QuoteRow>('SELECT * FROM cancellation_quotes WHERE id = $1 FOR UPDATE', [input.body.quoteId])).rows[0];
    if (!quote || quote.booking_id !== row.id || quote.actor !== input.as || quote.actor_user_id !== actor.userId) {
      requireParticipant(row, actor);
      throw conflict('QUOTE_CHANGED', 'This cancellation quote is not valid. Request a new one.');
    }
    // The same Idempotency-Key retried after a lost response resumes the operation it already created.
    if (quote.operation_id === operationId) return resume(tx, row, operationId);
    if (quote.consumed_at) throw conflict('QUOTE_CHANGED', 'This cancellation quote was already used. Request a new one.');

    guard(row, actor, input.as, now);
    const cancelling = await tx.query(
      `SELECT 1 FROM cancellation_quotes q JOIN booking_operations o ON o.id = q.operation_id AND o.status = 'PENDING' WHERE q.booking_id = $1`, [row.id]);
    if (cancelling.rowCount) throw conflict('OPERATION_IN_PROGRESS', 'A cancellation of this booking is already being processed');
    if (String(row.revision) !== input.ifMatch) throw revisionMismatch('REVISION_MISMATCH', 'This booking changed; reload it and try again');
    if (now.getTime() >= quote.expires_at.getTime()) throw conflict('QUOTE_EXPIRED', 'This cancellation quote has expired. Request a new one.');
    if (String(quote.booking_revision) !== String(row.revision) || quote.policy_version !== POLICY_VERSION) throw conflict('QUOTE_CHANGED', 'The booking changed. Request a new cancellation quote.');
    const terms = cancellationTerms(row, input.as, actor.admittedAt);
    if (terms.refund.toString() !== quote.refund_satang || terms.fee.toString() !== quote.fee_satang) throw conflict('QUOTE_CHANGED', 'The cancellation terms changed. Request a new quote.');

    const reason = input.body.reason?.trim() ? input.body.reason.trim() : null;
    await createOperation(tx, {
      id: operationId, kind: input.as === 'TUTOR' ? 'TUTOR_CANCEL_BOOKING' : 'CANCEL_BOOKING', initiatorUserId: actor.userId,
      affectedUserId: input.as === 'TUTOR' ? row.student_user_id : row.tutor_user_id,
      resourceType: 'booking', resourceId: row.id, resourceUrl: `/api/bookings/${row.id}`, now,
    });
    await tx.query('UPDATE cancellation_quotes SET consumed_at = $2, operation_id = $3, reason = $4 WHERE id = $1', [quote.id, now, operationId, reason]);

    if (row.status === 'PAYMENT_DUE') {
      const pending = await tx.query("SELECT 1 FROM payment_attempts WHERE booking_id = $1 AND status = 'PENDING'", [row.id]);
      if (!pending.rowCount) {
        await finalizeCancellation(tx, row, { by: input.as, reason, refundSatang: 0n, now, operationId });
        return { kind: 'DONE' };
      }
      await tx.query('UPDATE bookings SET pending_operation_id = $2, revision = revision + 1, updated_at = $3 WHERE id = $1', [row.id, operationId, now]);
      return { kind: 'CLOSE' };
    }

    const applied = (await tx.query<{ operation_id: string }>("SELECT operation_id FROM payment_attempts WHERE booking_id = $1 AND status = 'APPLIED'", [row.id])).rows[0];
    if (!applied) throw conflict('QUOTE_CHANGED', 'The payment for this booking is not settled yet. Try again shortly.');
    const refundOperationId = derivedId(`refund:${row.id}`);
    const command: RefundCommand = {
      bookingId: row.id,
      paymentOperationId: applied.operation_id,
      sourceOperationId: operationId,
      studentUserId: row.student_user_id,
      tutorUserId: row.tutor_user_id,
      quoteId: quote.id,
      kind: input.as === 'TUTOR' ? 'TUTOR_CANCEL' : 'STUDENT_CANCEL',
      amount: money(terms.refund),
      policyVersion: POLICY_VERSION,
      admission: actorAdmission(actor),
    };
    await tx.query(
      `INSERT INTO refund_operations (operation_id, booking_id, booking_operation_id, quote_id, kind, reason, command, next_attempt_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [refundOperationId, row.id, operationId, quote.id, command.kind, reason, JSON.stringify(command), new Date(now.getTime() + 10_000), now],
    );
    await tx.query('UPDATE bookings SET pending_operation_id = $2, revision = revision + 1, updated_at = $3 WHERE id = $1', [row.id, operationId, now]);
    return { kind: 'REFUND', refundOperationId, command };
  }));

  const context = input.context;
  if (plan.kind === 'REFUND') {
    try {
      await settleRefund(ctx, plan.refundOperationId, await ctx.peers.wallet.applyCancellationRefund(plan.refundOperationId, plan.command, context));
    } catch {
      /* Unknown outcome: the pending refund is repeated by identity until Wallet answers. */
    }
  } else if (plan.kind === 'CLOSE') {
    await closePendingAttempts(ctx, input.bookingId, context);
    await finishUnpaidCancellation(ctx, input.bookingId);
  }

  return ctx.idem.run({ ...input.scope, now: ctx.clock.now() }, async (tx) => {
    const op = (await tx.query<{ status: string; resource_type: string | null; resource_id: string | null; resource_url: string | null }>(
      'SELECT id, status, resource_type, resource_id, resource_url FROM booking_operations WHERE id = $1', [operationId])).rows[0];
    if (op.status === 'REJECTED') throw conflict('QUOTE_CHANGED', 'The booking was paid while it was being cancelled. Request a new cancellation quote.');
    if (op.status === 'SUCCEEDED') {
      const row = (await loadBooking(tx, input.bookingId)) as BookingRow;
      const bookingBody = bookingView(row, actor.userId, ctx.clock.now());
      return { status: 200, body: bookingBody, headers: { ETag: `"${bookingBody.revision}"` } };
    }
    const ref = operationRef({ ...op, id: operationId });
    return { status: 202, body: ref, headers: { Location: ref.statusUrl } };
  });
}

/** Re-entry for a retried Idempotency-Key whose first attempt already created the operation. */
async function resume(tx: import('../db').Tx, row: BookingRow, operationId: string): Promise<Plan> {
  if (row.status === 'CANCELLED') return { kind: 'DONE' };
  const refund = (await tx.query<{ operation_id: string; command: RefundCommand; status: string }>(
    'SELECT operation_id, command, status FROM refund_operations WHERE booking_operation_id = $1', [operationId])).rows[0];
  if (refund) return refund.status === 'APPLIED' ? { kind: 'DONE' } : { kind: 'REFUND', refundOperationId: refund.operation_id, command: refund.command };
  return { kind: 'CLOSE' };
}

/** Close every unresolved attempt at Wallet (resolve-or-close is the only terminal answer) before an unpaid cancellation finalizes. */
async function closePendingAttempts(ctx: Ctx, bookingId: string, context: CallContext): Promise<void> {
  const attempts = await ctx.pool.query<{ operation_id: string; command: PaymentCommand }>(
    "SELECT operation_id, command FROM payment_attempts WHERE booking_id = $1 AND status = 'PENDING'", [bookingId]);
  for (const attempt of attempts.rows) {
    try {
      await settleAttempt(ctx, attempt.operation_id, await ctx.peers.wallet.resolveOrCloseLessonCharge(attempt.operation_id, attempt.command, 'CANCEL_REQUESTED', context));
    } catch (error) {
      if (error instanceof PeerRefusal && error.code === 'PAYMENT_GATE_CLOSED') {
        await settleAttempt(ctx, attempt.operation_id, { status: 'CLOSED', transactionId: null, reason: 'PAYMENT_GATE_CLOSED', decidedAt: iso(ctx.clock.now()) });
      }
      /* Otherwise unknown: payment recovery repeats the close, and finishUnpaidCancellation waits. */
    }
  }
}

/**
 * Completes an unpaid cancellation once no payment attempt is unresolved. If a charge turned out to be applied the
 * booking is now paid, so the stale unpaid quote is rejected and the student must request a new one.
 */
export async function finishUnpaidCancellation(ctx: Ctx, bookingId: string): Promise<void> {
  await withRetry(() => withTx(ctx.pool, async (tx) => {
    const row = await lockBooking(tx, bookingId);
    const now = ctx.clock.now();
    const quote = (await tx.query<QuoteRow>(
      `SELECT q.* FROM cancellation_quotes q JOIN booking_operations o ON o.id = q.operation_id AND o.status = 'PENDING'
       WHERE q.booking_id = $1 AND q.consumed_at IS NOT NULL ORDER BY q.consumed_at DESC LIMIT 1`, [bookingId])).rows[0];
    if (!quote) return;
    if (row.status === 'CONFIRMED') {
      await resolveOperation(tx, quote.operation_id as string, 'REJECTED', now, conflict('QUOTE_CHANGED', 'The booking was paid while it was being cancelled.'));
      await tx.query('UPDATE bookings SET pending_operation_id = NULL, revision = revision + 1, updated_at = $2 WHERE id = $1', [bookingId, now]);
      return;
    }
    if (row.status !== 'PAYMENT_DUE') return;
    const pending = await tx.query("SELECT 1 FROM payment_attempts WHERE booking_id = $1 AND status = 'PENDING'", [bookingId]);
    if (pending.rowCount) return;
    await finalizeCancellation(tx, row, { by: quote.actor, reason: quote.reason, refundSatang: 0n, now, operationId: quote.operation_id as string });
  }));
}

/** Records Wallet's refund answer. Idempotent; the booking is cancelled and its slots released exactly once. */
export async function settleRefund(ctx: Ctx, refundOperationId: string, result: { transactionId: string }): Promise<void> {
  const located = await ctx.pool.query<{ booking_id: string }>('SELECT booking_id FROM refund_operations WHERE operation_id = $1', [refundOperationId]);
  if (!located.rows[0]) return;
  await withRetry(() => withTx(ctx.pool, async (tx) => {
    const row = await lockBooking(tx, located.rows[0].booking_id);
    const refund = (await tx.query<{ status: string; kind: string; reason: string | null; command: RefundCommand; booking_operation_id: string }>(
      'SELECT status, kind, reason, command, booking_operation_id FROM refund_operations WHERE operation_id = $1 FOR UPDATE', [refundOperationId])).rows[0];
    if (refund.status !== 'PENDING') return;
    const now = ctx.clock.now();
    await tx.query("UPDATE refund_operations SET status = 'APPLIED', transaction_id = $2, lease_until = NULL, updated_at = $3 WHERE operation_id = $1", [refundOperationId, result.transactionId, now]);
    if (row.status === 'CONFIRMED') {
      const refunded = BigInt(refund.command.amount.amount.replace('.', ''));
      await finalizeCancellation(tx, row, { by: refund.kind === 'TUTOR_CANCEL' ? 'TUTOR' : 'STUDENT', reason: refund.reason, refundSatang: refunded, now, operationId: refund.booking_operation_id });
    }
  }));
}

interface ClaimedRefund {
  operation_id: string;
  command: RefundCommand;
  fence: string;
  attempts: number;
}

/** Repeats unresolved refund commands by identity, so an interrupted cancellation finalizes once and never credits twice. */
export async function recoverRefunds(ctx: Ctx, batch = 10): Promise<number> {
  const now = ctx.clock.now();
  const claimed = await ctx.pool.query<ClaimedRefund>(
    `UPDATE refund_operations SET lease_until = $1, fence = fence + 1
     WHERE operation_id IN (
       SELECT operation_id FROM refund_operations
       WHERE status = 'PENDING' AND next_attempt_at <= $2 AND (lease_until IS NULL OR lease_until <= $2)
       ORDER BY next_attempt_at LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING operation_id, command, fence, attempts`,
    [new Date(now.getTime() + LEASE_MS), now, batch],
  );
  for (const refund of claimed.rows) {
    try {
      await settleRefund(ctx, refund.operation_id, await ctx.peers.wallet.applyCancellationRefund(refund.operation_id, refund.command, { requestId: newId() }));
    } catch (error) {
      const attempts = refund.attempts + 1;
      await ctx.pool.query(
        `UPDATE refund_operations SET attempts = $3, lease_until = NULL, next_attempt_at = $4, last_error = $5, needs_attention = needs_attention OR $6
         WHERE operation_id = $1 AND fence = $2 AND status = 'PENDING'`,
        [refund.operation_id, refund.fence, attempts, new Date(ctx.clock.now().getTime() + backoffMs(attempts)),
          String((error as Error).message).slice(0, 500), attempts >= ATTENTION_AFTER],
      );
    }
  }
  return claimed.rows.length;
}

/** Finishes unpaid cancellations whose payment attempts have since been closed by recovery. */
export async function resumeUnpaidCancellations(ctx: Ctx, batch = 20): Promise<number> {
  const due = await ctx.pool.query<{ booking_id: string }>(
    `SELECT DISTINCT q.booking_id FROM cancellation_quotes q
     JOIN booking_operations o ON o.id = q.operation_id AND o.status = 'PENDING'
     JOIN bookings b ON b.id = q.booking_id
     WHERE q.consumed_at IS NOT NULL AND b.status = 'PAYMENT_DUE'
       AND NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.booking_id = b.id AND a.status = 'PENDING')
     LIMIT $1`, [batch]);
  for (const { booking_id: id } of due.rows) await finishUnpaidCancellation(ctx, id);
  return due.rows.length;
}
