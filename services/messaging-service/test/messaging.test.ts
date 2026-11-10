import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import type { Actor } from '../src/auth';
import type { CallContext, Peers } from '../src/clients';
import { Contracts } from '../src/contracts';
import { MessagingService } from '../src/domain';
import { AppError } from '../src/errors';
import type { Clock } from '../src/time';

const mongoUri = process.env.TEST_MONGO_URI;
function isLoopbackMongoUri(uri: string): boolean {
  const authority = /^mongodb:\/\/([^/?#]+)/.exec(uri)?.[1];
  if (!authority) return false;
  const endpoints = authority.slice(authority.lastIndexOf('@') + 1).split(',');
  return endpoints.length > 0 && endpoints.every((endpoint) => {
    const host = endpoint.startsWith('[') ? endpoint.slice(1, endpoint.indexOf(']')) : endpoint.split(':')[0];
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  });
}
if (mongoUri && !isLoopbackMongoUri(mongoUri)) {
  throw new Error('TEST_MONGO_URI must use a loopback MongoDB host because the suite drops its dedicated test database');
}
const describeMongo = mongoUri ? describe : describe.skip;

const ids = {
  student: '11111111-1111-4111-8111-111111111111',
  tutor: '22222222-2222-4222-8222-222222222222',
  outsider: '33333333-3333-4333-8333-333333333333',
};

function actor(userId: string, capabilities: Actor['capabilities']): Actor {
  return {
    userId,
    sessionId: randomUUID(),
    admissionId: randomUUID(),
    admittedAt: new Date('2026-01-01T00:00:00.000Z'),
    requestId: randomUUID(),
    publicOperation: 'sendMessage',
    capabilities,
    accountRevision: '1',
  };
}

const student = actor(ids.student, ['STUDENT']);
const tutor = actor(ids.tutor, ['STUDENT', 'TUTOR']);
const outsider = actor(ids.outsider, ['STUDENT']);
const context: CallContext = { requestId: randomUUID() };
const clock: Clock = { now: () => new Date('2026-06-01T12:00:00.000Z') };

const peers: Peers = {
  auth: {
    async lookupAccounts(userIds) {
      return userIds.map((id) => ({
        id,
        displayName: id === ids.student ? 'Student' : id === ids.tutor ? 'Tutor' : 'Outsider',
        status: 'ACTIVE' as const,
        capabilities: id === ids.tutor ? ['STUDENT', 'TUTOR'] as const : ['STUDENT'] as const,
      }));
    },
  },
  tutor: {
    async getTutorEligibility(userId) {
      return { userId, tutorId: 'tutor-record-1', approved: true, activated: true, published: true };
    },
  },
};

describeMongo('MessagingService Mongo integration', () => {
  let client: MongoClient | undefined;
  let db: Db | undefined;
  let service: MessagingService | undefined;
  let connected = false;

  beforeAll(async () => {
    client = new MongoClient(mongoUri!);
    try {
      await client.connect();
      connected = true;
      db = client.db(`messaging_test_${randomUUID().replaceAll('-', '')}`);
      service = new MessagingService({ client, db, clock, peers, contracts: new Contracts(path.resolve(__dirname, '../../../contracts')) });
      await service.migrate();
    } catch (error) {
      try {
        if (connected && db) await db.dropDatabase();
      } finally {
        await client.close();
        connected = false;
      }
      throw error;
    }
  });

  beforeEach(async () => {
    await db!.dropDatabase();
    await service!.migrate();
  });

  afterAll(async () => {
    if (!client) return;
    try {
      if (connected && db) await db.dropDatabase();
    } finally {
      await client.close();
      connected = false;
    }
  });

  it('persists one message and notification event, replays idempotently, and enforces membership/read cursors', async () => {
    const activeDb = db!;
    const activeService = service!;
    const key = randomUUID();
    const firstBody = { recipientId: ids.tutor, view: 'STUDENT', content: 'Could we discuss algebra?' };
    const first = await activeService.send(student, { body: firstBody, key, context });
    assert.equal(first.status, 201);
    const message = first.body as { id: string; conversationId: string; content: string };
    assert.equal(message.content, firstBody.content);

    const replay = await activeService.send(student, { body: firstBody, key, context });
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, first.body);
    assert.equal(replay.headers?.['Idempotent-Replay'], 'true');
    assert.equal(await activeDb.collection('messages').countDocuments({}), 1);
    assert.equal(await activeDb.collection('conversations').countDocuments({}), 1);

    const event = await activeDb.collection('outbox').findOne({});
    assert.equal(await activeDb.collection('outbox').countDocuments({}), 1);
    assert.equal(event?.status, 'PENDING');
    assert.equal(event?.envelope.type, 'messaging.message-sent');
    assert.deepEqual(event?.envelope.targets.userIds, [ids.tutor]);
    assert.equal(JSON.stringify(event?.envelope).includes(firstBody.content), false);

    await assert.rejects(
      activeService.send(student, { body: { ...firstBody, content: 'Different input' }, key, context }),
      (error: unknown) => error instanceof AppError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(await activeDb.collection('messages').countDocuments({}), 1);

    let tutorInbox = await activeService.inbox(tutor, 'TUTOR', { page: 1, pageSize: 20, offset: 0 });
    assert.equal(tutorInbox.items[0]?.unreadCount, 1);
    const thread = await activeService.thread(tutor, ids.student, 'TUTOR', { limit: 20 });
    assert.equal(thread.items.length, 1);
    await activeService.markRead(tutor, ids.student, 'TUTOR', { lastReadMessageId: message.id });
    tutorInbox = await activeService.inbox(tutor, 'TUTOR', { page: 1, pageSize: 20, offset: 0 });
    assert.equal(tutorInbox.items[0]?.unreadCount, 0);

    await activeService.send(student, { body: { ...firstBody, content: 'One more detail.' }, key: randomUUID(), context });
    tutorInbox = await activeService.inbox(tutor, 'TUTOR', { page: 1, pageSize: 20, offset: 0 });
    assert.equal(tutorInbox.items[0]?.unreadCount, 1);

    await assert.rejects(
      activeService.send(tutor, {
        body: { recipientId: ids.student, view: 'STUDENT', content: 'The tutor cannot use the student view.' },
        key: randomUUID(),
        context,
      }),
      (error: unknown) => error instanceof AppError && error.code === 'PARTICIPANT_NOT_ALLOWED',
    );

    const outsiderThread = await activeService.thread(outsider, ids.student, 'STUDENT', { limit: 20 });
    assert.deepEqual(outsiderThread, { conversation: null, items: [], nextCursor: null });
  });
});
