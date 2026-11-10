import { derivedId, newId } from '../ids';
import type { Tx } from '../db';

export type NotificationGroup = 'BOOKING_UPDATES' | 'LESSON_REMINDERS' | 'NEW_MESSAGES' | 'WALLET_PAYMENTS' | 'PRODUCT_NEWS' | 'SYSTEM';

export type Targets = { kind: 'USERS'; userIds: string[] } | { kind: 'ADMINS' };

export interface EventInput {
  type: string;
  aggregate: { type: string; id: string; version: bigint | string };
  targets: Targets;
  group: NotificationGroup;
  data: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  /** Stable key so a repeated decision cannot enqueue a second event. */
  dedupeKey: string;
  now: Date;
}

export interface Envelope {
  eventId: string;
  type: string;
  schemaVersion: 1;
  occurredAt: string;
  producer: 'wallet';
  aggregate: { type: string; id: string; version: string };
  correlationId: string;
  causationId?: string;
  targets: Targets;
  notificationGroup: NotificationGroup;
  data: Record<string, unknown>;
}

export function buildEnvelope(input: EventInput): Envelope {
  const version = String(input.aggregate.version);
  const targets: Targets = input.targets.kind === 'USERS'
    ? { kind: 'USERS', userIds: [...new Set(input.targets.userIds)] }
    : input.targets;
  return {
    eventId: derivedId(`event:${input.type}:${input.dedupeKey}`),
    type: input.type,
    schemaVersion: 1,
    occurredAt: input.now.toISOString(),
    producer: 'wallet',
    aggregate: { type: input.aggregate.type, id: input.aggregate.id, version },
    correlationId: input.correlationId ?? derivedId(`correlation:${input.dedupeKey}`),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    targets,
    notificationGroup: input.group,
    data: input.data,
  };
}

/**
 * Saves the immutable event in the caller's transaction. The business decision and its
 * notification work commit or roll back together; publication happens later, from the worker.
 */
export async function enqueueEvent(tx: Tx, input: EventInput): Promise<Envelope> {
  const envelope = buildEnvelope(input);
  await tx.query(
    `INSERT INTO outbox (event_id, type, envelope, next_attempt_at, created_at)
     VALUES ($1, $2, $3, $4, $4) ON CONFLICT (event_id) DO NOTHING`,
    [envelope.eventId, envelope.type, JSON.stringify(envelope), input.now],
  );
  return envelope;
}

export { newId };
