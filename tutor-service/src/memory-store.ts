import { failedWork, type Store, type Transaction } from "./store";
import type {
  GrantWork,
  OutboxWork,
  StoredOperation,
  TutorState,
} from "./types";
export class MemoryStore implements Store {
  accounts = new Map<string, TutorState>();
  operations = new Map<string, StoredOperation>();
  grants = new Map<string, GrantWork>();
  outbox = new Map<string, OutboxWork>();
  private pending: Promise<void> = Promise.resolve();
  async transaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.pending;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const accounts = structuredClone(this.accounts),
      operations = structuredClone(this.operations),
      grants = structuredClone(this.grants),
      outbox = structuredClone(this.outbox);
    try {
      const result = await run({
        getState: async (id) => accounts.get(id) ?? null,
        putState: async (value) => {
          accounts.set(value._id, structuredClone(value));
        },
        getOperation: async (id) => operations.get(id) ?? null,
        putOperation: async (value) => {
          operations.set(value._id, structuredClone(value));
        },
        getGrant: async (id) => grants.get(id) ?? null,
        putGrant: async (value) => {
          grants.set(value._id, structuredClone(value));
        },
        putOutbox: async (value) => {
          outbox.set(value._id, structuredClone(value));
        },
      });
      this.accounts = accounts;
      this.operations = operations;
      this.grants = grants;
      this.outbox = outbox;
      return structuredClone(result);
    } finally {
      release();
    }
  }
  async states() {
    return structuredClone([...this.accounts.values()]);
  }
  async operation(id: string) {
    return structuredClone(
      [...this.operations.values()].find((item) => item.id === id) ?? null,
    );
  }
  async claimGrant(now: number) {
    const work = [...this.grants.values()].find(
      (item) =>
        item.state === "PENDING" &&
        item.availableAt <= now &&
        item.lockedUntil <= now,
    );
    if (!work) return null;
    work.lockedUntil = now + 30000;
    work.fence++;
    work.attempts++;
    return structuredClone(work);
  }
  async claimOutbox(now: number) {
    const work = [...this.outbox.values()].find(
      (item) =>
        item.state === "PENDING" &&
        item.availableAt <= now &&
        item.lockedUntil <= now,
    );
    if (!work) return null;
    work.lockedUntil = now + 30000;
    work.fence++;
    work.attempts++;
    return structuredClone(work);
  }
  async finishOutbox(id: string, fence: number, error?: string) {
    const work = this.outbox.get(id);
    if (!work || work.fence !== fence || work.state !== "PENDING") return;
    if (error) Object.assign(work, failedWork(work, error));
    else {
      work.lockedUntil = 0;
      work.state = "SENT";
    }
  }
  async retryGrant(id: string, fence: number, error: string) {
    const work = this.grants.get(id);
    if (!work || work.fence !== fence || work.state !== "PENDING") return;
    Object.assign(work, failedWork(work, error));
  }
}
