import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db';
import { clearDueEarnings } from '../src/domain/clearing';
import { decideDispute, openDispute } from '../src/domain/disputes';
import { FinancialService, type RefundCommand } from '../src/domain/financial';
import type { BookingEvidence } from '../src/clients';
import { AppError } from '../src/errors';
import { newId } from '../src/ids';
import { money } from '../src/money';
import { actor, admission, FakeClock, fixture, freshPool, fund, HOUR, resetData, T0 } from './helpers';

let pool: Pool;
let clock: FakeClock;
let svc: FinancialService;

beforeAll(async () => { pool = await freshPool(); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => {
  await resetData(pool);
  clock = new FakeClock(T0);
  svc = new FinancialService(pool, clock);
});

const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as AppError).code; }
  return 'NO_ERROR';
};
const balance = async (userId: string) => (await pool.query('SELECT posted_satang, reserved_satang FROM wallets WHERE user_id = $1', [userId])).rows[0];
const ledgerCount = async (type?: string) => Number((await pool.query(`SELECT count(*) FROM ledger_entries ${type ? `WHERE type = '${type}'` : ''}`)).rows[0].count);

function evidence(f: ReturnType<typeof fixture>, status: BookingEvidence['status']): BookingEvidence {
  const cmd = f.command('1.00');
  return { bookingId: f.bookingId, status, studentUserId: f.student, tutorUserId: f.tutor, subjectId: cmd.subjectId, startsAt: cmd.startsAt, endsAt: cmd.endsAt, completedAt: null, cancelledAt: null, revision: '3' };
}

function refund(f: ReturnType<typeof fixture>, paymentOp: string, amount: string, kind: RefundCommand['kind'], at = T0): RefundCommand {
  return {
    bookingId: f.bookingId, paymentOperationId: paymentOp, sourceOperationId: newId(), studentUserId: f.student, tutorUserId: f.tutor, quoteId: newId(), kind,
    amount: money(BigInt(Math.round(Number(amount) * 100))), policyVersion: '2026-11-06.v1', admission: admission(kind === 'STUDENT_CANCEL' ? f.student : f.tutor, at),
  };
}

describe('lesson charge', () => {
  it('debits once and replays the same receipt', async () => {
    const f = fixture(); await fund(pool, f.student, 100000n);
    const op = newId(); const cmd = f.command('500.00');
    const first = await svc.applyLessonCharge(op, cmd);
    const second = await svc.applyLessonCharge(op, cmd);
    expect(first.status).toBe('APPLIED');
    expect(second).toEqual(first);
    expect((await balance(f.student)).posted_satang).toBe('50000');
    expect(await ledgerCount('LESSON_PAYMENT')).toBe(1);
  });

  it('rejects the same identity with a changed amount and leaves the receipt unchanged', async () => {
    const f = fixture(); await fund(pool, f.student, 100000n);
    const op = newId(); const cmd = f.command('500.00');
    const first = await svc.applyLessonCharge(op, cmd);
    expect(await code(svc.applyLessonCharge(op, { ...cmd, amount: money(10000n) }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(await svc.getLessonCharge(op)).toEqual(first);
  });

  it('declines without any debit when funds are short, and permits a new attempt after a top-up', async () => {
    const f = fixture(); await fund(pool, f.student, 10000n);
    const declined = await svc.applyLessonCharge(newId(), f.command('500.00'));
    expect(declined.status).toBe('DECLINED');
    expect(declined.transactionId).toBeNull();
    expect(await ledgerCount()).toBe(0);
    await fund(pool, f.student, 100000n);
    const retry = await svc.applyLessonCharge(newId(), f.command('500.00'));
    expect(retry.status).toBe('APPLIED');
  });

  it('cannot apply a first charge admitted at the hold deadline', async () => {
    const f = fixture(); await fund(pool, f.student, 100000n);
    const late = admission(f.student, new Date(T0.getTime() + 15 * 60_000));
    const result = await svc.applyLessonCharge(newId(), f.command('500.00', { admission: late }));
    expect(result.status).toBe('CLOSED');
    expect(result.reason).toBe('HOLD_EXPIRED');
    expect(await ledgerCount()).toBe(0);
  });

  it('permits at most one applied payment across attempts', async () => {
    const f = fixture(); await fund(pool, f.student, 100000n);
    await svc.applyLessonCharge(newId(), f.command('500.00'));
    expect(await code(svc.applyLessonCharge(newId(), f.command('500.00')))).toBe('PAYMENT_ALREADY_APPLIED');
    expect(await ledgerCount('LESSON_PAYMENT')).toBe(1);
  });

  it('applies exactly one debit under concurrent attempts with one identity', async () => {
    const f = fixture(); await fund(pool, f.student, 100000n);
    const op = newId(); const cmd = f.command('500.00');
    const results = await Promise.all(Array.from({ length: 12 }, () => svc.applyLessonCharge(op, cmd)));
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await ledgerCount('LESSON_PAYMENT')).toBe(1);
    expect((await balance(f.student)).posted_satang).toBe('50000');
  });

  it('applies at most one of several concurrent attempts with different identities', async () => {
    const f = fixture(); await fund(pool, f.student, 1000000n);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => svc.applyLessonCharge(newId(), f.command('500.00')).then((r) => r.status, (e: AppError) => e.code)));
    expect(outcomes.filter((o) => o === 'APPLIED')).toHaveLength(1);
    expect(await ledgerCount('LESSON_PAYMENT')).toBe(1);
  });
});

describe('resolve or close', () => {
  it('writes a CLOSED tombstone for an absent operation so a late charge cannot debit', async () => {
    const f = fixture(); await fund(pool, f.student, 100000n);
    const op = newId(); const cmd = f.command('500.00');
    const closed = await svc.resolveOrCloseLessonCharge(op, { command: cmd, reason: 'CANCEL_REQUESTED' });
    expect(closed.status).toBe('CLOSED');
    const late = await svc.applyLessonCharge(op, cmd);
    expect(late.status).toBe('CLOSED');
    expect(await ledgerCount()).toBe(0);
    expect(await code(svc.applyLessonCharge(newId(), cmd))).toBe('PAYMENT_GATE_CLOSED');
  });

  it('returns the applied receipt when the charge had committed', async () => {
    const f = fixture(); await fund(pool, f.student, 100000n);
    const op = newId(); const cmd = f.command('500.00');
    const applied = await svc.applyLessonCharge(op, cmd);
    const resolved = await svc.resolveOrCloseLessonCharge(op, { command: cmd, reason: 'HOLD_EXPIRED' });
    expect(resolved).toEqual(applied);
  });

  it('ABORT_PAYMENT closes only that attempt and permits a new admitted attempt', async () => {
    const f = fixture(); await fund(pool, f.student, 100000n);
    const cmd = f.command('500.00');
    await svc.resolveOrCloseLessonCharge(newId(), { command: cmd, reason: 'ABORT_PAYMENT' });
    expect((await svc.applyLessonCharge(newId(), cmd)).status).toBe('APPLIED');
  });

  it('rejects a close whose original command differs', async () => {
    const f = fixture(); const op = newId(); const cmd = f.command('500.00');
    await svc.resolveOrCloseLessonCharge(op, { command: cmd, reason: 'ABORT_PAYMENT' });
    expect(await code(svc.resolveOrCloseLessonCharge(op, { command: { ...cmd, amount: money(1n) }, reason: 'ABORT_PAYMENT' }))).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('serializes a close racing a charge: either the charge applied or the tombstone wins, never both', async () => {
    for (let i = 0; i < 10; i += 1) {
      const f = fixture(); await fund(pool, f.student, 100000n);
      const op = newId(); const cmd = f.command('500.00');
      const [charge, close] = await Promise.all([
        svc.applyLessonCharge(op, cmd), svc.resolveOrCloseLessonCharge(op, { command: cmd, reason: 'CANCEL_REQUESTED' }),
      ]);
      expect(charge.status).toBe(close.status);
      expect(await ledgerCount('LESSON_PAYMENT')).toBe(charge.status === 'APPLIED' ? 1 : 0);
      await resetData(pool);
    }
  });
});

describe('cancellation refunds and disputes', () => {
  async function paid(amount = '1000.00') {
    const f = fixture(); await fund(pool, f.student, 500000n);
    const op = newId(); await svc.applyLessonCharge(op, f.command(amount));
    return { f, op };
  }

  it('refunds 100% when more than 24 hours remain, once', async () => {
    const { f, op } = await paid();
    const cmd = refund(f, op, '1000.00', 'STUDENT_CANCEL');
    const refundOp = newId();
    const first = await svc.applyCancellationRefund(refundOp, cmd);
    expect(first.totalRefunded.amount).toBe('1000.00');
    expect(await svc.applyCancellationRefund(refundOp, cmd)).toEqual(first);
    expect(await ledgerCount('REFUND')).toBe(1);
    expect((await svc.getBookingFinancialRecord(f.bookingId)).status).toBe('CANCELLED');
  });

  it('refunds exactly 70% at exactly 24 hours and rejects a stale 100% amount', async () => {
    const { f, op } = await paid();
    const at = new Date(new Date(f.command('1.00').startsAt).getTime() - 24 * HOUR);
    expect(await code(svc.applyCancellationRefund(newId(), refund(f, op, '1000.00', 'STUDENT_CANCEL', at)))).toBe('POLICY_AMOUNT_MISMATCH');
    const ok = await svc.applyCancellationRefund(newId(), refund(f, op, '700.00', 'STUDENT_CANCEL', at));
    expect(ok.amount.amount).toBe('700.00');
  });

  it('rounds the 70% refund half-up to the satang', async () => {
    const { f, op } = await paid('0.05');
    const at = new Date(new Date(f.command('1.00').startsAt).getTime() - HOUR);
    expect((await svc.applyCancellationRefund(newId(), refund(f, op, '0.04', 'STUDENT_CANCEL', at))).amount.amount).toBe('0.04');
  });

  it('refunds the full payment for a tutor cancellation even inside 24 hours', async () => {
    const { f, op } = await paid();
    const at = new Date(new Date(f.command('1.00').startsAt).getTime() - HOUR);
    expect((await svc.applyCancellationRefund(newId(), refund(f, op, '1000.00', 'TUTOR_CANCEL', at))).amount.amount).toBe('1000.00');
  });

  it('rejects cancellation once the lesson has started', async () => {
    const { f, op } = await paid();
    const at = new Date(new Date(f.command('1.00').startsAt).getTime());
    expect(await code(svc.applyCancellationRefund(newId(), refund(f, op, '1000.00', 'STUDENT_CANCEL', at)))).toBe('BOOKING_STARTED');
  });

  it('70% cancellation then an approved dispute refunds only the remaining 30%', async () => {
    const { f, op } = await paid();
    const lessonStart = new Date(f.command('1.00').startsAt);
    const at = new Date(lessonStart.getTime() - HOUR);
    await svc.applyCancellationRefund(newId(), refund(f, op, '700.00', 'STUDENT_CANCEL', at));
    const student = actor(f.student, ['STUDENT'], new Date(lessonStart.getTime() + HOUR));
    const admin = actor(newId(), ['ADMIN']);
    clock.set(new Date(lessonStart.getTime() + HOUR));
    const opened = await withTx(pool, (tx) => openDispute(tx, student, { bookingId: f.bookingId, reason: 'Tutor no-show' }, evidence(f, 'CANCELLED'), clock.now()));
    const dispute = opened.body as { id: string; revision: string };
    const decided = await withTx(pool, (tx) => decideDispute(tx, admin, dispute.id, dispute.revision, { decision: 'APPROVE_FULL_REMAINDER', reason: 'Confirmed' }, clock.now()));
    expect((decided.body as { refundedAmount: { amount: string } }).refundedAmount.amount).toBe('300.00');
    const record = await svc.getBookingFinancialRecord(f.bookingId);
    expect(record.refunded.amount).toBe('1000.00');
    expect(record.paid.amount).toBe('1000.00');
    expect(record.disputeHeld).toBe(false);
    expect((await balance(f.student)).posted_satang).toBe('500000');
  });

  it('closes the cancelled-booking claim window exactly at endsAt + 24 hours', async () => {
    const { f, op } = await paid();
    const lessonStart = new Date(f.command('1.00').startsAt);
    await svc.applyCancellationRefund(newId(), refund(f, op, '700.00', 'STUDENT_CANCEL', new Date(lessonStart.getTime() - HOUR)));
    const endsAt = new Date(f.command('1.00').endsAt);
    const edge = new Date(endsAt.getTime() + 24 * HOUR);
    const before = actor(f.student, ['STUDENT'], new Date(edge.getTime() - 1));
    const at = actor(f.student, ['STUDENT'], edge);
    expect(await code(withTx(pool, (tx) => openDispute(tx, at, { bookingId: f.bookingId, reason: 'late' }, evidence(f, 'CANCELLED'), edge)))).toBe('DISPUTE_WINDOW_CLOSED');
    const ok = await withTx(pool, (tx) => openDispute(tx, before, { bookingId: f.bookingId, reason: 'in time' }, evidence(f, 'CANCELLED'), edge));
    expect(ok.status).toBe(201);
  });

  it('refuses a dispute before the lesson starts', async () => {
    const { f } = await paid();
    expect(await code(withTx(pool, (tx) => openDispute(tx, actor(f.student), { bookingId: f.bookingId, reason: 'early' }, evidence(f, 'CONFIRMED'), T0)))).toBe('DISPUTE_WINDOW_CLOSED');
  });

  it('allows only one OPEN dispute per booking even under concurrent submissions', async () => {
    const { f } = await paid();
    const at = new Date(new Date(f.command('1.00').startsAt).getTime() + 5 * 60_000);
    const student = actor(f.student, ['STUDENT'], at);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () =>
      withTx(pool, (tx) => openDispute(tx, student, { bookingId: f.bookingId, reason: 'x' }, evidence(f, 'CONFIRMED'), at)).then(() => 'OPENED', (e: AppError) => e.code)));
    expect(outcomes.filter((o) => o === 'OPENED')).toHaveLength(1);
    expect(Number((await pool.query("SELECT count(*) FROM disputes WHERE status = 'OPEN'")).rows[0].count)).toBe(1);
  });

  it('rejects a dispute decision with a stale revision and a second decision', async () => {
    const { f } = await paid();
    const at = new Date(new Date(f.command('1.00').startsAt).getTime() + 5 * 60_000);
    const opened = await withTx(pool, (tx) => openDispute(tx, actor(f.student, ['STUDENT'], at), { bookingId: f.bookingId, reason: 'x' }, evidence(f, 'CONFIRMED'), at));
    const id = (opened.body as { id: string }).id;
    const admin = actor(newId(), ['ADMIN']);
    expect(await code(withTx(pool, (tx) => decideDispute(tx, admin, id, '7', { decision: 'REJECT', reason: 'no' }, at)))).toBe('REVISION_MISMATCH');
    await withTx(pool, (tx) => decideDispute(tx, admin, id, '0', { decision: 'REJECT', reason: 'no' }, at));
    expect(await code(withTx(pool, (tx) => decideDispute(tx, admin, id, '1', { decision: 'APPROVE_FULL_REMAINDER', reason: 'again' }, at)))).toBe('DISPUTE_ALREADY_DECIDED');
    expect(await ledgerCount('REFUND')).toBe(0);
  });
});

describe('completion and clearing', () => {
  async function completedLesson(deliveredLateMs = 0) {
    const f = fixture(); await fund(pool, f.student, 500000n);
    const op = newId(); await svc.applyLessonCharge(op, f.command('1000.00'));
    const confirmedAt = new Date(new Date(f.command('1.00').endsAt).getTime() + 10 * 60_000);
    clock.set(new Date(confirmedAt.getTime() + deliveredLateMs));
    const record = await svc.recordLessonCompletion(f.bookingId, { sourceOperationId: newId(), bookingVersion: '4', tutorConfirmedAt: confirmedAt.toISOString(), admission: admission(f.tutor, confirmedAt) });
    return { f, confirmedAt, record };
  }

  it('records fee 15% and net pending earning, due 24h after the original confirmation', async () => {
    const { confirmedAt, record } = await completedLesson();
    expect(record.fee.amount).toBe('150.00');
    expect(record.pendingEarning.amount).toBe('850.00');
    expect(record.clearingDueAt).toBe(new Date(confirmedAt.getTime() + 24 * HOUR).toISOString());
    expect(record.status).toBe('COMPLETED');
  });

  it('derives the deadline from the original confirmation even when delivered a day late', async () => {
    const { confirmedAt, record } = await completedLesson(24 * HOUR);
    expect(record.clearingDueAt).toBe(new Date(confirmedAt.getTime() + 24 * HOUR).toISOString());
  });

  it('is idempotent for the same confirmation and conflicts on a different time', async () => {
    const { f, confirmedAt, record } = await completedLesson();
    const sourceOperationId = (await pool.query('SELECT completion_source_operation_id AS s FROM financial_records')).rows[0].s;
    const again = await svc.recordLessonCompletion(f.bookingId, { sourceOperationId, bookingVersion: '4', tutorConfirmedAt: confirmedAt.toISOString(), admission: admission(f.tutor) });
    expect(again).toEqual(record);
    const later = new Date(confirmedAt.getTime() + HOUR).toISOString();
    expect(await code(svc.recordLessonCompletion(f.bookingId, { sourceOperationId, bookingVersion: '4', tutorConfirmedAt: later, admission: admission(f.tutor) }))).toBe('COMPLETION_CONFLICT');
  });

  it('refuses completion before the scheduled end and from the wrong actor', async () => {
    const f = fixture(); await fund(pool, f.student, 500000n);
    await svc.applyLessonCharge(newId(), f.command('1000.00'));
    const early = new Date(f.command('1.00').startsAt);
    expect(await code(svc.recordLessonCompletion(f.bookingId, { sourceOperationId: newId(), bookingVersion: '4', tutorConfirmedAt: early.toISOString(), admission: admission(f.tutor) }))).toBe('COMPLETION_TOO_EARLY');
    const ok = new Date(f.command('1.00').endsAt).toISOString();
    expect(await code(svc.recordLessonCompletion(f.bookingId, { sourceOperationId: newId(), bookingVersion: '4', tutorConfirmedAt: ok, admission: admission(f.student) }))).toBe('ADMISSION_MISMATCH');
  });

  it('clears nothing before 24h, then exactly once, even across repeated sweeps', async () => {
    const { f, confirmedAt } = await completedLesson();
    clock.set(new Date(confirmedAt.getTime() + 24 * HOUR - 1));
    expect((await clearDueEarnings(pool, clock)).cleared).toBe(0);
    clock.set(new Date(confirmedAt.getTime() + 24 * HOUR));
    const sweeps = await Promise.all([clearDueEarnings(pool, clock), clearDueEarnings(pool, clock), clearDueEarnings(pool, clock)]);
    expect(sweeps.reduce((n, s) => n + s.cleared, 0)).toBe(1);
    await clearDueEarnings(pool, clock);
    expect(await ledgerCount('LESSON_EARNING')).toBe(1);
    expect((await balance(f.tutor)).posted_satang).toBe('85000');
    expect((await svc.getBookingFinancialRecord(f.bookingId)).status).toBe('SETTLED');
  });

  it('does not clear while a dispute hold exists, and a rejection keeps the original deadline', async () => {
    const { f, confirmedAt } = await completedLesson();
    const during = new Date(confirmedAt.getTime() + 2 * HOUR);
    const opened = await withTx(pool, (tx) => openDispute(tx, actor(f.student, ['STUDENT'], during), { bookingId: f.bookingId, reason: 'x' }, evidence(f, 'COMPLETED'), during));
    clock.set(new Date(confirmedAt.getTime() + 30 * HOUR));
    expect((await clearDueEarnings(pool, clock)).cleared).toBe(0);
    const id = (opened.body as { id: string }).id;
    await withTx(pool, (tx) => decideDispute(tx, actor(newId(), ['ADMIN']), id, '0', { decision: 'REJECT', reason: 'no merit' }, clock.now()));
    const record = await svc.getBookingFinancialRecord(f.bookingId);
    expect(record.clearingDueAt).toBe(new Date(confirmedAt.getTime() + 24 * HOUR).toISOString());
    expect((await clearDueEarnings(pool, clock)).cleared).toBe(1);
  });

  it('an approved remedy removes the pending earning and nothing ever clears', async () => {
    const { f, confirmedAt } = await completedLesson();
    const during = new Date(confirmedAt.getTime() + 2 * HOUR);
    const opened = await withTx(pool, (tx) => openDispute(tx, actor(f.student, ['STUDENT'], during), { bookingId: f.bookingId, reason: 'x' }, evidence(f, 'COMPLETED'), during));
    const id = (opened.body as { id: string }).id;
    await withTx(pool, (tx) => decideDispute(tx, actor(newId(), ['ADMIN']), id, '0', { decision: 'APPROVE_FULL_REMAINDER', reason: 'valid' }, during));
    const record = await svc.getBookingFinancialRecord(f.bookingId);
    expect(record.pendingEarning.amount).toBe('0.00');
    expect(record.status).toBe('REFUNDED');
    clock.set(new Date(confirmedAt.getTime() + 48 * HOUR));
    expect((await clearDueEarnings(pool, clock)).cleared).toBe(0);
    expect(await ledgerCount('LESSON_EARNING')).toBe(0);
  });

  it('a dispute opened before completion stays effective when completion arrives later', async () => {
    const f = fixture(); await fund(pool, f.student, 500000n);
    await svc.applyLessonCharge(newId(), f.command('1000.00'));
    const started = new Date(new Date(f.command('1.00').startsAt).getTime() + 10 * 60_000);
    clock.set(started);
    await withTx(pool, (tx) => openDispute(tx, actor(f.student, ['STUDENT'], started), { bookingId: f.bookingId, reason: 'x' }, evidence(f, 'CONFIRMED'), started));
    const confirmedAt = new Date(new Date(f.command('1.00').endsAt).getTime() + 60_000);
    clock.set(new Date(confirmedAt.getTime() + 2 * 24 * HOUR));
    await svc.recordLessonCompletion(f.bookingId, { sourceOperationId: newId(), bookingVersion: '5', tutorConfirmedAt: confirmedAt.toISOString(), admission: admission(f.tutor, confirmedAt) });
    expect((await clearDueEarnings(pool, clock)).cleared).toBe(0);
    expect((await svc.getBookingFinancialRecord(f.bookingId)).disputeHeld).toBe(true);
  });

  it('a dispute racing clearing at the deadline never yields both a cleared earning and a refund', async () => {
    for (let i = 0; i < 12; i += 1) {
      await resetData(pool);
      const { f, confirmedAt } = await completedLesson();
      const deadline = new Date(confirmedAt.getTime() + 24 * HOUR);
      clock.set(deadline);
      const student = actor(f.student, ['STUDENT'], deadline);
      const [open] = await Promise.all([
        withTx(pool, (tx) => openDispute(tx, student, { bookingId: f.bookingId, reason: 'race' }, evidence(f, 'COMPLETED'), deadline)).then(() => 'OPENED', (e: AppError) => e.code),
        clearDueEarnings(pool, clock),
      ]);
      const record = await svc.getBookingFinancialRecord(f.bookingId);
      const earnings = await ledgerCount('LESSON_EARNING');
      if (open === 'OPENED') { expect(earnings).toBe(0); expect(record.disputeHeld).toBe(true); }
      else { expect(open).toBe('DISPUTE_WINDOW_CLOSED'); expect(earnings).toBe(1); expect(record.status).toBe('SETTLED'); }
    }
  });
});
