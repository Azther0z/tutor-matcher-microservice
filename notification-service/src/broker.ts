import amqp, { type Channel, type ConsumeMessage } from 'amqplib';
import type { EventAcceptor, Inbound } from './domain/events';

export const EXCHANGE = 'tutor-matcher.events';
export const QUEUE = 'notification.events.v1';
export const BINDING = 'v1.#';
export const DEAD_EXCHANGE = 'tutor-matcher.dead';
export const DEAD_QUEUE = 'notification.events.v1.dead';
export const DEAD_ROUTING_KEY = 'notification.invalid';

/** Installs the versioned topology. Readiness is false until this has succeeded. */
export async function installTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_EXCHANGE, 'direct', { durable: true });
  await channel.assertQueue(DEAD_QUEUE, { durable: true });
  await channel.bindQueue(DEAD_QUEUE, DEAD_EXCHANGE, DEAD_ROUTING_KEY);
  await channel.assertQueue(QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': DEAD_EXCHANGE, 'x-dead-letter-routing-key': DEAD_ROUTING_KEY },
  });
  await channel.bindQueue(QUEUE, EXCHANGE, BINDING);
}

export function inboundFrom(message: ConsumeMessage): Inbound {
  return {
    body: message.content, routingKey: message.fields.routingKey, userId: message.properties.userId,
    messageId: message.properties.messageId, type: message.properties.type,
  };
}

export interface ConsumerOptions {
  /** Transient storage failures: delay (ms) before the message is requeued, so a failing store is never hot-looped. */
  retryDelayMs?: (attempt: number) => number;
  maxAttempts?: number;
}

/**
 * Consumes `notification.events.v1`. A message is acknowledged only after the event and its jobs are durable.
 * Invalid/unknown payloads are dead-lettered without requeue; a transient failure is requeued after a bounded delay.
 */
export class EventConsumer {
  private connection?: Awaited<ReturnType<typeof amqp.connect>>;
  private channel?: Channel;
  private attempts = new Map<string, number>();
  private ready = false;
  private stopped = false;

  constructor(private readonly url: string, private readonly acceptor: EventAcceptor, private readonly options: ConsumerOptions = {}) {}

  isReady(): boolean { return this.ready; }

  async start(): Promise<void> {
    for (let attempt = 1; !this.stopped; attempt += 1) {
      try {
        await this.connect();
        return;
      } catch (error) {
        console.warn(`[Notification] RabbitMQ not ready (${(error as Error).message}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4))));
      }
    }
  }

  private async connect(): Promise<void> {
    const connection = await amqp.connect(this.url);
    const reconnect = () => {
      if (this.stopped) return;
      this.ready = false;
      this.channel = undefined;
      console.error('[Notification] RabbitMQ connection lost; reconnecting');
      setTimeout(() => void this.start(), 2000).unref();
    };
    connection.on('close', reconnect);
    connection.on('error', () => undefined);
    const channel = await connection.createChannel();
    await installTopology(channel);
    await channel.prefetch(10);
    await channel.consume(QUEUE, (message) => { if (message) void this.onMessage(channel, message); }, { noAck: false });
    this.connection = connection;
    this.channel = channel;
    this.ready = true;
    console.log(`[Notification] consuming ${QUEUE} (binding ${BINDING}) with dead-letter ${DEAD_QUEUE}`);
  }

  async onMessage(channel: Pick<Channel, 'ack' | 'nack'>, message: ConsumeMessage): Promise<void> {
    const inbound = inboundFrom(message);
    const key = message.properties.messageId ?? `${message.fields.deliveryTag}`;
    try {
      const outcome = await this.acceptor.accept(inbound);
      this.attempts.delete(key);
      if (outcome.kind === 'QUARANTINED' && outcome.deadLetter) channel.nack(message, false, false); // → dead-letter exchange
      else channel.ack(message);
    } catch (error) {
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);
      console.error(`[Notification] could not durably accept ${key} (attempt ${attempt}): ${(error as Error).message}`);
      if (attempt >= (this.options.maxAttempts ?? 10)) {
        this.attempts.delete(key);
        await this.acceptor.exhausted(inbound, `Storage failed ${attempt} times: ${(error as Error).message}`).catch(() => undefined);
        channel.nack(message, false, false);
        return;
      }
      const delay = this.options.retryDelayMs?.(attempt) ?? Math.min(30_000, 500 * 2 ** attempt);
      setTimeout(() => { try { channel.nack(message, false, true); } catch { /* channel closed: broker redelivers */ } }, delay).unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
