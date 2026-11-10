import type { Pool } from 'pg';
import type { Actor } from '../auth';
import type { Tx } from '../db';
import { AppError, notFound } from '../errors';

export type OperationStatus = 'PENDING' | 'SUCCEEDED' | 'REJECTED';

export interface NewOperation {
  id: string;
  kind: string;
  initiatorUserId: string;
  affectedUserId?: string | null;
  resourceType: string;
  resourceId: string;
  resourceUrl: string;
  now: Date;
}

export async function createOperation(tx: Tx, op: NewOperation): Promise<void> {
  await tx.query(
    `INSERT INTO booking_operations (id, kind, initiator_user_id, affected_user_id, status, resource_type, resource_id, resource_url, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7, $8, $8)`,
    [op.id, op.kind, op.initiatorUserId, op.affectedUserId ?? null, op.resourceType, op.resourceId, op.resourceUrl, op.now],
  );
}

export async function resolveOperation(
  tx: Tx, id: string, status: Exclude<OperationStatus, 'PENDING'>, now: Date, error?: AppError, requestId?: string,
): Promise<void> {
  const payload = error
    ? JSON.stringify({ code: error.code, message: error.message, requestId: requestId ?? '00000000-0000-4000-8000-000000000000', retryable: error.retryable, fields: error.fields })
    : null;
  await tx.query("UPDATE booking_operations SET status = $2, error = $3, updated_at = $4 WHERE id = $1 AND status = 'PENDING'", [id, status, payload, now]);
}

export function operationRef(row: { id: string; status: string; resource_type: string | null; resource_id: string | null; resource_url: string | null }) {
  return {
    id: row.id,
    owner: 'booking' as const,
    status: row.status as OperationStatus,
    statusUrl: `/api/operations/booking/${row.id}`,
    resource: row.resource_type ? { type: row.resource_type, id: row.resource_id, url: row.resource_url } : null,
  };
}

/**
 * Owner status read. The initiating user, the affected participant and a responsible admin may see it;
 * anyone else receives 404 so an ID alone grants nothing.
 */
export async function readOperation(pool: Pool, id: string, actor: Actor) {
  const { rows } = await pool.query('SELECT * FROM booking_operations WHERE id = $1', [id]);
  const row = rows[0];
  const allowed = row && (row.initiator_user_id === actor.userId || row.affected_user_id === actor.userId || actor.capabilities.includes('ADMIN'));
  if (!allowed) throw notFound('NOT_FOUND', 'Operation not found');
  return {
    id: row.id,
    owner: 'booking',
    status: row.status,
    kind: row.kind,
    resource: row.resource_type ? { type: row.resource_type, id: row.resource_id, url: row.resource_url } : null,
    error: row.status === 'REJECTED' ? row.error : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
