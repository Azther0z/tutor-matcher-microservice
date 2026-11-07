import { createHash } from 'node:crypto';
import type { Contracts } from '../contracts';
import { derivedId, newId } from '../ids';
import type { Clock } from '../time';
import { inTransaction, type Channel, type DeliveryDoc, type EventDoc, type Group, type QuarantineDoc, type Store } from '../store';
import { summarize } from './templates';

export interface Inbound {
  body: Buffer;
  routingKey: string;
  /** AMQP user_id, verified by the broker against the connected user. */
  userId: string | undefined;
  messageId: string | undefined;
  type: string | undefined;
}

export type Outcome =
  | { kind: 'ACCEPTED'; eventId: string }
  | { kind: 'DUPLICATE'; eventId: string }
  | { kind: 'QUARANTINED'; quarantine: QuarantineDoc['kind']; deadLetter: boolean; reason: string };

/** Hash of the canonical payload. Same event ID + same hash is a repeat; same ID + different hash is a conflict. */
export function canonicalHash(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

export const channelsFor = (group: Group): Channel[] => (group === 'SYSTEM' ? ['EMAIL'] : ['EMAIL', 'PUSH']);

export function deliveryFor(event: Pick<EventDoc, '_id' | 'type' | 'group' | 'envelope'>, recipientUserId: string, channel: Channel, now: Date): DeliveryDoc {
  return {
    _id: derivedId(`delivery:${event._id}:${recipientUserId}:${channel}`),
    eventId: event._id, eventType: event.type, recipientUserId, channel, category: event.group,
    status: 'PENDING', reason: null, preferencesRevision: null, attempts: 0, needsAttention: false,
    nextAttemptAt: now, leaseUntil: null, fence: 0, lastError: null,
    summary: summarize(event.type, (event.envelope.data ?? {}) as Record<string, unknown>), createdAt: now, deliveredAt: null,
  };
}

/**
 * Validates and durably accepts a RabbitMQ message. The event, its audience work and every delivery job are
 * written in ONE transaction; the caller acknowledges the broker message only after this resolves.
 */
export class EventAcceptor {
  constructor(
    private readonly store: Store, private readonly contracts: Contracts, private readonly clock: Clock,
    private readonly publisherIdentities: Record<string, string>,
  ) {}

  private async quarantine(kind: QuarantineDoc['kind'], reason: string, inbound: Inbound, eventId: string | null, deadLetter: boolean): Promise<Outcome> {
    await this.store.quarantine.insertOne({
      _id: newId(), kind, eventId, reason: reason.slice(0, 500), publisher: inbound.userId ?? null, routingKey: inbound.routingKey,
      bodyBytes: inbound.body.length, bodySha256: createHash('sha256').update(inbound.body).digest('hex'), // never the body itself
      receivedAt: this.clock.now(), status: 'OPEN',
    });
    console.warn(`[Notification] QUARANTINED ${kind}: ${reason} (event ${eventId ?? 'unknown'}, publisher ${inbound.userId ?? 'none'})`);
    return { kind: 'QUARANTINED', quarantine: kind, deadLetter, reason };
  }

  async accept(inbound: Inbound): Promise<Outcome> {
    let envelope: any;
    try {
      envelope = JSON.parse(inbound.body.toString('utf8'));
    } catch {
      return this.quarantine('INVALID', 'Body is not valid JSON', inbound, null, true);
    }
    const eventId: string | null = typeof envelope?.eventId === 'string' ? envelope.eventId : null;

    const verdict = this.contracts.validateEvent(envelope);
    if (!verdict.ok) return this.quarantine('INVALID', `Schema validation failed: ${verdict.errors.slice(0, 3).join('; ')}`, inbound, eventId, true);

    // Authenticated publisher identity must match the envelope producer and its own event prefix.
    const allowedProducer = inbound.userId ? this.publisherIdentities[inbound.userId] : undefined;
    if (!allowedProducer || allowedProducer !== envelope.producer || !String(envelope.type).startsWith(`${envelope.producer}.`)) {
      return this.quarantine('IDENTITY', `Publisher ${inbound.userId ?? '(none)'} may not publish ${envelope.type} as ${envelope.producer}`, inbound, eventId, true);
    }
    if (inbound.routingKey !== `v1.${envelope.type}`) {
      return this.quarantine('ROUTING', `Routing key ${inbound.routingKey} does not match type ${envelope.type}`, inbound, eventId, true);
    }
    if (inbound.messageId !== undefined && inbound.messageId !== envelope.eventId) {
      return this.quarantine('ROUTING', 'AMQP message_id differs from eventId', inbound, eventId, true);
    }

    const hash = canonicalHash(envelope);
    const now = this.clock.now();
    const group = envelope.notificationGroup as Group;
    const doc: EventDoc = {
      _id: envelope.eventId, type: envelope.type, producer: envelope.producer, group, targets: envelope.targets, hash, envelope,
      publisher: inbound.userId!, acceptedAt: now,
      audienceStatus: envelope.targets.kind === 'ADMINS' ? 'PENDING' : 'NOT_NEEDED',
      recipients: envelope.targets.kind === 'USERS' ? envelope.targets.userIds : null,
      audienceAttempts: 0, audienceNextAttemptAt: now, audienceLeaseUntil: null, audienceFence: 0, audienceError: null,
    };

    const outcome = await inTransaction(this.store, async (session) => {
      const existing = await this.store.events.findOne({ _id: doc._id }, { session });
      if (existing) return existing.hash === hash ? 'DUPLICATE' as const : 'CONFLICT' as const;
      await this.store.events.insertOne(doc, { session });
      if (doc.recipients) {
        const jobs = doc.recipients.flatMap((userId) => channelsFor(group).map((channel) => deliveryFor(doc, userId, channel, now)));
        if (jobs.length) await this.store.deliveries.insertMany(jobs, { session });
      }
      return 'ACCEPTED' as const;
    });

    if (outcome === 'CONFLICT') {
      return this.quarantine('CONFLICT', 'A different payload already exists for this event ID', inbound, doc._id, false);
    }
    return { kind: outcome === 'ACCEPTED' ? 'ACCEPTED' : 'DUPLICATE', eventId: doc._id };
  }

  /** Records a message that exhausted its bounded retries so it stays inspectable and manually retryable. */
  async exhausted(inbound: Inbound, reason: string): Promise<void> {
    await this.quarantine('EXHAUSTED', reason, inbound, null, true);
  }
}
