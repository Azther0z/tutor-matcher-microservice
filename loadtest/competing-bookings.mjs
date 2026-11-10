import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Competing bookings: many students try to book the same half-hour slot at the
// same instant. Booking locks the slot row, so exactly one request may win.
//
//   npm run loadtest:booking-race
//
// Round 1: CONTENDERS different students, one slot, distinct Idempotency-Keys.
//          Expect exactly one 201 and no 5xx.
// Round 2: one student sends the same request REPLAYS times at once with the
//          same Idempotency-Key. Expect one booking and identical replies.
//
// Creates synthetic students (lt-<run>-<n>@example.test) with throwaway
// passwords that are never printed, and cancels the bookings it made.

const base = (process.env.BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const contenders = Number(process.env.CONTENDERS || 20);
const replays = Number(process.env.REPLAYS || 10);
const out = process.env.RESULT_FILE || "";
const run = randomBytes(3).toString("hex");

async function call(method, path, { token, body, headers = {} } = {}) {
  const started = performance.now();
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // empty body
  }
  return { status: response.status, data, ms: performance.now() - started, headers: response.headers };
}

async function student(index) {
  const password = randomBytes(12).toString("base64url") + "aA1!";
  const response = await call("POST", "/auth/signup", {
    headers: { "idempotency-key": randomUUID() },
    body: {
      firstName: "Load",
      lastName: `Student${index}`,
      email: `lt-${run}-${index}@example.test`,
      password,
      passwordConfirmation: password,
      termsAccepted: true,
      privacyAccepted: true,
    },
  });
  if (response.status !== 201) throw new Error(`signup ${index} failed with ${response.status}`);
  return response.data.token;
}

async function findTarget() {
  const list = await call("GET", "/discovery/tutors?pageSize=20");
  for (const item of list.data.items) {
    const { subject } = item;
    for (let day = 3; day < 10; day += 1) {
      const date = new Date(Date.now() + day * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);
      const detail = await call("GET", `/discovery/tutors/${subject.tutorId}/subjects/${subject.id}?date=${date}`);
      if (detail.data?.slots?.length >= 2) return { subjectId: subject.id, slots: detail.data.slots.slice(0, 2), date };
    }
  }
  throw new Error("no subject with two open slots was found");
}

const summarize = (results) => {
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  return {
    byStatus,
    fastestMs: Math.round(times[0]),
    slowestMs: Math.round(times.at(-1)),
  };
};

async function cancel(token, id) {
  const quote = await call("GET", `/bookings/${id}/cancellation-quote`, { token });
  const read = await call("GET", `/bookings/${id}`, { token });
  const done = await call("POST", `/bookings/${id}/cancel`, {
    token,
    body: { quoteId: quote.data?.quoteId, reason: "load test cleanup" },
    headers: { "idempotency-key": randomUUID(), "if-match": read.headers.get("etag") },
  });
  return done.status;
}

const target = await findTarget();
// Setup is not measured, so sign the students up a few at a time.
const tokens = [];
for (let i = 0; i < contenders; i += 4) {
  const batch = Array.from({ length: Math.min(4, contenders - i) }, (_, k) => student(i + k + 1));
  tokens.push(...(await Promise.all(batch)));
}
const payload = (slot) => ({ subjectId: target.subjectId, availabilityIds: [slot.id], description: "race" });

const raceStart = performance.now();
const race = await Promise.all(
  tokens.map((token) =>
    call("POST", "/bookings", { token, body: payload(target.slots[0]), headers: { "idempotency-key": randomUUID() } }),
  ),
);
const raceMs = Math.round(performance.now() - raceStart);
const winners = race.filter((r) => r.status === 201);

const key = randomUUID();
const replay = await Promise.all(
  Array.from({ length: replays }, () =>
    call("POST", "/bookings", { token: tokens[0], body: payload(target.slots[1]), headers: { "idempotency-key": key } }),
  ),
);
const replayIds = new Set(replay.filter((r) => r.status < 300).map((r) => r.data?.id));

const cleanup = [];
for (const [index, result] of race.entries())
  if (result.status === 201) cleanup.push(await cancel(tokens[index], result.data.id));
for (const id of replayIds) if (id) cleanup.push(await cancel(tokens[0], id));

const report = {
  measuredAt: new Date().toISOString(),
  base,
  slotDate: target.date,
  round1: {
    contenders,
    wallClockMs: raceMs,
    ...summarize(race),
    winners: winners.length,
    serverErrors: race.filter((r) => r.status >= 500).length,
    pass: winners.length === 1 && race.every((r) => r.status < 500),
  },
  round2: {
    sameKeyRequests: replays,
    ...summarize(replay),
    distinctBookings: replayIds.size,
    pass: replayIds.size === 1 && replay.every((r) => r.status < 500),
  },
  cleanupStatuses: cleanup,
};
console.log(JSON.stringify(report, null, 2));
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}
process.exit(report.round1.pass && report.round2.pass ? 0 : 1);
