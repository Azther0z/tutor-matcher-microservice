import { readFileSync } from "node:fs";
import path from "node:path";
const eventSchema = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "../../../contracts/schemas/events.v1.json"),
    "utf8",
  ),
) as object;
import { randomUUID, createHash } from "node:crypto";
import {
  AppError,
  validateRequest,
  validateSchema,
} from "@tutor-matcher/shared";
import type { ActorClaims } from "@tutor-matcher/shared";
import type { Store, Transaction } from "./store";
import type {
  Admission,
  CommandContext,
  DraftWrite,
  EventEnvelope,
  Peers,
  Result,
  SearchQuery,
  StoredOperation,
  Subject,
  SubjectWrite,
  Submission,
  TutorState,
} from "./types";

const DAY = 86_400_000;
export const learningAreas = [
  "Mathematics",
  "Thai Language",
  "English",
  "Science",
  "Physics",
  "Chemistry",
  "Biology",
  "Computer Programming",
  "Business",
  "Accounting",
  "Economics",
  "Art and Design",
  "Music",
  "Social Studies",
  "History",
  "Geography",
  "Computer Science",
  "Data Science",
  "Chinese",
  "Japanese",
  "Korean",
  "French",
  "Public Speaking",
  "Academic Writing",
  "Other",
]
  .map((label) => ({
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label,
  }))
  .sort((a, b) =>
    a.id === "other"
      ? 1
      : b.id === "other"
        ? -1
        : a.label.localeCompare(b.label),
  );
const areaIds = new Set(learningAreas.map((area) => area.id));
const increment = (revision: string) => (BigInt(revision) + 1n).toString();
const emptyState = (userId: string): TutorState => ({
  _id: userId,
  revision: "0",
  tutorId: null,
  published: false,
  activation: "NONE",
  currentSubmissionId: null,
  approvedSubmissionId: null,
  submissions: [],
  subjects: [],
});
const clone = <T>(value: T): T => structuredClone(value);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function admission(actor: ActorClaims): Admission {
  return {
    id: actor.admissionId,
    actorUserId: actor.userId,
    sessionId: actor.sessionId,
    admittedAt: actor.admittedAt,
    requestId: actor.requestId,
    publicOperation: actor.publicOperation,
  };
}
export function satang(amount: string): bigint {
  return BigInt(amount.replace(".", ""));
}
export function requireCapability(actor: ActorClaims, name: string): void {
  if (!actor.capabilities.includes(name))
    throw new AppError(403, "FORBIDDEN", "This capability is required.");
}
export function checkRevision(actual: string, supplied?: string): void {
  if (supplied === undefined)
    throw new AppError(
      428,
      "PRECONDITION_REQUIRED",
      "Refresh this resource before saving.",
    );
  if (supplied !== `"${actual}"`)
    throw new AppError(
      412,
      "REVISION_MISMATCH",
      "The resource changed. Refresh and try again.",
    );
}
function submission(state: TutorState, id: string): Submission {
  const found = state.submissions.find((item) => item.id === id);
  if (!found) throw new AppError(404, "NOT_FOUND", "Submission was not found.");
  return found;
}
export function workspace(state: TutorState) {
  return {
    tutorId: state.tutorId,
    published: state.published,
    activation: state.activation,
    currentSubmissionId: state.currentSubmissionId,
    approvedSubmissionId: state.approvedSubmissionId,
    drafts: state.submissions.filter((item) => item.state === "DRAFT"),
    submissions: state.submissions.filter((item) => item.state !== "DRAFT"),
    revision: state.revision,
  };
}
export function publicContent(item: Submission) {
  return {
    headline: item.headline,
    bio: item.bio,
    avatarUrl: item.avatarUrl,
    introVideoUrl: item.introVideoUrl,
  };
}
function page<T>(items: T[], query: { page?: number; pageSize?: number }) {
  const current = query.page ?? 1,
    size = query.pageSize ?? 20;
  if (
    !Number.isInteger(current) ||
    current < 1 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 100
  )
    throw new AppError(422, "VALIDATION_FAILED", "Pagination is invalid.");
  return {
    items: items.slice((current - 1) * size, current * size),
    pagination: {
      page: current,
      pageSize: size,
      totalItems: items.length,
      totalPages: Math.ceil(items.length / size),
    },
  };
}

export class TutorService {
  constructor(
    readonly store: Store,
    readonly peers: Peers,
    readonly now: () => Date = () => new Date(),
  ) {}
  async getWorkspace(userId: string) {
    return workspace(
      (await this.store.states()).find((item) => item._id === userId) ??
        emptyState(userId),
    );
  }
  async ownerOfSubmission(id: string): Promise<string> {
    const found = (await this.store.states()).find((state) =>
      state.submissions.some((item) => item.id === id),
    );
    if (!found)
      throw new AppError(404, "NOT_FOUND", "Submission was not found.");
    return found._id;
  }
  private async write(
    context: CommandContext,
    ownerId: string,
    kind: string,
    body: unknown,
    action: (
      state: TutorState,
      tx: Transaction,
      op: StoredOperation,
    ) => Promise<Result> | Result,
  ): Promise<Result> {
    validateRequest("Id", context.idempotencyKey);
    const key = `${context.actor.userId}:${context.method}:${context.route}:${context.idempotencyKey}`;
    const inputHash = createHash("sha256")
      .update(canonical(body))
      .digest("hex");
    return this.store.transaction(async (tx) => {
      const existing = await tx.getOperation(key);
      if (existing) {
        if (
          existing.inputHash !== inputHash ||
          existing.ownerUserId !== ownerId
        )
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This action identity has different input.",
          );
        return clone(existing.result);
      }
      const state = (await tx.getState(ownerId)) ?? emptyState(ownerId);
      const time = this.now().toISOString();
      const op: StoredOperation = {
        _id: key,
        id: randomUUID(),
        actorUserId: context.actor.userId,
        ownerUserId: ownerId,
        kind,
        inputHash,
        status: "SUCCEEDED",
        admission: admission(context.actor),
        result: { status: 200 },
        resource: null,
        createdAt: time,
        updatedAt: time,
      };
      const result = await action(state, tx, op);
      state.revision = increment(state.revision);
      op.result = clone(result);
      await tx.putState(state);
      await tx.putOperation(op);
      return result;
    });
  }
  private async event(
    tx: Transaction,
    state: TutorState,
    item: Submission,
    type: string,
    data: Record<string, unknown>,
    correlationId: string,
  ): Promise<void> {
    const id = randomUUID();
    const event: EventEnvelope = {
      eventId: id,
      type,
      schemaVersion: 1,
      occurredAt: this.now().toISOString(),
      producer: "tutor",
      aggregate: {
        type: "tutor-submission",
        id: item.id,
        version: item.revision,
      },
      correlationId,
      notificationGroup: "SYSTEM",
      targets:
        type === "tutor.submission-submitted" ||
        type === "tutor.submission-withdrawn"
          ? { kind: "ADMINS" }
          : { kind: "USERS", userIds: [state._id] },
      data,
    };
    validateSchema(
      JSON.parse(
        JSON.stringify(eventSchema).replaceAll(
          "./v1.json#",
          "https://tutor-matcher.local/schemas/v1.json#",
        ),
      ),
      event,
    );
    await tx.putOutbox({
      _id: id,
      event,
      state: "PENDING",
      availableAt: this.now().getTime(),
      lockedUntil: 0,
      fence: 0,
      attempts: 0,
    });
  }
  private newDraft(state: TutorState, body: DraftWrite): Submission {
    return {
      id: randomUUID(),
      userId: state._id,
      kind: state.approvedSubmissionId ? "REVISION" : "APPLICATION",
      state: "DRAFT",
      activation: "NOT_REQUIRED",
      bio: body.bio ?? "",
      identificationDocumentUrl: body.identificationDocumentUrl ?? null,
      introVideoUrl: body.introVideoUrl ?? null,
      avatarUrl: body.avatarUrl ?? null,
      headline: body.headline ?? "",
      rejectionReason: null,
      revision: "0",
      submittedAt: null,
      reviewedAt: null,
    };
  }
  async createDraft(
    context: CommandContext,
    body: DraftWrite,
  ): Promise<Result> {
    requireCapability(context.actor, "STUDENT");
    validateRequest("TutorDraftWrite", body);
    return this.write(
      context,
      context.actor.userId,
      "createTutorDraft",
      body,
      (state) => {
        const item = this.newDraft(state, body);
        state.submissions.push(item);
        return {
          status: 201,
          body: item,
          revision: item.revision,
          location: `/api/profiles/me/tutor`,
        };
      },
    );
  }
  async updateDraft(
    context: CommandContext,
    id: string,
    body: DraftWrite,
  ): Promise<Result> {
    validateRequest("TutorDraftWrite", body);
    return this.write(
      context,
      context.actor.userId,
      "updateTutorDraft",
      body,
      (state) => {
        const item = submission(state, id);
        checkRevision(item.revision, context.ifMatch);
        if (item.state !== "DRAFT")
          throw new AppError(
            409,
            "IMMUTABLE_SUBMISSION",
            "Only drafts are editable.",
          );
        Object.assign(
          item,
          {
            bio: "",
            identificationDocumentUrl: null,
            introVideoUrl: null,
            avatarUrl: null,
            headline: "",
          },
          body,
        );
        item.revision = increment(item.revision);
        return { status: 200, body: item, revision: item.revision };
      },
    );
  }
  async deleteDraft(context: CommandContext, id: string): Promise<Result> {
    return this.write(
      context,
      context.actor.userId,
      "deleteTutorDraft",
      {},
      (state) => {
        const item = submission(state, id);
        checkRevision(item.revision, context.ifMatch);
        if (item.state !== "DRAFT")
          throw new AppError(
            409,
            "IMMUTABLE_SUBMISSION",
            "Only drafts can be deleted.",
          );
        state.submissions = state.submissions.filter((v) => v.id !== id);
        return { status: 204 };
      },
    );
  }
  async submit(
    context: CommandContext,
    id: string,
    body: { consentAccepted: true },
  ): Promise<Result> {
    validateRequest("TutorSubmit", body);
    return this.write(
      context,
      context.actor.userId,
      "submitTutorDraft",
      body,
      async (state, tx) => {
        const item = submission(state, id);
        checkRevision(item.revision, context.ifMatch);
        if (item.state !== "DRAFT")
          throw new AppError(
            409,
            "INVALID_TRANSITION",
            "Only a draft can be submitted.",
          );
        const errors: Record<string, string> = {};
        if (!item.bio.trim()) errors["/bio"] = "A bio is required.";
        if (!item.identificationDocumentUrl)
          errors["/identificationDocumentUrl"] =
            "An identification document URL is required.";
        if (!item.introVideoUrl)
          errors["/introVideoUrl"] = "An introduction video URL is required.";
        if (Object.keys(errors).length)
          throw new AppError(
            422,
            "VALIDATION_FAILED",
            "Complete the application before submitting.",
            errors,
          );
        if (state.activation === "PENDING")
          throw new AppError(
            409,
            "ACTIVATION_PENDING",
            "Wait for the approved application to activate.",
          );
        if (state.submissions.some((v) => v.state === "PENDING"))
          throw new AppError(
            409,
            "PENDING_SUBMISSION_EXISTS",
            "One submission is already awaiting review.",
          );
        item.kind = state.approvedSubmissionId ? "REVISION" : "APPLICATION";
        item.state = "PENDING";
        item.submittedAt = this.now().toISOString();
        item.revision = increment(item.revision);
        state.currentSubmissionId = item.id;
        await this.event(
          tx,
          state,
          item,
          "tutor.submission-submitted",
          {
            submissionId: item.id,
            applicantUserId: state._id,
            kind: item.kind,
          },
          context.actor.requestId,
        );
        return { status: 200, body: item, revision: item.revision };
      },
    );
  }
  async withdraw(
    context: CommandContext,
    body: { submissionId: string },
  ): Promise<Result> {
    validateRequest("TutorWithdraw", body);
    return this.write(
      context,
      context.actor.userId,
      "withdrawTutorSubmission",
      body,
      async (state, tx) => {
        const item = submission(state, body.submissionId);
        checkRevision(item.revision, context.ifMatch);
        if (item.state !== "PENDING")
          throw new AppError(
            409,
            "INVALID_TRANSITION",
            "Only pending submissions can be withdrawn.",
          );
        item.state = "CANCELLED";
        item.revision = increment(item.revision);
        state.currentSubmissionId = null;
        await this.event(
          tx,
          state,
          item,
          "tutor.submission-withdrawn",
          {
            submissionId: item.id,
            applicantUserId: state._id,
            kind: item.kind,
          },
          context.actor.requestId,
        );
        return { status: 200, body: item, revision: item.revision };
      },
    );
  }
  async copy(context: CommandContext, id: string): Promise<Result> {
    return this.write(
      context,
      context.actor.userId,
      "copyTutorSubmission",
      {},
      (state) => {
        const source = submission(state, id);
        if (!["REJECTED", "CANCELLED"].includes(source.state))
          throw new AppError(
            409,
            "INVALID_TRANSITION",
            "Only rejected or withdrawn submissions can be copied.",
          );
        const item = this.newDraft(state, source);
        state.submissions.push(item);
        return {
          status: 201,
          body: item,
          revision: item.revision,
          location: "/api/profiles/me/tutor",
        };
      },
    );
  }
  async listRequests(query: {
    page?: number;
    pageSize?: number;
    status?: string;
  }) {
    const status = query.status ?? "PENDING";
    if (
      !["PENDING", "APPROVED", "REJECTED", "CANCELLED", "ALL"].includes(status)
    )
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Unknown submission status.",
      );
    const items = (await this.store.states())
      .flatMap((s) => s.submissions)
      .filter(
        (s) => s.state !== "DRAFT" && (status === "ALL" || s.state === status),
      )
      .sort(
        (a, b) =>
          (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "") ||
          a.id.localeCompare(b.id),
      );
    return page(items, query);
  }
  async request(id: string) {
    const owner = await this.ownerOfSubmission(id);
    return submission(
      (await this.store.states()).find((s) => s._id === owner)!,
      id,
    );
  }
  async review(
    context: CommandContext,
    id: string,
    body: { decision: "APPROVE" | "REJECT"; reason?: string },
  ): Promise<Result> {
    requireCapability(context.actor, "ADMIN");
    validateRequest("TutorReviewWrite", body);
    const owner = await this.ownerOfSubmission(id);
    return this.write(
      context,
      owner,
      "reviewTutorSubmission",
      body,
      async (state, tx, op) => {
        const item = submission(state, id);
        checkRevision(item.revision, context.ifMatch);
        if (item.state !== "PENDING")
          throw new AppError(
            409,
            "INVALID_TRANSITION",
            "This submission is no longer pending.",
          );
        if (body.decision === "REJECT" && !body.reason?.trim())
          throw new AppError(
            422,
            "VALIDATION_FAILED",
            "A rejection reason is required.",
            { "/reason": "Required." },
          );
        item.state = body.decision === "APPROVE" ? "APPROVED" : "REJECTED";
        item.reviewedAt = this.now().toISOString();
        item.rejectionReason = body.decision === "REJECT" ? body.reason! : null;
        item.revision = increment(item.revision);
        state.currentSubmissionId = null;
        await this.event(
          tx,
          state,
          item,
          "tutor.submission-decided",
          {
            submissionId: id,
            decision: body.decision,
            reason: body.reason ?? null,
          },
          context.actor.requestId,
        );
        if (body.decision === "REJECT")
          return { status: 200, body: item, revision: item.revision };
        const initial = state.activation !== "ACTIVE";
        state.tutorId ??= randomUUID();
        state.approvedSubmissionId = id;
        if (!initial) {
          item.activation = "NOT_REQUIRED";
          return { status: 200, body: item, revision: item.revision };
        }
        state.activation = "PENDING";
        item.activation = "PENDING";
        state.published = false;
        op.status = "PENDING";
        op.resource = {
          type: "tutor-submission",
          id,
          url: `/api/admin/tutor-requests/${id}`,
        };
        await tx.putGrant({
          _id: op.id,
          operationId: op.id,
          ownerOperationKey: op._id,
          userId: state._id,
          submissionId: id,
          approvalRevision: item.revision,
          admission: op.admission,
          state: "PENDING",
          availableAt: this.now().getTime(),
          lockedUntil: 0,
          fence: 0,
          attempts: 0,
        });
        return {
          status: 202,
          body: {
            id: op.id,
            owner: "tutor",
            status: "PENDING",
            statusUrl: `/api/operations/tutor/${op.id}`,
            resource: op.resource,
          },
          location: `/api/operations/tutor/${op.id}`,
        };
      },
    );
  }
  async activateNext(): Promise<boolean> {
    const work = await this.store.claimGrant(this.now().getTime());
    if (!work) return false;
    try {
      const outcome = await this.peers.grant(work);
      if (
        outcome.operationId !== work.operationId ||
        outcome.userId !== work.userId ||
        outcome.capability !== "TUTOR" ||
        outcome.status !== "APPLIED"
      )
        throw new AppError(
          503,
          "INVALID_DEPENDENCY_RESPONSE",
          "Tutor activation outcome does not match.",
        );
      await this.store.transaction(async (tx) => {
        const current = await tx.getGrant(work._id);
        if (
          !current ||
          current.fence !== work.fence ||
          current.state !== "PENDING"
        )
          return;
        const state = await tx.getState(work.userId);
        if (!state) throw new Error("Missing approval state");
        const item = submission(state, work.submissionId);
        if (
          item.state !== "APPROVED" ||
          item.revision !== work.approvalRevision
        )
          throw new Error("Approval changed");
        item.activation = "ACTIVE";
        item.revision = increment(item.revision);
        state.activation = "ACTIVE";
        state.revision = increment(state.revision);
        const op = await tx.getOperation(work.ownerOperationKey);
        if (!op) throw new Error("Missing activation operation");
        op.status = "SUCCEEDED";
        op.result = { status: 200, body: item, revision: item.revision };
        op.updatedAt = this.now().toISOString();
        current.state = "DONE";
        current.lockedUntil = 0;
        await tx.putGrant(current);
        await tx.putState(state);
        await tx.putOperation(op);
        await this.event(
          tx,
          state,
          item,
          "tutor.activated",
          { submissionId: item.id, tutorId: state.tutorId },
          work.admission.requestId,
        );
      });
    } catch {
      await this.store.retryGrant(
        work._id,
        work.fence,
        "AUTH_ACTIVATION_UNAVAILABLE",
      );
    }
    return true;
  }
  private approvedTutor(state: TutorState, actor: ActorClaims): void {
    requireCapability(actor, "TUTOR");
    if (
      state.activation !== "ACTIVE" ||
      !state.tutorId ||
      !state.approvedSubmissionId
    )
      throw new AppError(
        403,
        "TUTOR_NOT_ACTIVE",
        "Tutor approval and activation are required.",
      );
  }
  async publication(
    context: CommandContext,
    body: { published: boolean },
  ): Promise<Result> {
    validateRequest("PublicationWrite", body);
    requireCapability(context.actor, "TUTOR");
    return this.write(
      context,
      context.actor.userId,
      "setTutorPublication",
      body,
      (state) => {
        this.approvedTutor(state, context.actor);
        checkRevision(state.revision, context.ifMatch);
        state.published = body.published;
        const result = workspace(state);
        result.revision = increment(state.revision);
        return { status: 200, body: result, revision: result.revision };
      },
    );
  }
  async createSubject(
    context: CommandContext,
    body: SubjectWrite,
  ): Promise<Result> {
    validateRequest("SubjectWrite", body);
    this.validateAreas(body);
    requireCapability(context.actor, "TUTOR");
    return this.write(
      context,
      context.actor.userId,
      "createSubject",
      body,
      (state) => {
        this.approvedTutor(state, context.actor);
        if (state.subjects.length >= 100)
          throw new AppError(
            409,
            "SUBJECT_LIMIT",
            "At most 100 subjects are supported.",
          );
        const item: Subject = {
          ...body,
          id: randomUUID(),
          tutorId: state.tutorId!,
          tutorUserId: state._id,
          revision: "0",
        };
        state.subjects.push(item);
        return {
          status: 201,
          body: item,
          revision: item.revision,
          location: `/api/discovery/tutors/${item.tutorId}/subjects/${item.id}`,
        };
      },
    );
  }
  async updateSubject(
    context: CommandContext,
    id: string,
    body: SubjectWrite,
  ): Promise<Result> {
    validateRequest("SubjectWrite", body);
    this.validateAreas(body);
    requireCapability(context.actor, "TUTOR");
    return this.write(
      context,
      context.actor.userId,
      "updateSubject",
      body,
      (state) => {
        this.approvedTutor(state, context.actor);
        const item = state.subjects.find((s) => s.id === id);
        if (!item)
          throw new AppError(404, "NOT_FOUND", "Subject was not found.");
        checkRevision(item.revision, context.ifMatch);
        Object.assign(item, body, { revision: increment(item.revision) });
        return { status: 200, body: item, revision: item.revision };
      },
    );
  }
  private validateAreas(body: SubjectWrite) {
    if (body.learningAreas.some((id) => !areaIds.has(id)))
      throw new AppError(422, "VALIDATION_FAILED", "Unknown learning area.", {
        "/learningAreas": "Choose supported learning areas.",
      });
    if (!body.name.trim() || !body.description.trim())
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Subject name and description cannot be blank.",
      );
  }
  async ownSubjects(
    actor: ActorClaims,
    query: { page?: number; pageSize?: number },
  ) {
    const state =
      (await this.store.states()).find((s) => s._id === actor.userId) ??
      emptyState(actor.userId);
    this.approvedTutor(state, actor);
    return page(
      state.subjects.sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
      query,
    );
  }
  async operation(actor: ActorClaims, id: string) {
    const op = await this.store.operation(id);
    if (
      !op ||
      !(
        actor.userId === op.actorUserId ||
        actor.userId === op.ownerUserId ||
        actor.capabilities.includes("ADMIN")
      )
    )
      throw new AppError(404, "NOT_FOUND", "Operation was not found.");
    return {
      id: op.id,
      owner: "tutor",
      status: op.status,
      kind: op.kind,
      resource: op.resource,
      error: null,
      createdAt: op.createdAt,
      updatedAt: op.updatedAt,
    };
  }
  async eligibility(userId: string) {
    validateRequest("Id", userId);
    const state = (await this.store.states()).find((s) => s._id === userId);
    let active = true;
    if (state?.activation === "ACTIVE") {
      const [account] = await this.peers.accounts([userId]);
      if (!account)
        throw new AppError(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "Tutor account information is incomplete.",
          undefined,
          true,
        );
      active =
        account.status === "ACTIVE" && account.capabilities.includes("TUTOR");
    }
    return {
      userId,
      tutorId: state?.tutorId ?? null,
      approved: Boolean(state?.approvedSubmissionId),
      activated: state?.activation === "ACTIVE" && active,
      published: Boolean(
        state?.published && state.activation === "ACTIVE" && active,
      ),
      revision: state?.revision ?? "0",
    };
  }
  async bookable(subjectId: string) {
    const state = (await this.store.states()).find((s) =>
      s.subjects.some((subject) => subject.id === subjectId),
    );
    if (!state || !state.published || state.activation !== "ACTIVE")
      throw new AppError(404, "NOT_FOUND", "Bookable subject was not found.");
    const [account] = await this.peers.accounts([state._id]);
    if (
      !account ||
      account.status !== "ACTIVE" ||
      !account.capabilities.includes("TUTOR")
    )
      throw new AppError(404, "NOT_FOUND", "Bookable subject was not found.");
    const item = state.subjects.find((s) => s.id === subjectId)!;
    const { learningAreas: _areas, ...snapshot } = item;
    return {
      subject: snapshot,
      published: true,
      eligibilityCheckedAt: this.now().toISOString(),
    };
  }
  private async visible() {
    const states = (await this.store.states()).filter(
      (s) => s.published && s.activation === "ACTIVE" && s.approvedSubmissionId,
    );
    if (!states.length) return [];
    const accounts = await this.batched(
      states.map((s) => s._id),
      (ids) => this.peers.accounts(ids),
    );
    const byId = new Map(accounts.map((account) => [account.id, account]));
    return states.flatMap((state) => {
      const account = byId.get(state._id);
      if (!account)
        throw new AppError(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "Tutor account information is incomplete.",
          undefined,
          true,
        );
      return account.status === "ACTIVE" &&
        account.capabilities.includes("TUTOR")
        ? [{ state, account }]
        : [];
    });
  }
  private async batched<T, R>(
    items: T[],
    read: (batch: T[]) => Promise<R[]>,
  ): Promise<R[]> {
    const result: R[] = [];
    for (let offset = 0; offset < items.length; offset += 100)
      result.push(...(await read(items.slice(offset, offset + 100))));
    return result;
  }
  async search(query: SearchQuery) {
    if (
      query.preferredLearningAreas &&
      (query.preferredLearningAreas.length > 30 ||
        new Set(query.preferredLearningAreas).size !==
          query.preferredLearningAreas.length ||
        query.preferredLearningAreas.some((id) => !areaIds.has(id)))
    )
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Preferred learning areas are invalid.",
      );
    const listed = await this.visible(),
      now = this.now();
    const matching = listed
      .flatMap(({ state, account }) =>
        state.subjects.map((subject) => ({
          subject,
          tutorDisplayName: account.displayName,
        })),
      )
      .filter((item) => {
        const words = (text: string | undefined) =>
          (text ?? "")
            .toLocaleLowerCase()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 5);
        return (
          words(query.q).every((word) =>
            `${item.subject.name} ${item.subject.description}`
              .toLocaleLowerCase()
              .includes(word),
          ) &&
          words(query.tutorName).every((word) =>
            item.tutorDisplayName.toLocaleLowerCase().includes(word),
          ) &&
          (!query.learningArea ||
            item.subject.learningAreas.includes(query.learningArea)) &&
          (!query.minRate ||
            satang(item.subject.hourlyRate) >= satang(query.minRate)) &&
          (!query.maxRate ||
            satang(item.subject.hourlyRate) <= satang(query.maxRate))
        );
      });
    if (
      query.minRate &&
      query.maxRate &&
      satang(query.minRate) > satang(query.maxRate)
    )
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Minimum rate exceeds maximum rate.",
      );
    if (!matching.length) return page([], query);
    const until = new Date(now.getTime() + 30 * DAY).toISOString();
    const from = now.toISOString();
    const [ratings, availability] = await Promise.all([
      this.batched(
        matching.map((x) => x.subject.id),
        (ids) => this.peers.ratings(ids),
      ),
      this.batched(matching, async (batch) => {
        const result = await this.peers.batchAvailability(
          batch.map((x) => ({
            tutorId: x.subject.tutorId,
            subjectId: x.subject.id,
            from,
            to: until,
          })),
        );
        if (
          result.length !== batch.length ||
          result.some((r, index) => r.queryIndex !== index)
        )
          throw new AppError(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "Availability summaries are incomplete.",
            undefined,
            true,
          );
        return result;
      }),
    ]);
    const ratingById = new Map(ratings.map((r) => [r.subjectId, r]));
    if (ratingById.size !== matching.length)
      throw new AppError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Rating summaries are incomplete.",
        undefined,
        true,
      );
    const items = matching
      .map((item, index) => {
        const rating = ratingById.get(item.subject.id);
        if (!rating)
          throw new AppError(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "Rating summary is missing.",
          );
        return {
          ...item,
          rating,
          nextAvailableAt: availability[index].hasAvailability
            ? availability[index].nextAvailableAt
            : null,
          classesTaught: null,
          classesTaughtAvailable: false,
        };
      })
      .filter(
        (item) =>
          query.minRating === undefined ||
          (item.rating.average !== null &&
            item.rating.average >= query.minRating),
      );
    const preferred = query.preferredLearningAreas ?? [];
    const score = (item: (typeof items)[number]) => {
      const rating = (item.rating.average ?? 0) / 5;
      const available = item.nextAvailableAt
        ? Math.max(
            0,
            1 - (Date.parse(item.nextAvailableAt) - now.getTime()) / (30 * DAY),
          )
        : 0;
      return preferred.length
        ? 0.5 *
            (item.subject.learningAreas.filter((id) => preferred.includes(id))
              .length /
              preferred.length) +
            0.3 * rating +
            0.2 * available
        : 0.6 * rating + 0.4 * available;
    };
    items.sort((a, b) => {
      let order = 0;
      switch (query.sort ?? "RECOMMENDED") {
        case "PRICE_ASC":
          order =
            satang(a.subject.hourlyRate) < satang(b.subject.hourlyRate)
              ? -1
              : satang(a.subject.hourlyRate) > satang(b.subject.hourlyRate)
                ? 1
                : 0;
          break;
        case "PRICE_DESC":
          order =
            satang(a.subject.hourlyRate) > satang(b.subject.hourlyRate)
              ? -1
              : satang(a.subject.hourlyRate) < satang(b.subject.hourlyRate)
                ? 1
                : 0;
          break;
        case "TOP_RATED":
          order =
            (b.rating.average ?? -1) - (a.rating.average ?? -1) ||
            b.rating.reviewCount - a.rating.reviewCount;
          break;
        default:
          order =
            score(b) - score(a) || b.rating.reviewCount - a.rating.reviewCount;
      }
      return (
        order ||
        a.subject.name.localeCompare(b.subject.name) ||
        a.tutorDisplayName.localeCompare(b.tutorDisplayName) ||
        a.subject.id.localeCompare(b.subject.id)
      );
    });
    return {
      ...page(items, query),
      recommendationMode: preferred.length ? "PERSONALIZED" : "FALLBACK",
    };
  }
  async publicTutor(tutorId: string) {
    const visible = (await this.visible()).find(
      ({ state }) => state.tutorId === tutorId,
    );
    if (!visible)
      throw new AppError(404, "NOT_FOUND", "Tutor profile was not found.");
    const { state, account } = visible;
    const approved = submission(state, state.approvedSubmissionId!);
    const recentReviews = await this.peers.publicReviews({ tutorId });
    return {
      id: tutorId,
      userId: state._id,
      displayName: account.displayName,
      ...publicContent(approved),
      verified: true,
      subjects: state.subjects,
      recentReviews,
    };
  }
  async publicSubject(tutorId: string, subjectId: string, date?: string) {
    const tutor = await this.publicTutor(tutorId);
    const subject = tutor.subjects.find((item) => item.id === subjectId);
    if (!subject)
      throw new AppError(404, "NOT_FOUND", "Subject was not found.");
    const selectedDate =
      date ??
      new Date(this.now().getTime() + 7 * 3600000).toISOString().slice(0, 10);
    validateRequest("Date", selectedDate);
    const start = Date.parse(`${selectedDate}T00:00:00.000+07:00`);
    const today = Date.parse(
      `${new Date(this.now().getTime() + 7 * 3600000).toISOString().slice(0, 10)}T00:00:00.000+07:00`,
    );
    if (!Number.isFinite(start) || start < today || start > today + 92 * DAY)
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Choose a Bangkok date within the next 93 days.",
      );
    const [ratings, slots, reviews] = await Promise.all([
      this.peers.ratings([subjectId]),
      this.peers.availability({
        tutorId,
        subjectId,
        from: new Date(start).toISOString(),
        to: new Date(start + DAY).toISOString(),
      }),
      this.peers.publicReviews({ tutorId, subjectId }),
    ]);
    const rating = ratings.find((item) => item.subjectId === subjectId);
    if (!rating)
      throw new AppError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Rating summary is missing.",
      );
    return { tutor, subject, rating, selectedDate, slots, reviews };
  }
  async priceRange() {
    const rates = (await this.visible())
      .flatMap(({ state }) => state.subjects.map((s) => s.hourlyRate))
      .sort((a, b) =>
        satang(a) < satang(b) ? -1 : satang(a) > satang(b) ? 1 : 0,
      );
    return {
      minimum: { currency: "THB", amount: rates[0] ?? "0.00" },
      maximum: { currency: "THB", amount: rates.at(-1) ?? "0.00" },
    };
  }
}
