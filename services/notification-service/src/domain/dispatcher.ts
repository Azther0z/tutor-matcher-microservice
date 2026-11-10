import type { Peers } from '../clients';
import { PeerRejected, PeerUnavailable } from '../clients';
import { newId } from '../ids';
import type { Clock } from '../time';
import type { DeliveryDoc, Store } from '../store';
import { GROUP_KEY, loadPreferences } from './preferences';

/** The simulated Email/Push provider. `idempotencyKey` is stable per (event, recipient, channel). */
export interface Provider {
  send(delivery: { idempotencyKey: string; channel: string; recipientUserId: string; eventType: string }): Promise<void>;
}

export class SimulatedProvider implements Provider {
  /** Test/demo hook: make the next `count` sends fail, as an unreliable provider would. */
  failures = 0;
  sent: string[] = [];
  async send(delivery: { idempotencyKey: string }): Promise<void> {
    if (this.failures > 0) { this.failures -= 1; throw new Error('Simulated provider failure'); }
    this.sent.push(delivery.idempotencyKey);
  }
}

const BASE_MS = 1000;
const CAP_MS = 60_000;
export function backoffMs(failures: number, random: () => number = Math.random): number {
  return Math.round(Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, failures - 1)) * (0.5 + random() * 0.5));
}

export interface DispatcherOptions { leaseMs?: number; attentionAfter?: number; random?: () => number }

export interface SweepResult { delivered: number; skipped: number; failed: number; deferred: number }

export class Dispatcher {
  private readonly leaseMs: number;
  private readonly attentionAfter: number;
  private readonly random: () => number;
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly store: Store, private readonly clock: Clock, private readonly peers: Peers, private readonly provider: Provider,
    options: DispatcherOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.attentionAfter = options.attentionAfter ?? 10;
    this.random = options.random ?? Math.random;
  }

  /** Claims one ready job with a lease and a monotonically increasing fence. Terminal receipts are never claimed. */
  private async claim(): Promise<DeliveryDoc | null> {
    const now = this.clock.now();
    return this.store.deliveries.findOneAndUpdate(
      {
        status: { $in: ['PENDING', 'FAILED'] }, nextAttemptAt: { $lte: now },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
      },
      { $set: { leaseUntil: new Date(now.getTime() + this.leaseMs) }, $inc: { fence: 1 } },
      { sort: { nextAttemptAt: 1, _id: 1 }, returnDocument: 'after' },
    );
  }

  async runOnce(limit = 100): Promise<SweepResult> {
    const result: SweepResult = { delivered: 0, skipped: 0, failed: 0, deferred: 0 };
    for (let i = 0; i < limit; i += 1) {
      const job = await this.claim();
      if (!job) break;
      let verdict: keyof SweepResult;
      try {
        verdict = await this.process(job);
      } catch (error) {
        // One bad job must not abort the sweep or strand its lease: record the failure and keep it retryable.
        await this.retryLater(job, 'FAILED', (error as Error).message ?? 'UNEXPECTED');
        verdict = 'failed';
      }
      result[verdict] += 1;
    }
    return result;
  }

  /** Terminal write guarded by the fence: a stale worker whose lease was taken over changes nothing. */
  private async finish(job: DeliveryDoc, status: 'DELIVERED' | 'SKIPPED', reason: string | null, preferencesRevision: string | null): Promise<boolean> {
    const res = await this.store.deliveries.updateOne(
      { _id: job._id, fence: job.fence, status: { $in: ['PENDING', 'FAILED'] } },
      { $set: { status, reason, preferencesRevision, deliveredAt: status === 'DELIVERED' ? this.clock.now() : null, leaseUntil: null, lastError: null } },
    );
    return res.matchedCount === 1;
  }

  private async retryLater(job: DeliveryDoc, status: 'PENDING' | 'FAILED', error: string): Promise<void> {
    const attempts = job.attempts + 1;
    await this.store.deliveries.updateOne(
      { _id: job._id, fence: job.fence, status: { $in: ['PENDING', 'FAILED'] } },
      { $set: {
        status, attempts, leaseUntil: null, lastError: error.slice(0, 300),
        nextAttemptAt: new Date(this.clock.now().getTime() + backoffMs(attempts, this.random)),
        needsAttention: attempts >= this.attentionAfter,
      } },
    );
  }

  private async process(job: DeliveryDoc): Promise<keyof SweepResult> {
    const context = { requestId: newId() };
    const event = await this.store.events.findOne({ _id: job.eventId });
    if (!event) { await this.retryLater(job, 'FAILED', 'EVENT_MISSING'); return 'failed'; }
    const data = (event.envelope.data ?? {}) as Record<string, any>;

    // 1. Preferences are read at dispatch, immediately before the effect (and again on every retry).
    let revision: string | null = null;
    if (job.category !== 'SYSTEM') {
      const prefs = await loadPreferences(this.store, job.recipientUserId, this.clock.now());
      const group = prefs[GROUP_KEY[job.category]];
      revision = prefs.revision;
      if (!(job.channel === 'EMAIL' ? group.email : group.push)) {
        return (await this.finish(job, 'SKIPPED', 'PREFERENCE_DISABLED', revision)) ? 'skipped' : 'deferred';
      }
    }

    try {
      // 2. Delayed reminders re-check Booking immediately before sending.
      if (job.eventType === 'booking.reminder-due') {
        const eligibility = await this.peers.booking.getReminderEligibility(
          { bookingId: data.bookingId, scheduleVersion: data.scheduleVersion, offsetMinutes: data.offsetMinutes }, context);
        if (!eligibility.eligible) return (await this.finish(job, 'SKIPPED', 'REMINDER_SUPPRESSED', revision)) ? 'skipped' : 'deferred';
      }
      // 3. Reset emails fetch their sensitive body only now, bound to the recipient and its expiry.
      if (job.eventType === 'auth.password-reset-requested') {
        try {
          const meta = await this.peers.auth.checkResetContent(data.contentRef, context);
          if (meta.recipientUserId !== job.recipientUserId || new Date(meta.expiresAt).getTime() <= this.clock.now().getTime()) {
            return (await this.finish(job, 'SKIPPED', 'EXPIRED', revision)) ? 'skipped' : 'deferred';
          }
        } catch (error) {
          if (error instanceof PeerRejected) return (await this.finish(job, 'SKIPPED', 'EXPIRED', revision)) ? 'skipped' : 'deferred';
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof PeerUnavailable || error instanceof PeerRejected) {
        // An outage — or a refusal we cannot interpret here, such as a mis-set workload credential — leaves the job
        // pending. It must neither drop the notification nor become a terminal result.
        await this.retryLater(job, 'PENDING', error instanceof PeerRejected ? 'PEER_REFUSED' : 'PEER_UNAVAILABLE');
        return 'deferred';
      }
      throw error;
    }

    // 4. The simulated provider effect. The delivery ID is the provider idempotency key.
    try {
      await this.provider.send({ idempotencyKey: job._id, channel: job.channel, recipientUserId: job.recipientUserId, eventType: job.eventType });
    } catch (error) {
      await this.retryLater(job, 'FAILED', (error as Error).message);
      return 'failed';
    }
    return (await this.finish(job, 'DELIVERED', null, revision)) ? 'delivered' : 'deferred';
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try { await this.runOnce(); } catch (error) { console.error('[Notification] dispatch sweep failed', (error as Error).message); } finally { this.busy = false; }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
