import test from "node:test";
import assert from "node:assert/strict";
import { AppError, validateRequest } from "@tutor-matcher/shared";
import { TutorService } from "./service";
import { retryDelay, failedWork } from "./store";
import { MemoryStore } from "./memory-store";
import { fixtureActor, fixtureContext, FixturePeers } from "./fixtures";
import { publishNext } from "./outbox";
import type { Submission, Subject } from "./types";
const complete = {
  bio: "I teach mathematics.",
  identificationDocumentUrl: "https://example.test/private-document",
  introVideoUrl: "https://example.test/intro",
  headline: "Maths teacher",
};
const subjectBody = {
  name: "Maths",
  description: "Algebra lessons",
  hourlyRate: "400.00",
  format: "ONLINE" as const,
  learningAreas: ["mathematics"],
};
function harness() {
  let instant = Date.now();
  const store = new MemoryStore(),
    peers = new FixturePeers(),
    service = new TutorService(store, peers, () => new Date(instant));
  return {
    store,
    peers,
    service,
    student: fixtureActor(),
    admin: fixtureActor(undefined, ["STUDENT", "ADMIN"]),
    advance: () => {
      instant = Date.now() + 5000;
    },
  };
}
async function approve(h: ReturnType<typeof harness>) {
  const created = await h.service.createDraft(
    fixtureContext(h.student, "createTutorDraft"),
    complete,
  );
  const draft = created.body as Submission;
  const submitted = await h.service.submit(
    fixtureContext(h.student, "submitTutorDraft", draft.revision),
    draft.id,
    { consentAccepted: true },
  );
  const decision = await h.service.review(
    fixtureContext(
      h.admin,
      "reviewTutorSubmission",
      (submitted.body as Submission).revision,
    ),
    draft.id,
    { decision: "APPROVE" },
  );
  await h.service.activateNext();
  h.student.capabilities.push("TUTOR");
  return { draft, decision };
}
async function publish(h: ReturnType<typeof harness>) {
  await approve(h);
  const workspace = await h.service.getWorkspace(h.student.userId);
  await h.service.publication(
    fixtureContext(h.student, "setTutorPublication", workspace.revision),
    { published: true },
  );
  return (
    await h.service.createSubject(
      fixtureContext(h.student, "createSubject"),
      subjectBody,
    )
  ).body as Subject;
}
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(
    promise,
    (error) => error instanceof AppError && error.code === code,
  );

test("incomplete drafts stay editable; submission validates all required fields", async () => {
  const h = harness();
  const result = await h.service.createDraft(
    fixtureContext(h.student, "createTutorDraft"),
    {},
  );
  const draft = result.body as Submission;
  validateRequest("TutorSubmission", draft);
  await rejects(
    h.service.submit(
      fixtureContext(h.student, "submitTutorDraft", "0"),
      draft.id,
      { consentAccepted: true },
    ),
    "VALIDATION_FAILED",
  );
  assert.equal(h.store.outbox.size, 0);
  const edited = await h.service.updateDraft(
    fixtureContext(h.student, "updateTutorDraft", "0"),
    draft.id,
    complete,
  );
  assert.equal((edited.body as Submission).revision, "1");
});
test("concurrent submissions admit at most one; submitted content cannot be edited", async () => {
  const h = harness();
  const a = (
    await h.service.createDraft(
      fixtureContext(h.student, "createTutorDraft"),
      complete,
    )
  ).body as Submission;
  const b = (
    await h.service.createDraft(
      fixtureContext(h.student, "createTutorDraft"),
      complete,
    )
  ).body as Submission;
  const results = await Promise.allSettled(
    [a, b].map((item) =>
      h.service.submit(
        fixtureContext(h.student, "submitTutorDraft", "0"),
        item.id,
        { consentAccepted: true },
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const pending = (await h.service.getWorkspace(h.student.userId))
    .submissions[0];
  await rejects(
    h.service.updateDraft(
      fixtureContext(h.student, "updateTutorDraft", pending.revision),
      pending.id,
      complete,
    ),
    "IMMUTABLE_SUBMISSION",
  );
  assert.equal(h.store.outbox.size, 1);
});
test("withdraw keeps immutable history; a rejected or withdrawn version copies into new draft", async () => {
  const h = harness();
  const a = (
    await h.service.createDraft(
      fixtureContext(h.student, "createTutorDraft"),
      complete,
    )
  ).body as Submission;
  const submitted = (
    await h.service.submit(
      fixtureContext(h.student, "submitTutorDraft", "0"),
      a.id,
      { consentAccepted: true },
    )
  ).body as Submission;
  const withdrawn = (
    await h.service.withdraw(
      fixtureContext(h.student, "withdrawTutorSubmission", submitted.revision),
      { submissionId: a.id },
    )
  ).body as Submission;
  assert.equal(withdrawn.state, "CANCELLED");
  const copied = (
    await h.service.copy(fixtureContext(h.student, "copyTutorSubmission"), a.id)
  ).body as Submission;
  assert.notEqual(copied.id, a.id);
  assert.equal(copied.bio, a.bio);
  assert.equal(
    (await h.service.getWorkspace(h.student.userId)).submissions[0].state,
    "CANCELLED",
  );
});
test("authorized same-key replay survives stale revision and changed input conflicts", async () => {
  const h = harness();
  const a = (
    await h.service.createDraft(
      fixtureContext(h.student, "createTutorDraft"),
      complete,
    )
  ).body as Submission;
  const context = fixtureContext(h.student, "updateTutorDraft", "0");
  const original = await h.service.updateDraft(context, a.id, {
    ...complete,
    bio: "Updated",
  });
  assert.deepEqual(
    await h.service.updateDraft(context, a.id, { ...complete, bio: "Updated" }),
    original,
  );
  await rejects(
    h.service.updateDraft(context, a.id, complete),
    "IDEMPOTENCY_CONFLICT",
  );
  const other = fixtureActor();
  await rejects(
    h.service.updateDraft(
      fixtureContext(other, "updateTutorDraft", "0"),
      a.id,
      complete,
    ),
    "NOT_FOUND",
  );
});
test("approval survives Auth outage with stable grant identity and activation pending", async () => {
  const h = harness();
  h.peers.authDown = true;
  const { decision } = await approve(h);
  assert.equal(decision.status, 202);
  let workspace = await h.service.getWorkspace(h.student.userId);
  assert.equal(workspace.activation, "PENDING");
  assert.equal(workspace.published, false);
  await rejects(
    h.service.publication(
      fixtureContext(h.student, "setTutorPublication", workspace.revision),
      { published: true },
    ),
    "TUTOR_NOT_ACTIVE",
  );
  const id = h.peers.grantCalls[0];
  h.peers.authDown = false;
  h.advance();
  await h.service.activateNext();
  workspace = await h.service.getWorkspace(h.student.userId);
  assert.equal(workspace.activation, "ACTIVE");
  assert.equal(h.peers.grantCalls[1], id);
  assert.equal(
    [...h.store.outbox.values()].filter(
      (row) => row.event.type === "tutor.activated",
    ).length,
    1,
  );
  const op = await h.service.operation(
    h.admin,
    (decision.body as { id: string }).id,
  );
  assert.equal(op.status, "SUCCEEDED");
});
test("pending/rejected revision preserves public content and publication; approval replaces content", async () => {
  const h = harness();
  const subject = await publish(h);
  const draft = (
    await h.service.createDraft(fixtureContext(h.student, "createTutorDraft"), {
      ...complete,
      bio: "Replacement bio",
    })
  ).body as Submission;
  const pending = (
    await h.service.submit(
      fixtureContext(h.student, "submitTutorDraft", "0"),
      draft.id,
      { consentAccepted: true },
    )
  ).body as Submission;
  assert.equal(
    (await h.service.publicTutor(subject.tutorId)).bio,
    complete.bio,
  );
  await h.service.review(
    fixtureContext(h.admin, "reviewTutorSubmission", pending.revision),
    draft.id,
    { decision: "REJECT", reason: "Needs more detail" },
  );
  assert.equal(
    (await h.service.publicTutor(subject.tutorId)).bio,
    complete.bio,
  );
  const copy = (
    await h.service.copy(
      fixtureContext(h.student, "copyTutorSubmission"),
      draft.id,
    )
  ).body as Submission;
  const submitted = (
    await h.service.submit(
      fixtureContext(h.student, "submitTutorDraft", "0"),
      copy.id,
      { consentAccepted: true },
    )
  ).body as Submission;
  await h.service.review(
    fixtureContext(h.admin, "reviewTutorSubmission", submitted.revision),
    copy.id,
    { decision: "APPROVE" },
  );
  assert.equal(
    (await h.service.publicTutor(subject.tutorId)).bio,
    "Replacement bio",
  );
  assert.equal(
    (await h.service.getWorkspace(h.student.userId)).published,
    true,
  );
});
test("public projection excludes private documents and catalogue RPC never calls Booking", async () => {
  const h = harness();
  const subject = await publish(h);
  const dto = await h.service.publicTutor(subject.tutorId);
  validateRequest("PublicTutor", dto);
  assert.equal(JSON.stringify(dto).includes("private-document"), false);
  h.peers.bookingDown = true;
  const snapshot = await h.service.bookable(subject.id);
  validateRequest("BookableSubject", snapshot);
  assert.equal(h.peers.availabilityCalls, 0);
  const workspace = await h.service.getWorkspace(h.student.userId);
  await h.service.publication(
    fixtureContext(h.student, "setTutorPublication", workspace.revision),
    { published: false },
  );
  await rejects(h.service.bookable(subject.id), "NOT_FOUND");
});
test("subject validation and capabilities enforced in backend; changing subject preserves returned snapshot", async () => {
  const h = harness();
  await rejects(
    h.service.createSubject(
      fixtureContext(h.student, "createSubject"),
      subjectBody,
    ),
    "FORBIDDEN",
  );
  const subject = await publish(h);
  await rejects(
    h.service.updateSubject(
      fixtureContext(h.student, "updateSubject", "0"),
      subject.id,
      { ...subjectBody, hourlyRate: "0.00" },
    ),
    "VALIDATION_FAILED",
  );
  await rejects(
    h.service.createSubject(fixtureContext(h.student, "createSubject"), {
      ...subjectBody,
      learningAreas: ["unknown"],
    }),
    "VALIDATION_FAILED",
  );
  const snapshot = await h.service.bookable(subject.id);
  await h.service.updateSubject(
    fixtureContext(h.student, "updateSubject", "0"),
    subject.id,
    { ...subjectBody, hourlyRate: "600.00" },
  );
  assert.equal(snapshot.subject.hourlyRate, "400.00");
  assert.equal(
    (await h.service.bookable(subject.id)).subject.hourlyRate,
    "600.00",
  );
});
test("rating filtering and sorting occur before pagination; dependency failures remain failures", async () => {
  const h = harness();
  const a = await publish(h);
  const b = (
    await h.service.createSubject(fixtureContext(h.student, "createSubject"), {
      ...subjectBody,
      name: "Physics",
      hourlyRate: "200.00",
      learningAreas: ["physics"],
    })
  ).body as Subject;
  h.peers.ratingsById.set(b.id, {
    subjectId: b.id,
    average: 5,
    reviewCount: 1,
    distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 1 },
  });
  const result = await h.service.search({ minRating: 4, pageSize: 1 });
  assert.equal(result.pagination.totalItems, 1);
  assert.equal(result.items[0].subject.id, b.id);
  assert.equal(result.items[0].classesTaught, null);
  assert.equal(result.items[0].classesTaughtAvailable, false);
  assert.equal(h.peers.ratingCalls, 1);
  assert.equal(h.peers.availabilityCalls, 1);
  h.peers.reviewDown = true;
  await assert.rejects(h.service.search({}));
  h.peers.reviewDown = false;
  h.peers.bookingDown = true;
  await assert.rejects(h.service.search({}));
  assert.notEqual(a.id, b.id);
});
test("outbox survives broker outage and stale leases cannot mark newer work sent", async () => {
  const h = harness();
  const draft = (
    await h.service.createDraft(
      fixtureContext(h.student, "createTutorDraft"),
      complete,
    )
  ).body as Submission;
  await h.service.submit(
    fixtureContext(h.student, "submitTutorDraft", "0"),
    draft.id,
    { consentAccepted: true },
  );
  const row = [...h.store.outbox.values()][0];
  await publishNext(h.store, {
    publish: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(h.store.outbox.get(row._id)!.state, "PENDING");
  const seen: string[] = [];
  await publishNext(
    h.store,
    {
      publish: async (event) => {
        seen.push(event.eventId);
      },
    },
    Date.now() + 5000,
  );
  assert.deepEqual(seen, [row.event.eventId]);
  assert.equal(h.store.outbox.get(row._id)!.state, "SENT");
  const staleStore = new MemoryStore();
  staleStore.outbox.set(row._id, {
    ...row,
    state: "PENDING",
    availableAt: 0,
    lockedUntil: 0,
    fence: 0,
  });
  const first = await staleStore.claimOutbox(0);
  const second = await staleStore.claimOutbox(31000);
  await staleStore.finishOutbox(row._id, first!.fence);
  assert.equal(staleStore.outbox.get(row._id)!.state, "PENDING");
  await staleStore.finishOutbox(row._id, second!.fence);
  assert.equal(staleStore.outbox.get(row._id)!.state, "SENT");
});

test("worker retry policy is jittered exponential, capped at 60 seconds, and exhausts after ten attempts", () => {
  assert.equal(
    retryDelay(1, () => 0),
    1000,
  );
  assert.equal(
    retryDelay(2, () => 0),
    2000,
  );
  assert.equal(
    retryDelay(3, () => 0.5),
    4400,
  );
  assert.equal(
    retryDelay(20, () => 1),
    60000,
  );
  assert.equal(failedWork({ attempts: 9 }, "OFFLINE").state, "PENDING");
  assert.equal(
    failedWork({ attempts: 10 }, "OFFLINE").state,
    "NEEDS_ATTENTION",
  );
  assert.equal(
    failedWork({ attempts: 10, attemptLimit: 20 }, "OFFLINE").state,
    "PENDING",
  );
});
