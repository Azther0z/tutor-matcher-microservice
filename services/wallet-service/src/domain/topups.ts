import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { Actor } from '../auth';
import type { Tx } from '../db';
import { conflict, notFound, validation } from '../errors';
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
  manual: boolean; slip_url: string | null; slip_content_type: string | null; slip_uploaded_at: Date | null; decision_reason: string | null; decided_at: Date | null;
  op_status: string; op_resource_type: string; op_resource_id: string; op_resource_url: string;
}

// The slip image itself is never selected here: it is large and is served only by getSlip.
const COLUMNS = `t.id, t.user_id, t.amount_satang, t.status, t.provider_reference, t.operation_id, t.return_to_booking_id, t.synthetic, t.created_at, t.confirmed_at,
                 t.manual, t.slip_url, t.slip_content_type, t.slip_uploaded_at, t.decision_reason, t.decided_at`;
const SELECT = `SELECT ${COLUMNS}, o.status AS op_status, o.resource_type AS op_resource_type, o.resource_id AS op_resource_id, o.resource_url AS op_resource_url
                FROM topups t JOIN wallet_operations o ON o.id = t.operation_id`;

export function topupView(row: TopupRow) {
  const amount = BigInt(row.amount_satang);
  return {
    id: row.id,
    userId: row.user_id,
    amount: money(amount),
    status: row.status,
    demo: !row.manual,
    manual: row.manual,
    providerReference: row.provider_reference,
    // Simulated requests carry a clearly non-payable text; manual requests are paid by a real PromptPay transfer outside the system.
    paymentRepresentation: row.manual
      ? `PromptPay transfer of THB ${money(amount).amount}, reviewed by an admin from the attached slip`
      : `SIMULATED DEMONSTRATION ONLY - NOT PAYABLE | top-up ${row.id} | THB ${money(amount).amount} | provider reference ${row.provider_reference}`,
    slip: row.slip_uploaded_at && row.slip_content_type ? { contentType: row.slip_content_type, uploadedAt: row.slip_uploaded_at.toISOString(), url: row.slip_url ?? `/api/admin/topups/${row.id}/slip` } : null,
    decisionReason: row.decision_reason,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    returnToBookingId: row.return_to_booking_id,
    operation: operationRef({ id: row.operation_id, status: row.op_status, resource_type: row.op_resource_type, resource_id: row.op_resource_id, resource_url: row.op_resource_url }),
    createdAt: row.created_at.toISOString(),
    confirmedAt: row.confirmed_at ? row.confirmed_at.toISOString() : null,
  };
}

const MAX_SLIP_BYTES = 2 * 1024 * 1024;
const SLIP_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Where slip files live: the service's own uploads directory, or SLIP_DIR (a mounted volume in Compose). */
export const slipDirectory = (): string => process.env.SLIP_DIR || path.resolve(__dirname, '../../uploads/slips');
/** The file name is derived from the request id and type, never from anything the user sent. */
const slipFile = (id: string, contentType: string): string => path.join(slipDirectory(), `${id}.${EXTENSION[contentType]}`);

/** The first bytes of a real image of the claimed type, so a renamed file is not stored as a slip. */
function matchesType(bytes: Buffer, contentType: string): boolean {
  if (contentType === 'image/png') return bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG';
  if (contentType === 'image/jpeg') return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

export interface TopupRequest {
  amount: string;
  slipImage: string;
  slipContentType: string;
  returnToBookingId?: string;
}

/**
 * A manual PromptPay top-up request: the amount and the transfer slip arrive together. It stays PENDING until an admin
 * decides, and a user may have only one request waiting at a time.
 */
export async function createTopup(tx: Tx, actor: Actor, body: TopupRequest, now: Date): Promise<Reply> {
  const fields: Array<{ path: string; code: string; message: string }> = [];
  let amount = 0n;
  try { amount = parseAmount(body.amount); } catch { fields.push({ path: '/body/amount', code: 'INVALID', message: 'Enter an amount with at most two decimal places' }); }
  if (amount <= 0n || amount > 10_000_000n) fields.push({ path: '/body/amount', code: 'INVALID', message: 'The amount must be from 0.01 to 100,000.00' });
  if (!(SLIP_TYPES as readonly string[]).includes(body.slipContentType)) fields.push({ path: '/body/slipContentType', code: 'INVALID', message: 'The slip must be a PNG, JPEG or WebP image' });
  const bytes = typeof body.slipImage === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(body.slipImage) ? Buffer.from(body.slipImage, 'base64') : null;
  if (!bytes || bytes.length === 0) fields.push({ path: '/body/slipImage', code: 'REQUIRED', message: 'Attach the transfer slip image' });
  else if (bytes.length > MAX_SLIP_BYTES) fields.push({ path: '/body/slipImage', code: 'INVALID', message: 'The slip image must be 2 MB or smaller' });
  else if (!matchesType(bytes, body.slipContentType)) fields.push({ path: '/body/slipImage', code: 'INVALID', message: 'The file is not a valid image of the selected type' });
  if (fields.length) throw validation(fields);

  const open = await tx.query("SELECT 1 FROM topups WHERE user_id = $1 AND manual AND status = 'PENDING'", [actor.userId]);
  if (open.rowCount) throw conflict('TOPUP_REQUEST_OPEN', 'You already have a top-up request waiting for review. Wait for the decision before sending another.');

  const id = newId();
  const operationId = newId();
  const file = slipFile(id, body.slipContentType);
  // The image goes to disk first; the row stores only the URL it is served from. A failed insert removes the file again.
  await fs.mkdir(slipDirectory(), { recursive: true });
  await fs.writeFile(file, bytes as Buffer, { flag: 'wx', mode: 0o640 });
  try {
    await createOperation(tx, {
      id: operationId, kind: 'wallet.topup', initiatorUserId: actor.userId, affectedUserId: actor.userId,
      resourceType: 'topup', resourceId: id, resourceUrl: `/api/wallet/topups/${id}`, now,
    });
    await tx.query(
      `INSERT INTO topups (id, user_id, amount_satang, provider_reference, operation_id, return_to_booking_id, synthetic, manual,
                           slip_url, slip_content_type, slip_uploaded_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, true, $7, $8, $9, $9)`,
      [id, actor.userId, amount, newId(), operationId, body.returnToBookingId ?? null, `/api/admin/topups/${id}/slip`, body.slipContentType, now],
    );
  } catch (error) {
    await fs.rm(file, { force: true });
    throw error;
  }
  const { rows } = await tx.query<TopupRow>(`${SELECT} WHERE t.id = $1`, [id]);
  return { status: 201, body: topupView(rows[0]), headers: { Location: `/api/wallet/topups/${id}` } };
}

/** Admin review queue: waiting requests first, then the most recent decisions. */
export async function listReviewTopups(pool: Pool, filter: { status?: string }, page: Page) {
  const where = filter.status ? 'WHERE t.manual AND t.status = $1' : 'WHERE t.manual';
  const params: unknown[] = filter.status ? [filter.status] : [];
  const total = Number((await pool.query(`SELECT count(*) FROM topups t ${where}`, params)).rows[0].count);
  const { rows } = await pool.query<TopupRow>(
    `${SELECT} ${where} ORDER BY (t.status = 'PENDING') DESC, t.created_at DESC, t.id DESC LIMIT ${page.pageSize} OFFSET ${page.offset}`, params);
  return { rows, total };
}

/** The slip image, for an admin reviewing the request: read from the uploads directory (or the legacy database copy). */
export async function getSlip(pool: Pool, topupId: string): Promise<{ contentType: string; bytes: Buffer }> {
  const { rows } = await pool.query<{ slip_url: string | null; slip_image: Buffer | null; slip_content_type: string | null }>(
    'SELECT slip_url, slip_image, slip_content_type FROM topups WHERE id = $1 AND manual', [topupId]);
  const row = rows[0];
  if (!row?.slip_content_type) throw notFound('NOT_FOUND', 'Slip not found');
  if (row.slip_url) {
    try {
      return { contentType: row.slip_content_type, bytes: await fs.readFile(slipFile(topupId, row.slip_content_type)) };
    } catch {
      throw notFound('NOT_FOUND', 'The slip file is missing');
    }
  }
  if (row.slip_image) return { contentType: row.slip_content_type, bytes: row.slip_image };
  throw notFound('NOT_FOUND', 'Slip not found');
}

/** Approve credits the wallet exactly once; reject records the reason and credits nothing. A decided request is final. */
export async function decideTopup(
  tx: Tx, admin: Actor, topupId: string, input: { decision: 'APPROVE' | 'REJECT'; reason?: string }, now: Date,
): Promise<Reply> {
  const { rows } = await tx.query<TopupRow>(`${SELECT} WHERE t.id = $1 AND t.manual FOR UPDATE OF t`, [topupId]);
  const topup = rows[0];
  if (!topup) throw notFound('NOT_FOUND', 'Top-up request not found');
  if (topup.status !== 'PENDING') throw conflict('TOPUP_ALREADY_DECIDED', 'This top-up request has already been decided');
  const reason = input.reason?.trim() ?? '';
  if (input.decision === 'REJECT' && !reason) throw validation([{ path: '/body/reason', code: 'REQUIRED', message: 'Give the student a reason for rejecting the request' }]);
  if (reason.length > 500) throw validation([{ path: '/body/reason', code: 'INVALID', message: 'The reason must be 500 characters or fewer' }]);

  const amount = BigInt(topup.amount_satang);
  if (input.decision === 'APPROVE') {
    await lockWallet(tx, topup.user_id, now);
    await postMovement(tx, { userId: topup.user_id, type: 'TOP_UP', direction: 'IN', amount, operationId: topup.operation_id, now });
    await tx.query("UPDATE topups SET status = 'SUCCEEDED', confirmed_at = $2, decided_by = $3, decided_at = $2, decision_reason = $4 WHERE id = $1", [topupId, now, admin.userId, reason || null]);
    await resolveOperation(tx, topup.operation_id, 'SUCCEEDED', now);
    await emit(tx, topup, 'SUCCEEDED', amount, now);
  } else {
    await tx.query("UPDATE topups SET status = 'FAILED', decided_by = $2, decided_at = $3, decision_reason = $4 WHERE id = $1", [topupId, admin.userId, now, reason]);
    await resolveOperation(tx, topup.operation_id, 'REJECTED', now,
      new AppError({ code: 'TOPUP_REJECTED', http: 409, grpc: grpcStatus.FAILED_PRECONDITION, message: `An admin rejected this top-up: ${reason}` }));
    await emit(tx, topup, 'FAILED', amount, now);
  }
  const fresh = (await tx.query<TopupRow>(`${SELECT} WHERE t.id = $1`, [topupId])).rows[0];
  return { status: 200, body: topupView(fresh) };
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
