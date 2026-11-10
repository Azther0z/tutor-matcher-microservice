import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AppError,
  toHttpError,
  validateRequest,
  validateSchema,
  verifyActorAssertion,
  verifyWorkload,
  type ActorClaims,
} from "@tutor-matcher/shared";
import { learningAreas, requireCapability, type TutorService } from "./service";
import type { CommandContext, Result } from "./types";
type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  schema: Record<string, unknown>;
};
type SpecOperation = {
  operationId: string;
  parameters?: Parameter[];
  security?: unknown[];
  responses?: Record<
    string,
    { content?: Record<string, { schema?: { $ref?: string } }> }
  >;
  "x-required-capabilities"?: string[];
};
const spec = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "../../../contracts/public.openapi.json"),
    "utf8",
  ),
) as { paths: Record<string, Record<string, SpecOperation>> };
const operations = new Map(
  Object.values(spec.paths)
    .flatMap((methods) => Object.values(methods))
    .map((op) => [op.operationId, op]),
);
function trace(req: Request) {
  return String(req.res?.getHeader("X-Request-Id") ?? randomUUID());
}
function actor(req: Request, operation: string): ActorClaims {
  const credential = process.env.GATEWAY_WORKLOAD_CREDENTIAL ?? "";
  verifyWorkload(req.get("authorization"), credential, "gateway", operation, {
    gateway: [operation],
  });
  const signed = req.get("x-actor-context");
  const key = process.env.ACTOR_ASSERTION_PUBLIC_KEY;
  if (!signed || !key)
    throw new AppError(
      401,
      "INVALID_ACTOR_ASSERTION",
      "Gateway admission is required.",
    );
  const claims = verifyActorAssertion(signed, key);
  if (claims.publicOperation !== operation || claims.requestId !== trace(req))
    throw new AppError(
      403,
      "FORBIDDEN",
      "Admission does not match this action.",
    );
  for (const capability of operations.get(operation)?.[
    "x-required-capabilities"
  ] ?? [])
    requireCapability(claims, capability);
  return claims;
}
function params(req: Request, operation: string): Record<string, unknown> {
  if (req.get("If-Match") && req.get("If-None-Match"))
    throw new AppError(
      400,
      "VALIDATION_FAILED",
      "Conflicting revision preconditions.",
    );
  const declared = operations.get(operation)?.parameters ?? [];
  const known = new Set(
    declared.filter((p) => p.in === "query").map((p) => p.name),
  );
  if (operation === "searchTutorSubjects") known.add("preferredLearningAreas");
  const actual = new URL(req.originalUrl, "http://owner.invalid").searchParams;
  for (const name of new Set(actual.keys()))
    if (!known.has(name) || actual.getAll(name).length !== 1)
      throw new AppError(
        400,
        "VALIDATION_FAILED",
        "Unknown or duplicate query parameter.",
      );
  const values: Record<string, unknown> = {};
  for (const parameter of declared) {
    let raw: unknown =
      parameter.in === "query"
        ? (actual.get(parameter.name) ?? undefined)
        : parameter.in === "path"
          ? req.params[parameter.name]
          : req.get(parameter.name);
    if (raw === undefined) {
      if (parameter.required)
        throw new AppError(
          ["If-Match", "Idempotency-Key"].includes(parameter.name) ? 428 : 422,
          "PRECONDITION_REQUIRED",
          "A required parameter is missing.",
        );
      continue;
    }
    const schema = parameter.schema;
    const ref = schema.$ref;
    if (typeof ref === "string") {
      const name = ref.split("/").at(-1)!;
      if (parameter.in === "query" || parameter.in === "path")
        validateRequest(name, raw);
      continue;
    }
    if (schema.type === "integer" || schema.type === "number") {
      if (
        typeof raw !== "string" ||
        raw.trim() === "" ||
        !Number.isFinite(Number(raw))
      )
        throw new AppError(
          422,
          "VALIDATION_FAILED",
          "Query parameter must be numeric.",
        );
      raw = Number(raw);
    }
    validateSchema(schema, raw);
    if (parameter.in === "query") values[parameter.name] = raw;
  }
  for (const parameter of declared.filter(
    (p) => p.in === "query" && typeof p.schema.$ref === "string",
  )) {
    const value = actual.get(parameter.name);
    if (value !== null) values[parameter.name] = value;
  }
  const preferred = actual.get("preferredLearningAreas");
  if (preferred !== null) {
    const areas = preferred.split(",");
    if (
      areas.length > 30 ||
      new Set(areas).size !== areas.length ||
      areas.some((value) => !learningAreas.some((area) => area.id === value))
    )
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Preferred learning areas are invalid.",
      );
    values.preferredLearningAreas = areas;
  }
  return values;
}
function context(req: Request, claims: ActorClaims): CommandContext {
  return {
    actor: claims,
    idempotencyKey: req.get("Idempotency-Key") ?? "",
    ifMatch: req.get("If-Match"),
    route: req.path,
    method: req.method,
  };
}
function respond(res: Response, result: Result) {
  if (result.revision !== undefined)
    res.setHeader("ETag", `"${result.revision}"`);
  if (result.location) res.setHeader("Location", result.location);
  if (result.status === 204) res.status(204).end();
  else res.status(result.status).json(result.body);
}
export function createTutorApp(
  service: TutorService,
  healthy: () => Promise<boolean> = async () => true,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, _res, next) => {
    if (
      !req.url.startsWith("/api/") &&
      !req.url.startsWith("/internal/") &&
      req.url !== "/health"
    )
      req.url = `/api${req.url}`;
    next();
  });
  app.use((req, res, next) => {
    const input = req.get("x-request-id");
    if (input) {
      try {
        validateRequest("Id", input);
      } catch (error) {
        next(error);
        return;
      }
    }
    res.setHeader("X-Request-Id", input ?? randomUUID());
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", async (_req, res) => {
    let ready = false;
    try {
      ready = await healthy();
    } catch {
      ready = false;
    }
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? "ok" : "unavailable" });
  });
  const add = (
    method: "get" | "post" | "put" | "patch" | "delete",
    route: string,
    id: string,
    run: (
      req: Request,
      res: Response,
      claims: ActorClaims | undefined,
      query: Record<string, unknown>,
    ) => Promise<void>,
  ) => {
    app[method](route, async (req, res, next) => {
      try {
        const query = params(req, id);
        const protectedRoute = Boolean(operations.get(id)?.security?.length);
        const claims = protectedRoute ? actor(req, id) : undefined;
        if (protectedRoute) res.setHeader("Cache-Control", "no-store");
        const originalJson = res.json.bind(res);
        res.json = (body: unknown) => {
          if (res.statusCode < 300) {
            const ref =
              operations.get(id)?.responses?.[String(res.statusCode)]
                ?.content?.["application/json"]?.schema?.$ref;
            if (ref) validateRequest(ref.split("/").at(-1)!, body);
          }
          return originalJson(body);
        };
        await run(req, res, claims, query);
      } catch (error) {
        next(error);
      }
    });
  };
  add(
    "get",
    "/api/profiles/me/tutor",
    "getTutorWorkspace",
    async (_req, res, claims) => {
      const result = await service.getWorkspace(claims!.userId);
      res.setHeader("ETag", `"${result.revision}"`);
      res.json(result);
    },
  );
  add(
    "post",
    "/api/profiles/me/tutor/drafts",
    "createTutorDraft",
    async (req, res, claims) =>
      respond(res, await service.createDraft(context(req, claims!), req.body)),
  );
  add(
    "put",
    "/api/profiles/me/tutor/drafts/:draftId",
    "updateTutorDraft",
    async (req, res, claims) =>
      respond(
        res,
        await service.updateDraft(
          context(req, claims!),
          String(req.params.draftId),
          req.body,
        ),
      ),
  );
  add(
    "delete",
    "/api/profiles/me/tutor/drafts/:draftId",
    "deleteTutorDraft",
    async (req, res, claims) =>
      respond(
        res,
        await service.deleteDraft(
          context(req, claims!),
          String(req.params.draftId),
        ),
      ),
  );
  add(
    "post",
    "/api/profiles/me/tutor/drafts/:draftId/submit",
    "submitTutorDraft",
    async (req, res, claims) =>
      respond(
        res,
        await service.submit(
          context(req, claims!),
          String(req.params.draftId),
          req.body,
        ),
      ),
  );
  add(
    "post",
    "/api/profiles/me/tutor/withdraw",
    "withdrawTutorSubmission",
    async (req, res, claims) =>
      respond(res, await service.withdraw(context(req, claims!), req.body)),
  );
  add(
    "post",
    "/api/profiles/me/tutor/submissions/:submissionId/copy",
    "copyTutorSubmission",
    async (req, res, claims) =>
      respond(
        res,
        await service.copy(
          context(req, claims!),
          String(req.params.submissionId),
        ),
      ),
  );
  add(
    "patch",
    "/api/profiles/me/tutor/publication",
    "setTutorPublication",
    async (req, res, claims) =>
      respond(res, await service.publication(context(req, claims!), req.body)),
  );
  add(
    "get",
    "/api/admin/tutor-requests",
    "listTutorRequests",
    async (_req, res, _claims, query) => {
      res.json(await service.listRequests(query));
    },
  );
  add(
    "get",
    "/api/admin/tutor-requests/:submissionId",
    "getTutorRequest",
    async (req, res) => {
      const result = await service.request(String(req.params.submissionId));
      res.setHeader("ETag", `"${result.revision}"`);
      res.json(result);
    },
  );
  add(
    "post",
    "/api/admin/tutor-requests/:submissionId/review",
    "reviewTutorSubmission",
    async (req, res, claims) =>
      respond(
        res,
        await service.review(
          context(req, claims!),
          String(req.params.submissionId),
          req.body,
        ),
      ),
  );
  add(
    "get",
    "/api/profiles/me/tutor/subjects",
    "listOwnSubjects",
    async (_req, res, claims, query) => {
      res.json(await service.ownSubjects(claims!, query));
    },
  );
  add(
    "post",
    "/api/profiles/me/tutor/subjects",
    "createSubject",
    async (req, res, claims) =>
      respond(
        res,
        await service.createSubject(context(req, claims!), req.body),
      ),
  );
  add(
    "put",
    "/api/profiles/me/tutor/subjects/:subjectId",
    "updateSubject",
    async (req, res, claims) =>
      respond(
        res,
        await service.updateSubject(
          context(req, claims!),
          String(req.params.subjectId),
          req.body,
        ),
      ),
  );
  add(
    "get",
    "/api/discovery/learning-areas",
    "getLearningAreas",
    async (_req, res) => {
      res.json({ items: learningAreas });
    },
  );
  add(
    "get",
    "/api/discovery/price-range",
    "getSearchPriceRange",
    async (_req, res) => {
      res.json(await service.priceRange());
    },
  );
  add(
    "get",
    "/api/discovery/tutors",
    "searchTutorSubjects",
    async (_req, res, _claims, query) => {
      res.json(await service.search(query));
    },
  );
  add(
    "get",
    "/api/discovery/tutors/:tutorId/profile",
    "getPublicTutor",
    async (req, res) => {
      res.json(await service.publicTutor(String(req.params.tutorId)));
    },
  );
  add(
    "get",
    "/api/discovery/tutors/:tutorId/subjects/:subjectId",
    "getPublicSubject",
    async (req, res, _claims, query) => {
      res.json(
        await service.publicSubject(
          String(req.params.tutorId),
          String(req.params.subjectId),
          query.date as string | undefined,
        ),
      );
    },
  );
  app.get(
    "/internal/v1/tutor/operations/:operationId",
    async (req, res, next) => {
      try {
        validateRequest("Id", req.params.operationId);
        const claims = actor(req, "getOperation");
        res.setHeader("Cache-Control", "no-store");
        res.json(
          await service.operation(claims, String(req.params.operationId)),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  app.use((_req, _res, next) =>
    next(new AppError(404, "NOT_FOUND", "Route was not found.")),
  );
  app.use(
    (error: unknown, req: Request, res: Response, _next: NextFunction) => {
      const failure =
        error instanceof SyntaxError
          ? new AppError(400, "INVALID_JSON", "Request JSON is malformed.")
          : error;
      const result = toHttpError(failure, trace(req));
      res.status(result.status).json(result.body);
    },
  );
  return app;
}
