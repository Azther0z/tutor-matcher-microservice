import type { Pool } from 'pg';
import type { Contracts } from '../contracts';
import type { Envelope } from '../domain/outbox';
import type { Clock } from '../time';

export interface Broker {
  /** Throws unless the broker is reachable. Queue routing is proven by `publish`, not here. */
  verifyTopology(): Promise<void>;
  /** Resolves only after a *routed* publisher confirm. A nack, an unroutable return or a lost channel throws. */
  publish(envelope: Envelope): Promise<void>;
  close(): Promise<void>;
}

export interface PublisherOptions {
  batchSize?: number;
  leaseMs?: number;
  /** Consecutive failures after which an event is flagged NEEDS_ATTENTION (it is still retried). */
  attentionAfter?: number;
  random?: () => number;
}

const BASE_MS = 1000;
const CAP_MS = 60_000;

export function backoffMs(failures: number, random: () => number = Math.random): number {
  const exp = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(exp * (0.5 + random() * 0.5));
}

/**
 * Publishes events saved by business transactions. It never holds a database transaction open while talking
 * to RabbitMQ: it claims a leased, fenced batch, publishes, then records the outcome only if its fence is current.
 * Event identity is preserved across retries, so Notification can deduplicate a repeated delivery.
 */
export class OutboxPublisher {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly attentionAfter: number;
  private readonly random: () => number;

  constructor(
    private readonly pool: Pool, private readonly broker: Broker, private readonly clock: Clock, private readonly contracts: Contracts,
    options: PublisherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.attentionAfter = options.attentionAfter ?? 10;
    this.random = options.random ?? Math.random;
  }

  async runOnce(): Promise<{ published: number; failed: number }> {
    const now = this.clock.now();
    const claimed = await this.pool.query<{ event_id: string; envelope: Envelope; fence: string; attempts: number }>(
      `UPDATE outbox SET lease_until = $1, fence = fence + 1
       WHERE event_id IN (
         SELECT event_id FROM outbox
         WHERE status = 'PENDING' AND next_attempt_at <= $2 AND (lease_until IS NULL OR lease_until <= $2)
         ORDER BY created_at, event_id LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING event_id, envelope, fence, attempts`,
      [new Date(now.getTime() + this.leaseMs), now, this.batchSize],
    );
    let published = 0;
    let failed = 0;
    for (const row of claimed.rows) {
      try {
        const verdict = this.contracts.validateEvent(row.envelope);
        if (!verdict.ok) throw Object.assign(new Error(`SCHEMA_INVALID ${verdict.errors.join('; ')}`), { permanent: true });
        await this.broker.publish(row.envelope);
        // Compare the fence: a newer claimant owns the row if our lease expired mid-publish.
        await this.pool.query(
          "UPDATE outbox SET status = 'PUBLISHED', published_at = $3, lease_until = NULL, last_error = NULL WHERE event_id = $1 AND fence = $2",
          [row.event_id, row.fence, this.clock.now()],
        );
        published += 1;
      } catch (error) {
        failed += 1;
        const attempts = row.attempts + 1;
        const permanent = (error as { permanent?: boolean }).permanent === true;
        await this.pool.query(
          `UPDATE outbox SET attempts = $3, lease_until = NULL, next_attempt_at = $4, last_error = $5, needs_attention = needs_attention OR $6
           WHERE event_id = $1 AND fence = $2 AND status = 'PENDING'`,
          [row.event_id, row.fence, attempts, new Date(this.clock.now().getTime() + backoffMs(attempts, this.random)),
            String((error as Error).message).slice(0, 500), permanent || attempts >= this.attentionAfter],
        );
      }
    }
    return { published, failed };
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try { await this.runOnce(); } catch (error) { console.error('[Wallet] outbox sweep failed', (error as Error).message); } finally { this.running = false; }
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async pendingCount(): Promise<number> {
    return Number((await this.pool.query("SELECT count(*) FROM outbox WHERE status = 'PENDING'")).rows[0].count);
  }
}
