import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/ids';
import { freshPool, resetData, T0 } from './helpers';
import { startHarness, type Harness } from './harness';

let pool: Pool;
let h: Harness;

beforeAll(async () => { pool = await freshPool(); h = await startHarness(pool); });
afterAll(async () => { await h.close(); await pool.end(); });
beforeEach(async () => { await resetData(pool); h.clock.set(T0); });

const key = () => ({ 'idempotency-key': newId() });
const postedBalance = async (userId: string) => (await pool.query('SELECT posted_satang AS p, reserved_satang AS r FROM wallets WHERE user_id = $1', [userId])).rows[0];

async function fundViaTopup(userId: string, amount: string, admin: string) {
  const created = await h.call('POST', '/api/wallet/topups', { token: h.token(userId), headers: key(), body: { amount } });
  await h.call('POST', `/api/demo/topups/${created.body.id}/outcome`, {
    token: h.token(admin, ['STUDENT', 'ADMIN']), headers: key(), body: { outcome: 'SUCCEEDED', providerReference: created.body.providerReference },
  });
  return created.body;
}

describe('authentication and authorization', () => {
  it('requires a workload credential, an allowed caller and a signed actor', async () => {
    const user = newId();
    expect((await h.call('GET', '/api/wallet', { token: h.token(user), credential: null })).status).toBe(401);
    expect((await h.call('GET', '/api/wallet', { token: h.token(user), credential: 'wrong-wrong-wrong-wrong' })).status).toBe(401);
    expect((await h.call('GET', '/api/wallet', { token: h.token(user), credential: 'booking-secret-0123456789' })).status).toBe(403);
    expect((await h.call('GET', '/api/wallet')).status).toBe(401);
    expect((await h.call('GET', '/api/wallet', { token: 'not-a-jwt' })).status).toBe(401);
    expect((await h.call('GET', '/api/wallet', { headers: { 'x-user-id': user } })).status).toBe(401);
  });

  it('rejects an expired assertion', async () => {
    const user = newId();
    const token = h.token(user);
    h.clock.advance(61_000);
    expect((await h.call('GET', '/api/wallet', { token })).status).toBe(401);
  });

  it('enforces capabilities on the backend', async () => {
    const user = newId();
    expect((await h.call('GET', '/api/payout-accounts', { token: h.token(user) })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/disputes', { token: h.token(user) })).status).toBe(403);
    expect((await h.call('POST', `/api/demo/topups/${newId()}/outcome`, { token: h.token(user), headers: key(), body: { outcome: 'SUCCEEDED', providerReference: newId() } })).status).toBe(403);
  });

  it('answers with a request id and no-store, and rejects a malformed request id', async () => {
    const user = newId();
    const ok = await h.call('GET', '/api/wallet', { token: h.token(user) });
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect((await h.call('GET', '/api/wallet', { token: h.token(user), headers: { 'x-request-id': 'nope' } })).status).toBe(400);
  });

  it('rejects unknown and duplicate query parameters', async () => {
    const user = newId();
    expect((await h.call('GET', '/api/wallet/transactions?bogus=1', { token: h.token(user) })).status).toBe(400);
    expect((await h.call('GET', '/api/wallet/transactions?page=1&page=2', { token: h.token(user) })).status).toBe(400);
    const bad = await h.call('GET', '/api/wallet/transactions?pageSize=500', { token: h.token(user) });
    expect(bad.status).toBe(422);
    expect(bad.body.fields[0].path).toBe('/query/pageSize');
  });
});

describe('top-ups through the simulated provider', () => {
  it('creates a labelled non-payable top-up that credits nothing until the provider succeeds', async () => {
    const user = newId();
    const created = await h.call('POST', '/api/wallet/topups', { token: h.token(user), headers: key(), body: { amount: '250.50' } });
    expect(created.status).toBe(201);
    expect(created.body.demo).toBe(true);
    expect(created.body.status).toBe('PENDING');
    expect(created.body.paymentRepresentation).toContain('NOT PAYABLE');
    expect(created.body.operation.status).toBe('PENDING');
    expect(h.contracts.isDef('Topup', created.body)).toBe(true);
    expect(await postedBalance(user)).toBeUndefined();
    const overview = await h.call('GET', '/api/wallet', { token: h.token(user) });
    expect(overview.body.availableBalance.amount).toBe('0.00');
  });

  it('validates the amount, the unknown fields and the idempotency key', async () => {
    const user = newId();
    const t = h.token(user);
    for (const amount of ['0.00', '100000.01', '12.5', '12', 'abc', '-5.00']) {
      expect((await h.call('POST', '/api/wallet/topups', { token: t, headers: key(), body: { amount } })).status).toBe(422);
    }
    expect((await h.call('POST', '/api/wallet/topups', { token: t, headers: key(), body: { amount: '10.00', role: 'ADMIN' } })).status).toBe(422);
    expect((await h.call('POST', '/api/wallet/topups', { token: t, body: { amount: '10.00' } })).status).toBe(400);
    expect((await h.call('POST', '/api/wallet/topups', { token: t, headers: key(), body: { amount: '100000.00' } })).status).toBe(201);
  });

  it('replays the same key, and conflicts when the key is reused with different input', async () => {
    const user = newId(); const t = h.token(user); const headers = key();
    const first = await h.call('POST', '/api/wallet/topups', { token: t, headers, body: { amount: '10.00' } });
    const again = await h.call('POST', '/api/wallet/topups', { token: t, headers, body: { amount: '10.00' } });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect((await h.call('POST', '/api/wallet/topups', { token: t, headers, body: { amount: '11.00' } })).status).toBe(409);
    expect(Number((await pool.query('SELECT count(*) FROM topups')).rows[0].count)).toBe(1);
  });

  it('keeps the booking return destination', async () => {
    const user = newId(); const booking = newId();
    const created = await h.call('POST', '/api/wallet/topups', { token: h.token(user), headers: key(), body: { amount: '10.00', returnToBookingId: booking } });
    expect(created.body.returnToBookingId).toBe(booking);
  });

  it('credits exactly once on success, however often the outcome is repeated', async () => {
    const user = newId(); const admin = newId();
    const topup = await fundViaTopup(user, '300.00', admin);
    const again = await h.call('POST', `/api/demo/topups/${topup.id}/outcome`, { token: h.token(admin, ['STUDENT', 'ADMIN']), headers: key(), body: { outcome: 'SUCCEEDED', providerReference: topup.providerReference } });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('SUCCEEDED');
    expect((await postedBalance(user)).p).toBe('30000');
    expect(Number((await pool.query("SELECT count(*) FROM ledger_entries WHERE type = 'TOP_UP'")).rows[0].count)).toBe(1);
    const op = await h.call('GET', `/internal/v1/wallet/operations/${topup.operation.id}`, { token: h.token(user) });
    expect(op.body.status).toBe('SUCCEEDED');
    expect(h.contracts.isDef('Operation', op.body)).toBe(true);
  });

  it('never credits for a failed or unknown outcome and never reverses a terminal outcome', async () => {
    const user = newId(); const admin = h.token(newId(), ['STUDENT', 'ADMIN']);
    const failed = await h.call('POST', '/api/wallet/topups', { token: h.token(user), headers: key(), body: { amount: '90.00' } });
    const unknown = await h.call('POST', '/api/wallet/topups', { token: h.token(user), headers: key(), body: { amount: '70.00' } });
    const outcome = (t: any, o: string, ref = t.body.providerReference) => h.call('POST', `/api/demo/topups/${t.body.id}/outcome`, { token: admin, headers: key(), body: { outcome: o, providerReference: ref } });

    expect((await outcome(unknown, 'UNKNOWN')).body.status).toBe('UNKNOWN');
    expect((await postedBalance(user))).toBeUndefined();
    expect((await h.call('GET', `/internal/v1/wallet/operations/${unknown.body.operation.id}`, { token: h.token(user) })).body.status).toBe('PENDING');

    expect((await outcome(failed, 'FAILED')).body.status).toBe('FAILED');
    expect((await outcome(failed, 'SUCCEEDED')).status).toBe(409);
    expect((await outcome(failed, 'UNKNOWN')).status).toBe(409);
    const rejected = await h.call('GET', `/internal/v1/wallet/operations/${failed.body.operation.id}`, { token: h.token(user) });
    expect(rejected.body.status).toBe('REJECTED');
    expect(h.contracts.isDef('Operation', rejected.body)).toBe(true);
    expect(await postedBalance(user)).toBeUndefined();

    expect((await outcome(unknown, 'SUCCEEDED')).body.status).toBe('SUCCEEDED');
    expect((await outcome(unknown, 'FAILED')).status).toBe(409);
    expect((await postedBalance(user)).p).toBe('7000');
  });

  it('rejects a provider reference that does not match the stored one', async () => {
    const user = newId();
    const t = await h.call('POST', '/api/wallet/topups', { token: h.token(user), headers: key(), body: { amount: '10.00' } });
    const bad = await h.call('POST', `/api/demo/topups/${t.body.id}/outcome`, { token: h.token(newId(), ['ADMIN']), headers: key(), body: { outcome: 'SUCCEEDED', providerReference: newId() } });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('PROVIDER_OUTCOME_CONFLICT');
  });

  it('hides another user\'s top-up and operation', async () => {
    const owner = newId(); const other = newId();
    const t = await h.call('POST', '/api/wallet/topups', { token: h.token(owner), headers: key(), body: { amount: '10.00' } });
    expect((await h.call('GET', `/api/wallet/topups/${t.body.id}`, { token: h.token(other) })).status).toBe(404);
    expect((await h.call('GET', `/internal/v1/wallet/operations/${t.body.operation.id}`, { token: h.token(other) })).status).toBe(404);
    expect((await h.call('GET', `/internal/v1/wallet/operations/${t.body.operation.id}`, { token: h.token(newId(), ['STUDENT', 'ADMIN']) })).status).toBe(200);
  });
});

describe('demo mode', () => {
  it('refuses the provider controls when DEMO_MODE is off', async () => {
    const off = await startHarness(pool, { demoMode: false });
    try {
      const user = newId();
      const t = await off.call('POST', '/api/wallet/topups', { token: off.token(user), headers: key(), body: { amount: '10.00' } });
      const denied = await off.call('POST', `/api/demo/topups/${t.body.id}/outcome`, { token: off.token(newId(), ['ADMIN']), headers: key(), body: { outcome: 'SUCCEEDED', providerReference: t.body.providerReference } });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('DEMO_DISABLED');
    } finally { await off.close(); }
  });

  it('refuses a resource that is not marked synthetic', async () => {
    const user = newId();
    const t = await h.call('POST', '/api/wallet/topups', { token: h.token(user), headers: key(), body: { amount: '10.00' } });
    await pool.query('UPDATE topups SET synthetic = false WHERE id = $1', [t.body.id]);
    const denied = await h.call('POST', `/api/demo/topups/${t.body.id}/outcome`, { token: h.token(newId(), ['ADMIN']), headers: key(), body: { outcome: 'SUCCEEDED', providerReference: t.body.providerReference } });
    expect(denied.body.code).toBe('RESOURCE_NOT_SYNTHETIC');
  });
});

describe('payout accounts', () => {
  const tutor = newId();
  const t = () => h.token(tutor, ['STUDENT', 'TUTOR']);
  const create = (extra: Record<string, unknown> = {}, number = '1234567890') => {
    h.clock.advance(1000); // distinct createdAt values: the list orders by createdAt, then id
    return h.call('POST', '/api/payout-accounts', { token: t(), headers: key(), body: { bankCode: 'KBANK', accountHolderName: 'Somchai Jaidee', accountNumber: number, ...extra } });
  };

  it('lists banks, normalizes and masks the number, and never returns the full number', async () => {
    expect((await h.call('GET', '/api/payout-accounts/banks', { token: t() })).body.items.length).toBeGreaterThan(5);
    const res = await create({}, '123-456 7890');
    expect(res.status).toBe(201);
    expect(res.body.maskedAccountNumber).toBe('******7890');
    expect(JSON.stringify(res.body)).not.toContain('1234567890');
    expect(res.body.isDefault).toBe(true);
    expect(res.headers.get('etag')).toBe('"0"');
    expect(h.contracts.isDef('PayoutAccount', res.body)).toBe(true);
    const stored = JSON.stringify((await pool.query('SELECT * FROM payout_accounts')).rows);
    expect(stored).not.toContain('1234567890');
  });

  it('rejects bad numbers, unknown banks, duplicates and a sixth account', async () => {
    expect((await create({}, '123456789')).status).toBe(422);
    expect((await create({}, '1234567890123456')).status).toBe(422);
    expect((await create({}, 'abcdefghij')).status).toBe(422);
    expect((await create({ bankCode: 'NOPE' })).status).toBe(422);
    expect((await create()).status).toBe(201);
    const dup = await create({}, '1234-567-890');
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('PAYOUT_ACCOUNT_EXISTS');
    for (const n of ['1000000001', '1000000002', '1000000003', '1000000004']) expect((await create({}, n)).status).toBe(201);
    const sixth = await create({}, '1000000005');
    expect(sixth.status).toBe(409);
    expect(sixth.body.code).toBe('PAYOUT_ACCOUNT_LIMIT');
  });

  it('keeps one default: explicit change needs the current revision, removal promotes the oldest', async () => {
    const first = (await create({}, '1000000001')).body;
    const second = (await create({}, '1000000002')).body;
    const third = (await create({ makeDefault: true }, '1000000003')).body;
    const list = await h.call('GET', '/api/payout-accounts', { token: t() });
    expect(list.body.items.map((a: any) => a.id)).toEqual([third.id, first.id, second.id]);
    expect(list.body.items.filter((a: any) => a.isDefault)).toHaveLength(1);

    const noMatch = await h.call('PATCH', `/api/payout-accounts/${second.id}/default`, { token: t(), headers: key() });
    expect(noMatch.status).toBe(428);
    const stale = await h.call('PATCH', `/api/payout-accounts/${second.id}/default`, { token: t(), headers: { ...key(), 'if-match': '"9"' } });
    expect(stale.status).toBe(412);
    const set = await h.call('PATCH', `/api/payout-accounts/${second.id}/default`, { token: t(), headers: { ...key(), 'if-match': '"0"' } });
    expect(set.status).toBe(200);
    expect(set.body.isDefault).toBe(true);

    const removed = await h.call('DELETE', `/api/payout-accounts/${second.id}`, { token: t(), headers: { ...key(), 'if-match': set.headers.get('etag')! } });
    expect(removed.status).toBe(204);
    const after = (await h.call('GET', '/api/payout-accounts', { token: t() })).body.items;
    expect(after).toHaveLength(2);
    expect(after.find((a: any) => a.isDefault).id).toBe(first.id);
  });

  it('never exposes or edits another user\'s account', async () => {
    const mine = (await create({}, '1000000001')).body;
    const other = h.token(newId(), ['STUDENT', 'TUTOR']);
    expect((await h.call('PATCH', `/api/payout-accounts/${mine.id}/default`, { token: other, headers: { ...key(), 'if-match': '"0"' } })).status).toBe(404);
    expect((await h.call('DELETE', `/api/payout-accounts/${mine.id}`, { token: other, headers: { ...key(), 'if-match': '"0"' } })).status).toBe(404);
    expect((await h.call('GET', '/api/payout-accounts', { token: other })).body.items).toHaveLength(0);
  });
});

describe('payouts', () => {
  const tutor = newId(); const admin = newId();
  const t = () => h.token(tutor, ['STUDENT', 'TUTOR']);
  async function setup(balance = '1000.00') {
    await fundViaTopup(tutor, balance, admin);
    const account = (await h.call('POST', '/api/payout-accounts', { token: t(), headers: key(), body: { bankCode: 'SCB', accountHolderName: 'Tutor', accountNumber: '9876543210' } })).body;
    return account;
  }
  const outcome = (p: any, o: string) => h.call('POST', `/api/demo/payouts/${p.id}/outcome`, { token: h.token(admin, ['STUDENT', 'ADMIN']), headers: key(), body: { outcome: o, providerReference: p.providerReference } });

  it('reserves funds, rejects overspending and records a durable 402 for the same key', async () => {
    const account = await setup('1000.00');
    const ok = await h.call('POST', '/api/payouts', { token: t(), headers: key(), body: { amount: '600.00', payoutAccountId: account.id } });
    expect(ok.status).toBe(201);
    expect(ok.body.demo).toBe(true);
    expect(h.contracts.isDef('Payout', ok.body)).toBe(true);
    expect((await postedBalance(tutor))).toEqual({ p: '100000', r: '60000' });
    const headers = key();
    const refused = await h.call('POST', '/api/payouts', { token: t(), headers, body: { amount: '500.00', payoutAccountId: account.id } });
    expect(refused.status).toBe(402);
    expect(refused.body.code).toBe('INSUFFICIENT_BALANCE');
    // After topping up, the same key still replays the recorded refusal; a new action needs a new key.
    await fundViaTopup(tutor, '1000.00', admin);
    expect((await h.call('POST', '/api/payouts', { token: t(), headers, body: { amount: '500.00', payoutAccountId: account.id } })).status).toBe(402);
    expect((await h.call('POST', '/api/payouts', { token: t(), headers: key(), body: { amount: '500.00', payoutAccountId: account.id } })).status).toBe(201);
    const overview = (await h.call('GET', '/api/wallet', { token: t() })).body;
    expect(overview.postedBalance.amount).toBe('2000.00');
    expect(overview.reservedPayouts.amount).toBe('1100.00');
    expect(overview.availableBalance.amount).toBe('900.00');
    expect(h.contracts.isDef('WalletOverview', overview)).toBe(true);
  });

  it('cannot overspend under concurrent requests', async () => {
    const account = await setup('1000.00');
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      h.call('POST', '/api/payouts', { token: t(), headers: key(), body: { amount: '400.00', payoutAccountId: account.id } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 402)).toHaveLength(4);
    expect((await postedBalance(tutor)).r).toBe('80000');
  });

  it('success posts one payout movement; failure releases; unknown keeps the reservation', async () => {
    const account = await setup('1000.00');
    const mk = async (amount: string) => (await h.call('POST', '/api/payouts', { token: t(), headers: key(), body: { amount, payoutAccountId: account.id } })).body;
    const a = await mk('100.00'); const b = await mk('200.00'); const c = await mk('300.00');

    expect((await outcome(a, 'SUCCEEDED')).body.status).toBe('SUCCEEDED');
    expect((await outcome(a, 'SUCCEEDED')).status).toBe(200);
    expect((await outcome(a, 'FAILED')).status).toBe(409);
    expect(await postedBalance(tutor)).toEqual({ p: '90000', r: '50000' });

    expect((await outcome(b, 'FAILED')).body.status).toBe('FAILED');
    expect(await postedBalance(tutor)).toEqual({ p: '90000', r: '30000' });

    expect((await outcome(c, 'UNKNOWN')).body.status).toBe('UNKNOWN');
    expect(await postedBalance(tutor)).toEqual({ p: '90000', r: '30000' });
    expect((await outcome(c, 'SUCCEEDED')).body.status).toBe('SUCCEEDED');
    expect(await postedBalance(tutor)).toEqual({ p: '60000', r: '0' });
    expect(Number((await pool.query("SELECT count(*) FROM ledger_entries WHERE type = 'PAYOUT'")).rows[0].count)).toBe(2);
    const overview = (await h.call('GET', '/api/wallet', { token: t() })).body;
    expect(overview.totalPaidOut.amount).toBe('400.00');
  });

  it('keeps the accepted destination after the account is removed, but refuses new payouts to it', async () => {
    const account = await setup('1000.00');
    const payout = (await h.call('POST', '/api/payouts', { token: t(), headers: key(), body: { amount: '100.00', payoutAccountId: account.id } })).body;
    await h.call('DELETE', `/api/payout-accounts/${account.id}`, { token: t(), headers: { ...key(), 'if-match': '"0"' } });
    const again = await h.call('GET', `/api/payouts/${payout.id}`, { token: t() });
    expect(again.body.payoutAccount.maskedAccountNumber).toBe('******3210');
    const refused = await h.call('POST', '/api/payouts', { token: t(), headers: key(), body: { amount: '100.00', payoutAccountId: account.id } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PAYOUT_ACCOUNT_REMOVED');
    expect((await outcome(payout, 'SUCCEEDED')).body.status).toBe('SUCCEEDED');
  });

  it('is Tutor-only, owner-only, and bounded to THB 100,000', async () => {
    const account = await setup('1000.00');
    expect((await h.call('POST', '/api/payouts', { token: h.token(tutor), headers: key(), body: { amount: '1.00', payoutAccountId: account.id } })).status).toBe(403);
    const other = h.token(newId(), ['STUDENT', 'TUTOR']);
    expect((await h.call('POST', '/api/payouts', { token: other, headers: key(), body: { amount: '1.00', payoutAccountId: account.id } })).status).toBe(404);
    expect((await h.call('POST', '/api/payouts', { token: t(), headers: key(), body: { amount: '100000.01', payoutAccountId: account.id } })).status).toBe(422);
  });
});

describe('transaction history', () => {
  it('lists only completed movements, newest first, and filters by type', async () => {
    const user = newId(); const admin = newId();
    await fundViaTopup(user, '100.00', admin);
    await h.call('POST', '/api/wallet/topups', { token: h.token(user), headers: key(), body: { amount: '55.00' } }); // pending: not history
    const list = await h.call('GET', '/api/wallet/transactions', { token: h.token(user) });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.pagination).toEqual({ page: 1, pageSize: 20, totalItems: 1, totalPages: 1 });
    expect(h.contracts.isDef('TransactionPage', list.body)).toBe(true);
    expect((await h.call('GET', '/api/wallet/transactions?type=REFUND', { token: h.token(user) })).body).toEqual({ items: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
    const one = await h.call('GET', `/api/wallet/transactions/${list.body.items[0].id}`, { token: h.token(user) });
    expect(one.status).toBe(200);
    expect((await h.call('GET', `/api/wallet/transactions/${list.body.items[0].id}`, { token: h.token(newId()) })).status).toBe(404);
  });
});

describe('disputes over HTTP', () => {
  async function paidLesson() {
    const student = newId(); const tutor = newId(); const bookingId = newId(); const admin = newId();
    await fundViaTopup(student, '1000.00', admin);
    const startsAt = new Date(T0.getTime() + 72 * 3_600_000);
    const endsAt = new Date(startsAt.getTime() + 3_600_000);
    const cmd = {
      bookingId, sourceOperationId: newId(), studentUserId: student, tutorUserId: tutor, subjectId: newId(), amount: { currency: 'THB' as const, amount: '600.00' },
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), holdExpiresAt: new Date(T0.getTime() + 900_000).toISOString(),
      admission: { id: newId(), actorUserId: student, sessionId: newId(), admittedAt: T0.toISOString(), requestId: newId(), publicOperation: 'payBooking' },
    };
    const { FinancialService } = await import('../src/domain/financial');
    await new FinancialService(pool, h.clock).applyLessonCharge(newId(), cmd);
    h.peers.evidence.set(bookingId, { bookingId, status: 'CONFIRMED', studentUserId: student, tutorUserId: tutor, subjectId: cmd.subjectId, startsAt: cmd.startsAt, endsAt: cmd.endsAt, completedAt: null, cancelledAt: null, revision: '2' });
    h.peers.accounts.set(student, { id: student, displayName: 'Student Name', status: 'ACTIVE', capabilities: ['STUDENT'] });
    h.peers.accounts.set(tutor, { id: tutor, displayName: 'Tutor Name', status: 'ACTIVE', capabilities: ['STUDENT', 'TUTOR'] });
    h.clock.set(new Date(startsAt.getTime() + 600_000));
    return { student, tutor, bookingId, admin: h.token(admin, ['STUDENT', 'ADMIN']) };
  }

  it('lets the student open a case, shows the admin the evidence, and applies the decision once', async () => {
    const { student, bookingId, admin } = await paidLesson();
    const headers = key();
    const opened = await h.call('POST', '/api/disputes', { token: h.token(student), headers, body: { bookingId, reason: 'Tutor never showed up' } });
    expect(opened.status).toBe(201);
    expect(opened.body.status).toBe('OPEN');
    expect(opened.body.earningsHeld).toBe(true);
    expect(opened.body.booking).toBeUndefined(); // the user DTO carries no booking/financial detail
    expect(h.contracts.isDef('Dispute', opened.body)).toBe(true);
    const replay = await h.call('POST', '/api/disputes', { token: h.token(student), headers, body: { bookingId, reason: 'Tutor never showed up' } });
    expect(replay.body.id).toBe(opened.body.id);
    expect((await h.call('POST', '/api/disputes', { token: h.token(student), headers: key(), body: { bookingId, reason: 'again' } })).body.code).toBe('DISPUTE_EXISTS');

    const detail = await h.call('GET', `/api/admin/disputes/${opened.body.id}`, { token: admin });
    expect(detail.status).toBe(200);
    expect(detail.body.studentDisplayName).toBe('Student Name');
    expect(detail.body.financial.disputeHeld).toBe(true);
    expect(detail.body.transactions.some((t: any) => t.type === 'LESSON_PAYMENT')).toBe(true);
    expect(h.contracts.isDef('AdminDisputeDetail', detail.body)).toBe(true);

    expect((await h.call('POST', `/api/admin/disputes/${opened.body.id}/decision`, { token: admin, headers: key(), body: { decision: 'REJECT', reason: 'x' } })).status).toBe(428);
    const decisionKey = key();
    const decide = () => h.call('POST', `/api/admin/disputes/${opened.body.id}/decision`, { token: admin, headers: { ...decisionKey, 'if-match': '"0"' }, body: { decision: 'APPROVE_FULL_REMAINDER', reason: 'Verified' } });
    const decided = await decide();
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe('APPROVED');
    expect(decided.body.refundedAmount.amount).toBe('600.00');
    expect((await decide()).body.id).toBe(opened.body.id); // lost response: same key replays, no second refund
    expect(Number((await pool.query("SELECT count(*) FROM ledger_entries WHERE type = 'REFUND'")).rows[0].count)).toBe(1);
    const own = await h.call('GET', `/api/disputes/${opened.body.id}`, { token: h.token(student) });
    expect(own.body.decisionReason).toBe('Verified');
    expect(own.body.audit.map((a: any) => a.action)).toEqual(['OPENED', 'APPROVED']);
  });

  it('hides a dispute from other students and refuses a booking that is not the caller\'s', async () => {
    const { student, bookingId } = await paidLesson();
    const stranger = h.token(newId());
    expect((await h.call('POST', '/api/disputes', { token: stranger, headers: key(), body: { bookingId, reason: 'mine now' } })).status).toBe(404);
    const opened = await h.call('POST', '/api/disputes', { token: h.token(student), headers: key(), body: { bookingId, reason: 'real' } });
    expect((await h.call('GET', `/api/disputes/${opened.body.id}`, { token: stranger })).status).toBe(404);
  });

  it('returns 503 rather than guessing when Booking evidence is unavailable', async () => {
    const { student } = await paidLesson();
    const original = h.peers.booking.getBookingEvidence;
    h.peers.booking.getBookingEvidence = async () => { const { unavailable } = await import('../src/errors'); throw unavailable('DEPENDENCY_UNAVAILABLE', 'down'); };
    try {
      const res = await h.call('POST', '/api/disputes', { token: h.token(student), headers: key(), body: { bookingId: newId(), reason: 'x' } });
      expect(res.status).toBe(503);
      expect(res.body.retryable).toBe(true);
    } finally { h.peers.booking.getBookingEvidence = original; }
  });

  it('lists admin cases by status', async () => {
    const { student, bookingId, admin } = await paidLesson();
    await h.call('POST', '/api/disputes', { token: h.token(student), headers: key(), body: { bookingId, reason: 'r' } });
    expect((await h.call('GET', '/api/admin/disputes?status=OPEN', { token: admin })).body.pagination.totalItems).toBe(1);
    expect((await h.call('GET', '/api/admin/disputes?status=APPROVED', { token: admin })).body.pagination.totalItems).toBe(0);
    expect((await h.call('GET', '/api/admin/disputes?status=BOGUS', { token: admin })).status).toBe(422);
  });
});
