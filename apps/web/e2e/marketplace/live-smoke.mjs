/* global fetch, AbortSignal */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { chromium, expect } from "@playwright/test";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repoRoot = path.resolve(webRoot, "../..");

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function login(page, origin, email, password, destination) {
  await page.goto(
    `${origin}/login?returnTo=${encodeURIComponent(destination)}`,
  );
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(`${origin}${destination}`, { timeout: 15000 });
}

async function stopProcess(child, exited) {
  if (!child?.pid || exited()) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 20 && !exited(); attempt++) await delay(100);
  if (!exited()) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already stopped. */
    }
  }
}

export async function runLiveSmoke({
  gatewayUrl,
  password,
  tutorId,
  subjectId,
  bookingId,
}) {
  const target = new URL(gatewayUrl);
  assert.ok(
    ["127.0.0.1", "localhost"].includes(target.hostname),
    "The browser smoke requires an isolated local gateway.",
  );
  assert.equal(typeof password, "string");
  assert.ok(password.length >= 8);
  for (const id of [tutorId, subjectId, bookingId])
    assert.match(id, /^[0-9a-f-]{36}$/i);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let childExited = false;
  let browser;
  let stage = "starting the local web server";
  const checks = [];
  try {
    child = spawn(
      process.execPath,
      [
        path.join(repoRoot, "node_modules/next/dist/bin/next"),
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: webRoot,
        env: {
          ...process.env,
          API_GATEWAY_URL: gatewayUrl,
          NEXT_TELEMETRY_DISABLED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", () => {
      childExited = true;
    });
    child.once("exit", () => {
      childExited = true;
    });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (childExited) throw new Error("Web server exited before readiness.");
      try {
        ready = (
          await fetch(`${origin}/login`, { signal: AbortSignal.timeout(2000) })
        ).ok;
      } catch {
        /* Wait for startup. */
      }
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, "The local web server did not become ready.");
    const configuredChrome =
      process.env.CHROME_BIN ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/google-chrome");
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(configuredChrome)
        ? { executablePath: configuredChrome }
        : {}),
    });
    const candidate = await browser.newContext();
    const admin = await browser.newContext();
    const visitor = await browser.newContext();
    const page = await candidate.newPage();
    const adminPage = await admin.newPage();
    const publicPage = await visitor.newPage();
    page.setDefaultTimeout(15000);
    adminPage.setDefaultTimeout(15000);
    publicPage.setDefaultTimeout(15000);

    stage = "candidate login and approved profile";
    await login(
      page,
      origin,
      "candidate.demo@example.test",
      password,
      "/teach/profile",
    );
    await expect(
      page.getByRole("heading", {
        name: "Profile and publication",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Unpublish listing", exact: true }),
    ).toBeVisible();
    const approved = page.locator("section.panel").filter({
      has: page.getByRole("heading", {
        name: "Current approved content",
        exact: true,
      }),
    });
    await expect(approved).toContainText("Integration Tutor");
    checks.push("real candidate login and approved/published profile");

    stage = "owned subject creation and editing";
    await page.goto(`${origin}/teach/subjects`);
    await expect(
      page.getByRole("heading", {
        name: "Edit Integration Mathematics",
        exact: true,
      }),
    ).toBeVisible();
    const newSubject = page.locator("section.panel").filter({
      has: page.getByRole("heading", {
        name: "Create a subject",
        exact: true,
      }),
    });
    await newSubject
      .getByLabel("Subject name", { exact: true })
      .fill("Browser Practice");
    await newSubject
      .getByLabel("Description", { exact: true })
      .fill("Synthetic browser-created teaching offering.");
    await newSubject
      .getByLabel("Hourly rate (THB)", { exact: true })
      .fill("450.00");
    await newSubject.getByLabel("Mathematics", { exact: true }).check();
    await newSubject
      .getByRole("button", { name: "Create subject", exact: true })
      .click();
    const editSubject = page.locator("section.panel").filter({
      has: page.getByRole("heading", {
        name: "Edit Browser Practice",
        exact: true,
      }),
    });
    await expect(editSubject).toBeVisible();
    await editSubject
      .getByLabel("Description", { exact: true })
      .fill("Updated through the real browser and Tutor API.");
    const savedSubject = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/api/profiles/me/tutor/subjects/"),
    );
    await editSubject
      .getByRole("button", { name: "Save subject", exact: true })
      .click();
    assert.equal((await savedSubject).status(), 200);
    await expect(
      editSubject.getByLabel("Description", { exact: true }),
    ).toHaveValue("Updated through the real browser and Tutor API.");
    checks.push("real owned subject create and revision-protected edit");

    stage = "profile revision submission";
    await page.goto(`${origin}/teach/profile`);
    await page
      .getByRole("button", { name: "Create profile revision", exact: true })
      .click();
    const newRevision = page.locator("section.panel").filter({
      has: page.getByRole("heading", {
        name: "New profile revision",
        exact: true,
      }),
    });
    await newRevision
      .getByLabel("Headline", { exact: true })
      .fill("Browser revision awaiting review");
    await newRevision
      .getByLabel("Bio", { exact: true })
      .fill("This pending revision must not replace approved public content.");
    await newRevision
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    const editor = page.locator("section.panel").filter({
      has: page.getByRole("heading", { name: "Edit draft", exact: true }),
    });
    await expect(editor).toBeVisible();
    await editor.getByRole("checkbox").check();
    const submittedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/profiles\/me\/tutor\/drafts\/[^/]+\/submit$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await editor
      .getByRole("button", { name: "Submit saved draft", exact: true })
      .click();
    const submitted = await submittedResponse;
    assert.equal(submitted.status(), 200);
    const pendingRevision = await submitted.json();
    assert.equal(pendingRevision.kind, "REVISION");
    assert.equal(pendingRevision.state, "PENDING");
    await expect(
      page.getByRole("button", { name: "Withdraw submission", exact: true }),
    ).toBeVisible();
    await publicPage.goto(`${origin}/tutors/${tutorId}`);
    await expect(
      publicPage.getByRole("heading", {
        name: "Integration Tutor",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      publicPage.getByText("Browser revision awaiting review", { exact: true }),
    ).toHaveCount(0);
    checks.push(
      "revision submission preserves approved public content while pending",
    );

    stage = "admin rejection and applicant history";
    await login(
      adminPage,
      origin,
      "admin.demo@example.test",
      password,
      `/admin/tutor-requests/${pendingRevision.id}`,
    );
    await expect(
      adminPage.getByRole("link", {
        name: "Open private identification document",
        exact: true,
      }),
    ).toBeVisible();
    await adminPage.getByLabel("Decision", { exact: true }).click();
    await adminPage.getByRole("option", { name: "Reject", exact: true }).click();
    await adminPage
      .getByLabel("Reason (required for rejection)", { exact: true })
      .fill("Synthetic revision rejected during the browser smoke.");
    await adminPage
      .getByRole("button", { name: "Save review decision", exact: true })
      .click();
    await expect(
      adminPage.getByText(
        "Synthetic revision rejected during the browser smoke.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.goto(`${origin}/teach/profile`);
    await expect(
      page.getByText(
        "Review reason: Synthetic revision rejected during the browser smoke.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.locator("section.panel").filter({
        has: page.getByRole("heading", {
          name: "Current approved content",
          exact: true,
        }),
      }),
    ).toContainText("Integration Tutor");
    await publicPage.reload();
    await expect(
      publicPage.getByRole("heading", {
        name: "Integration Tutor",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      publicPage.getByText("Browser revision awaiting review", { exact: true }),
    ).toHaveCount(0);
    checks.push(
      "real admin private-document review, rejection and immutable applicant history",
    );

    stage = "public discovery and Bangkok slot selection";
    await publicPage.goto(`${origin}/discover?q=Integration&sort=PRICE_ASC`);
    await publicPage
      .getByRole("link", { name: "View subject and availability", exact: true })
      .click();
    await expect(publicPage).toHaveURL(
      `${origin}/tutors/${tutorId}/subjects/${subjectId}`,
    );
    const futureDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(Date.now() + 2 * 86400000));
    const futureAvailability = publicPage.waitForResponse(
      (response) =>
        response
          .url()
          .includes(`/api/discovery/tutors/${tutorId}/subjects/${subjectId}`) &&
        new URL(response.url()).searchParams.get("date") === futureDate,
    );
    await publicPage
      .getByLabel("Lesson date (Bangkok)", { exact: true })
      .fill(futureDate);
    assert.equal((await futureAvailability).status(), 200);
    await publicPage.getByRole("checkbox").first().check();
    const continueLink = publicPage.getByRole("link", {
      name: "Sign in and continue",
      exact: true,
    });
    const loginDestination = new URL(
      await continueLink.getAttribute("href"),
      origin,
    );
    const bookingDestination = new URL(
      loginDestination.searchParams.get("returnTo"),
      origin,
    );
    assert.equal(bookingDestination.pathname, "/bookings/new");
    assert.equal(bookingDestination.searchParams.get("subjectId"), subjectId);
    assert.equal(bookingDestination.searchParams.get("tutorId"), tutorId);
    assert.match(
      bookingDestination.searchParams.get("slotIds"),
      /^[0-9a-f-]{36}$/i,
    );
    checks.push(
      "real public discovery/profile/subject composition and preserved selected-slot login destination",
    );

    stage = "private moderation details and hidden public review";
    await adminPage.goto(`${origin}/admin/review-flags`);
    const flaggedReview = adminPage
      .locator("article.panel")
      .filter({ hasText: "Synthetic moderation test" });
    await expect(flaggedReview).toBeVisible();
    await expect(flaggedReview).toContainText("Reported by Demo Candidate");
    await expect(flaggedReview).toContainText("Clear explanation");
    await expect(flaggedReview).toContainText("Thank you");
    await expect(flaggedReview).toContainText("HIDDEN");
    await expect(flaggedReview).toContainText(bookingId);
    await publicPage.goto(
      `${origin}/reviews?tutorId=${tutorId}&subjectId=${subjectId}`,
    );
    await expect(
      publicPage.getByText("No reviews yet.", { exact: true }),
    ).toBeVisible();
    await expect(
      publicPage.getByText("Clear explanation", { exact: true }),
    ).toHaveCount(0);
    checks.push(
      "real private moderation projection and whole hidden review absent publicly",
    );
    return {
      passed: checks.length,
      checks,
      limitations: [
        "Booking availability and Swarm discovery are typed fixtures; no Santa booking page, real Booking database, RabbitMQ delivery or hosted acceptance is established.",
      ],
    };
  } catch {
    throw new Error(
      `Live marketplace browser smoke failed while ${stage}. Credentials and browser diagnostics are omitted.`,
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      await stopProcess(child, () => childExited);
    }
  }
}
