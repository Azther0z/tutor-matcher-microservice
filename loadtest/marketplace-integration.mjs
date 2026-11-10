import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Pool } = require("pg");
const { MongoClient } = require("mongodb");
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
const adminUrl = new URL(
  process.env.PG_TEST_ADMIN_URL ||
    "postgresql://ideal_test@127.0.0.1:55439/postgres",
);
assert.ok(
  ["127.0.0.1", "localhost"].includes(adminUrl.hostname),
  "Only an isolated local PostgreSQL server is permitted.",
);
const mongoUri =
  process.env.MONGO_TEST_URI ||
  "mongodb://127.0.0.1:27229/?replicaSet=ideal-rs";
assert.ok(
  ["127.0.0.1", "localhost"].includes(new URL(mongoUri).hostname),
  "Only an isolated local MongoDB server is permitted.",
);
const suffix = randomBytes(8).toString("hex");
const dbName = `ideal_marketplace_test_${suffix}`;
const adminDb = new Pool({ connectionString: adminUrl.href });
await adminDb.query(`CREATE DATABASE ${dbName}`);
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const password = randomBytes(24).toString("base64url");
Object.assign(process.env, {
  DATABASE_URL: dbUrl.href,
  AUTH_MIGRATIONS_DIR: path.join(root, "auth-service/migrations"),
  JWT_SECRET: randomBytes(48).toString("hex"),
  RESET_CONTENT_KEY: randomBytes(32).toString("base64url"),
  IDEMPOTENCY_SECRET: randomBytes(32).toString("hex"),
  ACTOR_ASSERTION_PRIVATE_KEY: privateKey,
  ACTOR_ASSERTION_PUBLIC_KEY: publicKey,
  DEMO_MODE: "true",
  AUTH_DEMO_PASSWORD: password,
});
for (const owner of [
  "GATEWAY",
  "AUTH",
  "TUTOR",
  "BOOKING",
  "REVIEW",
  "WALLET",
  "MESSAGING",
  "NOTIFICATION",
]) {
  process.env[`${owner}_WORKLOAD_CREDENTIAL`] = randomBytes(32).toString("hex");
}
const {
  validateGrpcRequest,
  validateGrpcResponse,
  validateRequest,
  PROTO_LOADER_OPTIONS,
} = require("../shared/dist/index.js");
const { createAuthApp } = require("../auth-service/dist/index.js");
const { createAuthGrpcServer } = require("../auth-service/dist/grpc.js");
const { pool: authDb } = require("../auth-service/dist/db.js");
const { seedDemoAccounts } = require("../auth-service/dist/seed.js");
const { MongoStore } = require("../tutor-service/dist/store.js");
const { TutorService } = require("../tutor-service/dist/service.js");
const { GrpcPeers } = require("../tutor-service/dist/peers.js");
const { createTutorApp } = require("../tutor-service/dist/http.js");
const { createTutorGrpcServer } = require("../tutor-service/dist/grpc.js");
const { connectStore } = require("../review-service/dist/store.js");
const { ReviewService } = require("../review-service/dist/service.js");
const { makePeerClients } = require("../review-service/dist/peers.js");
const { createReviewApp } = require("../review-service/dist/routes.js");
const { createRatingServer } = require("../review-service/dist/grpc.js");
const { startTestGateway } =
  await import("../scripts/traefik-test-runtime.mjs");

const resources = [];
let gateway, tutorPeers, reviewPeers, mongo, reviewStore;
let bookingUnavailable = false;
const eligibility = new Map();
let availabilityCalls = 0;
async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  resources.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
async function bind(server) {
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
  resources.push(() => server.forceShutdown());
  return `127.0.0.1:${port}`;
}
function proto(file) {
  const dir = path.join(root, "contracts/grpc");
  return grpc.loadPackageDefinition(
    loader.loadSync(path.join(dir, file), {
      ...PROTO_LOADER_OPTIONS,
      includeDirs: [dir],
    }),
  );
}
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith("_"))
      .map(([key, item]) => [key, strip(item)]),
  );
}
function fixture(operation, work, caller) {
  return (call, callback) => {
    try {
      assert.equal(
        call.metadata.get("authorization")[0],
        `Bearer ${process.env[`${caller}_WORKLOAD_CREDENTIAL`]}`,
      );
      validateRequest("Id", call.metadata.get("x-request-id")[0]);
      const request = strip(call.request);
      validateGrpcRequest(operation, request);
      if (bookingUnavailable)
        return callback({
          code: grpc.status.UNAVAILABLE,
          details: "Synthetic Booking outage.",
        });
      const response = work(request);
      validateGrpcResponse(operation, response);
      callback(null, response);
    } catch {
      callback({
        code: grpc.status.INVALID_ARGUMENT,
        details: "Synthetic Booking fixture rejected the request.",
      });
    }
  };
}
async function request(
  route,
  { token, method = "GET", body, revision, key = randomUUID() } = {},
) {
  const response = await fetch(`${gateway.url}/api${route}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      "X-Request-Id": randomUUID(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method !== "GET" ? { "Idempotency-Key": key } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(revision === undefined ? {} : { "If-Match": `"${revision}"` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { code: "NON_JSON" };
  }
  return { status: response.status, data, headers: response.headers };
}
function ok(result, status = 200) {
  assert.equal(
    result.status,
    status,
    `Expected HTTP ${status}, got ${result.status} (${result.data?.code || "unknown"}).`,
  );
  return result.data;
}
try {
  await seedDemoAccounts();
  const authUrl = await listen(createAuthApp());
  process.env.AUTH_GRPC_URL = await bind(createAuthGrpcServer());
  const booking = new grpc.Server();
  booking.addService(
    proto("booking/v1/availability.proto").tutor_matcher.booking.v1
      .AvailabilityService.service,
    {
      batchGetAvailability: fixture(
        "batchGetAvailability",
        (request) => {
          availabilityCalls += 1;
          return {
            results: request.queries.map((query, queryIndex) => ({
              queryIndex,
              hasAvailability: true,
              nextAvailableAt: new Date(
                Date.parse(query.from) + 3600000,
              ).toISOString(),
              freeSlotCount: 1,
            })),
            checkedAt: new Date().toISOString(),
          };
        },
        "TUTOR",
      ),
      getAvailability: fixture(
        "getAvailability",
        (request) => ({
          slots: [
            {
              id: randomUUID(),
              tutorId: request.query.tutorId,
              subjectIds: [request.query.subjectId],
              startsAt: request.query.from,
              endsAt: new Date(
                Date.parse(request.query.from) + 1800000,
              ).toISOString(),
              revision: "0",
            },
          ],
          checkedAt: new Date().toISOString(),
        }),
        "TUTOR",
      ),
    },
  );
  booking.addService(
    proto("booking/v1/collaboration.proto").tutor_matcher.booking.v1
      .BookingEvidenceService.service,
    {
      getReviewEligibility: fixture(
        "getReviewEligibility",
        (request) => {
          const item = eligibility.get(request.bookingId);
          assert.ok(item);
          return item;
        },
        "REVIEW",
      ),
    },
  );
  process.env.BOOKING_GRPC_URL = await bind(booking);
  reviewStore = await connectStore(mongoUri, `ideal_review_test_${suffix}`);
  reviewPeers = makePeerClients({
    authUrl: process.env.AUTH_GRPC_URL,
    bookingUrl: process.env.BOOKING_GRPC_URL,
    credential: process.env.REVIEW_WORKLOAD_CREDENTIAL,
  });
  const reviewService = new ReviewService(reviewStore, reviewPeers);
  process.env.REVIEW_GRPC_URL = await bind(
    createRatingServer(reviewService, process.env.TUTOR_WORKLOAD_CREDENTIAL),
  );
  process.env.REVIEW_HTTP_URL = await listen(
    createReviewApp(reviewService, {
      gatewayCredential: process.env.GATEWAY_WORKLOAD_CREDENTIAL,
      actorPublicKey: publicKey,
    }),
  );
  mongo = await new MongoClient(mongoUri).connect();
  const tutorStore = new MongoStore(
    mongo,
    mongo.db(`ideal_tutor_test_${suffix}`),
  );
  await tutorStore.migrate();
  tutorPeers = new GrpcPeers();
  const tutorService = new TutorService(tutorStore, tutorPeers);
  const tutorUrl = await listen(createTutorApp(tutorService));
  await bind(createTutorGrpcServer(tutorService));
  gateway = await startTestGateway({
    healthCheckTimeout: "1s",
    authUrl,
    workloadCredential: process.env.GATEWAY_WORKLOAD_CREDENTIAL,
    ownerUrls: { tutor: tutorUrl, review: process.env.REVIEW_HTTP_URL },
  });

  const admin = ok(
    await request("/auth/login", {
      method: "POST",
      body: { email: "admin.demo@example.test", password },
    }),
  );
  const candidate = ok(
    await request("/auth/login", {
      method: "POST",
      body: { email: "candidate.demo@example.test", password },
    }),
  );
  const student = ok(
    await request("/auth/login", {
      method: "POST",
      body: { email: "student.demo@example.test", password },
    }),
  );
  const draft = ok(
    await request("/profiles/me/tutor/drafts", {
      token: candidate.token,
      method: "POST",
      body: {
        bio: "Synthetic integration tutor",
        headline: "Integration Tutor",
        identificationDocumentUrl: "https://documents.invalid/private-id",
        introVideoUrl: "https://video.invalid/introduction",
      },
    }),
    201,
  );
  const submitted = ok(
    await request(`/profiles/me/tutor/drafts/${draft.id}/submit`, {
      token: candidate.token,
      method: "POST",
      revision: draft.revision,
      body: { consentAccepted: true },
    }),
  );
  const approval = ok(
    await request(`/admin/tutor-requests/${draft.id}/review`, {
      token: admin.token,
      method: "POST",
      revision: submitted.revision,
      body: { decision: "APPROVE" },
    }),
    202,
  );
  validateRequest("OperationRef", approval);
  const pending = ok(
    await request("/profiles/me/tutor", { token: candidate.token }),
  );
  assert.equal(pending.activation, "PENDING");
  assert.equal(
    (
      await request("/profiles/me/tutor/subjects", {
        token: candidate.token,
        method: "POST",
        body: {
          name: "Math",
          description: "Math",
          hourlyRate: "400.00",
          format: "ONLINE",
          learningAreas: ["mathematics"],
        },
      })
    ).status,
    403,
  );
  assert.equal(await tutorService.activateNext(), true);
  const activated = ok(
    await request("/profiles/me/tutor", { token: candidate.token }),
  );
  assert.equal(activated.activation, "ACTIVE");
  const operation = ok(
    await request(`/operations/tutor/${approval.id}`, { token: admin.token }),
  );
  validateRequest("Operation", operation);
  assert.equal(operation.status, "SUCCEEDED");
  const subject = ok(
    await request("/profiles/me/tutor/subjects", {
      token: candidate.token,
      method: "POST",
      body: {
        name: "Integration Mathematics",
        description: "Algebra and calculus",
        hourlyRate: "400.00",
        format: "ONLINE",
        learningAreas: ["mathematics"],
      },
    }),
    201,
  );
  const beforePublish = ok(
    await request("/profiles/me/tutor", { token: candidate.token }),
  );
  ok(
    await request("/profiles/me/tutor/publication", {
      token: candidate.token,
      method: "PATCH",
      revision: beforePublish.revision,
      body: { published: true },
    }),
  );
  const searched = ok(
    await request(
      "/discovery/tutors?q=Integration&preferredLearningAreas=mathematics",
    ),
  );
  validateRequest("SearchPage", searched);
  assert.equal(searched.items.length, 1);
  assert.equal(searched.items[0].rating.average, null);
  assert.equal(searched.items[0].rating.reviewCount, 0);
  assert.ok(availabilityCalls > 0);
  assert.equal(searched.items[0].classesTaught, null);
  const profile = ok(
    await request(`/discovery/tutors/${activated.tutorId}/profile`),
  );
  validateRequest("PublicTutor", profile);
  assert.ok(!JSON.stringify(profile).includes("identificationDocumentUrl"));
  const bookingId = randomUUID();
  eligibility.set(bookingId, {
    bookingId,
    studentUserId: student.user.id,
    tutorId: activated.tutorId,
    tutorUserId: candidate.user.id,
    subjectId: subject.id,
    completedAt: new Date().toISOString(),
    bookingRevision: "4",
    eligible: true,
  });
  const review = ok(
    await request(`/bookings/${bookingId}/review`, {
      token: student.token,
      method: "POST",
      body: { rating: 5, text: "Clear explanation", headline: "Helpful" },
    }),
    201,
  );
  validateRequest("Review", review);
  ok(
    await request(`/reviews/${review.id}/reply`, {
      token: candidate.token,
      method: "POST",
      revision: review.revision,
      body: { text: "Thank you" },
    }),
  );
  const current = ok(await request(`/reviews?tutorId=${activated.tutorId}`));
  assert.equal(current.items[0].reply.text, "Thank you");
  const flagged = ok(
    await request(`/reviews/${review.id}/flags`, {
      token: candidate.token,
      method: "POST",
      revision: current.items[0].revision,
      body: { reason: "Synthetic moderation test" },
    }),
    201,
  );
  validateRequest("ReviewFlag", flagged);
  const flags = ok(
    await request("/admin/review-flags", { token: admin.token }),
  );
  validateRequest("FlagPage", flags);
  const beforeModeration = flags.items.find(
    (item) => item.review.id === review.id,
  ).review;
  ok(
    await request(`/admin/reviews/${review.id}/moderation`, {
      token: admin.token,
      method: "POST",
      revision: beforeModeration.revision,
      body: { decision: "HIDE", reason: "Synthetic hidden-review case" },
    }),
  );
  assert.equal(
    ok(await request(`/reviews?tutorId=${activated.tutorId}`)).items.length,
    0,
  );
  const afterModeration = ok(await request("/discovery/tutors?q=Integration"));
  assert.equal(afterModeration.items[0].rating.reviewCount, 0);
  bookingUnavailable = true;
  assert.equal((await request("/discovery/tutors?q=Integration")).status, 503);
  bookingUnavailable = false;
  if (process.env.MARKETPLACE_BROWSER === "1") {
    const { runLiveSmoke } =
      await import("../web/e2e/marketplace/live-smoke.mjs");
    const result = await runLiveSmoke({
      gatewayUrl: gateway.url,
      password,
      tutorId: activated.tutorId,
      subjectId: subject.id,
      bookingId,
    });
    console.log(
      "PASS: real marketplace browser walkthrough",
      JSON.stringify(result),
    );
  }
  if (process.env.MARKETPLACE_K6 === "1") {
    const { runDiagnostic } = await import("./run-diagnostic.mjs");
    await runDiagnostic({
      gatewayUrl: gateway.url,
      token: candidate.token,
      request,
    });
  }
  console.log(
    "PASS: real Auth/PostgreSQL, Tutor/Review Mongo transactions, signed Traefik admission, approval/activation, publication/discovery, review/reply/flag/moderation, rating exclusion and dependency failure.",
  );
  console.log(
    "LIMIT: Booking and Swarm discovery use typed test fixtures; RabbitMQ delivery and hosted/replica acceptance are not established.",
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await gateway?.close();
  tutorPeers?.close();
  reviewPeers?.close?.();
  for (const close of resources.reverse()) await close();
  if (reviewStore) {
    await reviewStore.client.db(reviewStore.database).dropDatabase();
    await reviewStore.client.close();
  }
  if (mongo) {
    await mongo.db(`ideal_tutor_test_${suffix}`).dropDatabase();
    await mongo.close();
  }
  await authDb.end();
  await adminDb.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await adminDb.end();
}
