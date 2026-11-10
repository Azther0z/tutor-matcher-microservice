import { recoverRefunds, resumeUnpaidCancellations } from './cancellation';
import type { Ctx } from './context';
import { provisionMeetings, recoverCompletions, sweepReminders } from './lifecycle';
import { expireHolds, recoverPayments } from './payments';

/**
 * Durable work always comes from the database, never from a timer's memory: each sweep selects due rows, so a restart
 * loses nothing. Sweeps are sequential per process; rows are leased and fenced, so several replicas can run safely.
 */
export class BackgroundWorkers {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly ctx: Ctx) {}

  async runOnce(): Promise<void> {
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['payment recovery', () => recoverPayments(this.ctx)],
      ['hold expiry', () => expireHolds(this.ctx)],
      ['unpaid cancellations', () => resumeUnpaidCancellations(this.ctx)],
      ['refund recovery', () => recoverRefunds(this.ctx)],
      ['completion handoff', () => recoverCompletions(this.ctx)],
      ['meeting provisioning', () => provisionMeetings(this.ctx)],
      ['reminders', () => sweepReminders(this.ctx)],
    ];
    for (const [name, step] of steps) {
      try { await step(); } catch (error) { console.error(`[Booking] ${name} sweep failed`, (error as Error).message); }
    }
  }

  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runOnce().finally(() => { this.running = false; });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
