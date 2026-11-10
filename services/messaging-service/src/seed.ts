import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { derivedId } from './ids';

interface SeedConversation {
  studentUserId: string;
  studentName: string;
  tutorUserId: string;
  tutorName: string;
  messages: Array<{ from: 'STUDENT' | 'TUTOR'; text: string }>;
}

/** Synthetic demo conversation so the inbox is not empty. Repeating the seed never duplicates it. */
export async function seedConversation(mongoUri: string, input: SeedConversation): Promise<{ created: boolean }> {
  const client = await new MongoClient(mongoUri).connect();
  try {
    const db = client.db();
    const conversations = db.collection('conversations');
    const messages = db.collection('messages');
    const conversationId = derivedId(`fixture:conversation:${input.studentUserId}:${input.tutorUserId}`);
    if (await conversations.findOne({ _id: conversationId as never })) return { created: false };
    const base = Date.now() - 2 * 60 * 60 * 1000;
    const docs = input.messages.map((m, index) => ({
      _id: derivedId(`fixture:message:${conversationId}:${index}`),
      conversationId,
      seq: index + 1,
      senderUserId: m.from === 'STUDENT' ? input.studentUserId : input.tutorUserId,
      recipientUserId: m.from === 'STUDENT' ? input.tutorUserId : input.studentUserId,
      content: m.text,
      createdAt: new Date(base + index * 5 * 60 * 1000),
    }));
    const last = docs[docs.length - 1];
    await conversations.insertOne({
      _id: conversationId, pairKey: [input.studentUserId, input.tutorUserId].sort().join(':'), kind: 'STUDENT_TUTOR',
      studentUserId: input.studentUserId, tutorUserId: input.tutorUserId, adminUserId: null,
      userIds: [input.studentUserId, input.tutorUserId],
      names: { [input.studentUserId]: input.studentName, [input.tutorUserId]: input.tutorName },
      lastSeq: docs.length, lastMessage: last, lastMessageAt: last.createdAt,
      // The student has read everything; the tutor has one unread message from the student if the student spoke last.
      readSeq: { [input.studentUserId]: docs.length, [input.tutorUserId]: 0 }, createdAt: new Date(base),
    } as never);
    await messages.insertMany(docs as never);
    return { created: true };
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  const uri = process.env.MONGO_URI;
  const raw = process.env.MESSAGING_SEED;
  if (process.env.DEMO_MODE !== 'true' || !uri || !raw) {
    console.error('[Messaging] seed requires DEMO_MODE=true, MONGO_URI and MESSAGING_SEED');
    process.exitCode = 1;
  } else {
    seedConversation(uri, JSON.parse(raw) as SeedConversation)
      .then((result) => console.log(`[Messaging] demo conversation ${result.created ? 'created' : 'already present'}`))
      .catch((error) => { console.error('[Messaging] seed failed', (error as Error).message); process.exitCode = 1; });
  }
}
