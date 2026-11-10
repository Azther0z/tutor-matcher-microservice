import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import amqp from "amqplib";
import { RabbitPublisher } from "./events";
import type { EventEnvelope } from "./types";
const event: EventEnvelope = {
  eventId: randomUUID(),
  type: "review.flagged",
  schemaVersion: 1,
  occurredAt: "2026-11-10T03:00:00.000Z",
  producer: "review",
  aggregate: { type: "review", id: randomUUID(), version: "1" },
  correlationId: randomUUID(),
  causationId: randomUUID(),
  targets: { kind: "ADMINS" },
  notificationGroup: "SYSTEM",
  data: { reviewId: randomUUID(), flagId: randomUUID() },
};
function transport(outcome: "confirm" | "nack" | "return") {
  const calls: Array<{
    exchange: string;
    key: string;
    content: Buffer;
    options: Record<string, unknown>;
  }> = [];
  const topology: string[] = [];
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: async (name: string) => {
      topology.push(name);
    },
    assertQueue: async (name: string) => {
      topology.push(name);
    },
    bindQueue: async (name: string, exchange: string, route: string) => {
      topology.push(`${name}:${exchange}:${route}`);
    },
    checkQueue: async () => ({}),
    publish(
      exchange: string,
      key: string,
      content: Buffer,
      options: Record<string, unknown>,
      callback: (error: Error | null) => void,
    ) {
      calls.push({ exchange, key, content, options });
      if (outcome === "return")
        channel.emit("return", {
          properties: { messageId: options.messageId },
        });
      callback(outcome === "nack" ? new Error("Broker nack.") : null);
      return true;
    },
  });
  const connection = Object.assign(new EventEmitter(), {
    createConfirmChannel: async () => channel,
    close: async () => {},
  });
  return {
    connector: (async () => connection) as unknown as typeof amqp.connect,
    calls,
    topology,
  };
}
test("publisher requests durable routed confirms with the authenticated producer username", async () => {
  const fake = transport("confirm");
  const publisher = new RabbitPublisher(
    "amqp://review%5Fowner:synthetic@localhost",
    fake.connector,
  );
  await publisher.publish(event);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.key, "v1.review.flagged");
  assert.equal(call.options.mandatory, true);
  assert.equal(call.options.persistent, true);
  assert.equal(call.options.userId, "review_owner");
  assert.equal(call.options.messageId, event.eventId);
  assert.deepEqual(JSON.parse(call.content.toString()), event);
  assert.deepEqual(
    fake.topology,
    [],
    "a publish-only producer must not declare or bind anything",
  );
  await publisher.close();
});
test("publisher readiness only proves the broker accepts the connection and declares nothing", async () => {
  const fake = transport("confirm");
  const publisher = new RabbitPublisher(
    "amqp://review:synthetic@localhost",
    fake.connector,
  );
  assert.equal(await publisher.ready(), true);
  assert.deepEqual(fake.topology, []);
  await publisher.close();
});
test("publisher treats both broker nacks and mandatory returns as failed work", async () => {
  for (const outcome of ["nack", "return"] as const) {
    const fake = transport(outcome);
    const publisher = new RabbitPublisher(
      "amqp://review:synthetic@localhost",
      fake.connector,
    );
    await assert.rejects(publisher.publish(event));
    await publisher.close();
  }
});
