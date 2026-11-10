import type { Pool } from 'pg';
import type { Actor } from '../auth';
import type { Tx } from '../db';
import { notFound } from '../errors';
import { newId } from '../ids';
import { money, parseAmount } from '../money';
import { lockWallet, postMovement } from './ledger';
import { setOutcomeGuard, type ProviderOutcome } from './providerGuard';
import { createOperation, operationRef, resolveOperation } from './operations';
import { enqueueEvent } from './outbox';
import { pageMeta, type Page, type Reply } from './reply';
import { AppError } from '../errors';
import { status as grpcStatus } from '@grpc/grpc-js';

interface TopupRow {
  id: string; user_id: string; amount_satang: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; provider_reference: string;
  operation_id: string; return_to_booking_id: string | null; synthetic: boolean; created_at: Date; confirmed_at: Date | null;
  op_status: string; op_resource_type: string; op_resource_id: string; op_resource_url: string;
}

const SELECT = `SELECT t.*, o.status AS op_status, o.resource_type AS op_resource_type, o.resource_id AS op_resource_id, o.resource_url AS op_resource_url
                FROM topups t JOIN wallet_operations o ON o.id = t.operation_id`;

export function topupView(row: TopupRow) {
  const amount = BigInt(row.amount_satang);
  return {
    id: row.id,
    userId: row.user_id,
    amount: money(amount),
    status: row.status,
    demo: true as const,
    providerReference: row.provider_reference,
    // Deliberately not a scannable code or a PromptPay payload: nothing here can move real money.
    paymentRepresentation: `SIMULATED DEMONSTRATION ONLY - NOT PAYABLE | top-up ${row.id} | THB ${money(amount).amount} | provider reference ${row.provider_reference}`,
    returnToBookingId: row.return_to_booking_id,
    operation: operationRef({ id: row.operation_id, status: row.op_status, resource_type: row.op_resource_type, resource_id: row.op_resource_id, resource_url: row.op_resource_url }),
    createdAt: row.created_at.toISOString(),
    confirmedAt: row.confirmed_at ? row.confirmed_at.toISOString() : null,
  };
}

export async function createTopup(tx: Tx, actor: Actor, body: { amount: string; returnToBookingId?: string }, now: Date): Promise<Reply> {
  const id = newId();
  const operationId = newId();
  await createOperation(tx, {
    id: operationId, kind: 'wallet.topup', initiatorUserId: actor.userId, affectedUserId: actor.userId,
    resourceType: 'topup', resourceId: id, resourceUrl: `/api/wallet/topups/${id}`, now,
  });
  await tx.query(
    `INSERT INTO topups (id, user_id, amount_satang, provider_reference, operation_id, return_to_booking_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, actor.userId, parseAmount(body.amount), newId(), operationId, body.returnToBookingId ?? null, now],
  );
  const { rows } = await tx.query<TopupRow>(`${SELECT} WHERE t.id = $1`, [id]);
  return { status: 201, body: topupView(rows[0]), headers: { Location: `/api/wallet/topups/${id}` } };
}

export async function getTopup(pool: Pool, actor: Actor, id: string) {
  const { rows } = await pool.query<TopupRow>(`${SELECT} WHERE t.id = $1 AND t.user_id = $2`, [id, actor.userId]);
  if (!rows[0]) throw notFound('NOT_FOUND', 'Top-up not found');
  return topupView(rows[0]);
}

export async function listTopups(pool: Pool, userId: string, page: Page) {
  const total = Number((await pool.query('SELECT count(*) FROM topups WHERE user_id = $1', [userId])).rows[0].count);
  const { rows } = await pool.query<TopupRow>(`${SELECT} WHERE t.user_id = $1 ORDER BY t.created_at DESC, t.id DESC LIMIT $2 OFFSET $3`, [userId, page.pageSize, page.offset]);
  return { items: rows.map(topupView), pagination: pageMeta(page, total) };
}

export type { ProviderOutcome } from './providerGuard';

/**
 * Simulated provider control. SUCCEEDED credits exactly once; FAILED has no financial effect;
 * UNKNOWN keeps the operation pending and may later resolve either way. A terminal outcome is never reversed.
 */
export async function setTopupOutcome(
  tx: Tx, topupId: string, input: { outcome: ProviderOutcome; providerReference: string }, now: Date, demoMode: boolean,
): Promise<Reply> {
  const { rows } = await tx.query<TopupRow>(`${SELECT} WHERE t.id = $1 FOR UPDATE OF t`, [topupId]);
  const topup = rows[0];
  const decision = setOutcomeGuard(demoMode, topup ? { synthetic: topup.synthetic, providerReference: topup.provider_reference, status: topup.status } : null, input);
  const view = async () => topupView((await tx.query<TopupRow>(`${SELECT} WHERE t.id = $1`, [topupId])).rows[0]);
  if (decision === 'NOOP') return { status: 200, body: await view() };

  const amount = BigInt(topup.amount_satang);
  if (decision === 'UNKNOWN') {
    await tx.query("UPDATE topups SET status = 'UNKNOWN' WHERE id = $1", [topupId]);
  } else if (decision === 'SUCCEEDED') {
    await lockWallet(tx, topup.user_id, now);
    await postMovement(tx, { userId: topup.user_id, type: 'TOP_UP', direction: 'IN', amount, operationId: topup.operation_id, now });
    await tx.query("UPDATE topups SET status = 'SUCCEEDED', confirmed_at = $2 WHERE id = $1", [topupId, now]);
    await resolveOperation(tx, topup.operation_id, 'SUCCEEDED', now);
    await emit(tx, topup, 'SUCCEEDED', amount, now);
  } else {
    await tx.query("UPDATE topups SET status = 'FAILED' WHERE id = $1", [topupId]);
    await resolveOperation(tx, topup.operation_id, 'REJECTED', now,
      new AppError({ code: 'TOPUP_FAILED', http: 409, grpc: grpcStatus.FAILED_PRECONDITION, message: 'The simulated provider reported the top-up as failed' }));
    await emit(tx, topup, 'FAILED', amount, now);
  }
  return { status: 200, body: await view() };
}

async function emit(tx: Tx, topup: TopupRow, status: 'SUCCEEDED' | 'FAILED', amount: bigint, now: Date): Promise<void> {
  await enqueueEvent(tx, {
    type: 'wallet.topup-resolved', aggregate: { type: 'topup', id: topup.id, version: '1' },
    targets: { kind: 'USERS', userIds: [topup.user_id] }, group: 'WALLET_PAYMENTS',
    data: { topupId: topup.id, status, amount: money(amount) }, dedupeKey: `topup:${topup.id}`, now,
  });
}
