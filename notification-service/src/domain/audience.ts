import type { Peers } from '../clients';
import { newId } from '../ids';
import type { Clock } from '../time';
import { inTransaction, type EventDoc, type Store } from '../store';
import { backoffMs } from './dispatcher';
import { channelsFor, deliveryFor } from './events';

/**
 * Resolves an ADMINS audience through Auth once, saves the recipient snapshot with the jobs, and then retries
 * only those jobs. While Auth is unavailable the durable resolution work simply stays pending.
 */
export class AudienceResolver {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(private readonly store: Store, private readonly clock: Clock, private readonly peers: Peers, private readonly leaseMs = 30_000, private readonly random: () => number = Math.random) {}

  private claim(): Promise<EventDoc | null> {
    const now = this.clock.now();
    return this.store.events.findOneAndUpdate(
      { audienceStatus: 'PENDING', audienceNextAttemptAt: { $lte: now }, $or: [{ audienceLeaseUntil: null }, { audienceLeaseUntil: { $lte: now } }] },
      { $set: { audienceLeaseUntil: new Date(now.getTime() + this.leaseMs) }, $inc: { audienceFence: 1 } },
      { sort: { acceptedAt: 1, _id: 1 }, returnDocument: 'after' },
    );
  }

  async runOnce(limit = 50): Promise<{ resolved: number; deferred: number }> {
    let resolved = 0;
    let deferred = 0;
    for (let i = 0; i < limit; i += 1) {
      const event = await this.claim();
      if (!event) break;
      try {
        const admins = [...new Set(await this.peers.auth.listActiveAdmins({ requestId: newId() }))];
        const now = this.clock.now();
        const applied = await inTransaction(this.store, async (session) => {
          // Fence check: only the current claimant may publish the snapshot.
          const res = await this.store.events.updateOne(
            { _id: event._id, audienceStatus: 'PENDING', audienceFence: event.audienceFence },
            { $set: { audienceStatus: 'RESOLVED', recipients: admins, audienceLeaseUntil: null, audienceError: null } }, { session });
          if (res.matchedCount !== 1) return false;
          const jobs = admins.flatMap((userId) => channelsFor(event.group).map((channel) => deliveryFor(event, userId, channel, now)));
          if (jobs.length) await this.store.deliveries.insertMany(jobs, { session });
          return true;
        });
        if (applied) resolved += 1;
      } catch (error) {
        const attempts = event.audienceAttempts + 1;
        await this.store.events.updateOne(
          { _id: event._id, audienceFence: event.audienceFence, audienceStatus: 'PENDING' },
          { $set: { audienceAttempts: attempts, audienceLeaseUntil: null, audienceError: String((error as Error).message).slice(0, 200),
            audienceNextAttemptAt: new Date(this.clock.now().getTime() + backoffMs(attempts, this.random)) } });
        deferred += 1;
      }
    }
    return { resolved, deferred };
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try { await this.runOnce(); } catch (error) { console.error('[Notification] audience sweep failed', (error as Error).message); } finally { this.busy = false; }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
