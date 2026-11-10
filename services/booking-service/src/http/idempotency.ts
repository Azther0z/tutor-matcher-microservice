import type { Pool } from 'pg';
import { withRetry, withTx, type Tx } from '../db';
import { AppError, conflict } from '../errors';
import type { Reply } from '../domain/reply';
import { canonicalHash } from '../domain/hash';

export interface IdempotencyScope {
  actorUserId: string;
  method: string;
  /** Canonical route template plus resolved path parameters, e.g. POST /api/payouts. */
  route: string;
  key: string;
  inputHash: string;
  now: Date;
  requestId: string;
}

export function inputHash(body: unknown, extra: unknown = null): string {
  return canonicalHash({ body, extra });
}

function errorReply(error: AppError, requestId: string): Reply {
  return {
    status: error.http,
    body: { code: error.code, message: error.message, requestId, retryable: error.retryable, fields: error.fields, ...(error.operationId ? { operationId: error.operationId } : {}) },
  };
}

interface Stored { input_hash: string; status_code: number | null; response: unknown; headers: Record<string, string> | null }

function replayOf(row: Stored, scope: IdempotencyScope): Reply {
  if (row.input_hash !== scope.inputHash) {
    throw conflict('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with different input');
  }
  return { status: row.status_code ?? 200, body: row.response ?? undefined, headers: { ...(row.headers ?? {}), 'Idempotent-Replay': 'true' } };
}

/**
 * Within one identity, method and canonical route an Idempotency-Key names one logical action.
 * The key row, the business effect and the stored response commit in one local transaction,
 * so a lost response can always be recovered by repeating the same key. Records are never expired.
 */
export class IdempotencyStore {
  constructor(private readonly pool: Pool) {}

  /** Read-only check used before a slow dependency call so a replay does not repeat it. */
  async peek(scope: IdempotencyScope): Promise<Reply | null> {
    const { rows } = await this.pool.query<Stored>(
      'SELECT input_hash, status_code, response, headers FROM idempotency_keys WHERE actor_user_id = $1 AND method = $2 AND route = $3 AND idem_key = $4 AND status_code IS NOT NULL',
      [scope.actorUserId, scope.method, scope.route, scope.key],
    );
    return rows[0] ? replayOf(rows[0], scope) : null;
  }

  async run(scope: IdempotencyScope, work: (tx: Tx) => Promise<Reply>): Promise<Reply> {
    return withRetry(() => withTx(this.pool, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO idempotency_keys (actor_user_id, method, route, idem_key, input_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING idem_key`,
        [scope.actorUserId, scope.method, scope.route, scope.key, scope.inputHash, scope.now],
      );
      if (!inserted.rowCount) {
        // A concurrent first request blocks the insert above until it commits, so this read sees its result.
        const { rows } = await tx.query<Stored>(
          'SELECT input_hash, status_code, response, headers FROM idempotency_keys WHERE actor_user_id = $1 AND method = $2 AND route = $3 AND idem_key = $4',
          [scope.actorUserId, scope.method, scope.route, scope.key],
        );
        return replayOf(rows[0], scope);
      }

      let reply: Reply;
      await tx.query('SAVEPOINT business');
      try {
        reply = await work(tx);
      } catch (error) {
        // A known rejection (402/409) is the recorded answer for this key; its partial writes are undone.
        if (error instanceof AppError && error.durable) {
          await tx.query('ROLLBACK TO SAVEPOINT business');
          reply = errorReply(error, scope.requestId);
        } else {
          throw error;
        }
      }
      await tx.query(
        'UPDATE idempotency_keys SET status_code = $5, response = $6, headers = $7 WHERE actor_user_id = $1 AND method = $2 AND route = $3 AND idem_key = $4',
        [scope.actorUserId, scope.method, scope.route, scope.key, reply.status, reply.body === undefined ? null : JSON.stringify(reply.body), JSON.stringify(reply.headers ?? {})],
      );
      return reply;
    }));
  }
}
