import http from "k6/http";
import { check, fail } from "k6";
import { Counter } from "k6/metrics";
import { randomBytes } from "k6/crypto";

// Competing bookings as a k6 test.
//
//   k6 run loadtest/competing-bookings.js
//
// setup(): signs up CONTENDERS synthetic students (four at a time) and picks
//          two open consecutive slots for one subject.
// race:    every student sends one booking for the SAME slot at the same
//          moment, each with its own Idempotency-Key. Exactly one may win.
// replay:  one student sends the same request REPLAYS times with the SAME
//          Idempotency-Key for the other slot. Only one booking may exist.
// teardown(): counts duplicate bookings and cancels what the test created.

const base = (__ENV.BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const contenders = Number(__ENV.CONTENDERS || 20);
const replays = Number(__ENV.REPLAYS || 10);

const won = new Counter("booking_won");
const lost = new Counter("booking_lost");
const serverErrors = new Counter("booking_server_errors");
const duplicates = new Counter("booking_duplicates");

export const options = {
  setupTimeout: "180s",
  scenarios: {
    race: {
      executor: "per-vu-iterations",
      vus: contenders,
      iterations: 1,
      maxDuration: "30s",
      exec: "race",
    },
    replay: {
      executor: "per-vu-iterations",
      vus: replays,
      iterations: 1,
      maxDuration: "30s",
      startTime: "10s",
      exec: "replay",
    },
  },
  thresholds: {
    booking_won: ["count==1"],
    booking_lost: [`count==${contenders - 1}`],
    booking_server_errors: ["count==0"],
    booking_duplicates: ["count==0"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "max"],
};

function uuid() {
  const h = randomBytes(16);
  const b = new Uint8Array(h);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const json = (token, key, extra = {}) => ({
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(key ? { "Idempotency-Key": key } : {}),
    ...extra,
  },
});

function signupRequest(run, index) {
  const password = `${uuid()}aA1!`;
  return [
    "POST",
    `${base}/api/auth/signup`,
    JSON.stringify({
      firstName: "Load",
      lastName: `Student${index}`,
      email: `lt-${run}-${index}@example.test`,
      password,
      passwordConfirmation: password,
      termsAccepted: true,
      privacyAccepted: true,
    }),
    { ...json(null, uuid()), tags: { phase: "setup" } },
  ];
}

function findTarget() {
  const list = http.get(`${base}/api/discovery/tutors?pageSize=20`).json();
  for (const item of list.items) {
    const subject = item.subject;
    for (let day = 3; day < 10; day += 1) {
      const date = new Date(Date.now() + day * 86400000 + 7 * 3600000).toISOString().slice(0, 10);
      const detail = http
        .get(`${base}/api/discovery/tutors/${subject.tutorId}/subjects/${subject.id}?date=${date}`)
        .json();
      if (detail.slots && detail.slots.length >= 2)
        return { subjectId: subject.id, slots: detail.slots.slice(0, 2).map((s) => s.id), date };
    }
  }
  return null;
}

export function setup() {
  const run = uuid().slice(0, 6);
  const target = findTarget();
  if (!target) fail("No subject with two open slots was found. Seed the demo catalogue first.");
  const tokens = [];
  for (let i = 0; i < contenders; i += 4) {
    const batch = [];
    for (let k = i; k < Math.min(i + 4, contenders); k += 1) batch.push(signupRequest(run, k + 1));
    for (const response of http.batch(batch)) {
      if (response.status !== 201) fail(`signup failed with ${response.status}`);
      tokens.push(response.json().token);
    }
  }
  return { target, tokens, replayKey: uuid() };
}

const bookingBody = (target, slot) =>
  JSON.stringify({ subjectId: target.subjectId, availabilityIds: [slot], description: "race" });

export function race(data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const response = http.post(`${base}/api/bookings`, bookingBody(data.target, data.target.slots[0]), {
    ...json(token, uuid()),
    tags: { operation: "bookSameSlot" },
  });
  if (response.status === 201) won.add(1);
  else if (response.status === 409) lost.add(1);
  else if (response.status >= 500) serverErrors.add(1);
  check(response, { "no server error": (r) => r.status < 500 });
}

export function replay(data) {
  const response = http.post(`${base}/api/bookings`, bookingBody(data.target, data.target.slots[1]), {
    ...json(data.tokens[0], data.replayKey),
    tags: { operation: "replaySameKey" },
  });
  if (response.status >= 500) serverErrors.add(1);
  check(response, { "replay answered without error": (r) => r.status < 300 });
}

export function teardown(data) {
  // Student 0 sent both the race and the replay request: at most one booking per slot.
  const mine = http.get(`${base}/api/bookings?view=STUDENT&pageSize=50`, json(data.tokens[0])).json();
  const onReplaySlot = ((mine && mine.items) || []).filter(
    (b) => JSON.stringify(b).includes(data.target.slots[1]) && b.status !== "CANCELLED",
  );
  if (onReplaySlot.length > 1) duplicates.add(onReplaySlot.length - 1);
  for (const token of data.tokens) {
    const listed = http.get(`${base}/api/bookings?view=STUDENT&pageSize=50`, json(token)).json();
    for (const b of (listed && listed.items) || []) {
      if (b.status === "CANCELLED") continue;
      const quote = http.get(`${base}/api/bookings/${b.id}/cancellation-quote`, json(token));
      const read = http.get(`${base}/api/bookings/${b.id}`, json(token));
      http.post(
        `${base}/api/bookings/${b.id}/cancel`,
        JSON.stringify({ quoteId: quote.json().quoteId, reason: "load test cleanup" }),
        json(token, uuid(), { "If-Match": read.headers.Etag }),
      );
    }
  }
}
