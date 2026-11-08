import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

const require = createRequire(
  new URL("../shared/package.json", import.meta.url),
);
const Ajv = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const schemas = JSON.parse(
  readFileSync(
    new URL("../contracts/schemas/v1.json", import.meta.url),
    "utf8",
  ),
);
ajv.addSchema(schemas, "shared");
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.includes("test"))
  throw new Error("TEST_DATABASE_URL must identify an isolated test database.");
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = "test";
process.env.AUTH_MIGRATIONS_DIR = fileURLToPath(
  new URL("../auth-service/migrations", import.meta.url),
);
process.env.JWT_SECRET = randomBytes(32).toString("hex");
process.env.IDEMPOTENCY_SECRET = randomBytes(32).toString("hex");
process.env.RESET_CONTENT_KEY = randomBytes(32).toString("hex");
process.env.GATEWAY_WORKLOAD_CREDENTIAL = randomBytes(32).toString("hex");
process.env.ADMIN_SIGNUP_KEY = randomBytes(32).toString("hex");
process.env.DEMO_MODE = "true";
delete process.env.CONSUL_URL;
delete process.env.RABBITMQ_URL;
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.ACTOR_ASSERTION_PUBLIC_KEY = keys.publicKey;
process.env.ACTOR_ASSERTION_PRIVATE_KEY = keys.privateKey;
const tag = randomUUID();
const learnerEmail = `learner-${tag}@example.test`;
process.env.AUTH_SYNTHETIC_EMAILS = learnerEmail;
const password = randomBytes(18).toString("base64url");
const nextPassword = randomBytes(18).toString("base64url");
let assertions = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  assertions++;
}
function validate(name, value) {
  const validator = ajv.getSchema(`shared#/$defs/${name}`);
  check(validator(value), `${name} response does not match the shared schema`);
}
const { migrate, pool } = await import("../auth-service/dist/db.js");
await migrate();
const { createAuthApp } = await import("../auth-service/dist/index.js");
const { createGatewayApp } = await import("../api-gateway/dist/index.js");
const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
let auth;
let gateway;
try {
  auth = await listen(createAuthApp());
  process.env.AUTH_URL = `http://127.0.0.1:${auth.address().port}`;
  gateway = await listen(createGatewayApp());
  const base = `http://127.0.0.1:${gateway.address().port}/api`;
  const call = async (
    path,
    { method = "GET", token, body, revision, key, status = 200, schema } = {},
  ) => {
    const headers = { "X-Request-Id": randomUUID() };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && method !== "HEAD")
      headers["Idempotency-Key"] = key ?? randomUUID();
    if (revision !== undefined) headers["If-Match"] = `"${revision}"`;
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    check(
      response.status === status,
      `${method} ${path.split("?")[0]}: expected HTTP ${status}, received ${response.status}`,
    );
    const value = response.status === 204 ? undefined : await response.json();
    if (schema) validate(schema, value);
    if (response.status >= 400) validate("Error", value);
    return { response, value };
  };
  const signup = (email, admin = false) =>
    call("/auth/signup", {
      method: "POST",
      body: {
        firstName: "Synthetic",
        lastName: "Learner",
        email,
        password,
        passwordConfirmation: password,
        termsAccepted: true,
        privacyAccepted: true,
        ...(admin ? { adminSignupKey: process.env.ADMIN_SIGNUP_KEY } : {}),
      },
      status: 201,
      schema: "AuthSession",
    });
  const admin = (await signup(`admin-${tag}@example.test`, true)).value;
  const learner = (await signup(learnerEmail)).value;
  check(
    learner.user.capabilities.join(",") === "STUDENT",
    "Ordinary signup must not grant elevated access",
  );
  const otherSession = (
    await call("/auth/login", {
      method: "POST",
      body: { email: learnerEmail, password },
      schema: "AuthSession",
    })
  ).value;
  await call("/auth/login", {
    method: "POST",
    body: { email: learnerEmail, password: "incorrect synthetic password" },
    status: 401,
  });
  const renamed = (
    await call("/profiles/me/account", {
      method: "PUT",
      token: learner.token,
      revision: learner.user.revision,
      body: { firstName: "Updated" },
      schema: "Account",
    })
  ).value;
  await call("/auth/me", { token: otherSession.token, schema: "Account" });
  const profile = (
    await call("/profiles/me/student", {
      token: learner.token,
      schema: "StudentProfile",
    })
  ).value;
  const profileKey = randomUUID();
  const profileBody = {
    learningAreas: ["mathematics"],
    level: "Beginner",
    goals: "Synthetic learning goal",
    preferredPeriods: ["EVENING"],
  };
  const profileWrite = await call("/profiles/me/student", {
    method: "PUT",
    token: learner.token,
    revision: profile.revision,
    key: profileKey,
    body: profileBody,
    schema: "StudentProfile",
  });
  const replay = await call("/profiles/me/student", {
    method: "PUT",
    token: learner.token,
    revision: profile.revision,
    key: profileKey,
    body: profileBody,
    schema: "StudentProfile",
  });
  check(
    isDeepStrictEqual(profileWrite.value, replay.value),
    "A successful retry changed the student profile twice",
  );
  await call(`/operations/auth/${profileKey}`, {
    token: learner.token,
    schema: "Operation",
  });
  await call("/profiles/me/student", {
    method: "PUT",
    token: learner.token,
    revision: profile.revision,
    key: profileKey,
    body: { ...profileBody, goals: "Changed immutable retry input" },
    status: 409,
  });
  await call("/profiles/me/account", {
    method: "PUT",
    token: learner.token,
    revision: renamed.revision,
    body: { currentPassword: password, newPassword: nextPassword },
    schema: "Account",
  });
  await call("/auth/me", { token: learner.token, status: 401 });
  await call("/auth/me", { token: otherSession.token, status: 401 });
  let fresh = (
    await call("/auth/login", {
      method: "POST",
      body: { email: learnerEmail, password: nextPassword },
      schema: "AuthSession",
    })
  ).value;
  const restrict = (action, revision) =>
    call(`/admin/users/${fresh.user.id}/restrictions`, {
      method: "POST",
      token: admin.token,
      revision,
      body: { action, reason: "Synthetic lifecycle verification" },
      schema: "AccountDetail",
    });
  const suspended = (await restrict("SUSPEND", fresh.user.revision)).value;
  await call("/auth/login", {
    method: "POST",
    body: { email: learnerEmail, password: nextPassword },
    status: 403,
  });
  await restrict("RESTORE", suspended.revision);
  await call("/auth/me", { token: fresh.token, status: 401 });
  fresh = (
    await call("/auth/login", {
      method: "POST",
      body: { email: learnerEmail, password: nextPassword },
      schema: "AuthSession",
    })
  ).value;
  const deactivated = (
    await call("/profiles/me/account", {
      method: "PUT",
      token: fresh.token,
      revision: fresh.user.revision,
      body: { currentPassword: nextPassword, deactivate: true },
      schema: "Account",
    })
  ).value;
  check(
    deactivated.status === "DEACTIVATED",
    "Deactivation did not change account status",
  );
  await restrict("RESTORE", deactivated.revision);
  await call("/auth/me", { token: fresh.token, status: 401 });
  fresh = (
    await call("/auth/login", {
      method: "POST",
      body: { email: learnerEmail, password: nextPassword },
      schema: "AuthSession",
    })
  ).value;
  await call("/auth/password-reset/request", {
    method: "POST",
    body: { email: learnerEmail },
    status: 202,
  });
  const pending = await pool.query(
    "SELECT payload FROM events_outbox WHERE event_type='auth.password-reset-requested' AND payload->'targets'->'userIds' @> $1::jsonb ORDER BY created_at DESC LIMIT 1",
    [JSON.stringify([fresh.user.id])],
  );
  check(
    pending.rowCount === 1,
    "Broker outage lost password-reset outbox work",
  );
  const contentRef = pending.rows[0].payload.data.contentRef;
  const content = await call(`/demo/password-resets/${contentRef}`, {
    token: admin.token,
    schema: "NotificationContent",
  });
  check(
    content.response.headers.get("cache-control") === "no-store",
    "Reset demo content must not be cached",
  );
  const link = content.value.text.match(/https?:\/\/\S+/)?.[0];
  const resetToken = new URLSearchParams(new URL(link).hash.slice(1)).get(
    "token",
  );
  check(
    Boolean(resetToken),
    "Reset link must carry its token in the URL fragment",
  );
  check(
    !JSON.stringify(pending.rows[0].payload).includes(resetToken),
    "Reset token leaked into event payload",
  );
  await call("/auth/password-reset/validate", {
    method: "POST",
    body: { token: resetToken },
    schema: "ResetValidation",
  });
  await call("/auth/password-reset/confirm", {
    method: "POST",
    body: { token: resetToken, password, passwordConfirmation: password },
    status: 204,
  });
  await call("/auth/me", { token: fresh.token, status: 401 });
  await call("/auth/password-reset/validate", {
    method: "POST",
    body: { token: resetToken },
    status: 400,
  });
  fresh = (
    await call("/auth/login", {
      method: "POST",
      body: { email: learnerEmail, password },
      schema: "AuthSession",
    })
  ).value;
  const banned = (await restrict("BAN", fresh.user.revision)).value;
  await call(`/admin/users/${fresh.user.id}/restrictions`, {
    method: "POST",
    token: admin.token,
    revision: banned.revision,
    body: { action: "RESTORE", reason: "Synthetic invalid transition" },
    status: 409,
  });
  const direct = await fetch(`${process.env.AUTH_URL}/auth/me`, {
    headers: { "x-user-id": fresh.user.id },
  });
  check(
    direct.status === 401,
    "Direct forged identity bypassed owner authorization",
  );
  console.log(
    `PASS: integrated real Auth + Gateway + PostgreSQL identity flow (${assertions} status/schema/invariant checks).`,
  );
  console.log(
    "Broker delivery, peers, browser UI and hosted deployment are separate evidence.",
  );
} finally {
  for (const server of [gateway, auth])
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  await pool.end();
}
