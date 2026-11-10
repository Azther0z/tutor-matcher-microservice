import type { ConsumeMessage } from 'amqplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BINDING, DEAD_EXCHANGE, DEAD_QUEUE, DEAD_ROUTING_KEY, EXCHANGE, EventConsumer, installTopology, QUEUE } from '../src/broker';
import { Contracts } from '../src/contracts';
import { EventAcceptor } from '../src/domain/events';
import type { Store } from '../src/store';
import { contractsDir, envelope, FakeClock, freshStore, resetStore, T0 } from './helpers';

let store: Store;
const contracts = new Contracts(contractsDir);
beforeAll(async () => { store = await freshStore(); });
afterAll(async () => { await store.client.close(); });
beforeEach(async () => { await resetStore(store); });

function message(env: Record<string, any>, extra: Partial<ConsumeMessage['properties']> = {}, routingKey = `v1.${env.type}`): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(env)),
    fields: { deliveryTag: 1, redelivered: false, exchange: EXCHANGE, routingKey, consumerTag: 'c' },
    properties: { userId: env.producer, messageId: env.eventId, type: env.type, contentType: 'application/json', deliveryMode: 2, ...extra },
  } as ConsumeMessage;
}
const channel = () => ({ ack: vi.fn(), nack: vi.fn() });
const consumer = (acceptor: EventAcceptor, options = {}) => new EventConsumer('amqp://unused', acceptor, { retryDelayMs: () => 5, maxAttempts: 3, ...options });
const acceptorFor = () => new EventAcceptor(store, contracts, new FakeClock(T0), { wallet: 'wallet', booking: 'booking' });

describe('topology', () => {
  it('declares the versioned exchange, queue, binding and dead-letter path', async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const fake = new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => { calls.push([name, ...args]); return Promise.resolve({}); } });
    await installTopology(fake as any);
    expect(calls).toContainEqual(['assertExchange', EXCHANGE, 'topic', { durable: true }]);
    expect(calls).toContainEqual(['assertExchange', DEAD_EXCHANGE, 'direct', { durable: true }]);
    expect(calls).toContainEqual(['assertQueue', QUEUE, { durable: true, arguments: { 'x-dead-letter-exchange': DEAD_EXCHANGE, 'x-dead-letter-routing-key': DEAD_ROUTING_KEY } }]);
    expect(calls).toContainEqual(['bindQueue', QUEUE, EXCHANGE, BINDING]);
    expect(calls).toContainEqual(['bindQueue', DEAD_QUEUE, DEAD_EXCHANGE, DEAD_ROUTING_KEY]);
    expect([QUEUE, BINDING, DEAD_QUEUE, DEAD_ROUTING_KEY]).toEqual(['notification.events.v1', 'v1.#', 'notification.events.v1.dead', 'notification.invalid']);
  });
});

describe('acknowledgement', () => {
  it('acknowledges only after the event is durable, and acknowledges a redelivery without duplicating work', async () => {
    const env = envelope('wallet.topup-resolved'); const ch = channel(); const c = consumer(acceptorFor());
    await c.onMessage(ch, message(env));
    expect(ch.ack).toHaveBeenCalledTimes(1);
    expect(await store.events.countDocuments({ _id: env.eventId })).toBe(1);
    await c.onMessage(ch, message(env));
    expect(ch.ack).toHaveBeenCalledTimes(2);
    expect(await store.deliveries.countDocuments()).toBe(2);
  });

  it('dead-letters (nack, no requeue) an invalid message and a spoofed publisher', async () => {
    const ch = channel(); const c = consumer(acceptorFor());
    await c.onMessage(ch, message({ ...envelope('wallet.topup-resolved'), schemaVersion: 9 }));
    await c.onMessage(ch, message(envelope('wallet.topup-resolved'), { userId: 'booking' }));
    expect(ch.nack.mock.calls.map((a) => a.slice(1))).toEqual([[false, false], [false, false]]);
    expect(ch.ack).not.toHaveBeenCalled();
  });

  it('acknowledges a conflicting payload after quarantining it (it is durable and alerted)', async () => {
    const env = envelope('wallet.topup-resolved'); const ch = channel(); const c = consumer(acceptorFor());
    await c.onMessage(ch, message(env));
    await c.onMessage(ch, message({ ...env, data: { ...env.data, status: 'FAILED' } }));
    expect(ch.ack).toHaveBeenCalledTimes(2);
    expect(await store.quarantine.countDocuments({ kind: 'CONFLICT' })).toBe(1);
  });

  it('requeues a transient storage failure only after a delay, never acknowledges it, and gives up after bounded attempts', async () => {
    const env = envelope('wallet.topup-resolved'); const ch = channel();
    const broken = { accept: async () => { throw new Error('mongo unavailable'); }, exhausted: vi.fn(async () => undefined) } as unknown as EventAcceptor;
    const c = consumer(broken);
    await c.onMessage(ch, message(env));
    expect(ch.nack).not.toHaveBeenCalled(); // delayed: no hot loop
    await new Promise((r) => setTimeout(r, 30));
    expect(ch.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    await c.onMessage(ch, message(env));
    await c.onMessage(ch, message(env));
    expect(ch.ack).not.toHaveBeenCalled();
    expect(ch.nack).toHaveBeenLastCalledWith(expect.anything(), false, false);
    expect((broken as any).exhausted).toHaveBeenCalledTimes(1);
  });
});
