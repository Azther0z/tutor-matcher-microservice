import { MongoClient, type Collection, type Db } from 'mongodb';

export type Channel = 'EMAIL' | 'PUSH';
export type Group = 'BOOKING_UPDATES' | 'LESSON_REMINDERS' | 'NEW_MESSAGES' | 'WALLET_PAYMENTS' | 'PRODUCT_NEWS' | 'SYSTEM';

export interface EventDoc {
  _id: string;
  type: string;
  producer: string;
  group: Group;
  targets: { kind: 'USERS'; userIds: string[] } | { kind: 'ADMINS' };
  hash: string;
  envelope: Record<string, unknown>;
  publisher: string;
  acceptedAt: Date;
  /** ADMINS audiences are resolved once, then the snapshot is saved so every retry uses the same recipients. */
  audienceStatus: 'NOT_NEEDED' | 'PENDING' | 'RESOLVED';
  recipients: string[] | null;
  audienceAttempts: number;
  audienceNextAttemptAt: Date;
  audienceLeaseUntil: Date | null;
  audienceFence: number;
  audienceError: string | null;
}

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'SKIPPED' | 'FAILED';

/** One document per (event, recipient, channel): it is both the durable job and the simulated receipt. */
export interface DeliveryDoc {
  _id: string;
  eventId: string;
  eventType: string;
  recipientUserId: string;
  channel: Channel;
  category: Group;
  status: DeliveryStatus;
  reason: string | null;
  preferencesRevision: string | null;
  attempts: number;
  needsAttention: boolean;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  fence: number;
  lastError: string | null;
  summary: string;
  createdAt: Date;
  deliveredAt: Date | null;
}

export interface QuarantineDoc {
  _id: string;
  kind: 'INVALID' | 'CONFLICT' | 'IDENTITY' | 'ROUTING' | 'EXHAUSTED';
  eventId: string | null;
  reason: string;
  publisher: string | null;
  routingKey: string;
  bodyBytes: number;
  bodySha256: string;
  receivedAt: Date;
  status: 'OPEN' | 'RELEASED';
}

export interface PreferenceDoc {
  _id: string;
  bookingUpdates: ChannelPrefs; lessonReminders: ChannelPrefs; newMessages: ChannelPrefs; walletPayments: ChannelPrefs; productNews: ChannelPrefs;
  revision: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface ChannelPrefs { email: boolean; push: boolean }

export interface IdempotencyDoc { _id: string; hash: string; status: number; body: unknown; headers: Record<string, string>; createdAt: Date }

export interface OperationDoc {
  _id: string; kind: string; initiatorUserId: string; status: 'PENDING' | 'SUCCEEDED' | 'REJECTED';
  resource: { type: string; id: string; url: string } | null; error: unknown; createdAt: Date; updatedAt: Date;
}

export interface Store {
  client: MongoClient;
  db: Db;
  events: Collection<EventDoc>;
  deliveries: Collection<DeliveryDoc>;
  quarantine: Collection<QuarantineDoc>;
  preferences: Collection<PreferenceDoc>;
  idempotency: Collection<IdempotencyDoc>;
  operations: Collection<OperationDoc>;
}

export async function openStore(uri: string, dbName: string): Promise<Store> {
  const client = new MongoClient(uri, { retryWrites: true, serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(dbName);
  const store: Store = {
    client, db,
    events: db.collection<EventDoc>('events'),
    deliveries: db.collection<DeliveryDoc>('deliveries'),
    quarantine: db.collection<QuarantineDoc>('quarantine'),
    preferences: db.collection<PreferenceDoc>('preferences'),
    idempotency: db.collection<IdempotencyDoc>('idempotency'),
    operations: db.collection<OperationDoc>('operations'),
  };
  await ensureIndexes(store);
  return store;
}

export async function ensureIndexes(store: Store): Promise<void> {
  // Collections are created up front: a multi-document transaction cannot implicitly create one on older servers.
  const existing = new Set((await store.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of ['events', 'deliveries', 'quarantine', 'preferences', 'idempotency', 'operations']) {
    if (!existing.has(name)) await store.db.createCollection(name).catch(() => undefined);
  }
  // The simulated provider effect is unique per event, recipient and channel.
  await store.deliveries.createIndex({ eventId: 1, recipientUserId: 1, channel: 1 }, { unique: true, name: 'effect_per_event_recipient_channel' });
  await store.deliveries.createIndex({ status: 1, nextAttemptAt: 1 }, { name: 'claim_ready' });
  await store.deliveries.createIndex({ recipientUserId: 1, createdAt: -1, _id: -1 }, { name: 'receipts_by_recipient' });
  await store.events.createIndex({ audienceStatus: 1, audienceNextAttemptAt: 1 }, { name: 'audience_ready' });
  await store.quarantine.createIndex({ status: 1, receivedAt: -1 }, { name: 'open_quarantine' });
}

/** Runs `work` in a multi-document transaction (needs a replica set, see the system design). */
export async function inTransaction<T>(store: Store, work: (session: import('mongodb').ClientSession) => Promise<T>): Promise<T> {
  const session = store.client.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => { result = await work(session); }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return result;
  } finally {
    await session.endSession();
  }
}
