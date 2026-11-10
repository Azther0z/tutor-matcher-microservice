import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import type { Actor } from '../auth';
import type { Tx } from '../db';
import { AppError, conflict, forbidden, insufficientFunds, notFound, revisionMismatch, validation } from '../errors';
import { newId } from '../ids';
import { money, parseAmount } from '../money';
import { adjustReservation, lockWallet, postMovement } from './ledger';
import { createOperation, operationRef, resolveOperation } from './operations';
import { enqueueEvent } from './outbox';
import { pageMeta, type Page, type Reply } from './reply';
import { setOutcomeGuard, type ProviderOutcome } from './providerGuard';
import { status as grpcStatus } from '@grpc/grpc-js';

export const BANKS = [
  { code: 'BBL', name: 'Bangkok Bank' },
  { code: 'KBANK', name: 'Kasikornbank' },
  { code: 'KTB', name: 'Krung Thai Bank' },
  { code: 'SCB', name: 'Siam Commercial Bank' },
  { code: 'BAY', name: 'Bank of Ayudhya (Krungsri)' },
  { code: 'TTB', name: 'TMBThanachart Bank' },
  { code: 'GSB', name: 'Government Savings Bank' },
  { code: 'UOB', name: 'United Overseas Bank (Thai)' },
  { code: 'CIMBT', name: 'CIMB Thai Bank' },
  { code: 'KKP', name: 'Kiatnakin Phatra Bank' },
];

const MAX_ACTIVE_ACCOUNTS = 5;

interface AccountRow {
  id: string; user_id: string; bank_code: string; account_holder_name: string; number_fingerprint: string;
  masked_number: string; is_default: boolean; revision: string; created_at: Date; removed_at: Date | null;
}

export function accountView(row: AccountRow) {
  return { id: row.id, bankCode: row.bank_code, accountHolderName: row.account_holder_name, maskedAccountNumber: row.masked_number, isDefault: row.is_default, revision: row.revision };
}

/** Removes spaces and dashes, then requires 10–15 digits. */
export function normalizeAccountNumber(raw: string): string {
  const digits = raw.replace(/[ -]/g, '');
  if (!/^\d{10,15}$/.test(digits)) throw validation([{ path: '/accountNumber', code: 'INVALID', message: 'Account number must have 10 to 15 digits' }]);
  return digits;
}

export function maskNumber(digits: string): string {
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

export function fingerprint(key: string, bankCode: string, digits: string): string {
  return createHmac('sha256', key).update(`${bankCode}|${digits}`).digest('hex');
}

function expectRevision(actual: string, ifMatch: string): void {
  if (actual !== ifMatch) throw revisionMismatch('REVISION_MISMATCH', 'The payout account changed; refresh before deciding again');
}

export async function createPayoutAccount(
  tx: Tx, actor: Actor, body: { bankCode: string; accountHolderName: string; accountNumber: string; makeDefault?: boolean }, now: Date, key: string,
): Promise<Reply> {
  if (!BANKS.some((b) => b.code === body.bankCode)) throw validation([{ path: '/bankCode', code: 'UNKNOWN_BANK', message: 'Unsupported bank code' }]);
  const digits = normalizeAccountNumber(body.accountNumber);
  // The wallet row is the per-user serialization point for the five-account limit and the single default.
  await lockWallet(tx, actor.userId, now);
  const active = (await tx.query<AccountRow>('SELECT * FROM payout_accounts WHERE user_id = $1 AND removed_at IS NULL', [actor.userId])).rows;
  const fp = fingerprint(key, body.bankCode, digits);
  if (active.some((a) => a.number_fingerprint === fp)) throw conflict('PAYOUT_ACCOUNT_EXISTS', 'This bank account is already saved');
  if (active.length >= MAX_ACTIVE_ACCOUNTS) throw conflict('PAYOUT_ACCOUNT_LIMIT', 'At most five payout accounts can be active');

  const makeDefault = active.length === 0 || body.makeDefault === true;
  if (makeDefault) {
    await tx.query('UPDATE payout_accounts SET is_default = false, revision = revision + 1 WHERE user_id = $1 AND is_default AND removed_at IS NULL', [actor.userId]);
  }
  const id = newId();
  const { rows } = await tx.query<AccountRow>(
    `INSERT INTO payout_accounts (id, user_id, bank_code, account_holder_name, number_fingerprint, masked_number, is_default, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [id, actor.userId, body.bankCode, body.accountHolderName.trim(), fp, maskNumber(digits), makeDefault, now],
  );
  return { status: 201, body: accountView(rows[0]), headers: { Location: `/api/payout-accounts/${id}`, ETag: `"${rows[0].revision}"` } };
}

async function ownActiveAccount(tx: Tx, userId: string, id: string): Promise<AccountRow> {
  const { rows } = await tx.query<AccountRow>('SELECT * FROM payout_accounts WHERE id = $1 AND user_id = $2 AND removed_at IS NULL FOR UPDATE', [id, userId]);
  if (!rows[0]) throw notFound('NOT_FOUND', 'Payout account not found');
  return rows[0];
}

export async function setDefaultPayoutAccount(tx: Tx, actor: Actor, id: string, ifMatch: string, now: Date): Promise<Reply> {
  await lockWallet(tx, actor.userId, now);
  const account = await ownActiveAccount(tx, actor.userId, id);
  expectRevision(account.revision, ifMatch);
  if (account.is_default) return { status: 200, body: accountView(account), headers: { ETag: `"${account.revision}"` } };
  await tx.query('UPDATE payout_accounts SET is_default = false, revision = revision + 1 WHERE user_id = $1 AND is_default AND removed_at IS NULL', [actor.userId]);
  const { rows } = await tx.query<AccountRow>('UPDATE payout_accounts SET is_default = true, revision = revision + 1 WHERE id = $1 RETURNING *', [id]);
  return { status: 200, body: accountView(rows[0]), headers: { ETag: `"${rows[0].revision}"` } };
}

export async function deletePayoutAccount(tx: Tx, actor: Actor, id: string, ifMatch: string, now: Date): Promise<Reply> {
  await lockWallet(tx, actor.userId, now);
  const account = await ownActiveAccount(tx, actor.userId, id);
  expectRevision(account.revision, ifMatch);
  // Soft removal: accepted payouts keep their destination snapshot and historical reference.
  await tx.query('UPDATE payout_accounts SET removed_at = $2, is_default = false, revision = revision + 1 WHERE id = $1', [id, now]);
  if (account.is_default) {
    await tx.query(
      `UPDATE payout_accounts SET is_default = true, revision = revision + 1 WHERE id = (
         SELECT id FROM payout_accounts WHERE user_id = $1 AND removed_at IS NULL ORDER BY created_at, id LIMIT 1)`,
      [actor.userId],
    );
  }
  return { status: 204 };
}

export async function listPayoutAccounts(pool: Pool, userId: string, page: Page) {
  const total = Number((await pool.query('SELECT count(*) FROM payout_accounts WHERE user_id = $1 AND removed_at IS NULL', [userId])).rows[0].count);
  const { rows } = await pool.query<AccountRow>(
    'SELECT * FROM payout_accounts WHERE user_id = $1 AND removed_at IS NULL ORDER BY is_default DESC, created_at, id LIMIT $2 OFFSET $3',
    [userId, page.pageSize, page.offset],
  );
  return { items: rows.map(accountView), pagination: pageMeta(page, total) };
}

interface PayoutRow {
  id: string; user_id: string; amount_satang: string; payout_account_id: string; bank_code: string; account_holder_name: string;
  masked_number: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; provider_reference: string; operation_id: string;
  synthetic: boolean; created_at: Date; resolved_at: Date | null; op_status: string; op_resource_type: string; op_resource_id: string;
  op_resource_url: string; acct_default: boolean; acct_revision: string;
}

const PAYOUT_SELECT = `SELECT p.*, o.status AS op_status, o.resource_type AS op_resource_type, o.resource_id AS op_resource_id, o.resource_url AS op_resource_url,
                       a.is_default AS acct_default, a.revision AS acct_revision
                       FROM payouts p JOIN wallet_operations o ON o.id = p.operation_id JOIN payout_accounts a ON a.id = p.payout_account_id`;

export function payoutView(row: PayoutRow) {
  return {
    id: row.id,
    userId: row.user_id,
    amount: money(BigInt(row.amount_satang)),
    // Identity fields come from the immutable snapshot, never from the (possibly removed) account row.
    payoutAccount: { id: row.payout_account_id, bankCode: row.bank_code, accountHolderName: row.account_holder_name, maskedAccountNumber: row.masked_number, isDefault: row.acct_default, revision: row.acct_revision },
    status: row.status,
    operation: operationRef({ id: row.operation_id, status: row.op_status, resource_type: row.op_resource_type, resource_id: row.op_resource_id, resource_url: row.op_resource_url }),
    demo: true as const,
    providerReference: row.provider_reference,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

export async function createPayout(tx: Tx, actor: Actor, body: { amount: string; payoutAccountId: string }, now: Date): Promise<Reply> {
  const wallet = await lockWallet(tx, actor.userId, now);
  const { rows: found } = await tx.query<AccountRow>('SELECT * FROM payout_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE', [body.payoutAccountId, actor.userId]);
  const account = found[0];
  if (!account) throw notFound('NOT_FOUND', 'Payout account not found');
  if (account.removed_at) throw conflict('PAYOUT_ACCOUNT_REMOVED', 'This payout account was removed');

  const amount = parseAmount(body.amount);
  // Only posted-and-unreserved funds count. Pending earnings are not in the wallet balance at all.
  if (wallet.available < amount) throw insufficientFunds('INSUFFICIENT_BALANCE', 'Available funds do not cover this payout');

  const id = newId();
  const operationId = newId();
  await createOperation(tx, { id: operationId, kind: 'wallet.payout', initiatorUserId: actor.userId, affectedUserId: actor.userId, resourceType: 'payout', resourceId: id, resourceUrl: `/api/payouts/${id}`, now });
  // The reservation and the immutable destination/provider work commit together.
  await adjustReservation(tx, actor.userId, amount, now);
  await tx.query(
    `INSERT INTO payouts (id, user_id, amount_satang, payout_account_id, bank_code, account_holder_name, masked_number, provider_reference, operation_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, actor.userId, amount, account.id, account.bank_code, account.account_holder_name, account.masked_number, newId(), operationId, now],
  );
  const { rows } = await tx.query<PayoutRow>(`${PAYOUT_SELECT} WHERE p.id = $1`, [id]);
  return { status: 201, body: payoutView(rows[0]), headers: { Location: `/api/payouts/${id}` } };
}

export async function getPayout(pool: Pool, actor: Actor, id: string) {
  const { rows } = await pool.query<PayoutRow>(`${PAYOUT_SELECT} WHERE p.id = $1 AND p.user_id = $2`, [id, actor.userId]);
  if (!rows[0]) throw notFound('NOT_FOUND', 'Payout not found');
  return payoutView(rows[0]);
}

export async function listPayouts(pool: Pool, userId: string, page: Page) {
  const total = Number((await pool.query('SELECT count(*) FROM payouts WHERE user_id = $1', [userId])).rows[0].count);
  const { rows } = await pool.query<PayoutRow>(`${PAYOUT_SELECT} WHERE p.user_id = $1 ORDER BY p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`, [userId, page.pageSize, page.offset]);
  return { items: rows.map(payoutView), pagination: pageMeta(page, total) };
}

/**
 * Simulated payout provider. SUCCEEDED converts the reservation into one completed PAYOUT movement,
 * FAILED releases the reservation, UNKNOWN keeps it reserved and may later resolve.
 */
export async function setPayoutOutcome(
  tx: Tx, payoutId: string, input: { outcome: ProviderOutcome; providerReference: string }, now: Date, demoMode: boolean,
): Promise<Reply> {
  const { rows } = await tx.query<PayoutRow>(`${PAYOUT_SELECT} WHERE p.id = $1 FOR UPDATE OF p`, [payoutId]);
  const payout = rows[0];
  const decision = setOutcomeGuard(demoMode, payout ? { synthetic: payout.synthetic, providerReference: payout.provider_reference, status: payout.status } : null, input);
  const view = async () => payoutView((await tx.query<PayoutRow>(`${PAYOUT_SELECT} WHERE p.id = $1`, [payoutId])).rows[0]);
  if (decision === 'NOOP') return { status: 200, body: await view() };

  const amount = BigInt(payout.amount_satang);
  await lockWallet(tx, payout.user_id, now);
  if (decision === 'UNKNOWN') {
    await tx.query("UPDATE payouts SET status = 'UNKNOWN' WHERE id = $1", [payoutId]);
  } else if (decision === 'SUCCEEDED') {
    await postMovement(tx, { userId: payout.user_id, type: 'PAYOUT', direction: 'OUT', amount, operationId: payout.operation_id, payoutAccountId: payout.payout_account_id, releaseReservation: amount, now });
    await tx.query("UPDATE payouts SET status = 'SUCCEEDED', resolved_at = $2 WHERE id = $1", [payoutId, now]);
    await resolveOperation(tx, payout.operation_id, 'SUCCEEDED', now);
    await emit(tx, payout, 'SUCCEEDED', amount, now);
  } else {
    await adjustReservation(tx, payout.user_id, -amount, now);
    await tx.query("UPDATE payouts SET status = 'FAILED', resolved_at = $2 WHERE id = $1", [payoutId, now]);
    await resolveOperation(tx, payout.operation_id, 'REJECTED', now,
      new AppError({ code: 'PAYOUT_FAILED', http: 409, grpc: grpcStatus.FAILED_PRECONDITION, message: 'The simulated provider reported the payout as failed' }));
    await emit(tx, payout, 'FAILED', amount, now);
  }
  return { status: 200, body: await view() };
}

async function emit(tx: Tx, payout: PayoutRow, status: 'SUCCEEDED' | 'FAILED', amount: bigint, now: Date): Promise<void> {
  await enqueueEvent(tx, {
    type: 'wallet.payout-resolved', aggregate: { type: 'payout', id: payout.id, version: '1' },
    targets: { kind: 'USERS', userIds: [payout.user_id] }, group: 'WALLET_PAYMENTS',
    // Event bodies carry no bank details at all.
    data: { payoutId: payout.id, status, amount: money(amount) }, dedupeKey: `payout:${payout.id}`, now,
  });
}

export { forbidden };
