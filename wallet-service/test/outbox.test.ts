import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Contracts } from '../src/contracts';
import { withTx } from '../src/db';
import { enqueueEvent, type Envelope } from '../src/domain/outbox';
import { newId } from '../src/ids';
import { money } from '../src/money';
import { backoffMs, OutboxPublisher, type Broker } from '../src/outbox/publisher';
import { FakeClock, freshPool, resetData, T0 } from './helpers';

let pool: Pool; let clock: FakeClock;
const contracts = new Contracts(path.resolve(__dirname, '../../contracts'));

class FakeBroker implements Broker {
  mode: 'UP' | 'DOWN' | 'UNROUTABLE' = 'UP';
  delivered: Envelope[] = [];
  async verifyTopology() { if (this.mode === 'DOWN') throw new Error('down'); }
  async publish(envelope: Envelope) {
    if (this.mode === 'DOWN') throw new Error('ECONNREFUSED');
    if (this.mode === 'UNROUTABLE') throw new Error('UNROUTABLE');
    this.delivered.push(envelope);
  }
  async close() {}
}

beforeAll(async () => { pool = await freshPool(); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await resetData(pool); clock = new FakeClock(T0); });

const enqueue = (userId = newId()) => withTx(pool, (tx) => enqueueEvent(tx, {
  type: 'wallet.topup-resolved', aggregate: { type: 'topup', id: newId(), version: '1' }, targets: { kind: 'USERS', userIds: [userId] },
  group: 'WALLET_PAYMENTS', data: { topupId: newId(), status: 'SUCCEEDED', amount: money(10000n) }, dedupeKey: newId(), now: clock.now(),
}));

describe('transactional outbox', () => {
  it('saves a schema-valid event with the business transaction and rolls it back with it', async () => {
    const env = await enqueue();
    expect(contracts.validateEvent(env)).toEqual({ ok: true });
    await expect(withTx(pool, async (tx) => {
      await enqueueEvent(tx, { type: 'wallet.topup-resolved', aggregate: { type: 'topup', id: newId(), version: '1' }, targets: { kind: 'USERS', userIds: [newId()] }, group: 'WALLET_PAYMENTS', data: { topupId: newId(), status: 'FAILED', amount: money(1n) }, dedupeKey: 'rolled-back', now: clock.now() });
      throw new Error('business failure');
    })).rejects.toThrow();
    expect(Number((await pool.query('SELECT count(*) FROM outbox')).rows[0].count)).toBe(1);
  });

  it('survives a broker outage and later publishes the original event identity', async () => {
    const env = await enqueue();
    const broker = new FakeBroker(); broker.mode = 'DOWN';
    const publisher = new OutboxPublisher(pool, broker, clock, contracts, { random: () => 1 });
    expect(await publisher.runOnce()).toEqual({ published: 0, failed: 1 });
    expect(await publisher.pendingCount()).toBe(1);
    // Not due again until the backoff elapses.
    expect(await publisher.runOnce()).toEqual({ published: 0, failed: 0 });
    broker.mode = 'UP';
    clock.advance(2000);
    expect(await publisher.runOnce()).toEqual({ published: 1, failed: 0 });
    expect(broker.delivered.map((e) => e.eventId)).toEqual([env.eventId]);
    expect(await publisher.pendingCount()).toBe(0);
  });

  it('treats an unroutable publication as a failure and keeps the row retryable', async () => {
    await enqueue();
    const broker = new FakeBroker(); broker.mode = 'UNROUTABLE';
    const publisher = new OutboxPublisher(pool, broker, clock, contracts);
    await publisher.runOnce();
    expect(await publisher.pendingCount()).toBe(1);
    expect((await pool.query('SELECT last_error FROM outbox')).rows[0].last_error).toContain('UNROUTABLE');
  });

  it('flags NEEDS_ATTENTION after ten failures but still retries', async () => {
    await enqueue();
    const broker = new FakeBroker(); broker.mode = 'DOWN';
    const publisher = new OutboxPublisher(pool, broker, clock, contracts, { random: () => 0 });
    for (let i = 0; i < 10; i += 1) { clock.advance(61_000); await publisher.runOnce(); }
    const row = (await pool.query('SELECT needs_attention, attempts, status FROM outbox')).rows[0];
    expect(row).toEqual({ needs_attention: true, attempts: 10, status: 'PENDING' });
    broker.mode = 'UP'; clock.advance(61_000);
    expect((await publisher.runOnce()).published).toBe(1);
  });

  it('does not hand one event to two workers at once, and a stale fence cannot mark it published', async () => {
    await enqueue();
    const slow = new FakeBroker();
    const a = new OutboxPublisher(pool, slow, clock, contracts, { leaseMs: 1000 });
    const b = new OutboxPublisher(pool, new FakeBroker(), clock, contracts, { leaseMs: 1000 });
    const claimedByBoth = await Promise.all([a.runOnce(), b.runOnce()]);
    expect(claimedByBoth.reduce((n, r) => n + r.published, 0)).toBe(1);

    // Simulate a worker whose lease expired and was re-claimed: its late completion must not win.
    await resetData(pool); await enqueue();
    const first = await pool.query("UPDATE outbox SET fence = fence + 1, lease_until = $1 RETURNING event_id, fence", [new Date(clock.now().getTime() + 1000)]);
    const stale = (BigInt(first.rows[0].fence) - 1n).toString();
    await pool.query("UPDATE outbox SET fence = fence + 1 WHERE event_id = $1", [first.rows[0].event_id]);
    const res = await pool.query("UPDATE outbox SET status = 'PUBLISHED' WHERE event_id = $1 AND fence = $2", [first.rows[0].event_id, stale]);
    expect(res.rowCount).toBe(0);
  });

  it('quarantines an invalid event instead of publishing it', async () => {
    await pool.query("INSERT INTO outbox (event_id, type, envelope, next_attempt_at, created_at) VALUES ($1, 'wallet.bogus', '{\"type\":\"wallet.bogus\"}', $2, $2)", [newId(), clock.now()]);
    const broker = new FakeBroker();
    await new OutboxPublisher(pool, broker, clock, contracts).runOnce();
    expect(broker.delivered).toHaveLength(0);
    expect((await pool.query('SELECT needs_attention FROM outbox')).rows[0].needs_attention).toBe(true);
  });

  it('backs off exponentially from 1s up to a 60s cap with jitter', () => {
    expect(backoffMs(1, () => 1)).toBe(1000);
    expect(backoffMs(3, () => 1)).toBe(4000);
    expect(backoffMs(20, () => 1)).toBe(60_000);
    expect(backoffMs(20, () => 0)).toBe(30_000);
  });
});
