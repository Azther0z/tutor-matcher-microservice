import { createHash } from 'node:crypto';
import type { Db, MongoClient } from 'mongodb';
import type { Actor } from './auth';
import type { CallContext, Peers } from './clients';
import type { Contracts } from './contracts';
import { conflict, forbidden, malformed, notFound, unprocessable, validation } from './errors';
import { newId } from './ids';
import { enqueue, messageSentEnvelope } from './outbox';
import type { Clock } from './time';

export type View = 'STUDENT' | 'TUTOR' | 'ADMIN';
type Kind = 'STUDENT_TUTOR' | 'ADMIN_SUPPORT';

interface MessageDoc {
  _id: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  recipientUserId: string;
  content: string;
  createdAt: Date;
}

interface ConversationDoc {
  _id: string;
  /** Sorted pair of user ids: one conversation per unordered pair, whatever view either side uses. */
  pairKey: string;
  kind: Kind;
  studentUserId: string | null;
  tutorUserId: string | null;
  adminUserId: string | null;
  userIds: string[];
  names: Record<string, string>;
  lastSeq: number;
  lastMessage: MessageDoc | null;
  lastMessageAt: Date;
  /** Highest message sequence each participant has read. Only ever moves forward. */
  readSeq: Record<string, number>;
  createdAt: Date;
}

interface IdempotencyDoc {
  _id: string;
  inputHash: string;
  status: number;
  response: unknown;
  createdAt: Date;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Page {
  page: number;
  pageSize: number;
  offset: number;
}

export interface MessagingDeps {
  client: MongoClient;
  db: Db;
  clock: Clock;
  peers: Peers;
  contracts: Contracts;
}

const pairKeyOf = (a: string, b: string) => [a, b].sort().join(':');

function hashOf(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

const messageView = (m: MessageDoc) => ({
  id: m._id, conversationId: m.conversationId, senderUserId: m.senderUserId, recipientUserId: m.recipientUserId, content: m.content, createdAt: m.createdAt.toISOString(),
});

/** May this caller read and write this conversation in this view? Participant-only, and a view never widens access. */
export function roleAllows(conversation: ConversationDoc, userId: string, view: View, actor: Actor): boolean {
  if (!conversation.userIds.includes(userId)) return false;
  if (view === 'STUDENT') {
    return conversation.kind === 'STUDENT_TUTOR' ? conversation.studentUserId === userId : conversation.adminUserId !== userId;
  }
  if (view === 'TUTOR') return conversation.kind === 'STUDENT_TUTOR' && conversation.tutorUserId === userId && actor.capabilities.includes('TUTOR');
  return conversation.kind === 'ADMIN_SUPPORT' && conversation.adminUserId === userId && actor.capabilities.includes('ADMIN');
}

function inboxFilter(userId: string, view: View) {
  if (view === 'STUDENT') {
    return { $or: [{ kind: 'STUDENT_TUTOR', studentUserId: userId }, { kind: 'ADMIN_SUPPORT', userIds: userId, adminUserId: { $ne: userId } }] };
  }
  if (view === 'TUTOR') return { kind: 'STUDENT_TUTOR', tutorUserId: userId };
  return { kind: 'ADMIN_SUPPORT', adminUserId: userId };
}

function requireView(actor: Actor, view: View): void {
  if (view === 'TUTOR' && !actor.capabilities.includes('TUTOR')) throw forbidden('FORBIDDEN', 'The TUTOR capability is required');
  if (view === 'ADMIN' && !actor.capabilities.includes('ADMIN')) throw forbidden('FORBIDDEN', 'The ADMIN capability is required');
}

export class MessagingService {
  constructor(private readonly deps: MessagingDeps) {}

  private get conversations() { return this.deps.db.collection<ConversationDoc>('conversations'); }
  private get messages() { return this.deps.db.collection<MessageDoc>('messages'); }
  private get idempotency() { return this.deps.db.collection<IdempotencyDoc>('idempotency'); }

  /** Idempotent: the same call repeated is a no-op. Safe to run on every start. */
  async migrate(): Promise<void> {
    await this.conversations.createIndex({ pairKey: 1 }, { unique: true });
    await this.conversations.createIndex({ studentUserId: 1, lastMessageAt: -1, _id: -1 });
    await this.conversations.createIndex({ tutorUserId: 1, lastMessageAt: -1, _id: -1 });
    await this.conversations.createIndex({ userIds: 1, lastMessageAt: -1, _id: -1 });
    await this.messages.createIndex({ conversationId: 1, createdAt: -1, _id: -1 });
    await this.messages.createIndex({ conversationId: 1, seq: 1 }, { unique: true });
    await this.deps.db.collection('outbox').createIndex({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
  }

  /**
   * Sends one message. Rejects self-message, blank or over-long content and any pairing the caller's view does not allow.
   * The message, the conversation counters and the notification event commit in one transaction.
   */
  async send(actor: Actor, input: { body: unknown; key: string; context: CallContext }): Promise<Reply> {
    const body = this.deps.contracts.assertDef<{ recipientId: string; view: View; content: string }>('MessageWrite', input.body, '/body');
    if (!body.content.trim()) throw validation([{ path: '/body/content', code: 'INVALID', message: 'A message cannot be blank' }]);
    if (body.recipientId === actor.userId) throw unprocessable('SELF_MESSAGE', 'You cannot message yourself');
    requireView(actor, body.view);

    const scopeId = `${actor.userId}|POST|/api/messages|${input.key}`;
    const hash = hashOf(body);
    const replay = await this.idempotency.findOne({ _id: scopeId });
    if (replay) return this.replay(replay, hash);

    const accounts = await this.deps.peers.auth.lookupAccounts([actor.userId, body.recipientId], input.context);
    const sender = accounts.find((a) => a.id === actor.userId);
    const recipient = accounts.find((a) => a.id === body.recipientId);
    if (!sender || sender.status !== 'ACTIVE' || !recipient || recipient.status !== 'ACTIVE') {
      throw forbidden('PARTICIPANT_NOT_ALLOWED', 'This conversation is not available');
    }
    const key = pairKeyOf(actor.userId, body.recipientId);
    let existing = await this.conversations.findOne({ pairKey: key });
    let creation: Pick<ConversationDoc, 'kind' | 'studentUserId' | 'tutorUserId' | 'adminUserId'> | null = null;

    if (existing) {
      if (!roleAllows(existing, actor.userId, body.view, actor)) throw forbidden('PARTICIPANT_NOT_ALLOWED', 'You cannot message this person in this view');
    } else if (body.view === 'STUDENT') {
      if (recipient.capabilities.includes('ADMIN')) {
        creation = { kind: 'ADMIN_SUPPORT', studentUserId: null, tutorUserId: null, adminUserId: recipient.id };
      } else {
        const eligibility = await this.deps.peers.tutor.getTutorEligibility(recipient.id, input.context);
        if (!eligibility.tutorId || !eligibility.approved || !eligibility.activated) throw forbidden('PARTICIPANT_NOT_ALLOWED', 'You can only start a conversation with an approved tutor');
        creation = { kind: 'STUDENT_TUTOR', studentUserId: actor.userId, tutorUserId: recipient.id, adminUserId: null };
      }
    } else if (body.view === 'ADMIN') {
      creation = { kind: 'ADMIN_SUPPORT', studentUserId: null, tutorUserId: null, adminUserId: actor.userId };
    } else {
      throw forbidden('PARTICIPANT_NOT_ALLOWED', 'A tutor can only reply to an existing student conversation');
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.commit(actor, body, scopeId, hash, key, existing, creation, { sender: sender.displayName, recipient: recipient.displayName });
      } catch (error) {
        // A concurrent first message between the same pair created the conversation first: use it.
        if ((error as { code?: number }).code === 11000 && attempt === 0) {
          existing = await this.conversations.findOne({ pairKey: key });
          if (existing && !roleAllows(existing, actor.userId, body.view, actor)) throw forbidden('PARTICIPANT_NOT_ALLOWED', 'You cannot message this person in this view');
          const stored = await this.idempotency.findOne({ _id: scopeId });
          if (stored) return this.replay(stored, hash);
          continue;
        }
        throw error;
      }
    }
    throw conflict('CONTENTION', 'Try the same request again');
  }

  private replay(doc: IdempotencyDoc, hash: string): Reply {
    if (doc.inputHash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with different input');
    return { status: doc.status, body: doc.response, headers: { 'Idempotent-Replay': 'true' } };
  }

  private async commit(
    actor: Actor, body: { recipientId: string; view: View; content: string }, scopeId: string, hash: string, pairKey: string,
    existing: ConversationDoc | null, creation: Pick<ConversationDoc, 'kind' | 'studentUserId' | 'tutorUserId' | 'adminUserId'> | null,
    names: { sender: string; recipient: string },
  ): Promise<Reply> {
    const session = this.deps.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const now = this.deps.clock.now();
        const stored = await this.idempotency.findOne({ _id: scopeId }, { session });
        if (stored) return this.replay(stored, hash);

        let conversationId = existing?._id;
        if (!conversationId) {
          conversationId = newId();
          const doc: ConversationDoc = {
            _id: conversationId, pairKey, ...(creation as NonNullable<typeof creation>),
            userIds: [actor.userId, body.recipientId], names: {}, lastSeq: 0, lastMessage: null, lastMessageAt: now, readSeq: {}, createdAt: now,
          };
          await this.conversations.insertOne(doc, { session });
        }
        const counted = await this.conversations.findOneAndUpdate({ _id: conversationId }, { $inc: { lastSeq: 1 } }, { returnDocument: 'after', session });
        const seq = (counted as ConversationDoc).lastSeq;
        const message: MessageDoc = {
          _id: newId(), conversationId, seq, senderUserId: actor.userId, recipientUserId: body.recipientId, content: body.content, createdAt: now,
        };
        await this.messages.insertOne(message, { session });
        await this.conversations.updateOne(
          { _id: conversationId },
          // The sender has, by definition, read everything up to their own message.
          { $set: { lastMessage: message, lastMessageAt: now, [`names.${actor.userId}`]: names.sender, [`names.${body.recipientId}`]: names.recipient }, $max: { [`readSeq.${actor.userId}`]: seq } } as any,
          { session },
        );
        await enqueue(this.deps.db, session, messageSentEnvelope({ messageId: message._id, conversationId, senderUserId: actor.userId, recipientUserId: body.recipientId, version: seq, now }), now);
        const view = messageView(message);
        await this.idempotency.insertOne({ _id: scopeId, inputHash: hash, status: 201, response: view, createdAt: now }, { session });
        return { status: 201, body: view, headers: { Location: `/api/messages/thread/${body.recipientId}` } } as Reply;
      }, { writeConcern: { w: 'majority' } }) as Reply;
    } finally {
      await session.endSession();
    }
  }

  private async unread(conversation: ConversationDoc, userId: string): Promise<number> {
    return this.messages.countDocuments({ conversationId: conversation._id, seq: { $gt: conversation.readSeq[userId] ?? 0 }, senderUserId: { $ne: userId } });
  }

  private async conversationView(conversation: ConversationDoc, userId: string) {
    const name = (id: string) => (conversation.names[id] ?? 'Unavailable account').slice(0, 201);
    return {
      id: conversation._id,
      kind: conversation.kind,
      lastMessage: conversation.lastMessage ? messageView(conversation.lastMessage) : null,
      unreadCount: await this.unread(conversation, userId),
      participants: conversation.userIds.map((id) => ({ userId: id, displayName: name(id) })),
    };
  }

  async inbox(actor: Actor, view: View, page: Page) {
    requireView(actor, view);
    const filter = inboxFilter(actor.userId, view);
    const total = await this.conversations.countDocuments(filter);
    const rows = await this.conversations.find(filter).sort({ lastMessageAt: -1, _id: -1 }).skip(page.offset).limit(page.pageSize).toArray();
    return {
      items: await Promise.all(rows.map((row) => this.conversationView(row, actor.userId))),
      pagination: { page: page.page, pageSize: page.pageSize, totalItems: total, totalPages: total === 0 ? 0 : Math.ceil(total / page.pageSize) },
    };
  }

  private encodeCursor(message: MessageDoc, actor: Actor, view: View): string {
    return Buffer.from(JSON.stringify({ c: message.createdAt.toISOString(), i: message._id, u: actor.userId, v: view, t: message.conversationId })).toString('base64url');
  }

  private decodeCursor(cursor: string, actor: Actor, view: View, conversationId: string): { createdAt: Date; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c: string; i: string; u: string; v: string; t: string };
      // A cursor is bound to caller, view and thread; it is a position, never authorization.
      if (parsed.u !== actor.userId || parsed.v !== view || parsed.t !== conversationId) throw new Error('bound elsewhere');
      const createdAt = new Date(parsed.c);
      if (Number.isNaN(createdAt.getTime()) || typeof parsed.i !== 'string') throw new Error('malformed');
      return { createdAt, id: parsed.i };
    } catch {
      throw malformed('INVALID_CURSOR', 'The cursor is not valid for this thread');
    }
  }

  /** Newest page first selected, returned oldest-to-newest. `nextCursor` points at older messages. */
  async thread(actor: Actor, otherUserId: string, view: View, options: { cursor?: string; limit: number }) {
    requireView(actor, view);
    const conversation = await this.conversations.findOne({ pairKey: pairKeyOf(actor.userId, otherUserId) });
    if (!conversation) return { conversation: null, items: [], nextCursor: null };
    if (!roleAllows(conversation, actor.userId, view, actor)) throw notFound('NOT_FOUND', 'Conversation not found');

    const filter: Record<string, unknown> = { conversationId: conversation._id };
    if (options.cursor) {
      const at = this.decodeCursor(options.cursor, actor, view, conversation._id);
      filter.$or = [{ createdAt: { $lt: at.createdAt } }, { createdAt: at.createdAt, _id: { $lt: at.id } }];
    }
    const rows = await this.messages.find(filter).sort({ createdAt: -1, _id: -1 }).limit(options.limit + 1).toArray();
    const more = rows.length > options.limit;
    const pageRows = rows.slice(0, options.limit);
    return {
      conversation: await this.conversationView(conversation, actor.userId),
      items: pageRows.reverse().map(messageView),
      nextCursor: more ? this.encodeCursor(pageRows[0], actor, view) : null,
    };
  }

  /** Advances the caller's read cursor to a message they received in this thread. Never moves backward. */
  async markRead(actor: Actor, otherUserId: string, view: View, body: unknown): Promise<void> {
    requireView(actor, view);
    const input = this.deps.contracts.assertDef<{ lastReadMessageId: string }>('ReadCursorWrite', body, '/body');
    const conversation = await this.conversations.findOne({ pairKey: pairKeyOf(actor.userId, otherUserId) });
    if (!conversation || !roleAllows(conversation, actor.userId, view, actor)) throw notFound('NOT_FOUND', 'Conversation not found');
    const message = await this.messages.findOne({ _id: input.lastReadMessageId, conversationId: conversation._id, recipientUserId: actor.userId });
    if (!message) throw notFound('NOT_FOUND', 'No received message with that id in this thread');
    await this.conversations.updateOne({ _id: conversation._id }, { $max: { [`readSeq.${actor.userId}`]: message.seq } } as any);
  }
}

