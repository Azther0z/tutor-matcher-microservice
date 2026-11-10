import {
  MongoClient,
  type ClientSession,
  type Db,
  type Document,
} from "mongodb";
import type {
  TutorState,
  StoredOperation,
  GrantWork,
  OutboxWork,
} from "./types";
export interface Transaction {
  getState(id: string): Promise<TutorState | null>;
  putState(state: TutorState): Promise<void>;
  getOperation(key: string): Promise<StoredOperation | null>;
  putOperation(op: StoredOperation): Promise<void>;
  putGrant(work: GrantWork): Promise<void>;
  putOutbox(work: OutboxWork): Promise<void>;
  getGrant(id: string): Promise<GrantWork | null>;
}
export interface Store {
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  states(): Promise<TutorState[]>;
  operation(id: string): Promise<StoredOperation | null>;
  claimGrant(now: number): Promise<GrantWork | null>;
  claimOutbox(now: number): Promise<OutboxWork | null>;
  finishOutbox(id: string, fence: number, error?: string): Promise<void>;
  retryGrant(id: string, fence: number, error: string): Promise<void>;
}
export class MongoStore implements Store {
  constructor(
    readonly client: MongoClient,
    readonly db: Db,
  ) {}
  async migrate(): Promise<void> {
    await this.db.collection<TutorState>("accounts").createIndex(
      { tutorId: 1 },
      {
        unique: true,
        partialFilterExpression: { tutorId: { $type: "string" } },
      },
    );
    await this.db
      .collection<StoredOperation>("operations")
      .createIndex({ id: 1 }, { unique: true });
    await this.db
      .collection<OutboxWork>("outbox")
      .createIndex({ state: 1, availableAt: 1, lockedUntil: 1 });
    await this.db
      .collection<GrantWork>("grants")
      .createIndex({ state: 1, availableAt: 1, lockedUntil: 1 });
    await this.db
      .collection<GrantWork>("grants")
      .createIndex({ submissionId: 1, approvalRevision: 1 }, { unique: true });
  }
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => work(this.tx(session)), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      });
    } finally {
      await session.endSession();
    }
  }
  private tx(session: ClientSession): Transaction {
    const get = <T extends Document>(name: string, id: string) =>
      this.db
        .collection<T>(name)
        .findOne({ _id: id } as never, { session }) as Promise<T | null>;
    const put = async <T extends Document>(name: string, value: T) => {
      await this.db
        .collection<T>(name)
        .replaceOne({ _id: value._id } as never, value as never, {
          upsert: true,
          session,
        });
    };
    return {
      getState: (id) => get<TutorState>("accounts", id),
      putState: (value) => put("accounts", value),
      getOperation: (id) => get<StoredOperation>("operations", id),
      putOperation: (value) => put("operations", value),
      putGrant: (value) => put("grants", value),
      getGrant: (id) => get<GrantWork>("grants", id),
      putOutbox: (value) => put("outbox", value),
    };
  }
  async states(): Promise<TutorState[]> {
    return this.db.collection<TutorState>("accounts").find().toArray();
  }
  async operation(id: string): Promise<StoredOperation | null> {
    return this.db.collection<StoredOperation>("operations").findOne({ id });
  }
  async claimGrant(now: number): Promise<GrantWork | null> {
    return this.claim<GrantWork>("grants", now);
  }
  async claimOutbox(now: number): Promise<OutboxWork | null> {
    return this.claim<OutboxWork>("outbox", now);
  }
  private async claim<T extends GrantWork | OutboxWork>(
    name: string,
    now: number,
  ): Promise<T | null> {
    return this.db.collection<T>(name).findOneAndUpdate(
      {
        state: "PENDING",
        availableAt: { $lte: now },
        lockedUntil: { $lte: now },
      } as never,
      {
        $set: { lockedUntil: now + 30_000 },
        $inc: { fence: 1, attempts: 1 },
      } as never,
      { sort: { availableAt: 1, _id: 1 }, returnDocument: "after" },
    ) as Promise<T | null>;
  }
  async finishOutbox(id: string, fence: number, error?: string): Promise<void> {
    const collection = this.db.collection<OutboxWork>("outbox");
    const work = await collection.findOne({ _id: id, fence, state: "PENDING" });
    if (!work) return;
    await collection.updateOne(
      { _id: id, fence, state: "PENDING" },
      {
        $set: error
          ? failedWork(work, error)
          : { lockedUntil: 0, state: "SENT" },
      },
    );
  }
  async retryGrant(id: string, fence: number, error: string): Promise<void> {
    const collection = this.db.collection<GrantWork>("grants");
    const work = await collection.findOne({ _id: id, fence, state: "PENDING" });
    if (!work) return;
    await collection.updateOne(
      { _id: id, fence, state: "PENDING" },
      { $set: failedWork(work, error) },
    );
  }
}
export async function connectStore(uri: string): Promise<MongoStore> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db("tutor_db");
  const hello = await db.command({ hello: 1 });
  if (!hello.setName) {
    await client.close();
    throw new Error("Tutor requires a MongoDB replica set for transactions.");
  }
  const store = new MongoStore(client, db);
  await store.migrate();
  return store;
}

export function retryDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    60_000,
    1000 * 2 ** Math.min(6, Math.max(0, attempt - 1)),
  );
  return Math.min(60_000, base + Math.floor(base * 0.2 * random()));
}
export function failedWork(
  work: { attempts: number; attemptLimit?: number },
  error: string,
) {
  const exhausted = work.attempts >= (work.attemptLimit ?? 10);
  return {
    lockedUntil: 0,
    availableAt: Date.now() + retryDelay(work.attempts),
    lastError: error,
    state: exhausted ? ("NEEDS_ATTENTION" as const) : ("PENDING" as const),
    ...(exhausted ? { needsAttentionAt: Date.now() } : {}),
  };
}
export async function retryExhaustedWork(
  db: Db,
  kind: "grants" | "outbox",
  id: string,
): Promise<boolean> {
  const collection = db.collection<GrantWork | OutboxWork>(kind);
  const work = await collection.findOne({ _id: id, state: "NEEDS_ATTENTION" });
  if (!work) return false;
  const result = await collection.updateOne(
    { _id: id, fence: work.fence, state: "NEEDS_ATTENTION" },
    {
      $set: {
        state: "PENDING",
        availableAt: 0,
        lockedUntil: 0,
        attemptLimit: work.attempts + 10,
        lastError: "MANUAL_RETRY",
      },
      $inc: { fence: 1 },
      $push: {
        retryHistory: {
          requestedAt: new Date().toISOString(),
          priorAttempts: work.attempts,
        },
      },
    } as never,
  );
  return result.modifiedCount === 1;
}
