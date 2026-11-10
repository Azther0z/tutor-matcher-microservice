import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Contracts } from '../src/contracts';
import { withTx } from '../src/db';
import { clearDueEarnings } from '../src/domain/clearing';
import { decideDispute, openDispute } from '../src/domain/disputes';
import { FinancialService } from '../src/domain/financial';
import type { Envelope } from '../src/domain/outbox';
import { AppError } from '../src/errors';
import { newId } from '../src/ids';
import { formatAmount, money, parseAmount, platformFee, seventyPercent } from '../src/money';
import { actor, admission, FakeClock, fixture, freshPool, fund, HOUR, resetData, T0 } from './helpers';
import { startHarness, type Harness } from './harness';

const contractsDir = path.resolve(__dirname, '../../../contracts');
const cases = JSON.parse(fs.readFileSync(path.join(contractsDir, 'examples/cases.json'), 'utf8'));
let pool: Pool; let h: Harness; let svc: FinancialService; let clock: FakeClock;
const contracts = new Contracts(contractsDir);

beforeAll(async () => { pool = await freshPool(); h = await startHarness(pool); });
afterAll(async () => { await h.close(); await pool.end(); });
beforeEach(async () => { await resetData(pool); clock = new FakeClock(T0); svc = new FinancialService(pool, clock); });

describe('contracts/examples/cases.json', () => {
  it.each<any>(cases.moneyCases)('money case paid=$paid', (c: any) => {
    const paid = parseAmount(c.paid);
    expect(formatAmount(platformFee(paid))).toBe(c.fee);
    expect(formatAmount(paid - platformFee(paid))).toBe(c.net);
    expect(formatAmount(seventyPercent(paid))).toBe(c.lateRefund);
    expect(platformFee(paid) + (paid - platformFee(paid))).toBe(paid);
  });

  it.each<any>(cases.cancellationBoundaryCases)('cancellation boundary: $name', async (c: any) => {
    const f = fixture(); await fund(pool, f.student, 1_000_000n);
    const cmd = f.command('100.00', { startsAt: c.startsAt, endsAt: new Date(new Date(c.startsAt).getTime() + HOUR).toISOString(), holdExpiresAt: '2026-11-05T00:00:00.000Z', admission: admission(f.student, new Date('2026-11-04T00:00:00.000Z')) });
    const opId = newId();
    await svc.applyLessonCharge(opId, cmd);
    const at = new Date(c.admittedAt);
    const refund = (amount: string) => svc.applyCancellationRefund(newId(), {
      bookingId: f.bookingId, paymentOperationId: opId, sourceOperationId: newId(), studentUserId: f.student, tutorUserId: f.tutor, quoteId: newId(),
      kind: 'STUDENT_CANCEL', amount: money(parseAmount(amount)), policyVersion: '2026-11-06.v1', admission: admission(f.student, at),
    });
    if (c.refundPercent === null) {
      await expect(refund('100.00')).rejects.toMatchObject({ code: 'BOOKING_STARTED' });
    } else if (c.refundPercent === 100) {
      expect((await refund('100.00')).amount.amount).toBe('100.00');
    } else {
      await expect(refund('100.00')).rejects.toMatchObject({ code: 'POLICY_AMOUNT_MISMATCH' });
      expect((await refund('70.00')).amount.amount).toBe('70.00');
    }
  });

  it.each<any>(cases.refundCapCases)('refund cap: paid=$paid prior=$priorRefunds', (c: any) => {
    expect(formatAmount(parseAmount(c.paid) - parseAmount(c.priorRefunds))).toBe(c.remaining);
  });
});

describe('event conformance', () => {
  it('every event Wallet enqueues across the real flows is valid against the 21-variant event schema', async () => {
    // top-up success and failure, payout success and failure, cancellation refund, dispute open/approve/reject, clearing.
    const admin = h.token(newId(), ['STUDENT', 'ADMIN']);
    const key = () => ({ 'idempotency-key': newId() });
    const tutor = newId(); const student = newId();
    const topup = async (user: string, outcome: string, amount = '2000.00') => {
      const t = await h.call('POST', '/api/wallet/topups', { token: h.token(user), headers: key(), body: { amount } });
      await h.call('POST', `/api/demo/topups/${t.body.id}/outcome`, { token: admin, headers: key(), body: { outcome, providerReference: t.body.providerReference } });
    };
    await topup(tutor, 'SUCCEEDED'); await topup(tutor, 'FAILED', '5.00');
    const account = (await h.call('POST', '/api/payout-accounts', { token: h.token(tutor, ['STUDENT', 'TUTOR']), headers: key(), body: { bankCode: 'KBANK', accountHolderName: 'T', accountNumber: '1234567890' } })).body;
    for (const outcome of ['SUCCEEDED', 'FAILED']) {
      const p = await h.call('POST', '/api/payouts', { token: h.token(tutor, ['STUDENT', 'TUTOR']), headers: key(), body: { amount: '100.00', payoutAccountId: account.id } });
      await h.call('POST', `/api/demo/payouts/${p.body.id}/outcome`, { token: admin, headers: key(), body: { outcome, providerReference: p.body.providerReference } });
    }

    await fund(pool, student, 1_000_000n);
    const lesson = async (tag: 'cancel' | 'approve' | 'reject' | 'clear') => {
      const f = fixture(); const cmd = f.command('1000.00', { studentUserId: student, tutorUserId: tutor, admission: admission(student) });
      const bookingId = newId();
      const command = { ...cmd, bookingId };
      const op = newId(); await svc.applyLessonCharge(op, command);
      return { bookingId, command, op, tag };
    };
    const evidence = (l: Awaited<ReturnType<typeof lesson>>, status: 'CONFIRMED' | 'COMPLETED') => ({
      bookingId: l.bookingId, status, studentUserId: student, tutorUserId: tutor, subjectId: l.command.subjectId, startsAt: l.command.startsAt, endsAt: l.command.endsAt, completedAt: null, cancelledAt: null, revision: '1',
    });

    const cancel = await lesson('cancel');
    await svc.applyCancellationRefund(newId(), { bookingId: cancel.bookingId, paymentOperationId: cancel.op, sourceOperationId: newId(), studentUserId: student, tutorUserId: tutor, quoteId: newId(), kind: 'STUDENT_CANCEL', amount: money(100000n), policyVersion: '2026-11-06.v1', admission: admission(student) });

    const startedAt = new Date(new Date(cancel.command.startsAt).getTime() + 600_000);
    const complete = async (l: Awaited<ReturnType<typeof lesson>>) => {
      const confirmedAt = new Date(new Date(l.command.endsAt).getTime() + 60_000);
      await svc.recordLessonCompletion(l.bookingId, { sourceOperationId: newId(), bookingVersion: '2', tutorConfirmedAt: confirmedAt.toISOString(), admission: admission(tutor, confirmedAt) });
      return confirmedAt;
    };
    for (const tag of ['approve', 'reject'] as const) {
      const l = await lesson(tag); const confirmedAt = await complete(l);
      const at = new Date(confirmedAt.getTime() + 3_600_000);
      const opened = await withTx(pool, (tx) => openDispute(tx, actor(student, ['STUDENT'], at), { bookingId: l.bookingId, reason: 'because' }, evidence(l, 'COMPLETED'), at));
      await withTx(pool, (tx) => decideDispute(tx, actor(newId(), ['ADMIN']), (opened.body as any).id, '0', { decision: tag === 'approve' ? 'APPROVE_FULL_REMAINDER' : 'REJECT', reason: 'reviewed' }, at));
    }
    const cleared = await lesson('clear'); const confirmedAt = await complete(cleared);
    clock.set(new Date(confirmedAt.getTime() + 24 * HOUR));
    await clearDueEarnings(pool, clock);
    void startedAt;

    const rows = (await pool.query('SELECT envelope FROM outbox ORDER BY created_at, event_id')).rows.map((r) => r.envelope as Envelope);
    const types = new Set(rows.map((e) => e.type));
    for (const expected of ['wallet.topup-resolved', 'wallet.payout-resolved', 'wallet.refund-applied', 'wallet.earning-cleared', 'wallet.dispute-opened', 'wallet.dispute-held', 'wallet.dispute-decided']) {
      expect(types, `missing ${expected}`).toContain(expected);
    }
    for (const envelope of rows) {
      const verdict = contracts.validateEvent(envelope);
      expect(verdict, `${envelope.type} is schema-invalid`).toEqual({ ok: true });
      expect(envelope.producer).toBe('wallet');
      expect(JSON.stringify(envelope)).not.toMatch(/accountNumber|maskedAccountNumber|1234567890|\*\*\*\*/);
    }
    expect(new Set(rows.map((e) => e.eventId)).size).toBe(rows.length);
  });
});

void AppError;
