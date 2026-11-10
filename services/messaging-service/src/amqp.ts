import amqp, { type ConfirmChannel } from 'amqplib';
import type { Envelope } from './outbox';
import type { Broker } from './outbox';

export const EXCHANGE = 'tutor-matcher.events';
export const REQUIRED_QUEUE = 'notification.events.v1';

/**
 * RabbitMQ publisher. Uses publisher confirms plus the mandatory flag: a confirm alone does not prove a required
 * subscriber was bound, so an unroutable basic.return is treated as a failure and the outbox row stays retryable.
 * The AMQP user_id property is set to this service's own broker username, which RabbitMQ verifies.
 */
export class AmqpBroker implements Broker {
  private connection?: Awaited<ReturnType<typeof amqp.connect>>;
  private channel?: ConfirmChannel;
  private connecting?: Promise<ConfirmChannel>;
  private readonly returned = new Set<string>();

  constructor(private readonly url: string, private readonly user: string) {}

  private connect(): Promise<ConfirmChannel> {
    if (this.channel) return Promise.resolve(this.channel);
    this.connecting ??= (async () => {
      const connection = await amqp.connect(this.url);
      const reset = () => { this.channel = undefined; this.connection = undefined; this.connecting = undefined; };
      connection.on('close', reset);
      connection.on('error', reset);
      let channel: ConfirmChannel;
      try {
        channel = await connection.createConfirmChannel();
      } catch (error) {
        // Do not leak a half-open connection on every failed attempt.
        await connection.close().catch(() => undefined);
        throw error;
      }
      channel.on('close', reset);
      channel.on('error', reset);
      channel.on('return', (message) => { if (message.properties.messageId) this.returned.add(message.properties.messageId); });
      // The exchange belongs to Notification's versioned topology. Publish with write permission only: if it is
      // missing the broker closes this channel, the publish fails, and the outbox row stays retryable.
      this.connection = connection;
      this.channel = channel;
      return channel;
    })().catch((error) => { this.connecting = undefined; throw error; });
    return this.connecting;
  }

  /**
   * Proves the broker is reachable under Wallet's own credentials. It deliberately does not inspect the queue: a
   * passive declare needs `configure` access, which would also let Wallet delete or purge Notification's queue.
   * Routing is proven where it matters, by the `mandatory` publish below, which rejects an unroutable event.
   */
  async verifyTopology(): Promise<void> {
    await this.connect();
  }

  async publish(envelope: Envelope): Promise<void> {
    const channel = await this.connect();
    this.returned.delete(envelope.eventId);
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EXCHANGE, `v1.${envelope.type}`, Buffer.from(JSON.stringify(envelope)),
        { persistent: true, mandatory: true, contentType: 'application/json', messageId: envelope.eventId, type: envelope.type, userId: this.user, deliveryMode: 2 },
        (error) => {
          if (error) return reject(error);
          if (this.returned.delete(envelope.eventId)) return reject(new Error('UNROUTABLE: no queue is bound for this routing key'));
          resolve();
        },
      );
    });
  }

  async close(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = undefined;
    this.connection = undefined;
    this.connecting = undefined;
  }
}
