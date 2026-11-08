import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const require = createRequire(
  new URL("../shared/package.json", import.meta.url),
);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");
const amqp = require("amqplib");
const containerCli = process.env.CONTAINER_CLI || "docker";
const containerName = `tm-outbox-${randomUUID().slice(0, 12)}`;
const containerUser = `publisher_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
const containerPassword = randomBytes(32).toString("base64url");
const createdEnvironmentKeys = [
  "DATABASE_URL",
  "AUTH_MIGRATIONS_DIR",
  "JWT_SECRET",
  "IDEMPOTENCY_SECRET",
  "RESET_CONTENT_KEY",
  "GATEWAY_WORKLOAD_CREDENTIAL",
  "ADMIN_SIGNUP_KEY",
  "ACTOR_ASSERTION_PUBLIC_KEY",
  "ACTOR_ASSERTION_PRIVATE_KEY",
  "AUTH_SYNTHETIC_EMAILS",
  "RABBITMQ_URL",
  "RESET_BASE_URL",
  "DEMO_MODE",
  "NODE_ENV",
];

let authServer;
let authPool;
let publisherStops = [];
let brokerConnection;
let brokerChannel;
let containerCreated = false;
let failureStage = "initialization";
let safeFailureReason;

function assert(condition, message) {
  if (!condition) {
    safeFailureReason = message;
    throw new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runContainer(args, options = {}) {
  const result = spawnSync(containerCli, args, {
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "ignore"] : "ignore",
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
  });
  if (result.error || result.status !== 0)
    throw new Error("Container command failed");
  return options.capture ? result.stdout.trim() : "";
}

async function unusedLoopbackPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(
    address && typeof address !== "string",
    "Could not allocate an ephemeral loopback port",
  );
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(read, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch {
      // Keep waiting for dependencies and durable work to become visible.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function validateEnvelope(schema, event) {
  const validate = schema(event);
  assert(
    validate.ok,
    "Password reset event did not match the local event schema",
  );
}

async function loadEventSchema() {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    validateFormats: true,
  });
  addFormats(ajv);
  const shared = JSON.parse(
    await readFile(
      new URL("../contracts/schemas/v1.json", import.meta.url),
      "utf8",
    ),
  );
  const event = JSON.parse(
    await readFile(
      new URL("../contracts/schemas/events.v1.json", import.meta.url),
      "utf8",
    ),
  );
  ajv.addSchema(shared, "https://tutor-matcher.local/schemas/v1.json");
  ajv.addSchema(event, "https://tutor-matcher.local/schemas/events.v1.json");
  const validator = ajv.getSchema(
    "https://tutor-matcher.local/schemas/events.v1.json",
  );
  assert(validator, "Local event schema did not compile");
  return (value) => ({ ok: validator(value) === true });
}

async function startAuthServer(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

async function requestAuth(baseUrl, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.GATEWAY_WORKLOAD_CREDENTIAL}`,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  let value;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  return { status: response.status, value };
}

async function openBroker(url) {
  const connection = await amqp.connect(url, { timeout: 2500 });
  return connection;
}

async function main() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  assert(
    testDatabaseUrl,
    "TEST_DATABASE_URL must point to the isolated Auth test database",
  );
  const parsedDatabaseUrl = new URL(testDatabaseUrl);
  assert(
    parsedDatabaseUrl.pathname.endsWith("_test"),
    "Refusing a database without a _test suffix",
  );
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.AUTH_MIGRATIONS_DIR = fileURLToPath(
    new URL("../auth-service/migrations", import.meta.url),
  );
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  process.env.IDEMPOTENCY_SECRET = randomBytes(32).toString("hex");
  process.env.RESET_CONTENT_KEY = randomBytes(32).toString("hex");
  process.env.GATEWAY_WORKLOAD_CREDENTIAL = randomBytes(32).toString("hex");
  process.env.ADMIN_SIGNUP_KEY = randomBytes(32).toString("hex");
  process.env.DEMO_MODE = "true";
  process.env.RESET_BASE_URL = "https://example.invalid/password-reset";
  process.env.AUTH_SYNTHETIC_EMAILS = `outbox-${randomUUID()}@example.invalid`;

  failureStage = "Auth database migration";
  const { migrate, pool } = await import("../auth-service/dist/db.js");
  authPool = pool;
  await migrate();
  const database = await pool.query("SELECT current_database() AS name");
  assert(
    database.rows[0]?.name === parsedDatabaseUrl.pathname.slice(1),
    "Connected to an unexpected test database",
  );

  failureStage = "Auth app startup";
  const { createAuthApp } = await import("../auth-service/dist/index.js");
  const { startOutboxPublisher } =
    await import("../auth-service/dist/events.js");
  authServer = await startAuthServer(createAuthApp());
  const baseUrl = `http://127.0.0.1:${authServer.address().port}`;

  failureStage = "Synthetic account signup";
  const requestId = randomUUID();
  const email = process.env.AUTH_SYNTHETIC_EMAILS;
  const password = randomBytes(18).toString("base64url");
  const signup = await requestAuth(
    baseUrl,
    "/auth/signup",
    {
      firstName: "Outbox",
      lastName: "Smoke",
      email,
      password,
      passwordConfirmation: password,
      termsAccepted: true,
      privacyAccepted: true,
    },
    { "idempotency-key": randomUUID(), "x-request-id": requestId },
  );
  assert(
    signup.status === 201,
    `Synthetic signup returned HTTP ${signup.status} (${typeof signup.value?.code === "string" ? signup.value.code : "no error code"})`,
  );
  assert(
    typeof signup.value?.user?.id === "string",
    "Synthetic signup response omitted the user ID",
  );
  const userId = signup.value.user.id;

  failureStage = "Transactional reset request";
  const resetRequestId = randomUUID();
  const reset = await requestAuth(
    baseUrl,
    "/auth/password-reset/request",
    { email },
    { "x-request-id": resetRequestId },
  );
  assert(
    reset.status === 202,
    "Password reset request did not receive its enumeration-safe acknowledgement",
  );

  failureStage = "Outbox persistence";
  const outboxQuery = `SELECT event_id,event_type,routing_key,payload,published_at,attempts,last_error
    FROM events_outbox
    WHERE event_type='auth.password-reset-requested'
      AND payload->'targets'->'userIds' @> $1::jsonb
    ORDER BY created_at DESC LIMIT 1`;
  const targetJson = JSON.stringify([userId]);
  const initial = await pool.query(outboxQuery, [targetJson]);
  assert(
    initial.rowCount === 1,
    "Reset event was not committed to the Auth outbox",
  );
  const eventId = initial.rows[0].event_id;
  const routingKey = initial.rows[0].routing_key;
  const event = initial.rows[0].payload;
  assert(
    event.eventId === eventId,
    "Outbox identity did not match envelope eventId",
  );
  assert(
    event.correlationId === resetRequestId,
    "Reset event correlationId did not match the request",
  );

  const closedPort = await unusedLoopbackPort();
  process.env.RABBITMQ_URL = `amqp://${encodeURIComponent(containerUser)}:${encodeURIComponent(containerPassword)}@127.0.0.1:${closedPort}`;
  failureStage = "Broker outage retry";
  const stopPublisher = startOutboxPublisher();
  publisherStops.push(stopPublisher);
  const pending = await waitFor(
    async () => {
      const result = await pool.query(outboxQuery, [targetJson]);
      const row = result.rows[0];
      if (row?.published_at === null && Number(row.attempts) > 0) return row;
      return null;
    },
    "outbox attempt during broker outage",
    12_000,
  );
  assert(
    pending.event_id === eventId,
    "Broker outage changed the event identity",
  );

  failureStage = "Disposable RabbitMQ startup";
  const containerEnvironment = {
    ...process.env,
    RABBITMQ_DEFAULT_USER: containerUser,
    RABBITMQ_DEFAULT_PASS: containerPassword,
  };
  runContainer(
    [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-p",
      "127.0.0.1::5672",
      "--env",
      "RABBITMQ_DEFAULT_USER",
      "--env",
      "RABBITMQ_DEFAULT_PASS",
      "docker.io/library/rabbitmq:4.3.6-management",
    ],
    { env: containerEnvironment, timeout: 180_000 },
  );
  containerCreated = true;
  const portOutput = runContainer(["port", containerName, "5672/tcp"], {
    capture: true,
  });
  const hostPort =
    portOutput.match(/127\.0\.0\.1:(\d+)/)?.[1] ??
    portOutput.match(/:(\d+)/)?.[1];
  assert(hostPort, "Could not determine the disposable RabbitMQ loopback port");
  const brokerUrl = `amqp://${encodeURIComponent(containerUser)}:${encodeURIComponent(containerPassword)}@127.0.0.1:${hostPort}`;
  await waitFor(
    async () => {
      const connection = await openBroker(brokerUrl);
      await connection.close();
      return true;
    },
    "RabbitMQ readiness",
    90_000,
  );

  failureStage = "Publisher recovery";
  process.env.RABBITMQ_URL = brokerUrl;
  const eventSchema = await loadEventSchema();
  const published = await waitFor(
    async () => {
      const result = await pool.query(outboxQuery, [targetJson]);
      const row = result.rows[0];
      if (
        row?.published_at &&
        Number(row.attempts) >= Number(pending.attempts) + 1
      )
        return row;
      return null;
    },
    "confirmed outbox publication",
    35_000,
  );
  assert(
    published.event_id === eventId,
    "Recovered publication changed the event identity",
  );
  assert(
    published.routing_key === `v1.${event.type}`,
    "Outbox routing key did not match event type",
  );
  assert(
    published.last_error === null,
    "Published outbox row retained an error",
  );
  validateEnvelope(eventSchema, event);
  assert(
    event.producer === "auth",
    "Published event did not identify Auth as producer",
  );
  assert(
    event.type === "auth.password-reset-requested",
    "Unexpected event type",
  );
  assert(
    event.targets?.kind === "USERS" &&
      event.targets.userIds?.length === 1 &&
      event.targets.userIds[0] === userId,
    "Reset event audience did not target the registered user",
  );
  assert(
    Object.keys(event.data ?? {})
      .sort()
      .join(",") === "contentRef,expiresAt",
    "Reset event contains data outside contentRef and expiry",
  );
  assert(
    !JSON.stringify(event).includes("token=") &&
      !JSON.stringify(event).includes("http"),
    "Reset token or link appeared in the event envelope",
  );

  failureStage = "Broker delivery verification";
  brokerConnection = await openBroker(brokerUrl);
  brokerChannel = await brokerConnection.createChannel();
  const queue = await brokerChannel.checkQueue("notification.events.v1");
  assert(
    queue.messageCount === 1,
    `The versioned Notification queue had ${queue.messageCount} messages, expected one`,
  );
  const delivery = await brokerChannel.get("notification.events.v1", {
    noAck: false,
  });
  assert(delivery, "The confirmed event was not available in the bound queue");
  const received = JSON.parse(delivery.content.toString("utf8"));
  validateEnvelope(eventSchema, received);
  assert(
    received.eventId === eventId,
    "RabbitMQ message did not preserve eventId",
  );
  assert(
    delivery.fields.routingKey === routingKey,
    "RabbitMQ delivery routing key changed",
  );
  assert(
    delivery.properties.messageId === eventId,
    "AMQP message_id did not equal eventId",
  );
  assert(
    delivery.properties.type === event.type,
    "AMQP type did not equal envelope type",
  );
  assert(
    delivery.properties.contentType === "application/json",
    "AMQP content_type was not application/json",
  );
  assert(
    delivery.properties.deliveryMode === 2,
    "AMQP message was not persistent",
  );
  assert(
    delivery.properties.userId === containerUser,
    "AMQP user_id did not match the authenticated publisher",
  );
  brokerChannel.ack(delivery);
  const duplicate = await brokerChannel.get("notification.events.v1", {
    noAck: true,
  });
  assert(
    duplicate === false,
    "A duplicate reset event was present in the queue",
  );

  failureStage = "Publisher restart idempotency";
  stopPublisher();
  await delay(300);
  const beforeRestart = await pool.query(outboxQuery, [targetJson]);
  const publishedAt = new Date(beforeRestart.rows[0].published_at).getTime();
  const attempts = Number(beforeRestart.rows[0].attempts);
  const restartPublisher = startOutboxPublisher();
  publisherStops.push(restartPublisher);
  await delay(1500);
  const afterRestart = await pool.query(outboxQuery, [targetJson]);
  assert(
    afterRestart.rows[0].event_id === eventId,
    "Publisher restart changed outbox identity",
  );
  assert(
    Number(afterRestart.rows[0].attempts) === attempts,
    "Published row was claimed again after publisher restart",
  );
  assert(
    new Date(afterRestart.rows[0].published_at).getTime() === publishedAt,
    "Published timestamp changed after restart",
  );
  const remaining = await brokerChannel.checkQueue("notification.events.v1");
  assert(
    remaining.messageCount === 0,
    "Publisher restart duplicated the acknowledged event",
  );

  console.log(
    "PASS: Auth committed reset outbox work during broker outage, recovered to confirmed mandatory RabbitMQ delivery, and did not republish after restart.",
  );
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  const reason =
    safeFailureReason ??
    (error instanceof Error ? error.name : "unknown error");
  console.error(
    `FAIL: Auth outbox smoke stopped during ${failureStage} (${reason}).`,
  );
} finally {
  for (const stop of publisherStops.reverse()) {
    try {
      stop();
    } catch {
      /* Continue cleanup of owned resources. */
    }
  }
  await delay(150);
  try {
    await brokerChannel?.close();
  } catch {
    /* Already closed. */
  }
  try {
    await brokerConnection?.close();
  } catch {
    /* Already closed. */
  }
  if (authServer) {
    authServer.closeAllConnections();
    await new Promise((resolve) => authServer.close(resolve));
  }
  try {
    await authPool?.end();
  } catch {
    /* Preserve the original smoke result. */
  }
  if (containerCreated) {
    try {
      runContainer(["stop", containerName], { timeout: 20_000 });
    } catch {
      /* Remove only this run's container. */
    }
  }
  for (const key of createdEnvironmentKeys) delete process.env[key];
}
