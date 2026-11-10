const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function run(env, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["infra/docker/rabbitmq-provision.mjs"], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        RABBITMQ_MANAGEMENT_URL: `http://127.0.0.1:${port}`,
        RABBITMQ_DEFINITIONS: path.join(root, "services/notification-service/deploy/rabbitmq-definitions.json"),
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => resolve({ code, output }));
  });
}

async function withBroker(fn, status) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      res.writeHead(status ?? (req.headers.authorization ? 201 : 401)).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(server.address().port, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("provisions only producers with a supplied password and never touches auth", async () => {
  await withBroker(async (port, requests) => {
    const result = await run({ RABBITMQ_AUTH_PASSWORD: "admin-secret", RABBITMQ_WALLET_PASSWORD: "wallet-secret", RABBITMQ_NOTIFICATION_PASSWORD: "notification-secret" }, port);
    assert.equal(result.code, 0, result.output);
    const urls = requests.map((request) => `${request.method} ${request.url}`);
    assert.deepEqual(urls, [
      "PUT /api/exchanges/%2F/tutor-matcher.events",
      "PUT /api/exchanges/%2F/tutor-matcher.dead",
      "PUT /api/queues/%2F/notification.events.v1",
      "PUT /api/queues/%2F/notification.events.v1.dead",
      "POST /api/bindings/%2F/e/tutor-matcher.events/q/notification.events.v1",
      "POST /api/bindings/%2F/e/tutor-matcher.dead/q/notification.events.v1.dead",
      "PUT /api/users/wallet",
      "PUT /api/permissions/%2F/wallet",
      "PUT /api/topic-permissions/%2F/wallet",
      "PUT /api/users/notification",
      "PUT /api/permissions/%2F/notification",
    ]);
    assert.ok(requests.every((request) => request.authorization === `Basic ${Buffer.from("auth:admin-secret").toString("base64")}`));
    const queue = requests.find((request) => request.url === "/api/queues/%2F/notification.events.v1").body;
    assert.deepEqual(queue.arguments, { "x-dead-letter-exchange": "tutor-matcher.dead", "x-dead-letter-routing-key": "notification.invalid" });
    const wallet = requests.find((request) => request.url === "/api/topic-permissions/%2F/wallet").body;
    assert.equal(wallet.exchange, "tutor-matcher.events");
    assert.equal(wallet.write, "^v1\\.wallet\\.");
    assert.equal(requests.find((request) => request.url === "/api/permissions/%2F/wallet").body.configure, "^$", "a producer may not declare topology");
    assert.match(result.output, /Not provisioned.*tutor, booking, review, messaging/);
    assert.ok(!result.output.includes("wallet-secret"), "passwords are never printed");
  });
});

test("fails when the management API rejects a call", async () => {
  await withBroker(async (port) => {
    const result = await run({ RABBITMQ_AUTH_PASSWORD: "admin-secret", RABBITMQ_WALLET_PASSWORD: "wallet-secret" }, port);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /PUT exchanges\/%2F\/tutor-matcher.events returned 403/);
  }, 403);
});

test("fails before any call when the administrator credential is missing", async () => {
  await withBroker(async (port, requests) => {
    const result = await run({ RABBITMQ_WALLET_PASSWORD: "wallet-secret" }, port);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /RABBITMQ_AUTH_PASSWORD is required/);
    assert.equal(requests.length, 0);
  });
});
