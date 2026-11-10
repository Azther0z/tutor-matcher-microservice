const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const operationMap = require("../contracts/operation-map.json");
const inventory = operationMap.filter(
  (entry) => entry.protocol === "REST" && entry.surface === "PUBLIC",
);
const providers = process.env.GATEWAY_TEST_PROVIDER
  ? [process.env.GATEWAY_TEST_PROVIDER]
  : ["docker", "swarm"];
const gatewayCredential = "synthetic-gateway-workload-credential";
const browserToken = "synthetic-browser-bearer-token";
const actorProof = "synthetic-signed-actor-proof";
const requestId = "a0a0a0a0-0000-4000-8000-000000000001";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server, host = "127.0.0.1", port = 0) {
  server.listen(port, host);
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function createAuthServer(observations, state) {
  return http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(state.healthy ? 200 : 503, {
        "content-type": "application/json",
      });
      return res.end(
        state.healthy ? '{"status":"ok"}' : '{"status":"unavailable"}',
      );
    }
    if (req.url === "/internal/gateway/authorize") {
      const body = await readRequest(req);
      observations.auth.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body.toString(),
      });
      if (
        req.method !== "GET" ||
        req.headers["x-workload-authorization"] !==
          `Bearer ${gatewayCredential}` ||
        req.headers.authorization !== `Bearer ${browserToken}`
      ) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"error":"unauthorized"}');
      }
      res.writeHead(204, {
        "x-actor-context": actorProof,
        "x-request-id": requestId,
      });
      return res.end();
    }
    const body = await readRequest(req);
    observations.authOwner.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body.toString(),
    });
    const payload = JSON.stringify({
      owner: "auth",
      method: req.method,
      url: req.url,
      body: body.toString(),
      headers: safeHeaders(req.headers),
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "x-request-id": requestId,
    });
    res.end(payload);
  });
}

function safeHeaders(headers) {
  return {
    authorization: headers.authorization,
    actorContext: headers["x-actor-context"],
    workloadProof: headers["x-workload-authorization"],
    userId: headers["x-user-id"],
    userEmail: headers["x-user-email"],
    callerId: headers["x-caller-id"],
    requestId: headers["x-request-id"],
  };
}

function createOwnerServer(owner, instance, state, observations) {
  return http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(state.healthy ? 200 : 503, {
        "content-type": "application/json",
      });
      return res.end(
        state.healthy ? '{"status":"ok"}' : '{"status":"unavailable"}',
      );
    }
    const body = await readRequest(req);
    if (req.method === "GET" && state.failReads > 0) {
      state.failReads -= 1;
      res.writeHead(502);
      return res.end();
    }
    const record = {
      owner,
      instance,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body.toString(),
    };
    observations.owners.push(record);
    if (state.disconnectOnce > 0) {
      state.disconnectOnce -= 1;
      return req.socket.destroy();
    }
    if (state.disconnect) return req.socket.destroy();
    const payload = JSON.stringify({
      owner,
      instance,
      method: req.method,
      url: req.url,
      body: body.toString(),
      headers: safeHeaders(req.headers),
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "x-request-id": requestId,
    });
    res.end(payload);
  });
}

async function startProviderCase(t, provider) {
  const observations = { auth: [], authOwner: [], owners: [] };
  const servers = [];
  const authState = { healthy: true };
  const auth = createAuthServer(observations, authState);
  servers.push(auth);
  const authPort = await listen(auth);
  const ownerUrls = {};
  const ownerStates = {};
  for (const owner of [
    "booking",
    "messaging",
    "notification",
    "review",
    "tutor",
    "wallet",
  ]) {
    const replicas = owner === "tutor" ? 2 : 1;
    ownerUrls[owner] = [];
    ownerStates[owner] = [];
    let sharedPort;
    for (let index = 0; index < replicas; index += 1) {
      const state = { healthy: true, disconnect: false };
      const host = owner === "tutor" ? `127.0.0.${index + 2}` : "127.0.0.1";
      const server = createOwnerServer(
        owner,
        `${owner}-${index + 1}`,
        state,
        observations,
      );
      servers.push(server);
      sharedPort = await listen(server, host, sharedPort || 0);
      ownerStates[owner].push(state);
      ownerUrls[owner].push(`http://${host}:${sharedPort}`);
    }
  }
  const { startTestGateway } = await import(
    pathToFileURL(path.join(root, "scripts/traefik-test-runtime.mjs"))
  );
  let gateway;
  t.after(async () => {
    await gateway?.close();
    for (const server of servers.reverse()) await closeServer(server);
  });
  gateway = await startTestGateway({
    authUrl: `http://127.0.0.1:${authPort}`,
    ownerUrls,
    workloadCredential: gatewayCredential,
    provider,
    redactValues: [browserToken, actorProof],
    initialTaskCounts: { "tutor-service": 1 },
  });
  observations.auth.length = 0;
  observations.authOwner.length = 0;
  observations.owners.length = 0;
  const request = async (route, options = {}) => {
    const response = await fetch(gateway.url + route, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body, headers: response.headers };
  };

  await t.test(
    `${provider}: public routes forward path, query, body and workload credentials`,
    async () => {
      const response = await request("/api/auth/signup?source=test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${browserToken}`,
          "x-user-id": "forged-id",
          "x-user-email": "forged@example.invalid",
          "x-actor-context": "forged-actor",
          "x-caller-id": "forged-caller",
          "x-workload-authorization": "forged-workload",
        },
        body: JSON.stringify({ synthetic: true }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.owner, "auth");
      assert.equal(response.body.url, "/auth/signup?source=test");
      assert.equal(JSON.parse(response.body.body).synthetic, true);
      assert.ok(
        response.body.headers.authorization === `Bearer ${gatewayCredential}`,
        "public owner request must use the Gateway workload credential",
      );
      assert.equal(response.body.headers.workloadProof, undefined);
      assert.equal(response.body.headers.actorContext, undefined);
      assert.equal(response.body.headers.userId, undefined);
      assert.equal(response.body.headers.userEmail, undefined);
      assert.equal(response.body.headers.callerId, undefined);
    },
  );

  await t.test(
    `${provider}: protected route authenticates before forwarding and preserves conditionals`,
    async () => {
      const response = await request(
        "/api/profiles/me/account?include=revision",
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${browserToken}`,
            "x-request-id": requestId,
            "idempotency-key": "b0b0b0b0-0000-4000-8000-000000000002",
            "if-match": '"3"',
            "x-actor-context": "forged-actor",
            "x-workload-authorization": "forged-workload",
          },
          body: JSON.stringify({ name: "synthetic" }),
        },
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.owner, "auth");
      assert.equal(response.body.url, "/profiles/me/account?include=revision");
      assert.ok(
        response.body.headers.authorization === `Bearer ${gatewayCredential}`,
        "protected owner request must use the Gateway workload credential",
      );
      assert.ok(
        response.body.headers.actorContext === actorProof,
        "protected owner request must receive Auth's actor proof",
      );
      assert.equal(response.body.headers.workloadProof, undefined);
      assert.equal(response.body.headers.requestId, requestId);

      const admitted = observations.auth.at(-1);
      assert.equal(admitted.method, "GET");
      assert.equal(admitted.url, "/internal/gateway/authorize");
      assert.equal(
        admitted.headers["x-forwarded-method"],
        "PUT",
        `ForwardAuth headers: ${Object.keys(admitted.headers).join(",")}`,
      );
      assert.equal(
        admitted.headers["x-forwarded-uri"],
        "/api/profiles/me/account?include=revision",
      );
      assert.ok(
        admitted.headers["x-workload-authorization"] ===
          `Bearer ${gatewayCredential}`,
        "ForwardAuth must receive the Gateway workload credential",
      );
      assert.ok(
        admitted.headers.authorization === `Bearer ${browserToken}`,
        "ForwardAuth must receive the browser bearer token",
      );
      assert.equal(
        admitted.headers["idempotency-key"],
        "b0b0b0b0-0000-4000-8000-000000000002",
      );
      assert.equal(admitted.headers["if-match"], '"3"');
      assert.equal(admitted.body, "", "ForwardAuth must not send JSON bodies");
    },
  );

  await t.test(
    `${provider}: provider adds/removes tasks, excludes unhealthy replicas, and keeps cached routes during API outage`,
    async () => {
      const readTutor = () => request("/api/discovery/learning-areas");
      const waitUntil = async (check, label) => {
        const deadline = Date.now() + 8000;
        let last;
        while (Date.now() < deadline) {
          try {
            await check();
            return;
          } catch (error) {
            last = error;
          }
          await sleep(100);
        }
        throw new Error(
          `${label}: ${last?.message || "condition did not occur"}`,
        );
      };

      assert.equal((await readTutor()).body.instance, "tutor-1");
      gateway.setTaskCount("tutor-service", 2);
      await waitUntil(async () => {
        const seen = new Set();
        for (let index = 0; index < 12; index += 1) {
          seen.add((await readTutor()).body.instance);
        }
        assert.deepEqual(seen, new Set(["tutor-1", "tutor-2"]));
      }, "discover added Tutor task");

      ownerStates.tutor[1].healthy = false;
      await waitUntil(async () => {
        for (let index = 0; index < 5; index += 1) {
          assert.equal((await readTutor()).body.instance, "tutor-1");
        }
      }, "exclude unhealthy Tutor task");
      ownerStates.tutor[1].healthy = true;
      gateway.setTaskCount("tutor-service", 1);
      await waitUntil(async () => {
        const seen = new Set();
        for (let index = 0; index < 20; index += 1) {
          seen.add((await readTutor()).body.instance);
        }
        assert.deepEqual(seen, new Set(["tutor-1"]));
      }, "remove Tutor task");

      gateway.setDiscoveryAvailable(false);
      await sleep(350);
      assert.equal(
        (await readTutor()).status,
        200,
        "last discovered configuration must keep routing during provider outage",
      );
      gateway.setDiscoveryAvailable(true);
      await waitUntil(async () => {
        assert.equal((await readTutor()).status, 200);
      }, "recover provider discovery");
    },
  );

  await t.test(
    `${provider}: selected reads retry after an upstream disconnect`,
    async () => {
      ownerStates.tutor[0].disconnectOnce = 1;
      ownerStates.tutor[1].disconnectOnce = 1;
      const response = await request("/api/discovery/learning-areas");
      assert.equal(response.status, 200);
      assert.ok(["tutor-1", "tutor-2"].includes(response.body.instance));
    },
  );

  await t.test(`${provider}: selected reads retry a 502 response`, async () => {
    ownerStates.tutor[0].healthy = true;
    ownerStates.tutor[0].failReads = 1;
    const response = await request("/api/discovery/learning-areas");
    assert.equal(response.status, 200);
  });

  await t.test(
    `${provider}: gateway never retries a mutation after owner disconnect`,
    async () => {
      const before = observations.owners.filter(
        (entry) => entry.owner === "booking" && entry.method === "POST",
      ).length;
      ownerStates.booking[0].disconnect = true;
      try {
        await request("/api/bookings", {
          method: "POST",
          headers: { authorization: `Bearer ${browserToken}` },
          body: JSON.stringify({ synthetic: true }),
        });
      } catch {
        // The owner intentionally closes the upstream connection before a response.
      }
      ownerStates.booking[0].disconnect = false;
      const after = observations.owners.filter(
        (entry) => entry.owner === "booking" && entry.method === "POST",
      ).length;
      assert.equal(after - before, 1);
    },
  );

  await t.test(
    `${provider}: owner-operation routes are fixed and rewrite to private owner paths`,
    async () => {
      const response = await request(
        "/api/operations/booking/b0b0b0b0-0000-4000-8000-000000000002",
        {
          headers: {
            authorization: `Bearer ${browserToken}`,
            "x-request-id": requestId,
          },
        },
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.owner, "booking");
      assert.equal(
        response.body.url,
        "/internal/v1/booking/operations/b0b0b0b0-0000-4000-8000-000000000002",
      );
      assert.ok(
        response.body.headers.actorContext === actorProof,
        "operation owner must receive Auth's actor proof",
      );
      assert.equal(
        (
          await request(
            "/api/operations/unknown/b0b0b0b0-0000-4000-8000-000000000002",
          )
        ).status,
        404,
      );
    },
  );

  await t.test(
    `${provider}: exact inventory has 90 routes and unknown paths stay closed`,
    async () => {
      assert.equal(inventory.length, 90);
      assert.equal(
        new Set(inventory.map(({ method, path }) => `${method} ${path}`)).size,
        90,
      );
      const routeFile = readFileSync(
        path.join(root, "infra/gateway/routes.yaml"),
        "utf8",
      );
      assert.match(
        routeFile,
        /authResponseHeaders: \[X-Actor-Context, X-Request-Id\]/,
      );
      assert.doesNotMatch(routeFile, /PathPrefix\(`\/api`\)/);
      assert.doesNotMatch(routeFile, /\/auth\/register/);
      const routerPriority = (name) =>
        Number(
          routeFile.match(
            new RegExp(
              `    ${name}:\\n      entryPoints: \\[web\\]\\n      rule: [^\\n]+\\n      priority: (\\d+)`,
            ),
          )?.[1],
        );
      assert.ok(
        routerPriority("get-tutor-upcoming") > routerPriority("get-booking"),
        "fixed booking paths must outrank the booking ID parameter route",
      );
      for (const route of [
        "/api/rawdata",
        "/internal/gateway/authorize",
        "/health",
        "/api/discovery/no-such-route",
      ]) {
        assert.equal(
          (
            await request(route, {
              headers: { host: "tutor-matcher_auth-service" },
            })
          ).status,
          404,
          route,
        );
      }
      assert.equal((await request("/api/health")).status, 200);
      const generated = execFileSync(
        process.execPath,
        ["scripts/generate-traefik-routes.mjs", "--check"],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(generated, "");
    },
  );

  await t.test(
    `${provider}: provider-missing owners use explicit 503 fallbacks`,
    async () => {
      gateway.setTaskCount("notification-service", 0);
      const missingOwners = await request("/api/notifications", {
        headers: { authorization: `Bearer ${browserToken}` },
      });
      const missingNotificationDeadline = Date.now() + 8000;
      let notificationStatus = missingOwners.status;
      while (
        notificationStatus !== 503 &&
        Date.now() < missingNotificationDeadline
      ) {
        await sleep(100);
        notificationStatus = (
          await request("/api/notifications", {
            headers: { authorization: `Bearer ${browserToken}` },
          })
        ).status;
      }
      assert.equal(notificationStatus, 503);
      gateway.setTaskCount("tutor-service", 0);
      const missingTutorDeadline = Date.now() + 8000;
      while (Date.now() < missingTutorDeadline) {
        if ((await request("/api/discovery/learning-areas")).status === 503)
          break;
        await sleep(100);
      }
      assert.equal(
        (await request("/api/discovery/learning-areas")).status,
        503,
      );
      gateway.setTaskCount("tutor-service", 1);
      const authRecoveryDeadline = Date.now() + 8000;
      while (Date.now() < authRecoveryDeadline) {
        if ((await request("/api/discovery/learning-areas")).status === 200)
          break;
        await sleep(100);
      }
      authState.healthy = false;
      const authUnavailableDeadline = Date.now() + 8000;
      let authStatus = 200;
      while (authStatus !== 503 && Date.now() < authUnavailableDeadline) {
        await sleep(100);
        authStatus = (
          await request("/api/profiles/me/account", {
            headers: { authorization: `Bearer ${browserToken}` },
          })
        ).status;
      }
      assert.equal(authStatus, 503);
    },
  );
}

test(
  "Traefik gateway uses native Docker and Swarm discovery with exact allowlist",
  { timeout: 180000 },
  async (t) => {
    for (const provider of providers) {
      await t.test(
        `${provider} discovery integration`,
        { timeout: 85000 },
        async (providerTest) => {
          await startProviderCase(providerTest, provider);
        },
      );
    }
  },
);
