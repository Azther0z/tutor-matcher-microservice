import { beforeEach, describe, expect, it, vi } from 'vitest';

const connections: Array<{ close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }> = [];
let topologyFailures = 0;

vi.mock('amqplib', () => {
  const connect = vi.fn(async () => {
    const channel = {
      assertExchange: vi.fn(async () => { if (topologyFailures > 0) { topologyFailures -= 1; throw new Error('ACCESS_REFUSED'); } }),
      assertQueue: vi.fn(async () => undefined), bindQueue: vi.fn(async () => undefined),
      prefetch: vi.fn(async () => undefined), consume: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    };
    const connection = { close: vi.fn(async () => undefined), on: vi.fn(), createChannel: vi.fn(async () => channel) };
    connections.push(connection);
    return connection;
  });
  return { default: { connect }, connect };
});

import { EventConsumer } from '../src/broker';

const acceptor = { accept: vi.fn(), exhausted: vi.fn() } as never;

beforeEach(() => { connections.length = 0; topologyFailures = 0; vi.useRealTimers(); });

describe('connecting to the broker', () => {
  it('closes the connection when the topology cannot be installed, so retries do not leak connections', async () => {
    topologyFailures = 1;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return { unref() {} } as never; }) as never);
    const consumer = new EventConsumer('amqp://unused', acceptor);
    await consumer.start();
    expect(connections).toHaveLength(2);
    expect(connections[0].close).toHaveBeenCalledTimes(1);
    expect(connections[1].close).not.toHaveBeenCalled();
    expect(consumer.isReady()).toBe(true);
    vi.restoreAllMocks();
  });

  it('runs a single connect loop even if start is called again while it is retrying', async () => {
    topologyFailures = 3;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return { unref() {} } as never; }) as never);
    const consumer = new EventConsumer('amqp://unused', acceptor);
    await Promise.all([consumer.start(), consumer.start(), consumer.start()]);
    // One loop: three failed attempts, then one success. Parallel loops would have opened many more.
    expect(connections).toHaveLength(4);
    vi.restoreAllMocks();
  });

  it('does not register the reconnect handler until the connection is fully set up', async () => {
    topologyFailures = 1;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return { unref() {} } as never; }) as never);
    const consumer = new EventConsumer('amqp://unused', acceptor);
    await consumer.start();
    const closeHandlers = (index: number) => connections[index].on.mock.calls.filter(([event]) => event === 'close').length;
    expect(closeHandlers(0)).toBe(0);
    expect(closeHandlers(1)).toBe(1);
    vi.restoreAllMocks();
  });
});
