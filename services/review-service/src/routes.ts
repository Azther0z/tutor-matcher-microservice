import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import {
  AppError,
  verifyWorkload,
  verifyActorAssertion,
  toHttpError,
  validateRequest,
  type ActorClaims,
} from "@tutor-matcher/shared";
import type { ReviewService } from "./service";
import type { CommandContext } from "./types";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function createReviewApp(
  service: ReviewService,
  config: {
    gatewayCredential: string;
    actorPublicKey: string;
    ready?: () => Promise<boolean>;
  },
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.use((req, res, next) => {
    const value = req.get("x-request-id");
    res.locals.requestId = value && uuid.test(value) ? value : randomUUID();
    res.setHeader("X-Request-Id", res.locals.requestId);
    if (value && !uuid.test(value)) {
      next(
        new AppError(400, "INVALID_REQUEST_ID", "X-Request-Id must be a UUID."),
      );
      return;
    }
    next();
  });
  app.use((req, _res, next) => {
    if (
      ["POST", "PUT", "PATCH"].includes(req.method) &&
      !req.is("application/json")
    ) {
      next(
        new AppError(400, "UNSUPPORTED_MEDIA_TYPE", "Use application/json."),
      );
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  const route =
    (work: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      void work(req, res).catch(next);
    };
  function actor(req: Request, operation: string): ActorClaims {
    verifyWorkload(
      req.get("authorization"),
      config.gatewayCredential,
      "gateway",
      operation,
      { gateway: [operation] },
    );
    const assertion = req.get("x-actor-context");
    if (!assertion)
      throw new AppError(
        401,
        "INVALID_ACTOR_ASSERTION",
        "An actor assertion is required.",
      );
    const actor = verifyActorAssertion(assertion, config.actorPublicKey);
    if (actor.publicOperation !== operation)
      throw new AppError(
        403,
        "FORBIDDEN",
        "Actor admission does not match this operation.",
      );
    return actor;
  }
  function context(
    req: Request,
    res: Response,
    operation: string,
    mutation = true,
  ): CommandContext {
    const principal = actor(req, operation),
      key = mutation ? req.get("Idempotency-Key") : randomUUID();
    if (!key || !uuid.test(key))
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A UUID Idempotency-Key is required.",
      );
    const match = req.get("If-Match");
    if (match !== undefined && !/^"(0|[1-9][0-9]*)"$/.test(match))
      throw new AppError(
        400,
        "INVALID_PRECONDITION",
        "If-Match must be a quoted revision.",
      );
    if (req.get("If-None-Match"))
      throw new AppError(
        400,
        "INVALID_PRECONDITION",
        "If-None-Match is not supported for this operation.",
      );
    res.setHeader("Cache-Control", "no-store");
    return {
      actor: principal,
      key,
      requestId: res.locals.requestId as string,
      assertion: req.get("x-actor-context"),
      expectedRevision: match?.slice(1, -1),
    };
  }
  function id(value: unknown): string {
    if (typeof value !== "string" || !uuid.test(value))
      throw new AppError(422, "VALIDATION_FAILED", "A valid UUID is required.");
    return value;
  }
  function query(req: Request, allowed: string[]) {
    for (const [name, value] of Object.entries(req.query))
      if (!allowed.includes(name) || typeof value !== "string")
        throw new AppError(
          400,
          "INVALID_QUERY",
          "Unknown or repeated query parameter.",
        );
    const page = req.query.page === undefined ? 1 : Number(req.query.page),
      pageSize =
        req.query.pageSize === undefined ? 20 : Number(req.query.pageSize);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      throw new AppError(422, "VALIDATION_FAILED", "Invalid pagination.", {
        "/query/page": "Use a positive page and pageSize from 1 to 100.",
      });
    return { page, pageSize };
  }
  function noQuery(req: Request) {
    query(req, []);
  }
  app.get(
    "/health",
    route(async (_req, res) => {
      const ready = await (config.ready?.() ?? service.store.ready());
      res
        .status(ready ? 200 : 503)
        .json({ status: ready ? "ready" : "unavailable" });
    }),
  );
  app.get(
    "/reviews",
    route(async (req, res) => {
      const { page, pageSize } = query(req, [
        "tutorId",
        "subjectId",
        "page",
        "pageSize",
      ]);
      const result = await service.list(
        id(req.query.tutorId),
        req.query.subjectId === undefined ? undefined : id(req.query.subjectId),
        page,
        pageSize,
      );
      validateRequest("ReviewPage", result);
      res.json(result);
    }),
  );
  app.post(
    "/bookings/:bookingId/review",
    route(async (req, res) => {
      noQuery(req);
      const result = await service.create(
        context(req, res, "createReview"),
        id(req.params.bookingId),
        req.body,
      );
      validateRequest("Review", result);
      res
        .status(201)
        .set(
          "Location",
          `/api/reviews?tutorId=${result.tutorId}&subjectId=${result.subjectId}`,
        )
        .set("ETag", `"${result.revision}"`)
        .json(result);
    }),
  );
  app.post(
    "/reviews/:reviewId/reply",
    route(async (req, res) => {
      noQuery(req);
      const result = await service.reply(
        context(req, res, "replyToReview"),
        id(req.params.reviewId),
        req.body,
      );
      validateRequest("Review", result);
      res.set("ETag", `"${result.revision}"`).json(result);
    }),
  );
  app.post(
    "/reviews/:reviewId/flags",
    route(async (req, res) => {
      noQuery(req);
      const result = await service.flag(
        context(req, res, "flagReview"),
        id(req.params.reviewId),
        req.body,
      );
      validateRequest("ReviewFlag", result);
      res
        .status(201)
        .set("Location", `/api/admin/review-flags`)
        .set("ETag", `"${result.revision}"`)
        .json(result);
    }),
  );
  app.get(
    "/admin/review-flags",
    route(async (req, res) => {
      const { page, pageSize } = query(req, ["page", "pageSize"]);
      const result = await service.flags(
        context(req, res, "listReviewFlags", false),
        page,
        pageSize,
      );
      validateRequest("FlagPage", result);
      res.json(result);
    }),
  );
  app.post(
    "/admin/reviews/:reviewId/moderation",
    route(async (req, res) => {
      noQuery(req);
      const result = await service.moderate(
        context(req, res, "moderateReview"),
        id(req.params.reviewId),
        req.body,
      );
      validateRequest("Review", result);
      res.set("ETag", `"${result.revision}"`).json(result);
    }),
  );
  app.get(
    "/internal/v1/review/operations/:operationId",
    route(async (req, res) => {
      noQuery(req);
      const result = await service.operation(
        context(req, res, "getOperation", false),
        id(req.params.operationId),
      );
      validateRequest("Operation", result);
      res.json(result);
    }),
  );
  app.use((_req, _res, next) =>
    next(new AppError(404, "NOT_FOUND", "Route is unavailable.")),
  );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const mapped =
        error instanceof SyntaxError
          ? new AppError(400, "MALFORMED_JSON", "Request JSON is invalid.")
          : error instanceof Error && error.name.startsWith("Mongo")
            ? new AppError(
                503,
                "DEPENDENCY_UNAVAILABLE",
                "Review storage is unavailable.",
                undefined,
                true,
              )
            : error;
      const result = toHttpError(mapped, res.locals.requestId as string);
      res.status(result.status).json(result.body);
    },
  );
  return app;
}
