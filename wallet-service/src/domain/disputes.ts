import type { Pool } from 'pg';
import type { Actor } from '../auth';
import type { Tx } from '../db';
import type { BookingEvidence } from '../clients';
import { conflict, notFound, revisionMismatch } from '../errors';
import { derivedId, newId } from '../ids';
import { money } from '../money';
import { DISPUTE_RESIDUAL_MS, parseInstant } from '../time';
import { bumpRecord, lockRecord, recordView, type FinancialRow } from './financial';
import { lockWallet, postMovement } from './ledger';
import { enqueueEvent } from './outbox';
import { pageMeta, type Page, type Reply } from './reply';

interface DisputeRow {
  id: string; booking_id: string; student_user_id: string; tutor_user_id: string; status: 'OPEN' | 'APPROVED' | 'REJECTED';
  reason: string; decision_reason: string | null; refunded_satang: string; earnings_held: boolean; revision: string;
  created_at: Date; resolved_at: Date | null;
}

interface AuditRow { id: string; actor_user_id: string | null; action: string; reason: string | null; occurred_at: Date }

async function auditFor(q: Pick<Tx, 'query'>, disputeId: string) {
  const { rows } = await q.query<AuditRow>('SELECT * FROM dispute_audit WHERE dispute_id = $1 ORDER BY seq', [disputeId]);
  return rows.map((a) => ({ id: a.id, actorUserId: a.actor_user_id, action: a.action, reason: a.reason, occurredAt: a.occurred_at.toISOString() }));
}

/** The Dispute DTO deliberately carries no booking, financial or ledger detail (those are admin-only). */
export async function disputeView(q: Pick<Tx, 'query'>, row: DisputeRow) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    studentUserId: row.student_user_id,
    status: row.status,
    reason: row.reason,
    decisionReason: row.decision_reason,
    refundedAmount: money(BigInt(row.refunded_satang)),
    earningsHeld: row.earnings_held,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    audit: await auditFor(q, row.id),
  };
}

const windowClosed = (message: string) => conflict('DISPUTE_WINDOW_CLOSED', message);

/** Evidence-based claim window. Wallet re-checks its own financial state under the record lock afterwards. */
export function assertClaimWindow(evidence: BookingEvidence, admittedAt: Date): void {
  const startsAt = parseInstant(evidence.startsAt).getTime();
  const endsAt = parseInstant(evidence.endsAt).getTime();
  const at = admittedAt.getTime();
  if (evidence.status === 'PAYMENT_DUE') throw windowClosed('An unpaid booking has no financial claim');
  if (at < startsAt) throw windowClosed('A claim can be opened once the lesson has started');
  // Cancelled residual-payment claims run [startsAt, endsAt + 24h); a claim exactly at that end is closed.
  if (evidence.status === 'CANCELLED' && at >= endsAt + DISPUTE_RESIDUAL_MS) throw windowClosed('The cancelled-booking claim window has ended');
}

export async function openDispute(
  tx: Tx, actor: Actor, body: { bookingId: string; reason: string }, evidence: BookingEvidence, now: Date,
): Promise<Reply> {
  if (evidence.studentUserId !== actor.userId) throw notFound('NOT_FOUND', 'Booking not found');
  assertClaimWindow(evidence, actor.admittedAt);

  const record = await lockRecord(tx, body.bookingId);
  if (!record || record.student_user_id !== actor.userId) throw notFound('NOT_FOUND', 'No financial record exists for this booking');
  // Clearing committed first: the pre-clearing claim is closed.
  if (record.status === 'SETTLED') throw windowClosed('The earning has already cleared');
  const remaining = BigInt(record.paid_satang) - BigInt(record.refunded_satang);
  if (record.status === 'UNPAID' || remaining <= 0n) throw conflict('NO_REFUNDABLE_AMOUNT', 'There is no remaining paid amount to claim');
  if (record.dispute_held) throw conflict('DISPUTE_EXISTS', 'An open dispute already exists for this booking');

  const id = newId();
  const inserted = await tx.query<DisputeRow>(
    `INSERT INTO disputes (id, booking_id, student_user_id, tutor_user_id, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, body.bookingId, record.student_user_id, record.tutor_user_id, body.reason, now],
  );
  await tx.query(
    "INSERT INTO dispute_audit (id, dispute_id, actor_user_id, action, reason, occurred_at) VALUES ($1, $2, $3, 'OPENED', $4, $5)",
    [newId(), id, actor.userId, body.reason, now],
  );
  const updated = await bumpRecord(tx, body.bookingId, 'dispute_id = $3, dispute_held = true', [id], now);

  // The hold and its notification work commit together.
  await enqueueEvent(tx, {
    type: 'wallet.dispute-opened', aggregate: { type: 'dispute', id, version: '0' }, targets: { kind: 'ADMINS' }, group: 'SYSTEM',
    data: { disputeId: id, bookingId: body.bookingId }, dedupeKey: `dispute-opened:${id}`, now,
  });
  await enqueueEvent(tx, {
    type: 'wallet.dispute-held', aggregate: { type: 'dispute', id, version: '0' },
    targets: { kind: 'USERS', userIds: [record.student_user_id, record.tutor_user_id] }, group: 'SYSTEM',
    data: { disputeId: id, bookingId: body.bookingId }, dedupeKey: `dispute-held:${id}`, now,
  });
  void updated;
  return { status: 201, body: await disputeView(tx, inserted.rows[0]), headers: { Location: `/api/disputes/${id}`, ETag: '"0"' } };
}

export async function decideDispute(
  tx: Tx, actor: Actor, disputeId: string, ifMatch: string, body: { decision: 'APPROVE_FULL_REMAINDER' | 'REJECT'; reason: string }, now: Date,
): Promise<Reply> {
  const peek = await tx.query<DisputeRow>('SELECT * FROM disputes WHERE id = $1', [disputeId]);
  if (!peek.rows[0]) throw notFound('NOT_FOUND', 'Dispute not found');
  // Same lock order as charge/refund/clearing: financial record first, then the case.
  const record = (await lockRecord(tx, peek.rows[0].booking_id)) as FinancialRow;
  const dispute = (await tx.query<DisputeRow>('SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [disputeId])).rows[0];
  if (dispute.status !== 'OPEN') throw conflict('DISPUTE_ALREADY_DECIDED', 'This dispute was already decided');
  if (dispute.revision !== ifMatch) throw revisionMismatch('REVISION_MISMATCH', 'The dispute changed; refresh before deciding');

  let refund = 0n;
  let recordSet = 'dispute_id = NULL, dispute_held = false';
  const recordParams: unknown[] = [];
  if (body.decision === 'APPROVE_FULL_REMAINDER') {
    const paid = BigInt(record.paid_satang);
    const refunded = BigInt(record.refunded_satang);
    refund = paid - refunded; // full remaining paid amount; prior refunds count toward the cap
    if (refund <= 0n) throw conflict('REFUND_LIMIT_EXCEEDED', 'There is no remaining paid amount to refund');
    const operationId = derivedId(`dispute-remedy:${dispute.id}`); // distinct from any cancellation refund identity
    await lockWallet(tx, record.student_user_id, now);
    const moved = await postMovement(tx, { userId: record.student_user_id, type: 'REFUND', direction: 'IN', amount: refund, operationId, bookingId: record.booking_id, now });
    await tx.query(
      `INSERT INTO refund_operations (operation_id, booking_id, kind, command_hash, amount_satang, total_refunded_satang, transaction_id, applied_at)
       VALUES ($1, $2, 'DISPUTE_REMEDY', $3, $4, $5, $6, $7)`,
      [operationId, record.booking_id, dispute.id, refund, paid, moved.id, now],
    );
    // The refunded lesson's pending earning (and its fee) disappear in the same transaction.
    recordSet = `refunded_satang = $3, pending_earning_satang = 0, fee_satang = 0, status = $4, dispute_id = NULL, dispute_held = false`;
    recordParams.push(paid, record.status === 'CANCELLED' ? 'CANCELLED' : 'REFUNDED');
    await enqueueEvent(tx, {
      type: 'wallet.refund-applied', aggregate: { type: 'booking-financial-record', id: record.booking_id, version: String(BigInt(record.revision) + 1n) },
      targets: { kind: 'USERS', userIds: [record.student_user_id] }, group: 'WALLET_PAYMENTS',
      data: { bookingId: record.booking_id, transactionId: moved.id, amount: money(refund) }, dedupeKey: `refund:${operationId}`, now,
    });
  }
  await bumpRecord(tx, record.booking_id, recordSet, recordParams, now);

  const status = body.decision === 'REJECT' ? 'REJECTED' : 'APPROVED';
  const updated = await tx.query<DisputeRow>(
    `UPDATE disputes SET status = $2, decision_reason = $3, refunded_satang = $4, earnings_held = false, revision = revision + 1, resolved_at = $5
     WHERE id = $1 RETURNING *`,
    [dispute.id, status, body.reason, refund, now],
  );
  await tx.query(
    'INSERT INTO dispute_audit (id, dispute_id, actor_user_id, action, reason, occurred_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [newId(), dispute.id, actor.userId, status, body.reason, now],
  );
  await enqueueEvent(tx, {
    type: 'wallet.dispute-decided', aggregate: { type: 'dispute', id: dispute.id, version: updated.rows[0].revision },
    targets: { kind: 'USERS', userIds: [record.student_user_id, record.tutor_user_id] }, group: 'SYSTEM',
    data: { disputeId: dispute.id, bookingId: record.booking_id, decision: body.decision, reason: body.reason, refund: money(refund) },
    dedupeKey: `dispute-decided:${dispute.id}`, now,
  });
  return { status: 200, body: await disputeView(tx, updated.rows[0]), headers: { ETag: `"${updated.rows[0].revision}"` } };
}

export async function getOwnDispute(pool: Pool, actor: Actor, id: string) {
  const { rows } = await pool.query<DisputeRow>('SELECT * FROM disputes WHERE id = $1 AND student_user_id = $2', [id, actor.userId]);
  if (!rows[0]) throw notFound('NOT_FOUND', 'Dispute not found');
  return disputeView(pool, rows[0]);
}

export async function listOwnDisputes(pool: Pool, userId: string, page: Page) {
  const total = Number((await pool.query('SELECT count(*) FROM disputes WHERE student_user_id = $1', [userId])).rows[0].count);
  const { rows } = await pool.query<DisputeRow>(
    'SELECT * FROM disputes WHERE student_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3', [userId, page.pageSize, page.offset]);
  return { items: await Promise.all(rows.map((r) => disputeView(pool, r))), pagination: pageMeta(page, total) };
}

export async function listAdminDisputes(pool: Pool, status: string | undefined, page: Page) {
  const where = status ? 'WHERE status = $1' : '';
  const params = status ? [status] : [];
  const total = Number((await pool.query(`SELECT count(*) FROM disputes ${where}`, params)).rows[0].count);
  const { rows } = await pool.query<DisputeRow>(
    `SELECT * FROM disputes ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.pageSize, page.offset]);
  return { items: await Promise.all(rows.map((r) => disputeView(pool, r))), pagination: pageMeta(page, total) };
}

/** Admin detail: the case, Booking evidence (supplied by the caller), the financial record and the booking's ledger entries. */
export async function adminDisputeParts(pool: Pool, id: string) {
  const { rows } = await pool.query<DisputeRow>('SELECT * FROM disputes WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('NOT_FOUND', 'Dispute not found');
  const record = (await pool.query<FinancialRow>('SELECT * FROM financial_records WHERE booking_id = $1', [rows[0].booking_id])).rows[0];
  const ledger = await pool.query(
    'SELECT * FROM ledger_entries WHERE booking_id = $1 ORDER BY created_at, id', [rows[0].booking_id]);
  return { dispute: await disputeView(pool, rows[0]), row: rows[0], financial: recordView(record), ledger: ledger.rows };
}
