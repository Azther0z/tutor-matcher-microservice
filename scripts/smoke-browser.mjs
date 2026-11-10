import assert from "node:assert/strict";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!smokeDatabaseUrl)
  throw new Error(
    "Set TEST_DATABASE_URL to the isolated saint_browser_test database.",
  );
const parsedDatabaseUrl = new URL(smokeDatabaseUrl);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.pathname !== "/saint_browser_test"
) {
  throw new Error(
    "TEST_DATABASE_URL must point to the local saint_browser_test database.",
  );
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const jwtSecret = randomBytes(48).toString("base64url");
const resetContentKey = randomBytes(32).toString("base64url");
const workloadCredential = randomBytes(32).toString("base64url");

Object.assign(process.env, {
  DATABASE_URL: smokeDatabaseUrl,
  AUTH_MIGRATIONS_DIR: path.join(root, "services/auth-service", "migrations"),
  JWT_SECRET: jwtSecret,
  RESET_CONTENT_KEY: resetContentKey,
  ACTOR_ASSERTION_PUBLIC_KEY: publicKey,
  ACTOR_ASSERTION_PRIVATE_KEY: privateKey,
  GATEWAY_PRIVATE_KEY: privateKey,
  GATEWAY_WORKLOAD_CREDENTIAL: workloadCredential,
  API_GATEWAY_URL: "http://127.0.0.1:8080",
});
delete process.env.CONSUL_URL;
delete process.env.GATEWAY_WORKLOAD_CREDENTIAL_FILE;
delete process.env.ACTOR_ASSERTION_PRIVATE_KEY_FILE;
delete process.env.GATEWAY_PRIVATE_KEY_FILE;

const { migrate, pool } = require(
  path.join(root, "services/auth-service", "dist", "db.js"),
);
const { createAuthApp } = require(
  path.join(root, "services/auth-service", "dist", "index.js"),
);
const { startTestGateway } = await import("./traefik-test-runtime.mjs");
const { chromium, expect } = require("@playwright/test");

let authServer;
let gatewayServer;
let nextProcess;
let browser;
let context;
let phase = "startup";
let failureDetail = "";
const observedRevisions = new Map();

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

function listeningPort(server) {
  const address = server.address();
  assert.ok(
    address && typeof address === "object",
    "Expected a bound local HTTP port.",
  );
  return address.port;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = listeningPort(server);
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHttp(url, child, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error("Next.js exited before becoming ready.");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      // Keep waiting while Next.js compiles and starts its local dev server.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Next.js did not become ready before the smoke timeout.");
}

async function stopServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  const timer = new Promise((resolve) => setTimeout(resolve, 5000));
  await Promise.race([stopped, timer]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function capture(page, filename, maskEmail = false) {
  await page.addStyleTag({
    content: "nextjs-portal { display: none !important; }",
  });
  const options = { path: filename, fullPage: true };
  if (maskEmail) {
    options.mask = [page.locator("#email")];
    options.maskColor = "#dce6df";
  }
  await page.screenshot(options);
}

async function run() {
  phase = "database migration";
  await migrate(pool);
  phase = "Auth and Gateway startup";
  authServer = await listen(createAuthApp());
  const authUrl = `http://127.0.0.1:${listeningPort(authServer)}`;
  process.env.AUTH_URL = authUrl;
  process.env.TUTOR_URL = "http://127.0.0.1:9";
  process.env.BOOKING_URL = "http://127.0.0.1:9";
  process.env.WALLET_URL = "http://127.0.0.1:9";
  process.env.REVIEW_URL = "http://127.0.0.1:9";
  process.env.MESSAGING_URL = "http://127.0.0.1:9";
  process.env.NOTIFICATION_URL = "http://127.0.0.1:9";
  gatewayServer = await startTestGateway({ authUrl, workloadCredential });
  const gatewayUrl = gatewayServer.url;
  process.env.API_GATEWAY_URL = gatewayUrl;

  phase = "Next.js startup";
  const webPort = await freePort();
  const webUrl = `http://127.0.0.1:${webPort}`;
  nextProcess = spawn(
    process.execPath,
    [
      path.join(root, "node_modules", "next", "dist", "bin", "next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(webPort),
    ],
    {
      cwd: path.join(root, "apps/web"),
      env: { ...process.env, API_GATEWAY_URL: gatewayUrl },
      stdio: "ignore",
    },
  );
  await waitForHttp(webUrl, nextProcess);

  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {}),
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on("response", async (response) => {
    const url = new URL(response.url());
    const endpoint = url.pathname.endsWith("/profiles/me/student")
      ? "student"
      : url.pathname.endsWith("/profiles/me/account")
        ? "account"
        : null;
    if (
      endpoint &&
      ["GET", "PUT"].includes(response.request().method()) &&
      response.ok()
    ) {
      try {
        observedRevisions.set(
          `${endpoint}:${response.request().method()}`,
          response
            .json()
            .then((dto) => ({
              revision: String(dto.revision),
              etag: response.headers().etag ?? null,
            }))
            .catch(() => null),
        );
      } catch {
        // The smoke assertions below report missing revision metadata without exposing response bodies.
      }
    }
  });
  page.on("response", async (response) => {
    if (
      response.status() < 400 ||
      !response.url().includes("/api/profiles/me/student")
    )
      return;
    try {
      const payload = await response.json();
      const paths = Array.isArray(payload.fields)
        ? payload.fields.map((field) => `${field.path}:${field.code}`).join(",")
        : "no field details";
      failureDetail = `${response.request().method()} ${response.status()} ${payload.code ?? "API_ERROR"}; ${paths}`;
    } catch {
      failureDetail = `${response.status()} student profile request failed without JSON details`;
    }
  });

  phase = "signup page navigation";
  const initialPassword = randomBytes(24).toString("base64url");
  const changedPassword = randomBytes(24).toString("base64url");
  const syntheticEmail = `smoke-${randomUUID()}@example.test`;

  await page.goto(`${webUrl}/signup`);
  phase = "signup form submission";
  await page.getByLabel("First name").fill("Integration");
  await page.getByLabel("Last name").fill("Learner");
  await page.getByLabel("Email address").fill(syntheticEmail);
  await page.getByLabel("Password", { exact: true }).fill(initialPassword);
  await page.getByLabel("Confirm password").fill(initialPassword);
  await page.getByLabel(/Terms of Service/).check();
  await page.getByLabel(/Privacy notice/).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/account$/, { timeout: 30_000 });
  phase = "account and student profile load";
  await expect(
    page.getByRole("heading", { name: "Account settings" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Learning areas (comma-separated)"),
  ).toBeVisible();
  await assertRevisionEtag(
    observedRevisions.get("account:GET"),
    "account settings",
  );
  await assertRevisionEtag(
    observedRevisions.get("student:GET"),
    "student profile",
  );

  phase = "student profile save";
  await page
    .getByLabel("Learning areas (comma-separated)")
    .fill("integration-smoke, algebra");
  await page.getByLabel("Current level").fill("Intermediate");
  await page
    .getByLabel("Learning goals")
    .fill("Practice new concepts with a tutor.");
  await page.getByLabel("Evening").check();
  await page.getByRole("button", { name: "Save learning profile" }).click();
  try {
    await expect(
      page.getByText("Your learning profile has been saved."),
    ).toBeVisible();
  } catch {
    if (!failureDetail)
      failureDetail = (await page.getByRole("alert").allTextContents())
        .join(" ")
        .slice(0, 300);
    throw new Error("Student profile save did not succeed.");
  }
  await assertRevisionEtag(
    observedRevisions.get("student:PUT"),
    "student profile update",
  );

  phase = "account screenshots";
  const evidence = path.join(root, "docs", "evidence", "saint", "visual");
  await mkdir(evidence, { recursive: true });
  await capture(page, path.join(evidence, "account-desktop.png"), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, path.join(evidence, "account-mobile.png"), true);

  phase = "password change and login verification";
  await page
    .getByLabel("Current password", { exact: true })
    .fill(initialPassword);
  await page.getByLabel("New password", { exact: true }).fill(changedPassword);
  await page.getByLabel("Confirm new password").fill(changedPassword);
  await page.getByRole("button", { name: "Update password" }).click();
  await page.waitForURL(/\/login\?notice=password-changed$/, {
    timeout: 30_000,
  });
  assert.equal(
    await page.evaluate(() =>
      Boolean(sessionStorage.getItem("tm.session.token")),
    ),
    false,
    "Password change must clear the browser session token.",
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture(page, path.join(evidence, "login-desktop.png"));
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, path.join(evidence, "login-mobile.png"));

  await page.getByLabel("Email address").fill(syntheticEmail);
  await page.getByLabel("Password").fill(initialPassword);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
  await page.getByLabel("Password").fill(changedPassword);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/account$/, { timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Account settings" }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(() =>
      Boolean(sessionStorage.getItem("tm.session.token")),
    ),
    true,
    "A successful login must establish a tab session.",
  );
  console.log(
    "Browser/Auth/Traefik/PostgreSQL smoke passed; screenshots saved under docs/evidence/saint/visual.",
  );
}

async function assertRevisionEtag(observed, label) {
  observed = await observed;
  assert.ok(observed, `Expected a revision response for ${label}.`);
  assert.equal(
    observed.etag,
    `"${observed.revision}"`,
    `${label} must return an ETag matching its DTO revision.`,
  );
}

try {
  await run();
} catch (error) {
  console.error(
    `Browser/Auth/Traefik/PostgreSQL smoke failed during ${phase}.`,
    error instanceof Error ? error.name : "Unknown error",
    failureDetail,
  );
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopProcess(nextProcess).catch(() => undefined);
  await gatewayServer?.close().catch(() => undefined);
  await stopServer(authServer).catch(() => undefined);
  try {
    await pool.end();
  } catch {
    // Ensure cleanup failures do not expose test connection details.
  }
}
