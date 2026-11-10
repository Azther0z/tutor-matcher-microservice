import type { Collection, Db } from 'mongodb';
import type { ClientSession } from 'mongodb';
import type { Contracts } from './contracts';
import { derivedId } from './ids';
import type { Clock } from './time';

export interface Envelope {
  eventId: string;
  type: string;
  schemaVersion: 1;
  occurredAt: string;
  producer: 'messaging';
  aggregate: { type: string; id: string; version: string };
  correlationId: string;
  targets: { kind: 'USERS'; userIds: string[] };
  notificationGroup: 'NEW_MESSAGES';
  data: Record<string, unknown>;
}

export interface Broker {
  /** Throws unless the broker is reachable. Queue routing is proven by `publish`, not here. */
  verifyTopology(): Promise<void>;
  /** Resolves only after a *routed* publisher confirm. A nack, an unroutable return or a lost channel throws. */
  publish(envelope: Envelope): Promise<void>;
  close(): Promise<void>;
}

interface OutboxDoc {
  _id: string;
  type: string;
  envelope: Envelope;
  status: 'PENDING' | 'PUBLISHED';
  attempts: number;
  needsAttention: boolean;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  fence: number;
  lastError: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export const outboxOf = (db: Db): Collection<OutboxDoc> => db.collection<OutboxDoc>('outbox');

/** Builds the `messaging.message-sent` event. It carries identifiers only: never the message text. */
export function messageSentEnvelope(input: { messageId: string; conversationId: string; senderUserId: string; recipientUserId: string; version: number; now: Date }): Envelope {
  return {
    eventId: derivedId(`event:messaging.message-sent:${input.messageId}`),
    type: 'messaging.message-sent',
    schemaVersion: 1,
    occurredAt: input.now.toISOString(),
    producer: 'messaging',
    aggregate: { type: 'conversation', id: input.conversationId, version: String(input.version) },
    correlationId: derivedId(`correlation:${input.messageId}`),
    targets: { kind: 'USERS', userIds: [input.recipientUserId] },
    notificationGroup: 'NEW_MESSAGES',
    data: { messageId: input.messageId, conversationId: input.conversationId, senderUserId: input.senderUserId },
  };
}

/** Saved in the same transaction as the accepted message; publication happens later, from the worker. */
export async function enqueue(db: Db, session: ClientSession, envelope: Envelope, now: Date): Promise<void> {
  await outboxOf(db).insertOne({
    _id: envelope.eventId, type: envelope.type, envelope, status: 'PENDING', attempts: 0, needsAttention: false,
    nextAttemptAt: now, leaseUntil: null, fence: 0, lastError: null, createdAt: now, publishedAt: null,
  }, { session });
}

const BASE_MS = 1000;
const CAP_MS = 60_000;
export function backoffMs(failures: number, random: () => number = Math.random): number {
  const exp = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(exp * (0.5 + random() * 0.5));
}

/**
 * Publishes accepted messages' events. A broker outage never erases an accepted message: rows stay PENDING with the same
 * event identity and are retried with jittered backoff. A fence stops a stale publisher from marking a newer claim.
 */
export class OutboxPublisher {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly db: Db, private readonly broker: Broker, private readonly clock: Clock, private readonly contracts: Contracts) {}

  async runOnce(batch = 20): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;
    for (let i = 0; i < batch; i += 1) {
      const now = this.clock.now();
      const row = await outboxOf(this.db).findOneAndUpdate(
        { status: 'PENDING', nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
        { $set: { leaseUntil: new Date(now.getTime() + 30_000) }, $inc: { fence: 1 } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );
      if (!row) break;
      try {
        const verdict = this.contracts.validateEvent(row.envelope);
        if (!verdict.ok) throw Object.assign(new Error(`SCHEMA_INVALID ${verdict.errors.join('; ')}`), { permanent: true });
        await this.broker.publish(row.envelope);
        await outboxOf(this.db).updateOne({ _id: row._id, fence: row.fence }, { $set: { status: 'PUBLISHED', publishedAt: this.clock.now(), leaseUntil: null, lastError: null } });
        published += 1;
      } catch (error) {
        failed += 1;
        const attempts = row.attempts + 1;
        const permanent = (error as { permanent?: boolean }).permanent === true;
        await outboxOf(this.db).updateOne(
          { _id: row._id, fence: row.fence, status: 'PENDING' },
          { $set: { attempts, leaseUntil: null, nextAttemptAt: new Date(this.clock.now().getTime() + backoffMs(attempts)), lastError: String((error as Error).message).slice(0, 500), needsAttention: permanent || attempts >= 10 } },
        );
      }
    }
    return { published, failed };
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce().catch((error) => console.error('[Messaging] outbox sweep failed', (error as Error).message)).finally(() => { this.running = false; });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
