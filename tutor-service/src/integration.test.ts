import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { MongoClient } from "mongodb";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import path from "node:path";
import {
  signActorAssertion,
  PROTO_LOADER_OPTIONS,
} from "@tutor-matcher/shared";
import { MongoStore, retryExhaustedWork } from "./store";
import { MemoryStore } from "./memory-store";
import { TutorService } from "./service";
import { FixturePeers, fixtureActor, fixtureContext } from "./fixtures";
import { createTutorApp } from "./http";
import { createTutorGrpcServer } from "./grpc";
import type { Submission } from "./types";
const full = {
  bio: "Real storage test",
  identificationDocumentUrl: "https://example.test/private",
  introVideoUrl: "https://example.test/video",
};

test(
  "Mongo transactions serialize submissions and retain approval/outbox across a new process store",
  { skip: !process.env.TUTOR_TEST_MONGO_URI },
  async () => {
    const client = new MongoClient(process.env.TUTOR_TEST_MONGO_URI!);
    await client.connect();
    const db = client.db(
        `ideal_tutor_test_${randomUUID().replaceAll("-", "")}`,
      ),
      store = new MongoStore(client, db);
    await store.migrate();
    try {
      const peers = new FixturePeers(),
        service = new TutorService(store, peers),
        student = fixtureActor(),
        admin = fixtureActor(undefined, ["STUDENT", "ADMIN"]);
      const a = (
        await service.createDraft(
          fixtureContext(student, "createTutorDraft"),
          full,
        )
      ).body as Submission;
      const b = (
        await service.createDraft(
          fixtureContext(student, "createTutorDraft"),
          full,
        )
      ).body as Submission;
      const outcomes = await Promise.allSettled(
        [a, b].map((item) =>
          service.submit(
            fixtureContext(student, "submitTutorDraft", "0"),
            item.id,
            { consentAccepted: true },
          ),
        ),
      );
      assert.equal(
        outcomes.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const pending = (await service.getWorkspace(student.userId))
        .submissions[0];
      const approved = await service.review(
        fixtureContext(admin, "reviewTutorSubmission", pending.revision),
        pending.id,
        { decision: "APPROVE" },
      );
      assert.equal(approved.status, 202);
      peers.authDown = true;
      await service.activateNext();
      const grant = await db.collection("grants").findOne({});
      assert.equal(grant!.state, "PENDING");
      const originalId = grant!.operationId;
      await db
        .collection("grants")
        .updateOne({ _id: grant!._id }, { $set: { availableAt: 0 } });
      peers.authDown = false;
      const recovered = new TutorService(new MongoStore(client, db), peers);
      await recovered.activateNext();
      assert.equal(
        (await recovered.getWorkspace(student.userId)).activation,
        "ACTIVE",
      );
      assert.equal(peers.grantCalls.at(-1), originalId);
      assert.equal(
        await db
          .collection("outbox")
          .countDocuments({ "event.type": "tutor.submission-submitted" }),
        1,
      );
      assert.equal(
        await db
          .collection("outbox")
          .countDocuments({ "event.type": "tutor.activated" }),
        1,
      );
      const events = await db.collection("outbox").find().toArray();
      assert.equal(events.length, 3);
      assert(events.every((event) => event.state === "PENDING"));
      const event = events[0];
      await db
        .collection("outbox")
        .updateOne({ _id: event._id }, { $set: { attempts: 10, fence: 1 } });
      await store.finishOutbox(String(event._id), 1, "BROKER_UNAVAILABLE");
      const exhausted = await db
        .collection("outbox")
        .findOne({ _id: event._id });
      assert.equal(exhausted!.state, "NEEDS_ATTENTION");
      assert.equal(
        await retryExhaustedWork(db, "outbox", String(event._id)),
        true,
      );
      const requeued = await db
        .collection("outbox")
        .findOne({ _id: event._id });
      assert.equal(requeued!.state, "PENDING");
      assert.deepEqual(requeued!.event, event.event);
      assert.equal(requeued!.attemptLimit, 20);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "HTTP owner rejects forged admission and serves exact DTOs on stripped gateway paths",
  { skip: process.env.TUTOR_SOCKET_TESTS !== "1" },
  async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const previous = {
      key: process.env.ACTOR_ASSERTION_PUBLIC_KEY,
      credential: process.env.GATEWAY_WORKLOAD_CREDENTIAL,
    };
    process.env.ACTOR_ASSERTION_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    process.env.GATEWAY_WORKLOAD_CREDENTIAL = "synthetic-gateway-workload";
    const service = new TutorService(new MemoryStore(), new FixturePeers()),
      app = createTutorApp(service),
      server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const send = (
      operation: string,
      url: string,
      method = "GET",
      body?: unknown,
      capabilities = ["STUDENT"],
    ) => {
      const claims = fixtureActor(undefined, capabilities);
      claims.publicOperation = operation;
      const assertion = signActorAssertion(
        claims,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      );
      return fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: {
          authorization: "Bearer synthetic-gateway-workload",
          "x-actor-context": assertion,
          "x-request-id": claims.requestId,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };
    try {
      const forged = await fetch(`http://127.0.0.1:${port}/profiles/me/tutor`, {
        headers: { "x-user-id": randomUUID(), "x-actor-context": "forged" },
      });
      assert.equal(forged.status, 401);
      const workspace = await send("getTutorWorkspace", "/profiles/me/tutor");
      assert.equal(workspace.status, 200);
      assert.equal((await workspace.json()).activation, "NONE");
      const wrongAction = await send("createTutorDraft", "/profiles/me/tutor");
      assert.equal(wrongAction.status, 403);
      const application = await send(
        "createTutorDraft",
        "/profiles/me/tutor/drafts",
        "POST",
        {},
      );
      assert.equal(application.status, 201);
      assert.equal((await application.json()).state, "DRAFT");
      const admin = await send("listTutorRequests", "/admin/tutor-requests");
      assert.equal(admin.status, 403);
      const badSubject = await send(
        "createSubject",
        "/profiles/me/tutor/subjects",
        "POST",
        {
          name: "Injected",
          format: "ONLINE",
          hourlyRate: "0.00",
          learningAreas: ["mathematics"],
          description: "Invalid",
        },
        ["STUDENT", "TUTOR"],
      );
      assert.equal(badSubject.status, 422);
      const duplicate = await fetch(
        `http://127.0.0.1:${port}/discovery/tutors?page=1&page=2`,
      );
      assert.equal(duplicate.status, 400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous.key === undefined)
        delete process.env.ACTOR_ASSERTION_PUBLIC_KEY;
      else process.env.ACTOR_ASSERTION_PUBLIC_KEY = previous.key;
      if (previous.credential === undefined)
        delete process.env.GATEWAY_WORKLOAD_CREDENTIAL;
      else process.env.GATEWAY_WORKLOAD_CREDENTIAL = previous.credential;
    }
  },
);

test(
  "Tutor gRPC enforces workload allowlist, required scalar presence and preserves explicit false",
  { skip: process.env.TUTOR_SOCKET_TESTS !== "1" },
  async () => {
    process.env.BOOKING_WORKLOAD_CREDENTIAL = "synthetic-booking-workload";
    process.env.REVIEW_WORKLOAD_CREDENTIAL = "synthetic-review-workload";
    const server = createTutorGrpcServer(
      new TutorService(new MemoryStore(), new FixturePeers()),
    );
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : resolve(port)),
      ),
    );
    const root = path.resolve(__dirname, "../../contracts/grpc");
    const definition = loader.loadSync(
      path.join(root, "tutor/v1/catalogue.proto"),
      { ...PROTO_LOADER_OPTIONS, includeDirs: [root] },
    );
    const loaded = grpc.loadPackageDefinition(definition) as unknown as {
      tutor_matcher: {
        tutor: { v1: { TutorCatalogueService: grpc.ServiceClientConstructor } };
      };
    };
    const client = new loaded.tutor_matcher.tutor.v1.TutorCatalogueService(
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
    ) as unknown as grpc.Client & {
      getTutorEligibility(
        request: unknown,
        metadata: grpc.Metadata,
        options: grpc.CallOptions,
        callback: (
          error: Error | null,
          response: Record<string, unknown>,
        ) => void,
      ): void;
    };
    const call = (request: unknown, token = "synthetic-booking-workload") =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const metadata = new grpc.Metadata();
        metadata.set("authorization", `Bearer ${token}`);
        metadata.set("x-request-id", randomUUID());
        client.getTutorEligibility(
          request,
          metadata,
          { deadline: Date.now() + 2000 },
          (error: Error | null, response: Record<string, unknown>) =>
            error ? reject(error) : resolve(response),
        );
      });
    try {
      await assert.rejects(
        call({ userId: randomUUID() }, "synthetic-review-workload"),
        (error: unknown) =>
          (error as grpc.ServiceError).code === grpc.status.PERMISSION_DENIED,
      );
      await assert.rejects(
        call({}),
        (error: unknown) =>
          (error as grpc.ServiceError).code === grpc.status.INVALID_ARGUMENT &&
          Buffer.isBuffer(
            (error as grpc.ServiceError).metadata.get("tutor-error-bin")[0],
          ),
      );
      const response = await call({ userId: randomUUID() });
      assert.equal(response.approved, false);
      assert.equal(response.activated, false);
      assert.equal(response.published, false);
      assert.equal(response.revision, "0");
    } finally {
      client.close();
      server.forceShutdown();
      delete process.env.BOOKING_WORKLOAD_CREDENTIAL;
      delete process.env.REVIEW_WORKLOAD_CREDENTIAL;
    }
  },
);
