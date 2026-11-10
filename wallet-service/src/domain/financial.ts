import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Admission } from '../auth';
import { withRetry, withTx, type Tx } from '../db';
import { alreadyExists, conflict, forbidden, notFound } from '../errors';
import { derivedId, newId } from '../ids';
import { formatAmount, money, parseAmount, platformFee, seventyPercent } from '../money';
import { CLEARING_MS, HOUR_MS, parseInstant, type Clock } from '../time';
import { lockWallet, postMovement, readWallet } from './ledger';
import { enqueueEvent } from './outbox';

export interface MoneyView { currency: 'THB'; amount: string }

export interface PaymentCommand {
  bookingId: string; sourceOperationId: string; studentUserId: string; tutorUserId: string; subjectId: string;
  amount: MoneyView; startsAt: string; endsAt: string; holdExpiresAt: string; admission: Admission;
}
export interface ClosePayment { command: PaymentCommand; reason: 'CANCEL_REQUESTED' | 'HOLD_EXPIRED' | 'ABORT_PAYMENT' }
export interface RefundCommand {
  bookingId: string; paymentOperationId: string; sourceOperationId: string; studentUserId: string; tutorUserId: string;
  quoteId: string; kind: 'STUDENT_CANCEL' | 'TUTOR_CANCEL'; amount: MoneyView; policyVersion: string; admission: Admission;
}
export interface CompletionCommand { sourceOperationId: string; bookingVersion: string; tutorConfirmedAt: string; admission: Admission }

export interface FinancialRow {
  booking_id: string; student_user_id: string; tutor_user_id: string; paid_satang: string; refunded_satang: string;
  fee_satang: string; pending_earning_satang: string; status: string; payment_gate: string;
  applied_payment_operation_id: string | null; starts_at: Date; ends_at: Date; hold_expires_at: Date;
  tutor_confirmed_at: Date | null; completion_source_operation_id: string | null; clearing_due_at: Date | null;
  dispute_id: string | null; dispute_held: boolean; revision: string;
}

/** Order-independent canonical JSON so an immutable command hashes identically on every retry. */
export function canonicalHash(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]));
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

export function recordView(row: FinancialRow) {
  return {
    bookingId: row.booking_id,
    studentUserId: row.student_user_id,
    tutorUserId: row.tutor_user_id,
    paid: money(BigInt(row.paid_satang)),
    refunded: money(BigInt(row.refunded_satang)),
    pendingEarning: money(BigInt(row.pending_earning_satang)),
    fee: money(BigInt(row.fee_satang)),
    status: row.status,
    paymentGate: row.payment_gate,
    tutorConfirmedAt: row.tutor_confirmed_at ? row.tutor_confirmed_at.toISOString() : null,
    clearingDueAt: row.clearing_due_at ? row.clearing_due_at.toISOString() : null,
    disputeId: row.dispute_id,
    disputeHeld: row.dispute_held,
    revision: row.revision,
  };
}

/** Takes the booking's single financial-record lock. Every money decision for the booking goes through it. */
export async function lockRecord(tx: Tx, bookingId: string): Promise<FinancialRow | null> {
  const { rows } = await tx.query('SELECT * FROM financial_records WHERE booking_id = $1 FOR UPDATE', [bookingId]);
  return rows[0] ?? null;
}

export async function bumpRecord(tx: Tx, bookingId: string, set: string, params: unknown[], now: Date): Promise<FinancialRow> {
  const { rows } = await tx.query(
    `UPDATE financial_records SET ${set}, revision = revision + 1, updated_at = $1 WHERE booking_id = $2 RETURNING *`,
    [now, bookingId, ...params],
  );
  return rows[0];
}

interface PaymentOperationRow {
  operation_id: string; booking_id: string; command_hash: string; status: 'APPLIED' | 'DECLINED' | 'CLOSED';
  amount_satang: string; transaction_id: string | null; balance_after_satang: string; reason: string | null; decided_at: Date;
}

function paymentResult(row: PaymentOperationRow) {
  return {
    operationId: row.operation_id,
    bookingId: row.booking_id,
    status: row.status,
    transactionId: row.transaction_id,
    amount: money(BigInt(row.amount_satang)),
    balance: money(BigInt(row.balance_after_satang)),
    reason: row.reason,
    decidedAt: row.decided_at.toISOString(),
  };
}

export class FinancialService {
  constructor(private readonly pool: Pool, private readonly clock: Clock) {}

  /** Creates the record on first contact (charge or close) and takes its lock. */
  private async lockOrCreate(tx: Tx, command: PaymentCommand, now: Date): Promise<FinancialRow> {
    await tx.query(
      `INSERT INTO financial_records (booking_id, student_user_id, tutor_user_id, starts_at, ends_at, hold_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (booking_id) DO NOTHING`,
      [command.bookingId, command.studentUserId, command.tutorUserId, command.startsAt, command.endsAt, command.holdExpiresAt, now],
    );
    const record = (await lockRecord(tx, command.bookingId))!;
    if (record.student_user_id !== command.studentUserId || record.tutor_user_id !== command.tutorUserId) {
      throw conflict('BOOKING_PARTY_MISMATCH', 'The booking parties differ from the recorded financial record');
    }
    return record;
  }

  private assertStudentAdmission(command: PaymentCommand): void {
    if (command.admission.actorUserId !== command.studentUserId) {
      throw forbidden('ADMISSION_MISMATCH', 'Only the booking student can admit a payment');
    }
    if (command.studentUserId === command.tutorUserId) throw conflict('SELF_BOOKING', 'A booking needs two distinct accounts');
  }

  private replay(existing: PaymentOperationRow, command: PaymentCommand) {
    if (existing.booking_id !== command.bookingId || existing.command_hash !== canonicalHash(command)) {
      throw conflict('IDEMPOTENCY_CONFLICT', 'This operation identity was used with different input');
    }
    return paymentResult(existing);
  }

  async applyLessonCharge(operationId: string, command: PaymentCommand) {
    this.assertStudentAdmission(command);
    return withRetry(() => withTx(this.pool, async (tx) => {
      const now = this.clock.now();
      const record = await this.lockOrCreate(tx, command, now);
      const found = await tx.query<PaymentOperationRow>('SELECT * FROM payment_operations WHERE operation_id = $1', [operationId]);
      if (found.rows[0]) return this.replay(found.rows[0], command);

      if (record.applied_payment_operation_id) throw alreadyExists('PAYMENT_ALREADY_APPLIED', 'A payment is already applied for this booking');
      if (record.payment_gate === 'CLOSED') throw conflict('PAYMENT_GATE_CLOSED', 'Payment is closed for this booking');

      const amount = parseAmount(command.amount.amount);
      const hash = canonicalHash(command);
      const admittedAt = parseInstant(command.admission.admittedAt);
      const insert = async (status: 'APPLIED' | 'DECLINED' | 'CLOSED', transactionId: string | null, available: bigint, reason: string | null) => {
        const { rows } = await tx.query<PaymentOperationRow>(
          `INSERT INTO payment_operations (operation_id, booking_id, command_hash, status, amount_satang, transaction_id, balance_after_satang, reason, decided_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
          [operationId, command.bookingId, hash, status, amount, transactionId, available, reason, now],
        );
        return paymentResult(rows[0]);
      };

      // A first charge admitted at or after the hold deadline can never apply.
      if (admittedAt.getTime() >= parseInstant(command.holdExpiresAt).getTime()) {
        await bumpRecord(tx, command.bookingId, "payment_gate = 'CLOSED'", [], now);
        return insert('CLOSED', null, (await readWallet(tx, command.studentUserId)).available, 'HOLD_EXPIRED');
      }

      const wallet = await lockWallet(tx, command.studentUserId, now);
      if (wallet.available < amount) return insert('DECLINED', null, wallet.available, 'INSUFFICIENT_BALANCE');

      const moved = await postMovement(tx, {
        userId: command.studentUserId, type: 'LESSON_PAYMENT', direction: 'OUT', amount, operationId, bookingId: command.bookingId, now,
      });
      await bumpRecord(tx, command.bookingId, "paid_satang = $3, status = 'PAID', applied_payment_operation_id = $4", [amount, operationId], now);
      return insert('APPLIED', moved.id, moved.balanceAfter - wallet.reserved, null);
    }));
  }

  async getLessonCharge(operationId: string) {
    const { rows } = await this.pool.query<PaymentOperationRow>('SELECT * FROM payment_operations WHERE operation_id = $1', [operationId]);
    // NOT_FOUND only says no outcome was visible at this instant; it never proves an in-flight charge cannot commit.
    if (!rows[0]) throw notFound('NOT_FOUND', 'No charge outcome is recorded for this operation');
    return paymentResult(rows[0]);
  }

  async resolveOrCloseLessonCharge(operationId: string, close: ClosePayment) {
    const { command, reason } = close;
    this.assertStudentAdmission(command);
    return withRetry(() => withTx(this.pool, async (tx) => {
      const now = this.clock.now();
      const record = await this.lockOrCreate(tx, command, now);
      const found = await tx.query<PaymentOperationRow>('SELECT * FROM payment_operations WHERE operation_id = $1', [operationId]);
      const closesGate = reason === 'CANCEL_REQUESTED' || reason === 'HOLD_EXPIRED';
      if (closesGate && record.payment_gate === 'OPEN') await bumpRecord(tx, command.bookingId, "payment_gate = 'CLOSED'", [], now);
      if (found.rows[0]) return this.replay(found.rows[0], command);

      // No prior operation row: write a durable tombstone so a late charge with this ID observes CLOSED.
      const available = (await readWallet(tx, command.studentUserId)).available;
      const { rows } = await tx.query<PaymentOperationRow>(
        `INSERT INTO payment_operations (operation_id, booking_id, command_hash, status, amount_satang, transaction_id, balance_after_satang, reason, decided_at, created_at)
         VALUES ($1, $2, $3, 'CLOSED', $4, NULL, $5, $6, $7, $7) RETURNING *`,
        [operationId, command.bookingId, canonicalHash(command), parseAmount(command.amount.amount), available, reason, now],
      );
      return paymentResult(rows[0]);
    }));
  }

  async applyCancellationRefund(operationId: string, command: RefundCommand) {
    return withRetry(() => withTx(this.pool, async (tx) => {
      const now = this.clock.now();
      const record = await lockRecord(tx, command.bookingId);
      if (!record) throw conflict('PAYMENT_NOT_APPLIED', 'No payment exists for this booking');

      const hash = canonicalHash(command);
      const found = await tx.query('SELECT * FROM refund_operations WHERE operation_id = $1', [operationId]);
      if (found.rows[0]) {
        if (found.rows[0].booking_id !== command.bookingId || found.rows[0].command_hash !== hash) {
          throw conflict('IDEMPOTENCY_CONFLICT', 'This operation identity was used with different input');
        }
        return this.refundResult(found.rows[0]);
      }

      const expectedActor = command.kind === 'STUDENT_CANCEL' ? command.studentUserId : command.tutorUserId;
      if (command.admission.actorUserId !== expectedActor) throw forbidden('ADMISSION_MISMATCH', 'The admitted actor does not match the cancellation kind');
      if (record.student_user_id !== command.studentUserId || record.tutor_user_id !== command.tutorUserId) {
        throw conflict('BOOKING_PARTY_MISMATCH', 'The booking parties differ from the recorded financial record');
      }
      if (record.applied_payment_operation_id !== command.paymentOperationId) {
        throw conflict('PAYMENT_NOT_APPLIED', 'The referenced payment operation is not the applied payment');
      }
      if (record.status !== 'PAID') throw conflict('BOOKING_NOT_CANCELLABLE', `A ${record.status} financial record cannot take a cancellation refund`);

      const admittedAt = parseInstant(command.admission.admittedAt);
      if (admittedAt.getTime() >= record.starts_at.getTime()) throw conflict('BOOKING_STARTED', 'A started lesson cannot be ordinarily cancelled');

      const paid = BigInt(record.paid_satang);
      const refunded = BigInt(record.refunded_satang);
      // Student: full only when strictly more than 24h remain; exactly 24h is 70%. Tutor: always the full payment.
      const policyAmount = command.kind === 'TUTOR_CANCEL' || record.starts_at.getTime() - admittedAt.getTime() > 24 * HOUR_MS
        ? paid : seventyPercent(paid);
      const amount = parseAmount(command.amount.amount);
      if (amount !== policyAmount) throw conflict('POLICY_AMOUNT_MISMATCH', 'The refund amount differs from the cancellation policy amount');
      if (refunded + amount > paid) throw conflict('REFUND_LIMIT_EXCEEDED', 'Total refunds cannot exceed the original payment');

      await lockWallet(tx, command.studentUserId, now);
      const moved = await postMovement(tx, { userId: command.studentUserId, type: 'REFUND', direction: 'IN', amount, operationId, bookingId: command.bookingId, now });
      const total = refunded + amount;
      const updated = await bumpRecord(tx, command.bookingId, "refunded_satang = $3, status = 'CANCELLED', pending_earning_satang = 0, fee_satang = 0", [total], now);
      const { rows } = await tx.query(
        `INSERT INTO refund_operations (operation_id, booking_id, kind, command_hash, amount_satang, total_refunded_satang, transaction_id, applied_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [operationId, command.bookingId, command.kind, hash, amount, total, moved.id, now],
      );
      await enqueueEvent(tx, {
        type: 'wallet.refund-applied', aggregate: { type: 'booking-financial-record', id: command.bookingId, version: updated.revision },
        targets: { kind: 'USERS', userIds: [command.studentUserId] }, group: 'WALLET_PAYMENTS',
        data: { bookingId: command.bookingId, transactionId: moved.id, amount: money(amount) },
        dedupeKey: `refund:${operationId}`, causationId: command.sourceOperationId, now,
      });
      return this.refundResult(rows[0]);
    }));
  }

  private refundResult(row: { operation_id: string; booking_id: string; amount_satang: string; total_refunded_satang: string; transaction_id: string; applied_at: Date }) {
    return {
      operationId: row.operation_id,
      bookingId: row.booking_id,
      status: 'APPLIED' as const,
      amount: money(BigInt(row.amount_satang)),
      totalRefunded: money(BigInt(row.total_refunded_satang)),
      transactionId: row.transaction_id,
      appliedAt: row.applied_at.toISOString(),
    };
  }

  async getRefundOutcome(operationId: string) {
    const { rows } = await this.pool.query('SELECT * FROM refund_operations WHERE operation_id = $1', [operationId]);
    if (!rows[0]) throw notFound('NOT_FOUND', 'No refund outcome is recorded for this operation');
    return this.refundResult(rows[0]);
  }

  async recordLessonCompletion(bookingId: string, command: CompletionCommand) {
    return withRetry(() => withTx(this.pool, async (tx) => {
      const now = this.clock.now();
      const record = await lockRecord(tx, bookingId);
      if (!record) throw notFound('NOT_FOUND', 'No financial record exists for this booking');
      const confirmedAt = parseInstant(command.tutorConfirmedAt);

      if (record.tutor_confirmed_at) {
        // Idempotent on bookingId; the original confirmation time is immutable.
        if (record.tutor_confirmed_at.getTime() !== confirmedAt.getTime() || record.completion_source_operation_id !== command.sourceOperationId) {
          throw conflict('COMPLETION_CONFLICT', 'A different completion time or source is already recorded');
        }
        return recordView(record);
      }
      if (command.admission.actorUserId !== record.tutor_user_id) throw forbidden('ADMISSION_MISMATCH', 'Only the assigned tutor can complete the lesson');
      if (record.status === 'CANCELLED') throw conflict('BOOKING_CANCELLED', 'A cancelled booking cannot be completed');
      if (record.status === 'UNPAID') throw conflict('PAYMENT_NOT_APPLIED', 'An unpaid booking cannot be completed');
      if (confirmedAt.getTime() < record.ends_at.getTime()) throw conflict('COMPLETION_TOO_EARLY', 'Completion is eligible at or after the scheduled end');

      const dueAt = new Date(confirmedAt.getTime() + CLEARING_MS);
      const paid = BigInt(record.paid_satang);
      const remaining = paid - BigInt(record.refunded_satang);
      let set: string; let params: unknown[];
      if (remaining === 0n) {
        // An approved remedy already refunded everything: no fee and no earning remain.
        set = 'tutor_confirmed_at = $3, clearing_due_at = $4, completion_source_operation_id = $5';
        params = [confirmedAt, dueAt, command.sourceOperationId];
      } else {
        const fee = platformFee(paid);
        set = "tutor_confirmed_at = $3, clearing_due_at = $4, completion_source_operation_id = $5, fee_satang = $6, pending_earning_satang = $7, status = 'COMPLETED'";
        params = [confirmedAt, dueAt, command.sourceOperationId, fee, paid - fee];
      }
      return recordView(await bumpRecord(tx, bookingId, set, params, now));
    }));
  }

  async getBookingFinancialRecord(bookingId: string) {
    const { rows } = await this.pool.query<FinancialRow>('SELECT * FROM financial_records WHERE booking_id = $1', [bookingId]);
    if (!rows[0]) throw notFound('NOT_FOUND', 'No financial record exists for this booking');
    return recordView(rows[0]);
  }
}

export { derivedId, newId, formatAmount };
