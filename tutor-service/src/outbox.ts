import amqp, {
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from "amqplib";
import type { EventEnvelope } from "./types";
import type { Store } from "./store";
export interface EventPublisher {
  publish(event: EventEnvelope): Promise<void>;
}
export class RabbitPublisher implements EventPublisher {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private opening?: Promise<ConfirmChannel>;
  private returned = new Set<string>();
  private username = "";
  private async ready(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const url = process.env.RABBITMQ_URL;
      if (!url) throw new Error("Broker configuration missing");
      this.username = decodeURIComponent(new URL(url).username);
      if (!this.username) throw new Error("Broker publisher identity missing");
      const connection = await amqp.connect(url, { timeout: 5000 });
      this.connection = connection;
      connection.on("error", () => this.reset());
      connection.on("close", () => this.reset());
      const channel = await connection.createConfirmChannel();
      channel.on("error", () => this.reset());
      channel.on("close", () => this.reset());
      channel.on("return", (message: ConsumeMessage) =>
        this.returned.add(message.properties.messageId ?? ""),
      );
      // Publish-only: this producer's broker user may write to the exchange but not declare or inspect anything
      // (see notification-service/deploy/rabbitmq-definitions.json). Auth, Notification and docker/rabbitmq-provision.mjs
      // install the topology, and the mandatory flag below rejects an event that no queue received.
      this.channel = channel;
      return channel;
    })();
    try {
      return await this.opening;
    } catch (error) {
      this.reset();
      throw error;
    }
  }
  private reset() {
    this.channel = undefined;
    this.opening = undefined;
  }
  async publish(event: EventEnvelope): Promise<void> {
    const channel = await this.ready();
    this.returned.delete(event.eventId);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reset();
        reject(new Error("Broker confirmation timeout"));
      }, 5000);
      timer.unref();
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
          userId: this.username,
        },
        (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        },
      );
    });
    if (this.returned.delete(event.eventId))
      throw new Error("Required event routing unavailable");
  }
  async close() {
    await this.connection?.close().catch(() => undefined);
    this.reset();
  }
}
export async function publishNext(
  store: Store,
  publisher: EventPublisher,
  now = Date.now(),
): Promise<boolean> {
  const work = await store.claimOutbox(now);
  if (!work) return false;
  try {
    await publisher.publish(work.event);
    await store.finishOutbox(work._id, work.fence);
  } catch {
    await store.finishOutbox(work._id, work.fence, "BROKER_UNAVAILABLE");
  }
  return true;
}
export function startWorkers(
  service: { activateNext(): Promise<boolean> },
  store: Store,
  publisher: EventPublisher,
): () => void {
  let busy = false,
    stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (let i = 0; i < 20 && !stopped; i++) {
        const [grant, event] = await Promise.all([
          service.activateNext(),
          publishNext(store, publisher),
        ]);
        if (!grant && !event) break;
      }
    } catch {
      return;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
