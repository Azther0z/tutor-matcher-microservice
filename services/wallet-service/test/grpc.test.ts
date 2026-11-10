import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkloadAuthenticator } from '../src/auth';
import { Contracts } from '../src/contracts';
import { FinancialService } from '../src/domain/financial';
import { CHANNEL_OPTIONS, decodeErrorDetail, decoded, loadProtos } from '../src/grpc/proto';
import { startGrpcServer } from '../src/grpc/server';
import { newId } from '../src/ids';
import { money } from '../src/money';
import { BOOKING_SECRET, GATEWAY_SECRET } from './harness';
import { admission, FakeClock, fixture, freshPool, fund, resetData, T0 } from './helpers';

const contractsDir = path.resolve(__dirname, '../../../contracts');
let pool: Pool; let server: grpc.Server; let client: any; let clock: FakeClock;

beforeAll(async () => {
  pool = await freshPool();
  clock = new FakeClock(T0);
  const contracts = new Contracts(contractsDir);
  const started = await startGrpcServer({
    contractsDir, contracts, workload: new WorkloadAuthenticator({ gateway: GATEWAY_SECRET, booking: BOOKING_SECRET }), finance: new FinancialService(pool, clock),
  }, 0, '127.0.0.1');
  server = started.server;
  const proto = loadProtos(contractsDir, ['wallet/v1/finance.proto']) as any;
  client = new proto.tutor_matcher.wallet.v1.WalletFinanceService(`127.0.0.1:${started.port}`, grpc.credentials.createInsecure(), CHANNEL_OPTIONS);
});
afterAll(async () => { client.close(); server.forceShutdown(); await pool.end(); });
beforeEach(async () => { await resetData(pool); });

const call = (method: string, request: unknown, credential: string | null = BOOKING_SECRET) =>
  new Promise<{ error?: grpc.ServiceError; detail?: ReturnType<typeof decodeErrorDetail>; response?: any }>((resolve) => {
    const metadata = new grpc.Metadata();
    if (credential) metadata.set('authorization', `Bearer ${credential}`);
    metadata.set('x-request-id', newId());
    client[method](request, metadata, { deadline: new Date(Date.now() + 3000) }, (error: grpc.ServiceError | null, response: any) => {
      if (!error) return resolve({ response: decoded(response) });
      const bin = error.metadata?.get('tutor-error-bin')[0] as Buffer | undefined;
      resolve({ error, detail: bin ? decodeErrorDetail(contractsDir, bin) : undefined });
    });
  });

describe('WalletFinanceService over gRPC', () => {
  it('refuses missing and non-allowlisted workload identities with a typed error trailer', async () => {
    const f = fixture();
    const none = await call('GetBookingFinancialRecord', { bookingId: f.bookingId }, null);
    expect(none.error?.code).toBe(grpc.status.UNAUTHENTICATED);
    expect(none.detail?.code).toBe('WORKLOAD_UNAUTHENTICATED');
    const wrong = await call('GetBookingFinancialRecord', { bookingId: f.bookingId }, GATEWAY_SECRET);
    expect(wrong.error?.code).toBe(grpc.status.PERMISSION_DENIED);
    expect(wrong.detail?.code).toBe('CALLER_NOT_ALLOWED');
  });

  it('applies a charge, replays it, and rejects a changed amount for the same identity', async () => {
    const f = fixture(); await fund(pool, f.student, 100000n);
    const operationId = newId(); const command = f.command('500.00');
    const first = await call('ApplyLessonCharge', { operationId, command });
    expect(first.response.status).toBe('APPLIED');
    expect(first.response.amount).toEqual({ currency: 'THB', amount: '500.00' });
    expect(first.response.transactionId).toBeTruthy();
    expect(first.response.reason).toBeUndefined(); // an absent nullable field stays absent on the wire
    const second = await call('ApplyLessonCharge', { operationId, command });
    expect(second.response.transactionId).toBe(first.response.transactionId);
    const changed = await call('ApplyLessonCharge', { operationId, command: { ...command, amount: money(100n) } });
    expect(changed.error?.code).toBe(grpc.status.FAILED_PRECONDITION);
    expect(changed.detail?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(Number((await pool.query("SELECT count(*) FROM ledger_entries WHERE type = 'LESSON_PAYMENT'")).rows[0].count)).toBe(1);
  });

  it('writes a CLOSED tombstone through gRPC and then observes it from a late charge', async () => {
    const f = fixture(); await fund(pool, f.student, 100000n);
    const operationId = newId(); const command = f.command('500.00');
    expect((await call('GetLessonCharge', { operationId })).error?.code).toBe(grpc.status.NOT_FOUND);
    const closed = await call('ResolveOrCloseLessonCharge', { operationId, command: { command, reason: 'CANCEL_REQUESTED' } });
    expect(closed.response.status).toBe('CLOSED');
    const late = await call('ApplyLessonCharge', { operationId, command });
    expect(late.response.status).toBe('CLOSED');
    expect((await call('GetLessonCharge', { operationId })).response.status).toBe('CLOSED');
    const fresh = await call('ApplyLessonCharge', { operationId: newId(), command });
    expect(fresh.detail?.code).toBe('PAYMENT_GATE_CLOSED');
  });

  it('reports a declined charge as an OK result with no receipt', async () => {
    const f = fixture(); await fund(pool, f.student, 100n);
    const result = await call('ApplyLessonCharge', { operationId: newId(), command: f.command('500.00') });
    expect(result.response.status).toBe('DECLINED');
    expect(result.response.transactionId).toBeUndefined();
    expect(result.response.reason).toBe('INSUFFICIENT_BALANCE');
  });

  it('validates presence and values after decoding, reporting field errors', async () => {
    const f = fixture();
    const missing = await call('ApplyLessonCharge', { operationId: newId(), command: { ...f.command('500.00'), amount: undefined } });
    expect(missing.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(missing.detail?.fields.some((x) => x.path.endsWith('/amount') && x.code === 'REQUIRED')).toBe(true);
    const zero = await call('ApplyLessonCharge', { operationId: newId(), command: f.command('500.00', { amount: { currency: 'THB', amount: '0.00' } }) });
    expect(zero.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    const unspecifiedKind = await call('ApplyCancellationRefund', { operationId: newId(), command: {
      bookingId: f.bookingId, paymentOperationId: newId(), sourceOperationId: newId(), studentUserId: f.student, tutorUserId: f.tutor, quoteId: newId(),
      kind: 'KIND_UNSPECIFIED', amount: money(100n), policyVersion: '2026-11-06.v1', admission: admission(f.student),
    } });
    expect(unspecifiedKind.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
    const noId = await call('GetRefundOutcome', {});
    expect(noId.error?.code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  it('records completion with the immutable original time and returns the financial record', async () => {
    const f = fixture(); await fund(pool, f.student, 500000n);
    await call('ApplyLessonCharge', { operationId: newId(), command: f.command('1000.00') });
    const confirmedAt = new Date(new Date(f.command('1.00').endsAt).getTime() + 60_000);
    const sourceOperationId = newId();
    const body = { bookingId: f.bookingId, command: { sourceOperationId, bookingVersion: '4', tutorConfirmedAt: confirmedAt.toISOString(), admission: admission(f.tutor, confirmedAt) } };
    const recorded = await call('RecordLessonCompletion', body);
    expect(recorded.response.status).toBe('COMPLETED');
    expect(recorded.response.fee.amount).toBe('150.00');
    expect(recorded.response.disputeId).toBeUndefined();
    expect(recorded.response.disputeHeld).toBe(false); // explicit false is preserved, not dropped
    const conflict = await call('RecordLessonCompletion', { ...body, command: { ...body.command, tutorConfirmedAt: new Date(confirmedAt.getTime() + 1000).toISOString() } });
    expect(conflict.detail?.code).toBe('COMPLETION_CONFLICT');
    const record = await call('GetBookingFinancialRecord', { bookingId: f.bookingId });
    expect(record.response.clearingDueAt).toBe(new Date(confirmedAt.getTime() + 24 * 3_600_000).toISOString());
  });
});
