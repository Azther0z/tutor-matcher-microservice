import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import jwt from "jsonwebtoken";
import { verifyActorAssertion } from "@tutor-matcher/shared";
import { createGatewayApp, PUBLIC_ROUTE_COUNT, type GatewayConfig } from "../src/index.js";

const jwtSecret = "local-test-jwt-secret";
const workloadCredential = "local-test-gateway-workload";
const userId = "8eac4f52-9255-44c6-bb5a-8238bc1b8092";
const sessionId = "912325b1-e5de-47bb-9f0b-377202fb8c91";

interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body;
}

function respond(response: ServerResponse, value: FakeResponse): void {
  response.statusCode = value.status ?? 200;
  for (const [name, content] of Object.entries(value.headers ?? {})) response.setHeader(name, content);
  if (value.body !== undefined) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value.body));
  } else response.end();
}

function makeAuthServer(
  introspectionResponse: FakeResponse = { body: { active: true, userId, sessionId, capabilities: ["STUDENT", "TUTOR", "ADMIN"], accountRevision: "1" } },
  received: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }> = [],
): Server {
  return createServer(async (request, response) => {
    const body = await readBody(request);
    received.push({ path: request.url ?? "/", headers: request.headers, body });
    if (request.url === "/internal/v1/auth/introspections") {
      respond(response, introspectionResponse);
      return;
    }
    respond(response, {
      body: { owner: "auth", path: request.url },
      headers: { etag: '"rev-1"' },
    });
  });
}

function makeServiceServer(owner: string, calls: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }>): Server {
  return createServer(async (request, response) => {
    const body = await readBody(request);
    calls.push({ path: request.url ?? "/", headers: request.headers, body });
    respond(response, { body: { owner, path: request.url }, headers: { etag: '"service-revision"' } });
  });
}

function config(authUrl: string, tutorUrl: string, publicKey: string, privateKey: string, extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    jwtSecret,
    gatewayPrivateKey: privateKey,
    workloadCredential,
    authUrl,
    serviceUrls: {
      auth: authUrl,
      tutor: tutorUrl,
      booking: tutorUrl,
      wallet: tutorUrl,
      review: tutorUrl,
      messaging: tutorUrl,
      notification: tutorUrl,
      gateway: "http://127.0.0.1:0",
    },
    fetcher: fetch,
    consulCacheMs: 1000,
    staleCacheMs: 10000,
    requestTimeoutMs: 2000,
    ...extra,
  };
}

async function makeGateway(testConfig: GatewayConfig): Promise<{ url: string; server: Server }> {
  const server = createGatewayApp(testConfig).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, server };
}

function userToken(): string {
  return jwt.sign({ sub: userId, sessionId }, jwtSecret, { algorithm: "HS256", expiresIn: "10m" });
}

test("registers exactly 86 explicit public routes and denies internal paths", async (t) => {
  assert.equal(PUBLIC_ROUTE_COUNT, 86);
  const authServer = makeAuthServer();
  const serviceCalls: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const tutorServer = makeServiceServer("tutor", serviceCalls);
  const authUrl = await listen(authServer);
  const tutorUrl = await listen(tutorServer);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const gateway = await makeGateway(config(authUrl, tutorUrl, publicKey, privateKey));
  t.after(async () => { await close(gateway.server); await close(authServer); await close(tutorServer); });

  const health = await fetch(`${gateway.url}/api/health`);
  assert.equal(health.status, 200);
  const consulHealth = await fetch(`${gateway.url}/health`);
  assert.equal(consulHealth.status, 200);
  const internal = await fetch(`${gateway.url}/internal/v1/auth/introspections`, { method: "POST" });
  assert.equal(internal.status, 404);
  const unknown = await fetch(`${gateway.url}/api/not-a-route`);
  assert.equal(unknown.status, 404);
});

test("strips forged identity and forwards fresh signed actor, workload and request metadata", async (t) => {
  const authCalls: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const authServer = makeAuthServer(undefined, authCalls);
  const authUrl = await listen(authServer);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const gateway = await makeGateway(config(authUrl, authUrl, publicKey, privateKey));
  t.after(async () => { await close(gateway.server); await close(authServer); });

  const response = await fetch(`${gateway.url}/api/profiles/me/account`, {
    headers: {
      authorization: `Bearer ${userToken()}`,
      "x-user-id": "forged-user",
      "x-user-email": "attacker@example.invalid",
      "x-actor-context": "forged-actor",
      "x-request-id": "761489cb-01b9-49dd-a44b-66e1096a0643",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"rev-1"');
  const publicCall = authCalls.find((call) => call.path === "/profiles/me/account");
  assert.ok(publicCall);
  assert.equal(publicCall.headers.authorization, `Bearer ${workloadCredential}`);
  assert.equal(publicCall.headers["x-user-id"], undefined);
  assert.equal(publicCall.headers["x-user-email"], undefined);
  assert.notEqual(publicCall.headers["x-actor-context"], "forged-actor");
  assert.equal(publicCall.headers["x-request-id"], "761489cb-01b9-49dd-a44b-66e1096a0643");
  const actor = verifyActorAssertion(String(publicCall.headers["x-actor-context"]), publicKey);
  assert.equal(actor.userId, userId);
  assert.equal(actor.sessionId, sessionId);
  assert.equal(actor.publicOperation, "getAccountSettings");
  const introspection = authCalls.find((call) => call.path === "/internal/v1/auth/introspections");
  assert.ok(introspection);
  assert.equal(introspection.headers.authorization, `Bearer ${workloadCredential}`);
  assert.equal(JSON.parse(introspection.body).token, userToken());
});

test("rejects revoked sessions and fails closed when Auth is unavailable", async (t) => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const revokedServer = makeAuthServer({ status: 401, body: { code: "SESSION_REVOKED" } });
  const revokedUrl = await listen(revokedServer);
  const revokedGateway = await makeGateway(config(revokedUrl, revokedUrl, publicKey, privateKey));
  t.after(async () => { await close(revokedGateway.server); await close(revokedServer); });
  const revoked = await fetch(`${revokedGateway.url}/api/profiles/me/account`, { headers: { authorization: `Bearer ${userToken()}` } });
  assert.equal(revoked.status, 401);

  const unavailableServer = makeAuthServer({ status: 503, body: { code: "DOWN" } });
  const unavailableUrl = await listen(unavailableServer);
  const unavailableGateway = await makeGateway(config(unavailableUrl, unavailableUrl, publicKey, privateKey));
  t.after(async () => { await close(unavailableGateway.server); await close(unavailableServer); });
  const unavailable = await fetch(`${unavailableGateway.url}/api/profiles/me/account`, { headers: { authorization: `Bearer ${userToken()}` } });
  assert.equal(unavailable.status, 503);
});

test("validates request IDs, unknown query keys and strict request bodies", async (t) => {
  const authServer = makeAuthServer();
  const authUrl = await listen(authServer);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const gateway = await makeGateway(config(authUrl, authUrl, publicKey, privateKey));
  t.after(async () => { await close(gateway.server); await close(authServer); });

  const badRequestId = await fetch(`${gateway.url}/api/health`, { headers: { "x-request-id": "bad" } });
  assert.equal(badRequestId.status, 400);
  const unknownQuery = await fetch(`${gateway.url}/api/discovery/learning-areas?unexpected=1`);
  assert.equal(unknownQuery.status, 400);
  const duplicateQuery = await fetch(`${gateway.url}/api/discovery/learning-areas?page=1&page=2`);
  assert.equal(duplicateQuery.status, 400);
  const invalidDate = await fetch(`${gateway.url}/api/profiles/me/tutor/availability/calendar?from=bad`, { headers: { authorization: `Bearer ${userToken()}` } });
  assert.equal(invalidDate.status, 422);
  const invalidDateBody = await invalidDate.json() as { fields: Array<{ path: string }> };
  assert.ok(invalidDateBody.fields.some(({ path }) => path === "/query/from"));
  const invalidPathDate = await fetch(`${gateway.url}/api/profiles/me/tutor/availability/not-a-date/09:00`, {
    method: "PUT",
    headers: { "if-none-match": "*", "idempotency-key": "761489cb-01b9-49dd-a44b-66e1096a0643" },
  });
  assert.equal(invalidPathDate.status, 422);
  const invalidPathBody = await invalidPathDate.json() as { fields: Array<{ path: string }> };
  assert.ok(invalidPathBody.fields.some(({ path }) => path === "/path/date"));

  const missingPrecondition = await fetch(`${gateway.url}/api/profiles/me/tutor/availability/2026-11-08/09:00`, {
    method: "PUT",
    headers: { "idempotency-key": "761489cb-01b9-49dd-a44b-66e1096a0643" },
  });
  assert.equal(missingPrecondition.status, 428);
  const nonJsonBody = await fetch(`${gateway.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not json",
  });
  assert.equal(nonJsonBody.status, 400);
  const nonJsonBodyError = await nonJsonBody.json() as { code: string };
  assert.equal(nonJsonBodyError.code, "UNSUPPORTED_MEDIA_TYPE");

  const unknownBodyKey = await fetch(`${gateway.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "student@example.invalid", password: "synthetic-password", userId: "forged" }),
  });
  assert.equal(unknownBodyKey.status, 422);
});

test("routes status reads through the fixed owner path with actor and workload", async (t) => {
  const authCalls: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const authServer = makeAuthServer(undefined, authCalls);
  const authUrl = await listen(authServer);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const gateway = await makeGateway(config(authUrl, authUrl, publicKey, privateKey));
  t.after(async () => { await close(gateway.server); await close(authServer); });

  const operationId = "92c69395-1899-427b-bbaf-12f987bd3b22";
  const response = await fetch(`${gateway.url}/api/operations/auth/${operationId}`, { headers: { authorization: `Bearer ${userToken()}` } });
  assert.equal(response.status, 200);
  const statusCall = authCalls.find((call) => call.path === `/internal/v1/auth/operations/${operationId}`);
  assert.ok(statusCall);
  assert.equal(statusCall.headers.authorization, `Bearer ${workloadCredential}`);
  assert.ok(statusCall.headers["x-actor-context"]);
  const invalidOwner = await fetch(`${gateway.url}/api/operations/constructor/${operationId}`, { headers: { authorization: `Bearer ${userToken()}` } });
  assert.equal(invalidOwner.status, 422);
});

test("allows declared ADMIN views only when the current account has ADMIN", async (t) => {
  const authCalls: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const authServer = makeAuthServer(undefined, authCalls);
  const serviceCalls: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const serviceServer = makeServiceServer("messaging", serviceCalls);
  const authUrl = await listen(authServer);
  const serviceUrl = await listen(serviceServer);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const gateway = await makeGateway(config(authUrl, serviceUrl, publicKey, privateKey));
  t.after(async () => { await close(gateway.server); await close(authServer); await close(serviceServer); });

  const allowed = await fetch(`${gateway.url}/api/messages/inbox?view=ADMIN`, { headers: { authorization: `Bearer ${userToken()}` } });
  assert.equal(allowed.status, 200);
  const actorToken = String(serviceCalls[0]?.headers["x-actor-context"]);
  assert.equal(verifyActorAssertion(actorToken, publicKey).view, "ADMIN");

  const studentOnly = makeAuthServer({ body: { active: true, userId, sessionId, capabilities: ["STUDENT"], accountRevision: "1" } });
  const studentOnlyUrl = await listen(studentOnly);
  const restrictedGateway = await makeGateway(config(studentOnlyUrl, serviceUrl, publicKey, privateKey));
  t.after(async () => { await close(restrictedGateway.server); await close(studentOnly); });
  const denied = await fetch(`${restrictedGateway.url}/api/messages/inbox?view=ADMIN`, { headers: { authorization: `Bearer ${userToken()}` } });
  assert.equal(denied.status, 403);
  const deniedTutorView = await fetch(`${restrictedGateway.url}/api/bookings?view=TUTOR`, { headers: { authorization: `Bearer ${userToken()}` } });
  assert.equal(deniedTutorView.status, 403);
  assert.equal(serviceCalls.length, 1);
});

test("uses fixed fallback during Consul outage and retries one failed GET replica", async (t) => {
  const authServer = makeAuthServer();
  const authUrl = await listen(authServer);
  const calls: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const tutorServer = makeServiceServer("tutor", calls);
  const tutorUrl = await listen(tutorServer);
  const consulDown = createServer((_request, response) => { response.statusCode = 503; response.end(); });
  const consulDownUrl = await listen(consulDown);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const fallbackGateway = await makeGateway(config(authUrl, tutorUrl, publicKey, privateKey, { consulUrl: consulDownUrl }));
  t.after(async () => {
    await close(fallbackGateway.server); await close(authServer); await close(tutorServer); await close(consulDown);
  });
  const fallback = await fetch(`${fallbackGateway.url}/api/discovery/learning-areas`);
  assert.equal(fallback.status, 200);
  assert.equal(calls.length, 1);

  const healthyConsul = createServer((_request, response) => {
    respond(response, { body: [
      { Service: { Address: "127.0.0.1", Port: 1 } },
      { Service: { Address: "127.0.0.1", Port: Number(new URL(tutorUrl).port) } },
    ] });
  });
  const healthyConsulUrl = await listen(healthyConsul);
  const retryGateway = await makeGateway(config(authUrl, tutorUrl, publicKey, privateKey, { consulUrl: healthyConsulUrl }));
  t.after(async () => { await close(retryGateway.server); await close(healthyConsul); });
  const retried = await fetch(`${retryGateway.url}/api/discovery/learning-areas`);
  assert.equal(retried.status, 200);
  assert.equal(calls.length, 2);
});
