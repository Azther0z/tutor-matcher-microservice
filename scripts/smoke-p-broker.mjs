// Real-broker smoke test for Wallet publishing and Notification consuming.
//
// Needs a DISPOSABLE RabbitMQ (with the management plugin) and a MongoDB replica set. It creates users, an
// exchange and queues, and deletes a queue, so it refuses to run unless P_SMOKE_DISPOSABLE=1.
//
//   P_SMOKE_DISPOSABLE=1 RABBITMQ_AMQP_HOST=127.0.0.1 RABBITMQ_AMQP_PORT=56720 \
//   RABBITMQ_MANAGEMENT_URL=http://127.0.0.1:56725 RABBITMQ_AUTH_PASSWORD=... \
//   SMOKE_MONGO_URI='mongodb://127.0.0.1:55434/?replicaSet=rs0&directConnection=true' \
//   npm run smoke:p-broker
//
// Optional: P_SMOKE_STOP_CMD / P_SMOKE_START_CMD stop and start the broker to prove publish recovery after an outage.
import { execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.P_SMOKE_DISPOSABLE !== "1") {
  console.error(
    "Refusing to run: this test creates users and topology and deletes a queue. Set P_SMOKE_DISPOSABLE=1 for a disposable broker.",
  );
  process.exit(2);
}
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const require = createRequire(import.meta.url);
const amqp = require("amqplib");
const { AmqpBroker } = require(
  path.join(root, "services/wallet-service/dist/outbox/amqp.js"),
);
const { EventConsumer, QUEUE, EXCHANGE } = require(
  path.join(root, "services/notification-service/dist/broker.js"),
);
const { EventAcceptor } = require(
  path.join(root, "services/notification-service/dist/domain/events.js"),
);
const { Contracts } = require(
  path.join(root, "services/notification-service/dist/contracts.js"),
);
const { openStore } = require(
  path.join(root, "services/notification-service/dist/store.js"),
);
const { systemClock } = require(
  path.join(root, "services/notification-service/dist/time.js"),
);
const { RabbitPublisher: TutorPublisher } = require(
  path.join(root, "services/tutor-service/dist/outbox.js"),
);
const { RabbitPublisher: ReviewPublisher } = require(
  path.join(root, "services/review-service/dist/events.js"),
);

const host = process.env.RABBITMQ_AMQP_HOST || "127.0.0.1";
const port = process.env.RABBITMQ_AMQP_PORT || "5672";
const management = (
  process.env.RABBITMQ_MANAGEMENT_URL || "http://127.0.0.1:15672"
).replace(/\/$/, "");
const adminPassword = process.env.RABBITMQ_AUTH_PASSWORD;
const mongoUri = process.env.SMOKE_MONGO_URI;
if (!adminPassword || !mongoUri)
  throw new Error("RABBITMQ_AUTH_PASSWORD and SMOKE_MONGO_URI are required");
const passwords = {
  wallet: randomUUID(),
  notification: randomUUID(),
  tutor: randomUUID(),
  review: randomUUID(),
};
const url = (user, password = passwords[user]) =>
  `amqp://${user}:${password}@${host}:${port}`;
const adminAuth = `Basic ${Buffer.from(`auth:${adminPassword}`).toString("base64")}`;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures += 1;
};
const observe = (name, detail) => console.log(`OBSERVED  ${name} — ${detail}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) return true;
    await sleep(100);
  }
  return false;
}
async function api(method, route) {
  const response = await fetch(`${management}/api/${route}`, {
    method,
    headers: { authorization: adminAuth },
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: response.status,
    body:
      response.status === 204
        ? undefined
        : await response.json().catch(() => undefined),
  };
}
/** A raw connection's channel error: resolves with the broker's reply text, or "" if nothing was refused. */
async function refusal(user, action) {
  const connection = await amqp.connect(url(user));
  connection.on("error", () => undefined);
  const channel = await connection.createConfirmChannel();
  const closed = new Promise((resolve) => {
    channel.on("error", (error) => resolve(String(error.message)));
    channel.on("close", () => resolve(""));
  });
  try {
    await action(channel);
  } catch (error) {
    await connection.close().catch(() => undefined);
    return String(error.message);
  }
  const outcome = await Promise.race([closed, sleep(1500).then(() => "")]);
  await connection.close().catch(() => undefined);
  return outcome;
}

const event = (overrides = {}) => ({
  eventId: randomUUID(),
  type: "wallet.topup-resolved",
  schemaVersion: 1,
  occurredAt: new Date().toISOString(),
  producer: "wallet",
  aggregate: { type: "topup", id: randomUUID(), version: "1" },
  correlationId: randomUUID(),
  targets: { kind: "USERS", userIds: [randomUUID()] },
  notificationGroup: "WALLET_PAYMENTS",
  data: {
    topupId: randomUUID(),
    status: "SUCCEEDED",
    amount: { currency: "THB", amount: "250.00" },
  },
  ...overrides,
});

// 1. Provision the producer users with the real script.
try {
  execFileSync(
    process.execPath,
    [path.join(root, "infra/docker/rabbitmq-provision.mjs")],
    {
      env: {
        PATH: process.env.PATH,
        RABBITMQ_MANAGEMENT_URL: management,
        RABBITMQ_AUTH_PASSWORD: adminPassword,
        RABBITMQ_DEFINITIONS: path.join(
          root,
          "services/notification-service/deploy/rabbitmq-definitions.json",
        ),
        RABBITMQ_WALLET_PASSWORD: passwords.wallet,
        RABBITMQ_NOTIFICATION_PASSWORD: passwords.notification,
        RABBITMQ_TUTOR_PASSWORD: passwords.tutor,
        RABBITMQ_REVIEW_PASSWORD: passwords.review,
      },
      stdio: "pipe",
    },
  );
} catch (error) {
  console.error(
    `Provisioning failed: ${
      String(error.stderr ?? error.message)
        .split("\n")
        .find((line) => line.startsWith("Error")) ?? error.message
    }`,
  );
  process.exit(1);
}
const users = (await api("GET", "users")).body ?? [];
check(
  "provisioning created the wallet, notification, tutor and review broker users",
  ["wallet", "notification", "tutor", "review"].every((name) =>
    users.some((user) => user.name === name),
  ),
);
check(
  "producer users carry no management tag",
  users
    .filter((u) =>
      ["wallet", "notification", "tutor", "review"].includes(u.name),
    )
    .every((u) => !u.tags?.length),
);

// 2. Notification installs the topology as the `notification` user and starts consuming.
const store = await openStore(mongoUri, "notification_smoke_broker");
await store.client.db("notification_smoke_broker").dropDatabase();
const contracts = new Contracts(path.join(root, "contracts"));
// Notification's default: each producer connects to the broker as a user named after itself.
const publisherIdentities = Object.fromEntries(
  ["auth", "tutor", "booking", "wallet", "review", "messaging"].map((name) => [
    name,
    name,
  ]),
);
const acceptor = new EventAcceptor(
  store,
  contracts,
  systemClock,
  publisherIdentities,
);
let failNext = 0;
const flaky = {
  accept: async (inbound) => {
    if (failNext > 0) {
      failNext -= 1;
      throw new Error("simulated storage failure");
    }
    return acceptor.accept(inbound);
  },
  exhausted: (...args) => acceptor.exhausted(...args),
};
let consumer = new EventConsumer(url("notification"), flaky, {
  retryDelayMs: () => 100,
  maxAttempts: 5,
});
await consumer.start();
check(
  "Notification asserted the provisioned topology and is consuming as a restricted user",
  consumer.isReady(),
);

// 3. Wallet publishes with confirms + mandatory + user_id as the restricted `wallet` user.
const wallet = new AmqpBroker(url("wallet"), "wallet");
const first = event();
await wallet.publish(first);
check("Wallet publish resolved on a routed publisher confirm", true);
check(
  "Notification durably accepted it as publisher 'wallet'",
  await until(
    async () =>
      (await store.events.findOne({ _id: first.eventId }))?.publisher ===
      "wallet",
  ),
);
const deliveriesAfterFirst = await store.deliveries.countDocuments({
  eventId: first.eventId,
});
await wallet.publish(first);
await sleep(800);
check(
  "a repeated publish of the same event adds no second delivery",
  (await store.deliveries.countDocuments({ eventId: first.eventId })) ===
    deliveriesAfterFirst,
);

// 4. Permissions are enforced by the broker.
check(
  "Wallet's broker check works under its restricted permissions",
  await wallet.verifyTopology().then(
    () => true,
    (e) => {
      observe("verifyTopology failure", e.message);
      return false;
    },
  ),
);
const probeQueue = await refusal("wallet", (ch) => ch.checkQueue(QUEUE));
check(
  "Wallet cannot inspect Notification's queue (a passive declare needs configure access)",
  /ACCESS_REFUSED/i.test(probeQueue),
  probeQueue.slice(0, 100),
);
const other = await refusal("wallet", (ch) =>
  ch.publish(EXCHANGE, "v1.booking.confirmed", Buffer.from("{}"), {
    userId: "wallet",
    persistent: true,
  }),
);
check(
  "Wallet cannot publish under another producer's routing prefix",
  /ACCESS_REFUSED|access to topic/i.test(other),
  other.slice(0, 120),
);
const declare = await refusal("wallet", (ch) =>
  ch.assertQueue(`rogue.${randomUUID()}`, { durable: false }),
);
check(
  "Wallet cannot declare queues",
  /ACCESS_REFUSED/i.test(declare),
  declare.slice(0, 120),
);
const spoof = await refusal("wallet", (ch) =>
  ch.publish(EXCHANGE, "v1.wallet.topup-resolved", Buffer.from("{}"), {
    userId: "booking",
    persistent: true,
  }),
);
check(
  "the broker rejects a spoofed user_id",
  /PRECONDITION_FAILED|user_id/i.test(spoof),
  spoof.slice(0, 120),
);

// 5. Redelivery after a transient storage failure is bounded and eventually durable.
failNext = 2;
const retried = event();
await wallet.publish(retried);
check(
  "a transient storage failure is redelivered and then accepted",
  await until(
    async () => Boolean(await store.events.findOne({ _id: retried.eventId })),
    15_000,
  ),
);

// 6. An unroutable publish is a failure, never a silent success.
await consumer.stop();
const deleted = await api("DELETE", `queues/%2F/${encodeURIComponent(QUEUE)}`);
check(
  "administrator removed the required queue",
  deleted.status === 204,
  `HTTP ${deleted.status}`,
);
const unroutable = await wallet.publish(event()).then(
  () => "published",
  (e) => String(e.message),
);
check(
  "publishing with no bound queue is reported as UNROUTABLE",
  /UNROUTABLE/.test(unroutable),
  unroutable.slice(0, 100),
);
consumer = new EventConsumer(url("notification"), flaky, {
  retryDelayMs: () => 100,
  maxAttempts: 5,
});
await consumer.start();
const recovered = event();
await wallet.publish(recovered);
check(
  "after Notification reinstalls the topology, publishing succeeds again",
  await until(async () =>
    Boolean(await store.events.findOne({ _id: recovered.eventId })),
  ),
);

// 6b. The real Tutor and Review publishers send every Tutor/Review contract event through the broker.
const adminTarget = { kind: "ADMINS" };
const userTarget = () => ({ kind: "USERS", userIds: [randomUUID()] });
const marketplaceEvents = [
  [
    "tutor",
    "tutor.submission-submitted",
    adminTarget,
    () => ({
      submissionId: randomUUID(),
      applicantUserId: randomUUID(),
      kind: "APPLICATION",
    }),
  ],
  [
    "tutor",
    "tutor.submission-withdrawn",
    adminTarget,
    () => ({
      submissionId: randomUUID(),
      applicantUserId: randomUUID(),
      kind: "REVISION",
    }),
  ],
  [
    "tutor",
    "tutor.submission-decided",
    userTarget(),
    () => ({ submissionId: randomUUID(), decision: "APPROVE", reason: null }),
  ],
  [
    "tutor",
    "tutor.activated",
    userTarget(),
    () => ({ submissionId: randomUUID(), tutorId: randomUUID() }),
  ],
  [
    "review",
    "review.flagged",
    adminTarget,
    () => ({ reviewId: randomUUID(), flagId: randomUUID() }),
  ],
  [
    "review",
    "review.moderated",
    userTarget(),
    () => ({
      reviewId: randomUUID(),
      decision: "HIDE",
      reason: "Synthetic moderation reason.",
    }),
  ],
].map(([producer, type, targets, data]) =>
  event({
    type,
    producer,
    targets,
    notificationGroup: "SYSTEM",
    data: data(),
    aggregate: { type: type.split(".")[0], id: randomUUID(), version: "1" },
  }),
);
process.env.RABBITMQ_URL = url("tutor");
const tutorPublisher = new TutorPublisher();
const reviewPublisher = new ReviewPublisher(url("review"));
check(
  "Review's readiness check works under its publish-only permissions",
  await reviewPublisher.ready(),
);
for (const envelope of marketplaceEvents) {
  const publisher =
    envelope.producer === "tutor" ? tutorPublisher : reviewPublisher;
  const sent = await publisher.publish(envelope).then(
    () => "ok",
    (e) => String(e.message),
  );
  check(
    `${envelope.type} published by the real ${envelope.producer} publisher`,
    sent === "ok",
    sent === "ok" ? "" : sent.slice(0, 120),
  );
  const accepted = await until(
    async () =>
      (await store.events.findOne({ _id: envelope.eventId }))?.publisher ===
      envelope.producer,
  );
  check(
    `${envelope.type} accepted by Notification as publisher '${envelope.producer}'`,
    accepted,
  );
  if (envelope.targets.kind === "USERS") {
    check(
      `${envelope.type} created a mandatory simulated email for its recipient`,
      await until(
        async () =>
          (await store.deliveries.countDocuments({
            eventId: envelope.eventId,
            channel: "EMAIL",
          })) >= 1,
      ),
    );
  } else {
    const doc = await store.events.findOne({ _id: envelope.eventId });
    check(
      `${envelope.type} keeps its admin audience pending for resolution`,
      doc?.audienceStatus === "PENDING",
      String(doc?.audienceStatus),
    );
  }
}
const crossing = await refusal("tutor", (ch) =>
  ch.publish(EXCHANGE, "v1.review.flagged", Buffer.from("{}"), {
    userId: "tutor",
    persistent: true,
  }),
);
check(
  "Tutor cannot publish under Review's routing prefix",
  /ACCESS_REFUSED/i.test(crossing),
  crossing.slice(0, 100),
);
await tutorPublisher.close?.();
await reviewPublisher.close?.();

// 7. Optional: broker outage and recovery of the publisher connection.
if (process.env.P_SMOKE_STOP_CMD && process.env.P_SMOKE_START_CMD) {
  execSync(process.env.P_SMOKE_STOP_CMD, { stdio: "pipe" });
  const during = await Promise.race([
    wallet.publish(event()).then(
      () => "published",
      (e) => String(e.message),
    ),
    sleep(8000).then(() => "timeout"),
  ]);
  check(
    "publishing while the broker is down does not report success",
    during !== "published",
    during.slice(0, 100),
  );
  execSync(process.env.P_SMOKE_START_CMD, { stdio: "pipe" });
  const back = event();
  let published = false;
  for (let attempt = 0; attempt < 30 && !published; attempt += 1) {
    published = await wallet.publish(back).then(
      () => true,
      () => false,
    );
    if (!published) await sleep(1000);
  }
  check("Wallet publishes again after the broker returns", published);
  await consumer.stop().catch(() => undefined);
  consumer = new EventConsumer(url("notification"), flaky, {
    retryDelayMs: () => 100,
    maxAttempts: 5,
  });
  await consumer.start();
  check(
    "the event published after recovery is accepted exactly once",
    await until(
      async () =>
        (await store.events.countDocuments({ _id: back.eventId })) === 1,
      15_000,
    ),
  );
} else
  observe(
    "broker outage",
    "skipped (set P_SMOKE_STOP_CMD and P_SMOKE_START_CMD)",
  );

await consumer.stop().catch(() => undefined);
await wallet.close().catch(() => undefined);
await store.client.db("notification_smoke_broker").dropDatabase();
await store.client.close();
console.log(
  failures ? `\n${failures} check(s) failed.` : "\nAll broker checks passed.",
);
process.exit(failures ? 1 : 0);
