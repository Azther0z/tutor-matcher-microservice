import amqp, { type ConfirmChannel, type ChannelModel } from "amqplib";
import type { EventEnvelope, ReviewStore } from "./types";
export interface EventPublisher {
  publish(event: EventEnvelope): Promise<void>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}
export class RabbitPublisher implements EventPublisher {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private opening?: Promise<ConfirmChannel>;
  private returned = new Set<string>();
  constructor(
    private readonly url: string,
    private readonly connector: typeof amqp.connect = amqp.connect,
  ) {}
  private async connect(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const connection = await this.connector(this.url, { timeout: 3000 });
      this.connection = connection;
      const reset = () => {
        this.channel = undefined;
        this.opening = undefined;
      };
      connection.on("error", reset);
      connection.on("close", reset);
      const channel = await connection.createConfirmChannel();
      channel.on("error", reset);
      channel.on("close", reset);
      // Publish-only: this producer's broker user may write to the exchange but not declare or inspect anything
      // (see services/notification-service/deploy/rabbitmq-definitions.json). Auth, Notification and infra/docker/rabbitmq-provision.mjs
      // install the topology, and the mandatory flag below rejects an event that no queue received.
      channel.on("return", (message) => {
        if (message.properties.messageId)
          this.returned.add(message.properties.messageId);
      });
      this.channel = channel;
      return channel;
    })();
    try {
      return await this.opening;
    } catch (error) {
      this.opening = undefined;
      await this.connection?.close().catch(() => undefined);
      throw error;
    }
  }
  async ready(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }
  async publish(event: EventEnvelope): Promise<void> {
    const channel = await this.connect();
    this.returned.delete(event.eventId);
    const username = decodeURIComponent(new URL(this.url).username || "guest");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Publisher confirmation timed out.")),
        5000,
      );
      channel.publish(
        "tutor-matcher.events",
        `v1.${event.type}`,
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          mandatory: true,
          contentType: "application/json",
          messageId: event.eventId,
          type: event.type,
          userId: username,
        },
        (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        },
      );
    });
    if (this.returned.delete(event.eventId))
      throw new Error("Required notification queue did not receive the event.");
  }
  async close() {
    await this.connection?.close().catch(() => undefined);
    this.connection = undefined;
    this.channel = undefined;
    this.opening = undefined;
  }
}
export async function publishOnce(
  store: ReviewStore,
  publisher: Pick<EventPublisher, "publish">,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const row = await store.claimOutbox(now(), 30_000);
  if (!row) return false;
  try {
    await publisher.publish(row.event);
    await store.completeOutbox(row.id, row.fence, now());
  } catch {
    await store.retryOutbox(row.id, row.fence, now(), "PUBLISH_FAILED");
  }
  return true;
}
export function startPublisher(
  store: ReviewStore,
  publisher: EventPublisher,
): () => Promise<void> {
  let active = false,
    stopped = false;
  async function tick() {
    if (active || stopped) return;
    active = true;
    try {
      for (
        let count = 0;
        count < 20 && !stopped && (await publishOnce(store, publisher));
        count++
      );
    } catch {
      return;
    } finally {
      active = false;
    }
  }
  const timer = setInterval(() => {
    void tick();
  }, 1000);
  timer.unref();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await publisher.close();
  };
}
