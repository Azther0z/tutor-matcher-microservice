import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const base = (process.env.BASE_URL || "http://127.0.0.1:8080").replace(
  /\/$/,
  "",
);
assert.equal(
  process.env.SYNTHETIC_LOADTEST,
  "true",
  "Set SYNTHETIC_LOADTEST=true only for an isolated synthetic environment.",
);
const admin = process.env.LOADTEST_ADMIN_TOKEN;
assert.ok(
  admin,
  "Supply the current synthetic Admin token through LOADTEST_ADMIN_TOKEN.",
);
const count = Number(process.env.TUTOR_COUNT || 20);
assert.ok(Number.isInteger(count) && count > 0 && count <= 100);
const runId = randomUUID();
const query = `IdealLoad-${runId.slice(0, 8)}`;
const items = [];

async function request(
  path,
  { token, body, method = "GET", revision, ifNoneMatch } = {},
) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      "X-Request-Id": randomUUID(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(revision === undefined ? {} : { "If-Match": `"${revision}"` }),
      ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json();
  assert.ok(
    response.ok,
    `${method} ${path} failed with HTTP ${response.status} (${data?.code || "unknown"}).`,
  );
  return { data, etag: response.headers.get("ETag") };
}

for (let index = 0; index < count; index += 1) {
  const password = randomBytes(24).toString("base64url");
  const { data: account } = await request("/auth/signup", {
    method: "POST",
    body: {
      firstName: `Synthetic${index}`,
      lastName: "LoadTutor",
      email: `${runId}-${index}@load.invalid`,
      password,
      passwordConfirmation: password,
      termsAccepted: true,
      privacyAccepted: true,
    },
  });
  const token = account.token;
  assert.ok(token, "Synthetic signup did not return a session.");
  const { data: draft } = await request("/profiles/me/tutor/drafts", {
    token,
    method: "POST",
    body: {
      bio: "Synthetic load-test tutor, not a real person.",
      headline: query,
      identificationDocumentUrl: "https://documents.invalid/synthetic-id",
      introVideoUrl: "https://video.invalid/synthetic-introduction",
    },
  });
  const { data: submitted } = await request(
    `/profiles/me/tutor/drafts/${draft.id}/submit`,
    {
      token,
      method: "POST",
      revision: draft.revision,
      body: { consentAccepted: true },
    },
  );
  await request(`/admin/tutor-requests/${submitted.id}/review`, {
    token: admin,
    method: "POST",
    revision: submitted.revision,
    body: { decision: "APPROVE" },
  });
  let workspace;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    workspace = (await request("/profiles/me/tutor", { token })).data;
    if (workspace.activation === "ACTIVE") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(
    workspace.activation,
    "ACTIVE",
    "Auth activation did not complete; no fabricated grant was used.",
  );
  const { data: subject } = await request("/profiles/me/tutor/subjects", {
    token,
    method: "POST",
    body: {
      name: `${query} Mathematics ${index}`,
      description: "Synthetic algebra and calculus offering.",
      hourlyRate: `${300 + index * 10}.00`,
      format: "ONLINE",
      learningAreas: ["mathematics"],
    },
  });
  workspace = (await request("/profiles/me/tutor", { token })).data;
  await request("/profiles/me/tutor/publication", {
    token,
    method: "PATCH",
    revision: workspace.revision,
    body: { published: true },
  });
  const date = new Date(Date.now() + 3 * 86400000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Bangkok",
  });
  await request(`/profiles/me/tutor/availability/${date}/09:00`, {
    token,
    method: "PUT",
    ifNoneMatch: "*",
    body: { state: "OPEN", subjectIds: [subject.id] },
  });
  items.push({ tutorId: workspace.tutorId, subjectId: subject.id, date });
}
const result = {
  runId,
  searchQuery: query,
  expectedResults: items.length,
  preparedAt: new Date().toISOString(),
  items,
};
if (process.env.FIXTURE_OUTPUT)
  await writeFile(
    process.env.FIXTURE_OUTPUT,
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
console.log(JSON.stringify(result, null, 2));
