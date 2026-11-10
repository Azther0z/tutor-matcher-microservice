import { createHash, randomUUID } from "node:crypto";
import { AppError, validateRequest } from "@tutor-matcher/shared";
import type {
  CommandContext,
  ReviewStore,
  PeerClients,
  Review,
  Flag,
  EventEnvelope,
  RatingSummary,
} from "./types";

export function publicReview(review: Review): Review {
  const {
    id,
    bookingId,
    studentUserId,
    tutorId,
    tutorUserId,
    subjectId,
    rating,
    text,
    headline,
    reply,
    visibility,
    revision,
    createdAt,
    studentDisplayName,
  } = review;
  return {
    id,
    bookingId,
    studentUserId,
    tutorId,
    tutorUserId,
    subjectId,
    rating,
    text,
    headline,
    reply: reply
      ? { id: reply.id, text: reply.text, createdAt: reply.createdAt }
      : null,
    visibility,
    revision,
    createdAt,
    studentDisplayName,
  };
}
export function flagProjection(flag: Flag): Flag {
  const { id, reviewId, reporterUserId, reason, state, revision, createdAt } =
    flag;
  return { id, reviewId, reporterUserId, reason, state, revision, createdAt };
}
function fingerprint(kind: string, resource: string, body: unknown) {
  return createHash("sha256")
    .update(JSON.stringify([kind, resource, canonical(body)]))
    .digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function requireCapability(context: CommandContext, capability: string) {
  if (!context.actor.capabilities.includes(capability))
    throw new AppError(
      403,
      "FORBIDDEN",
      "This action is not allowed for this account.",
    );
}
function revision(context: CommandContext, review: Review) {
  if (context.expectedRevision === undefined)
    throw new AppError(428, "PRECONDITION_REQUIRED", "If-Match is required.");
  if (context.expectedRevision !== review.revision)
    throw new AppError(
      412,
      "REVISION_MISMATCH",
      "Review changed. Refresh before trying again.",
    );
}
function nonblank(text: string, field: string) {
  if (!text.trim())
    throw new AppError(422, "VALIDATION_FAILED", "Text cannot be blank.", {
      [`/${field}`]: "Enter some text.",
    });
}
export class ReviewService {
  constructor(
    readonly store: ReviewStore,
    readonly peers: PeerClients,
    readonly now: () => Date = () => new Date(),
  ) {}
  private async replay<T extends Review | Flag>(
    store: ReviewStore,
    context: CommandContext,
    hash: string,
  ): Promise<T | null> {
    const saved = await store.getOperation(context.actor.userId, context.key);
    if (!saved) {
      const other = await store.operation(context.key);
      if (other)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Operation identity is already in use.",
        );
      return null;
    }
    if (saved.fingerprint !== hash)
      throw new AppError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This key was used for a different action.",
      );
    return structuredClone(saved.response) as T;
  }
  private async mutation<T extends Review | Flag>(
    context: CommandContext,
    hash: string,
    work: (store: ReviewStore) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.store.transaction(work);
    } catch (error) {
      if (error instanceof AppError && error.code === "DUPLICATE_RESOURCE") {
        const saved = await this.replay<T>(this.store, context, hash);
        if (saved) return saved;
      }
      throw error;
    }
  }
  private async save(
    store: ReviewStore,
    context: CommandContext,
    hash: string,
    kind: string,
    response: Review | Flag,
  ) {
    const at = this.now().toISOString();
    await store.saveOperation({
      id: context.key,
      actorUserId: context.actor.userId,
      fingerprint: hash,
      kind,
      admission: {
        id: context.actor.admissionId,
        actorUserId: context.actor.userId,
        sessionId: context.actor.sessionId,
        admittedAt: context.actor.admittedAt,
        requestId: context.actor.requestId,
        publicOperation: context.actor.publicOperation,
      },
      status: "SUCCEEDED",
      response: structuredClone(response),
      resource: {
        type: "review",
        id: "reviewId" in response ? response.reviewId : response.id,
        url: `/api/reviews?tutorId=${"tutorId" in response ? response.tutorId : ""}`,
      },
      createdAt: at,
      updatedAt: at,
    });
  }
  private async event(
    store: ReviewStore,
    context: CommandContext,
    review: Review,
    type: EventEnvelope["type"],
    data: Record<string, string>,
    recipients?: string[],
  ) {
    const sorted = recipients ? [...new Set(recipients)].sort() : null;
    const chunks = sorted
      ? Array.from({ length: Math.ceil(sorted.length / 100) }, (_, i) =>
          sorted.slice(i * 100, (i + 1) * 100),
        )
      : [null];
    for (const chunk of chunks) {
      const eventId = randomUUID();
      const event: EventEnvelope = {
        eventId,
        type,
        schemaVersion: 1,
        occurredAt: this.now().toISOString(),
        producer: "review",
        aggregate: { type: "review", id: review.id, version: review.revision },
        correlationId: context.requestId,
        causationId: context.key,
        targets: chunk ? { kind: "USERS", userIds: chunk } : { kind: "ADMINS" },
        notificationGroup: "SYSTEM",
        data,
      };
      await store.addOutbox({
        id: eventId,
        event,
        sentAt: null,
        leaseUntil: new Date(0),
        fence: 0,
        attempts: 0,
        nextAttemptAt: new Date(0),
      });
    }
  }
  async create(
    context: CommandContext,
    bookingId: string,
    body: { rating: number; text: string; headline?: string },
  ): Promise<Review> {
    requireCapability(context, "STUDENT");
    validateRequest("ReviewCreate", body);
    nonblank(body.text, "text");
    const hash = fingerprint("createReview", bookingId, body);
    const replay = await this.replay<Review>(this.store, context, hash);
    if (replay) return replay;
    const eligibility = await this.peers.reviewEligibility(
      bookingId,
      context.assertion,
    );
    if (
      eligibility.bookingId !== bookingId ||
      eligibility.studentUserId !== context.actor.userId
    )
      throw new AppError(404, "NOT_FOUND", "Booking is unavailable.");
    if (!eligibility.eligible || !eligibility.completedAt)
      throw new AppError(
        409,
        "REVIEW_NOT_ELIGIBLE",
        "Only a completed lesson can be reviewed.",
      );
    const accounts = await this.peers.accounts([context.actor.userId]);
    const account = accounts.find((item) => item.id === context.actor.userId);
    if (!account)
      throw new AppError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Account details are unavailable.",
        undefined,
        true,
      );
    return this.mutation(context, hash, async (store) => {
      const replay = await this.replay<Review>(store, context, hash);
      if (replay) return replay;
      if (await store.getReviewByBooking(bookingId))
        throw new AppError(
          409,
          "REVIEW_EXISTS",
          "This booking already has a review.",
        );
      const review: Review = {
        id: randomUUID(),
        bookingId,
        studentUserId: eligibility.studentUserId,
        tutorId: eligibility.tutorId,
        tutorUserId: eligibility.tutorUserId,
        subjectId: eligibility.subjectId,
        rating: body.rating,
        text: body.text,
        headline: body.headline ?? null,
        reply: null,
        visibility: "PUBLIC",
        revision: "0",
        createdAt: this.now().toISOString(),
        studentDisplayName: account.displayName,
      };
      await store.insertReview(review);
      await this.save(store, context, hash, "createReview", review);
      return publicReview(review);
    });
  }
  async reply(
    context: CommandContext,
    reviewId: string,
    body: { text: string },
  ): Promise<Review> {
    requireCapability(context, "TUTOR");
    validateRequest("ReviewReply", body);
    nonblank(body.text, "text");
    const hash = fingerprint("replyToReview", reviewId, body);
    return this.mutation(context, hash, async (store) => {
      const replay = await this.replay<Review>(store, context, hash);
      if (replay) return replay;
      const review = await store.getReview(reviewId);
      if (
        !review ||
        review.tutorUserId !== context.actor.userId ||
        review.visibility !== "PUBLIC"
      )
        throw new AppError(404, "NOT_FOUND", "Review is unavailable.");
      revision(context, review);
      if (review.reply)
        throw new AppError(
          409,
          "REPLY_EXISTS",
          "This review already has a tutor reply.",
        );
      const previous = review.revision;
      review.reply = {
        id: randomUUID(),
        text: body.text,
        createdAt: this.now().toISOString(),
      };
      review.revision = (BigInt(previous) + 1n).toString();
      await store.replaceReview(review, previous);
      await this.save(
        store,
        context,
        hash,
        "replyToReview",
        publicReview(review),
      );
      return publicReview(review);
    });
  }
  async flag(
    context: CommandContext,
    reviewId: string,
    body: { reason: string },
  ): Promise<Flag> {
    requireCapability(context, "STUDENT");
    validateRequest("FlagCreate", body);
    nonblank(body.reason, "reason");
    const hash = fingerprint("flagReview", reviewId, body);
    return this.mutation(context, hash, async (store) => {
      const replay = await this.replay<Flag>(store, context, hash);
      if (replay) return replay;
      const review = await store.getReview(reviewId);
      if (!review || review.visibility !== "PUBLIC")
        throw new AppError(404, "NOT_FOUND", "Review is unavailable.");
      if (
        (await store.flags(reviewId)).some(
          (flag) => flag.reporterUserId === context.actor.userId,
        )
      )
        throw new AppError(
          409,
          "FLAG_EXISTS",
          "You already reported this review.",
        );
      const flag: Flag = {
        id: randomUUID(),
        reviewId,
        reporterUserId: context.actor.userId,
        reason: body.reason,
        state: "OPEN",
        revision: "0",
        createdAt: this.now().toISOString(),
      };
      const previous = review.revision;
      review.revision = (BigInt(previous) + 1n).toString();
      await store.replaceReview(review, previous);
      await store.insertFlag(flag);
      await this.event(store, context, review, "review.flagged", {
        reviewId,
        flagId: flag.id,
      });
      await this.save(store, context, hash, "flagReview", flag);
      return flagProjection(flag);
    });
  }
  async moderate(
    context: CommandContext,
    reviewId: string,
    body: { decision: "KEEP" | "HIDE" | "REMOVE"; reason: string },
  ): Promise<Review> {
    requireCapability(context, "ADMIN");
    validateRequest("ModerationWrite", body);
    nonblank(body.reason, "reason");
    const hash = fingerprint("moderateReview", reviewId, body);
    return this.mutation(context, hash, async (store) => {
      const replay = await this.replay<Review>(store, context, hash);
      if (replay) return replay;
      const review = await store.getReview(reviewId);
      if (!review)
        throw new AppError(404, "NOT_FOUND", "Review is unavailable.");
      revision(context, review);
      const flags = await store.flags(reviewId);
      const previous = review.revision;
      if (body.decision === "HIDE" && review.visibility !== "REMOVED")
        review.visibility = "HIDDEN";
      if (body.decision === "REMOVE") review.visibility = "REMOVED";
      review.revision = (BigInt(previous) + 1n).toString();
      await store.replaceReview(review, previous);
      await store.resolveFlags(reviewId);
      await store.saveAudit({
        id: randomUUID(),
        reviewId,
        actorUserId: context.actor.userId,
        action: body.decision,
        reason: body.reason,
        occurredAt: this.now().toISOString(),
      });
      await this.event(
        store,
        context,
        review,
        "review.moderated",
        { reviewId, decision: body.decision, reason: body.reason },
        [review.studentUserId, ...flags.map((flag) => flag.reporterUserId)],
      );
      await this.save(
        store,
        context,
        hash,
        "moderateReview",
        publicReview(review),
      );
      return publicReview(review);
    });
  }
  async list(
    tutorId: string,
    subjectId: string | undefined,
    page: number,
    pageSize: number,
  ) {
    const all = (
      await this.store.reviews({
        tutorId,
        ...(subjectId ? { subjectId } : {}),
        visibility: "PUBLIC",
      })
    ).sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    return {
      items: all
        .slice((page - 1) * pageSize, page * pageSize)
        .map(publicReview),
      pagination: {
        page,
        pageSize,
        totalItems: all.length,
        totalPages: Math.ceil(all.length / pageSize),
      },
    };
  }
  async flags(context: CommandContext, page: number, pageSize: number) {
    requireCapability(context, "ADMIN");
    const flags = (await this.store.flags()).sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    const selected = flags.slice((page - 1) * pageSize, page * pageSize);
    const ids = [...new Set(selected.map((flag) => flag.reporterUserId))];
    const accounts = new Map(
      (ids.length ? await this.peers.accounts(ids) : []).map((account) => [
        account.id,
        account,
      ]),
    );
    const items = await Promise.all(
      selected.map(async (flag) => {
        const review = await this.store.getReview(flag.reviewId),
          reporter = accounts.get(flag.reporterUserId);
        if (!review || !reporter)
          throw new AppError(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "Moderation details are unavailable.",
            undefined,
            true,
          );
        return {
          flag: flagProjection(flag),
          review: publicReview(review),
          reporterDisplayName: reporter.displayName,
        };
      }),
    );
    return {
      items,
      pagination: {
        page,
        pageSize,
        totalItems: flags.length,
        totalPages: Math.ceil(flags.length / pageSize),
      },
    };
  }
  async ratings(subjectIds: string[]): Promise<{ items: RatingSummary[] }> {
    validateRequest("RatingBatchWrite", { subjectIds });
    const reviews = await this.store.reviews({
      subjectIds,
      visibility: "PUBLIC",
    });
    return {
      items: subjectIds.map((subjectId) => {
        const selected = reviews.filter(
          (review) => review.subjectId === subjectId,
        );
        const distribution: Record<string, number> = {
          "1": 0,
          "2": 0,
          "3": 0,
          "4": 0,
          "5": 0,
        };
        for (const review of selected) distribution[String(review.rating)]++;
        return {
          subjectId,
          average: selected.length
            ? selected.reduce((sum, review) => sum + review.rating, 0) /
              selected.length
            : null,
          reviewCount: selected.length,
          distribution,
        };
      }),
    };
  }
  async operation(context: CommandContext, operationId: string) {
    const saved = await this.store.operation(operationId);
    const affected =
      saved &&
      "tutorUserId" in saved.response &&
      [saved.response.studentUserId, saved.response.tutorUserId].includes(
        context.actor.userId,
      );
    if (
      !saved ||
      (saved.actorUserId !== context.actor.userId &&
        !affected &&
        !context.actor.capabilities.includes("ADMIN"))
    ) {
      throw new AppError(404, "NOT_FOUND", "Operation is unavailable.");
    }
    const { id, kind, status, resource, createdAt, updatedAt } = saved;
    return {
      id,
      owner: "review",
      kind,
      status,
      resource,
      error: null,
      createdAt,
      updatedAt,
    };
  }
}
