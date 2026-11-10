import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import {
  AppError,
  signActorAssertion,
  validateRequest,
} from "@tutor-matcher/shared";
import { connectStore, type MongoReviewStore } from "./store";
import { ReviewService } from "./service";
import {
  PeerFixture,
  syntheticEligibility,
  syntheticIds,
  startPeerFixture,
} from "./fixtures";
import { makePeerClients, loadProto, grpcOptions } from "./peers";
import { createRatingServer, listenRatingServer } from "./grpc";
import { createReviewApp } from "./routes";
import { publishOnce } from "./events";
import type { CommandContext, Review } from "./types";

const uri = process.env.REVIEW_TEST_MONGO_URI;
const database = `review_test_${randomUUID().replace(/-/g, "")}`;
let store: MongoReviewStore;
const fixture = new PeerFixture();
let service: ReviewService;
let at = new Date("2026-11-10T03:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
function context(
  userId = syntheticIds.student,
  capabilities = ["STUDENT"],
  operation = "createReview",
): CommandContext {
  const requestId = randomUUID();
  return {
    key: randomUUID(),
    requestId,
    actor: {
      iss: "api-gateway",
      aud: "tutor-matcher-internal",
      sub: userId,
      userId,
      sessionId: randomUUID(),
      admissionId: randomUUID(),
      admittedAt: at.toISOString(),
      requestId,
      publicOperation: operation,
      capabilities,
      accountRevision: "0",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
  };
}
async function create(rating = 5, userId = syntheticIds.student) {
  const evidence = syntheticEligibility();
  evidence.studentUserId = userId;
  fixture.bookings.set(evidence.bookingId, evidence);
  return service.create(context(userId), evidence.bookingId, {
    rating,
    text: "Clear lesson explanation.",
  });
}
before(async () => {
  if (uri) {
    store = await connectStore(uri, database);
    service = new ReviewService(store, fixture, () => at);
  }
});
after(async () => {
  if (store) {
    await store.client.db(database).dropDatabase();
    await store.client.close();
  }
});
const integration = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !uri }, fn);
function code(expected: string) {
  return (error: unknown) =>
    error instanceof AppError && error.code === expected;
}

test("review input rejects blank text, fractional rating and client-owned identities", () => {
  assert.throws(
    () => validateRequest("ReviewCreate", { rating: 3.5, text: "good" }),
    code("VALIDATION_FAILED"),
  );
  assert.throws(
    () =>
      validateRequest("ReviewCreate", {
        rating: 5,
        text: "good",
        studentUserId: syntheticIds.reporter,
      }),
    code("VALIDATION_FAILED"),
  );
});
integration(
  "only the captured student can review an eligible completed booking",
  async () => {
    const evidence = syntheticEligibility();
    fixture.bookings.set(evidence.bookingId, evidence);
    await assert.rejects(
      service.create(context(syntheticIds.reporter), evidence.bookingId, {
        rating: 5,
        text: "hello",
      }),
      code("NOT_FOUND"),
    );
    evidence.eligible = false;
    await assert.rejects(
      service.create(context(), evidence.bookingId, {
        rating: 5,
        text: "hello",
      }),
      code("REVIEW_NOT_ELIGIBLE"),
    );
    evidence.eligible = true;
    evidence.completedAt = null;
    await assert.rejects(
      service.create(context(), evidence.bookingId, {
        rating: 5,
        text: "hello",
      }),
      code("REVIEW_NOT_ELIGIBLE"),
    );
    assert.equal(await store.getReviewByBooking(evidence.bookingId), null);
  },
);
integration(
  "Booking outage does not create review work or invent completion",
  async () => {
    const evidence = syntheticEligibility();
    fixture.bookings.set(evidence.bookingId, evidence);
    fixture.unavailable = true;
    try {
      await assert.rejects(
        service.create(context(), evidence.bookingId, {
          rating: 5,
          text: "hello",
        }),
        code("DEPENDENCY_UNAVAILABLE"),
      );
    } finally {
      fixture.unavailable = false;
    }
    assert.equal(await store.getReviewByBooking(evidence.bookingId), null);
  },
);
integration(
  "one review per booking is enforced for concurrent distinct operations",
  async () => {
    const evidence = syntheticEligibility();
    fixture.bookings.set(evidence.bookingId, evidence);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        service.create(context(), evidence.bookingId, {
          rating: 4,
          text: "Clear explanation.",
        }),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      await store.client
        .db(database)
        .collection("reviews")
        .countDocuments({ bookingId: evidence.bookingId }),
      1,
    );
  },
);
integration(
  "replay survives unavailable peers and rejects changed input",
  async () => {
    const evidence = syntheticEligibility();
    fixture.bookings.set(evidence.bookingId, evidence);
    const command = context();
    const original = await service.create(command, evidence.bookingId, {
      rating: 4,
      text: "Clear explanation.",
    });
    fixture.unavailable = true;
    try {
      assert.deepEqual(
        await service.create(command, evidence.bookingId, {
          text: "Clear explanation.",
          rating: 4,
        }),
        original,
      );
    } finally {
      fixture.unavailable = false;
    }
    await assert.rejects(
      service.create(command, evidence.bookingId, {
        rating: 5,
        text: "Clear explanation.",
      }),
      code("IDEMPOTENCY_CONFLICT"),
    );
    const otherActor = {
      ...command,
      actor: context(syntheticIds.reporter).actor,
    };
    await assert.rejects(
      service.create(otherActor, evidence.bookingId, {
        rating: 4,
        text: "Clear explanation.",
      }),
      code("IDEMPOTENCY_CONFLICT"),
    );
  },
);
integration(
  "one assigned tutor reply, required revision and authorized stale replay",
  async () => {
    const review = await create();
    const command = context(
      syntheticIds.tutorUser,
      ["STUDENT", "TUTOR"],
      "replyToReview",
    );
    await assert.rejects(
      service.reply(
        { ...command, actor: context(syntheticIds.reporter, ["TUTOR"]).actor },
        review.id,
        { text: "Thanks." },
      ),
      code("NOT_FOUND"),
    );
    await assert.rejects(
      service.reply(command, review.id, { text: "Thanks." }),
      code("PRECONDITION_REQUIRED"),
    );
    command.expectedRevision = "0";
    const result = await service.reply(command, review.id, { text: "Thanks." });
    assert.equal(result.reply?.text, "Thanks.");
    assert.deepEqual(
      await service.reply(command, review.id, { text: "Thanks." }),
      result,
    );
    const second = {
      ...context(syntheticIds.tutorUser, ["TUTOR"], "replyToReview"),
      expectedRevision: result.revision,
    };
    await assert.rejects(
      service.reply(second, review.id, { text: "Another reply." }),
      code("REPLY_EXISTS"),
    );
  },
);
integration(
  "flags are unique per reporter and private queue contains complete review and reporter",
  async () => {
    const review = await create();
    const command = context(syntheticIds.reporter, ["STUDENT"], "flagReview");
    const flag = await service.flag(command, review.id, {
      reason: "Please check this content.",
    });
    assert.deepEqual(
      await service.flag(command, review.id, {
        reason: "Please check this content.",
      }),
      flag,
    );
    await assert.rejects(
      service.flag(context(syntheticIds.reporter), review.id, {
        reason: "Duplicate report.",
      }),
      code("FLAG_EXISTS"),
    );
    const queue = await service.flags(
      context(syntheticIds.admin, ["ADMIN"]),
      1,
      100,
    );
    const item = queue.items.find((item) => item.flag.id === flag.id)!;
    assert.equal(item.review.id, review.id);
    assert.equal(
      item.reporterDisplayName,
      fixture.records.get(syntheticIds.reporter)?.displayName,
    );
    validateRequest("FlagPage", queue);
    await assert.rejects(service.flags(context(), 1, 20), code("FORBIDDEN"));
  },
);
integration(
  "hiding a review removes its entire projection, reply and rating in one decision",
  async () => {
    const review = await create(1);
    const tutor = context(syntheticIds.tutorUser, ["TUTOR"]);
    tutor.expectedRevision = "0";
    await service.reply(tutor, review.id, { text: "Private after hide." });
    await service.flag(context(syntheticIds.reporter), review.id, {
      reason: "Please check.",
    });
    const current = (await store.getReview(review.id))!;
    const before = (await service.ratings([syntheticIds.subject])).items[0];
    const admin = context(syntheticIds.admin, ["ADMIN"]);
    admin.expectedRevision = current.revision;
    const hidden = await service.moderate(admin, review.id, {
      decision: "HIDE",
      reason: "Contains inappropriate content.",
    });
    assert.equal(hidden.visibility, "HIDDEN");
    const list = await service.list(review.tutorId, review.subjectId, 1, 100);
    assert.equal(
      list.items.some((item) => item.id === review.id),
      false,
    );
    const after = (await service.ratings([review.subjectId])).items[0];
    assert.equal(after.reviewCount, before.reviewCount - 1);
    assert.equal(after.distribution["1"], before.distribution["1"] - 1);
    assert.equal((await store.flags(review.id))[0].state, "RESOLVED");
    assert.equal(
      await store.client
        .db(database)
        .collection("audit")
        .countDocuments({ reviewId: review.id }),
      1,
    );
    const events = await store.client
      .db(database)
      .collection("outbox")
      .find({
        "event.type": "review.moderated",
        "event.data.reviewId": review.id,
      })
      .toArray();
    assert.equal(events.length, 1);
    assert.deepEqual(
      events[0].event.targets.userIds,
      [syntheticIds.student, syntheticIds.reporter].sort(),
    );
    await service.moderate(admin, review.id, {
      decision: "HIDE",
      reason: "Contains inappropriate content.",
    });
    assert.equal(
      await store.client
        .db(database)
        .collection("audit")
        .countDocuments({ reviewId: review.id }),
      1,
    );
  },
);
integration(
  "moderation revision races commit only one decision and keep/remove preserve audit",
  async () => {
    const review = await create();
    const commands = Array.from({ length: 2 }, () => ({
      ...context(syntheticIds.admin, ["ADMIN"]),
      expectedRevision: "0",
    }));
    const outcomes = await Promise.allSettled(
      commands.map((command) =>
        service.moderate(command, review.id, {
          decision: "KEEP",
          reason: "No violation found.",
        }),
      ),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    const remove = {
      ...context(syntheticIds.admin, ["ADMIN"]),
      expectedRevision: "1",
    };
    assert.equal(
      (
        await service.moderate(remove, review.id, {
          decision: "REMOVE",
          reason: "New evidence received.",
        })
      ).visibility,
      "REMOVED",
    );
    assert.equal(
      await store.client
        .db(database)
        .collection("audit")
        .countDocuments({ reviewId: review.id }),
      2,
    );
  },
);
integration(
  "genuine empty summaries preserve null average and all five buckets",
  async () => {
    const result = await service.ratings([randomUUID()]);
    validateRequest("RatingBatch", result);
    assert.deepEqual(result.items[0], {
      subjectId: result.items[0].subjectId,
      average: null,
      reviewCount: 0,
      distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    });
  },
);
integration(
  "business transaction rolls back if durable notification work cannot be saved",
  async () => {
    const review = await create();
    const original = store.addOutbox;
    const faulty = Object.create(store) as MongoReviewStore;
    faulty.transaction = (work) =>
      store.transaction((tx) => {
        const wrapped = Object.create(tx) as MongoReviewStore;
        wrapped.addOutbox = async () => {
          throw new Error("injected outbox write fault");
        };
        return work(wrapped);
      });
    const broken = new ReviewService(faulty, fixture);
    await assert.rejects(
      broken.flag(context(syntheticIds.reporter), review.id, {
        reason: "Atomic check.",
      }),
    );
    assert.equal((await store.flags(review.id)).length, 0);
    assert.equal((await store.getReview(review.id))?.revision, "0");
    store.addOutbox = original;
  },
);
integration(
  "broker outage and lost confirmation retain the original event identity across retry",
  async () => {
    const review = await create();
    await service.flag(context(syntheticIds.reporter), review.id, {
      reason: "Recovery check.",
    });
    const rows = store.client.db(database).collection("outbox");
    await rows.updateMany(
      { sentAt: null },
      { $set: { nextAttemptAt: new Date("2099-01-01") } },
    );
    const row = await rows.findOne({ "event.data.reviewId": review.id });
    assert.ok(row);
    await rows.updateOne(
      { _id: row._id },
      { $set: { nextAttemptAt: new Date(0) } },
    );
    const observed: string[] = [];
    const publisher = {
      publish: async (event: { eventId: string }) => {
        observed.push(event.eventId);
        if (observed.length === 1) throw new Error("broker unavailable");
      },
    };
    assert.equal(await publishOnce(store, publisher, () => at), true);
    const failed = await rows.findOne({ _id: row._id });
    assert.equal(failed?.sentAt, null);
    at = new Date(at.getTime() + 6000);
    await publishOnce(store, publisher, () => at);
    assert.deepEqual(observed, [row.id, row.id]);
    assert.ok((await rows.findOne({ _id: row._id }))?.sentAt);
  },
);
integration(
  "an expired outbox lease cannot let an old publisher overwrite the new fence",
  async () => {
    const review = await create();
    await service.flag(context(syntheticIds.reporter), review.id, {
      reason: "Fence check.",
    });
    const rows = store.client.db(database).collection("outbox");
    await rows.updateMany(
      { sentAt: null },
      { $set: { nextAttemptAt: new Date("2099-01-01") } },
    );
    const row = await rows.findOne({ "event.data.reviewId": review.id });
    assert.ok(row);
    await rows.updateOne(
      { _id: row._id },
      { $set: { nextAttemptAt: new Date(0) } },
    );
    const first = await store.claimOutbox(at, 1000);
    assert.ok(first);
    const later = new Date(at.getTime() + 2000);
    const second = await store.claimOutbox(later, 1000);
    assert.ok(second);
    assert.ok(second.fence > first.fence);
    assert.equal(
      await store.completeOutbox(first.id, first.fence, later),
      false,
    );
    assert.equal(
      await store.completeOutbox(second.id, second.fence, later),
      true,
    );
  },
);
integration(
  "typed real gRPC Booking/Auth clients validate responses and workload identity",
  async () => {
    const evidence = syntheticEligibility();
    fixture.bookings.set(evidence.bookingId, evidence);
    const server = await startPeerFixture(fixture, "fixture-review-credential");
    const clients = makePeerClients({
      ...server,
      credential: "fixture-review-credential",
    });
    const bad = makePeerClients({ ...server, credential: "wrong-credential" });
    try {
      assert.deepEqual(
        await clients.reviewEligibility(evidence.bookingId),
        evidence,
      );
      assert.equal(
        (await clients.accounts([syntheticIds.student]))[0].id,
        syntheticIds.student,
      );
      await assert.rejects(
        bad.reviewEligibility(evidence.bookingId),
        (error) => error instanceof AppError && error.status === 401,
      );
      evidence.completedAt = null;
      evidence.eligible = false;
      assert.equal(
        (await clients.reviewEligibility(evidence.bookingId)).eligible,
        false,
      );
    } finally {
      clients.close?.();
      bad.close?.();
      server.close();
    }
  },
);
integration(
  "rating gRPC wire preserves absent-null averages and rejects unauthorized or omitted inputs",
  async () => {
    const server = createRatingServer(service, "fixture-tutor-credential");
    const port = await listenRatingServer(server, "127.0.0.1:0");
    const definition = loadProto("review/v1/ratings.proto");
    const client = new definition.tutor_matcher.review.v1.ReviewRatingService(
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
      grpcOptions,
    );
    const call = (request: unknown, credential: string) =>
      new Promise<any>((resolve, reject) => {
        const meta = new grpc.Metadata();
        meta.set("authorization", `Bearer ${credential}`);
        meta.set("x-request-id", randomUUID());
        client.getRatingSummaries(
          request,
          meta,
          { deadline: new Date(Date.now() + 2000) },
          (error: unknown, value: unknown) =>
            error ? reject(error) : resolve(value),
        );
      });
    try {
      const result = await call(
        { subjectIds: [randomUUID()] },
        "fixture-tutor-credential",
      );
      assert.equal(result.items[0].average, undefined);
      assert.equal(result.items[0].reviewCount, "0");
      await assert.rejects(
        call({ subjectIds: [randomUUID()] }, "wrong-credential"),
        (error: any) => error.code === grpc.status.UNAUTHENTICATED,
      );
      await assert.rejects(
        call({}, "fixture-tutor-credential"),
        (error: any) => error.code === grpc.status.INVALID_ARGUMENT,
      );
    } finally {
      client.close();
      server.forceShutdown();
    }
  },
);
integration(
  "stripped Gateway paths enforce signed HTTP admission, ownership and query constraints",
  async () => {
    const app = createReviewApp(service, {
      gatewayCredential: "fixture-gateway-credential",
      actorPublicKey: publicKey,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const evidence = syntheticEligibility();
      fixture.bookings.set(evidence.bookingId, evidence);
      const command = context();
      const {
        iss: _iss,
        aud: _aud,
        sub: _sub,
        exp: _exp,
        ...claims
      } = command.actor;
      const assertion = signActorAssertion(claims, privateKey);
      const headers = {
        "Content-Type": "application/json",
        Authorization: "Bearer fixture-gateway-credential",
        "X-Actor-Context": assertion,
        "Idempotency-Key": command.key,
      };
      const url = `${base}/bookings/${evidence.bookingId}/review`;
      assert.equal(
        (
          await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-User-Id": syntheticIds.student,
            },
            body: JSON.stringify({ rating: 5, text: "Test." }),
          })
        ).status,
        401,
      );
      const result = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ rating: 5, text: "Test." }),
      });
      assert.equal(result.status, 201);
      const review = (await result.json()) as Review;
      validateRequest("Review", review);
      assert.equal(result.headers.get("etag"), '"0"');
      assert.equal(
        (await fetch(`${base}/reviews?tutorId=${review.tutorId}&page=1&page=2`))
          .status,
        400,
      );
      assert.equal(
        (await fetch(`${base}/reviews?tutorId=${review.tutorId}&private=true`))
          .status,
        400,
      );
      const wrong = await fetch(
        `${base}/admin/reviews/${review.id}/moderation`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ decision: "HIDE", reason: "Test." }),
        },
      );
      assert.equal(wrong.status, 403);
      assert.equal(
        (await fetch(`${base}/internal/v1/review/operations/${command.key}`))
          .status,
        401,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
integration(
  "exhausted publication is inspectable and waits for explicit operator retry",
  async () => {
    const review = await create();
    await service.flag(context(syntheticIds.reporter), review.id, {
      reason: "Exhaustion check.",
    });
    const rows = store.client.db(database).collection("outbox");
    await rows.updateMany(
      { sentAt: null },
      { $set: { nextAttemptAt: new Date("2099-01-01") } },
    );
    const row = await rows.findOne({ "event.data.reviewId": review.id });
    assert.ok(row);
    await rows.updateOne(
      { _id: row._id },
      { $set: { nextAttemptAt: new Date(0), attempts: 9 } },
    );
    await publishOnce(
      store,
      {
        publish: async () => {
          throw new Error("Unavailable.");
        },
      },
      () => at,
    );
    const failed = await rows.findOne({ _id: row._id });
    assert.equal(failed?.attempts, 10);
    assert.equal(failed?.needsAttentionAt, at.toISOString());
    assert.equal(failed?.event.eventId, row.id);
    assert.equal(
      await store.claimOutbox(new Date(at.getTime() + 120000), 1000),
      null,
    );
  },
);

integration(
  "concurrent retries under one operation identity return the same committed review",
  async () => {
    const evidence = syntheticEligibility();
    fixture.bookings.set(evidence.bookingId, evidence);
    const command = context();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.create(command, evidence.bookingId, {
          rating: 4,
          text: "Same command.",
        }),
      ),
    );
    assert.equal(new Set(results.map((review) => review.id)).size, 1);
    assert.equal(
      await store.client
        .db(database)
        .collection("operations")
        .countDocuments({ id: command.key }),
      1,
    );
  },
);

integration(
  "moderation chunks every author and reporter into stable bounded recipient events",
  async () => {
    const review = await create();
    const reporterIds = Array.from({ length: 102 }, () => randomUUID());
    await store.transaction(async (tx) => {
      for (const reporterUserId of reporterIds)
        await tx.insertFlag({
          id: randomUUID(),
          reviewId: review.id,
          reporterUserId,
          reason: "Synthetic report fixture.",
          state: "OPEN",
          revision: "0",
          createdAt: at.toISOString(),
        });
    });
    const admin = {
      ...context(syntheticIds.admin, ["ADMIN"]),
      expectedRevision: "0",
    };
    await service.moderate(admin, review.id, {
      decision: "REMOVE",
      reason: "Moderation fixture.",
    });
    const collection = store.client.db(database).collection("outbox");
    const rows = await collection
      .find({
        "event.type": "review.moderated",
        "event.data.reviewId": review.id,
      })
      .toArray();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.event.targets.userIds.length <= 100));
    const recipients = rows.flatMap(
      (row) => row.event.targets.userIds as string[],
    );
    assert.equal(new Set(recipients).size, 103);
    assert.deepEqual(
      [...recipients].sort(),
      [syntheticIds.student, ...reporterIds].sort(),
    );
    await service.moderate(admin, review.id, {
      decision: "REMOVE",
      reason: "Moderation fixture.",
    });
    assert.equal(
      await collection.countDocuments({
        "event.type": "review.moderated",
        "event.data.reviewId": review.id,
      }),
      2,
    );
  },
);
