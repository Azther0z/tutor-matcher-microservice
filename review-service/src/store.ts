import {
  MongoClient,
  type ClientSession,
  type Collection,
  type Document,
} from "mongodb";
import { AppError } from "@tutor-matcher/shared";
import type {
  ReviewStore,
  Review,
  Flag,
  SavedOperation,
  Audit,
  OutboxRow,
} from "./types";

export class MongoReviewStore implements ReviewStore {
  constructor(
    readonly client: MongoClient,
    readonly database = "review_db",
    private readonly session?: ClientSession,
  ) {}
  private collection<T extends Document>(name: string): Collection<T> {
    return this.client.db(this.database).collection<T>(name);
  }
  private get options() {
    return this.session ? { session: this.session } : {};
  }
  async migrate(): Promise<void> {
    const db = this.client.db(this.database);
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid")
      throw new Error(
        "Review requires a MongoDB replica set for transactions.",
      );
    await Promise.all([
      db.collection("reviews").createIndex({ id: 1 }, { unique: true }),
      db.collection("reviews").createIndex({ bookingId: 1 }, { unique: true }),
      db.collection("reviews").createIndex({ subjectId: 1, visibility: 1 }),
      db
        .collection("reviews")
        .createIndex({ tutorId: 1, visibility: 1, createdAt: -1, id: -1 }),
      db.collection("flags").createIndex({ id: 1 }, { unique: true }),
      db
        .collection("flags")
        .createIndex({ reviewId: 1, reporterUserId: 1 }, { unique: true }),
      db.collection("operations").createIndex({ id: 1 }, { unique: true }),
      db.collection("outbox").createIndex({ id: 1 }, { unique: true }),
      db
        .collection("outbox")
        .createIndex({ sentAt: 1, nextAttemptAt: 1, leaseUntil: 1 }),
    ]);
  }
  async transaction<T>(work: (store: ReviewStore) => Promise<T>): Promise<T> {
    if (this.session) return work(this);
    const session = this.client.startSession();
    try {
      return await session.withTransaction(
        () => work(new MongoReviewStore(this.client, this.database, session)),
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          maxCommitTimeMS: 5000,
        },
      );
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw new AppError(
          409,
          "DUPLICATE_RESOURCE",
          "This review, flag or operation already exists.",
        );
      throw error;
    } finally {
      await session.endSession();
    }
  }
  async getReview(id: string) {
    return (await this.collection<Review>("reviews").findOne(
      { id },
      this.options,
    )) as Review | null;
  }
  async getReviewByBooking(bookingId: string) {
    return (await this.collection<Review>("reviews").findOne(
      { bookingId },
      this.options,
    )) as Review | null;
  }
  async insertReview(review: Review) {
    await this.collection<Review>("reviews").insertOne(
      { ...review },
      this.options,
    );
  }
  async replaceReview(review: Review, previousRevision: string) {
    const result = await this.collection<Review>("reviews").replaceOne(
      { id: review.id, revision: previousRevision },
      { ...review },
      this.options,
    );
    if (result.matchedCount !== 1)
      throw new AppError(
        412,
        "REVISION_MISMATCH",
        "Review changed. Refresh before trying again.",
      );
  }
  async reviews(filter: {
    tutorId?: string;
    subjectId?: string;
    subjectIds?: string[];
    visibility?: Review["visibility"];
  }) {
    const { subjectIds, ...query } = filter;
    return (await this.collection<Review>("reviews")
      .find(
        { ...query, ...(subjectIds ? { subjectId: { $in: subjectIds } } : {}) },
        this.options,
      )
      .toArray()) as Review[];
  }
  async getOperation(actorUserId: string, id: string) {
    return (await this.collection<SavedOperation>("operations").findOne(
      { id, actorUserId },
      this.options,
    )) as SavedOperation | null;
  }
  async operation(id: string) {
    return (await this.collection<SavedOperation>("operations").findOne(
      { id },
      this.options,
    )) as SavedOperation | null;
  }
  async saveOperation(operation: SavedOperation) {
    await this.collection<SavedOperation>("operations").insertOne(
      { ...operation },
      this.options,
    );
  }
  async flags(reviewId?: string) {
    return (await this.collection<Flag>("flags")
      .find(reviewId ? { reviewId } : {}, this.options)
      .toArray()) as Flag[];
  }
  async insertFlag(flag: Flag) {
    await this.collection<Flag>("flags").insertOne({ ...flag }, this.options);
  }
  async resolveFlags(reviewId: string) {
    for (const flag of await this.flags(reviewId))
      if (flag.state === "OPEN") {
        await this.collection<Flag>("flags").updateOne(
          { id: flag.id, revision: flag.revision },
          {
            $set: {
              state: "RESOLVED",
              revision: (BigInt(flag.revision) + 1n).toString(),
            },
          },
          this.options,
        );
      }
  }
  async saveAudit(audit: Audit) {
    await this.collection<Audit>("audit").insertOne({ ...audit }, this.options);
  }
  async addOutbox(row: OutboxRow) {
    await this.collection<OutboxRow>("outbox").insertOne(
      { ...row },
      this.options,
    );
  }
  async claimOutbox(now: Date, leaseMs: number) {
    return (await this.collection<OutboxRow>("outbox").findOneAndUpdate(
      {
        sentAt: null,
        needsAttentionAt: null,
        nextAttemptAt: { $lte: now },
        leaseUntil: { $lte: now },
      },
      {
        $set: { leaseUntil: new Date(now.getTime() + leaseMs) },
        $inc: { fence: 1, attempts: 1 },
      },
      { sort: { nextAttemptAt: 1, id: 1 }, returnDocument: "after" },
    )) as OutboxRow | null;
  }
  async completeOutbox(id: string, fence: number, now: Date) {
    const result = await this.collection<OutboxRow>("outbox").updateOne(
      { id, fence, sentAt: null },
      { $set: { sentAt: now.toISOString(), leaseUntil: new Date(0) } },
    );
    return result.modifiedCount === 1;
  }
  async retryOutbox(id: string, fence: number, now: Date, error: string) {
    const collection = this.collection<OutboxRow>("outbox");
    const row = await collection.findOne({ id, fence, sentAt: null });
    if (!row) return;
    const base = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts - 1, 6));
    const delay = base + Math.floor(Math.random() * base);
    await collection.updateOne(
      { id, fence, sentAt: null },
      {
        $set: {
          leaseUntil: new Date(0),
          nextAttemptAt: new Date(now.getTime() + delay),
          lastError: error,
          needsAttentionAt: row.attempts >= 10 ? now.toISOString() : null,
        },
      },
    );
  }
  async ready() {
    try {
      await this.client
        .db(this.database)
        .command({ ping: 1 }, { timeoutMS: 1000 });
      return true;
    } catch {
      return false;
    }
  }
}
export async function connectStore(uri: string, database = "review_db") {
  const client = await new MongoClient(uri, {
    serverSelectionTimeoutMS: 3000,
  }).connect();
  const store = new MongoReviewStore(client, database);
  await store.migrate();
  return store;
}
