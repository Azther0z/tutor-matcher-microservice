import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import express, { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import {
  AppError,
  signActorAssertion,
  toHttpError,
  validateRequest,
  validateSchema,
} from "@tutor-matcher/shared";

type Owner = "auth" | "tutor" | "booking" | "wallet" | "review" | "messaging" | "notification" | "gateway";
type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

interface OpenApiOperation {
  operationId: string;
  security?: Array<Record<string, unknown>>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: JsonSchema }>;
  [key: string]: unknown;
}

interface JsonSchema {
  $ref?: string;
  [key: string]: unknown;
}

export interface GatewayConfig {
  port: number;
  jwtSecret: string;
  gatewayPrivateKey: string;
  workloadCredential: string;
  authUrl: string;
  consulUrl?: string;
  serviceUrls: Record<Owner, string>;
  fetcher: typeof fetch;
  consulCacheMs: number;
  staleCacheMs: number;
  requestTimeoutMs: number;
}

interface ConsulEntry {
  Service?: { Address?: string; Port?: number; ID?: string };
  Node?: { Address?: string };
}

interface CachedTargets {
  refreshedAt: number;
  urls: string[];
}

interface Introspection {
  active: true;
  userId: string;
  sessionId: string;
  capabilities: string[];
  accountRevision: string;
}

const ownerToInternalPrefix: Record<Exclude<Owner, "gateway">, string> = {
  auth: "/internal/v1/auth",
  tutor: "/internal/v1/tutor",
  booking: "/internal/v1/booking",
  wallet: "/internal/v1/wallet",
  review: "/internal/v1/review",
  messaging: "/internal/v1/messaging",
  notification: "/internal/v1/notification",
};
const publicSpec = readJson(path.resolve(__dirname, "../../contracts/public.openapi.json")) as {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, JsonSchema> };
};
const sharedSchemas = readJson(path.resolve(__dirname, "../../contracts/schemas/v1.json")) as {
  $defs: Record<string, JsonSchema>;
};
const routeTable = Object.entries(publicSpec.paths)
  .flatMap(([contractPath, operations]) => Object.entries(operations)
    .filter(([method, operation]) => ["get", "post", "put", "patch", "delete", "head", "options"].includes(method.toLowerCase()) && !!operation?.operationId)
    .map(([method, operation]) => ({
      path: `/api${contractPath.replace(/\{([^}]+)\}/g, ":$1")}`,
      method: method.toLowerCase() as HttpMethod,
      operation,
    })))
  .sort((a, b) => countParams(a.path) - countParams(b.path) || b.path.length - a.path.length);
export const PUBLIC_ROUTE_COUNT = routeTable.length;

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function countParams(route: string): number {
  return [...route.matchAll(/:[^/]+/g)].length;
}

function defaultConfig(): GatewayConfig {
  const host = (name: string, fallback: string) => process.env[name] ?? fallback;
  return {
    port: Number(process.env.PORT ?? 8080),
    jwtSecret: process.env.JWT_SECRET ?? "",
    gatewayPrivateKey: readSecret("ACTOR_ASSERTION_PRIVATE_KEY") || readSecret("GATEWAY_PRIVATE_KEY"),
    workloadCredential: readSecret("GATEWAY_WORKLOAD_CREDENTIAL"),
    authUrl: host("AUTH_URL", "http://auth-service:4002"),
    consulUrl: process.env.CONSUL_URL?.replace(/\/$/, ""),
    serviceUrls: {
      auth: host("AUTH_URL", "http://auth-service:4002"),
      tutor: host("TUTOR_URL", "http://tutor-service:4001"),
      booking: host("BOOKING_URL", "http://booking-service:4004"),
      wallet: host("WALLET_URL", "http://wallet-service:4003"),
      review: host("REVIEW_URL", "http://review-service:4005"),
      messaging: host("MESSAGING_URL", "http://messaging-service:4006"),
      notification: host("NOTIFICATION_URL", "http://notification-service:4007"),
      gateway: "http://127.0.0.1:8080",
    },
    fetcher: fetch,
    consulCacheMs: 1000,
    staleCacheMs: 10_000,
    requestTimeoutMs: 5000,
  };
}

function readSecret(name: string): string {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  return process.env[name] ?? "";
}

export function createGatewayApp(config: GatewayConfig = defaultConfig()): express.Express {
  const app = express();
  const targetCache = new Map<string, CachedTargets>();
  let roundRobin = 0;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use((req, res, next) => {
    const candidate = req.get("x-request-id");
    if (candidate && !isUuid(candidate)) {
      return next(new AppError(400, "INVALID_REQUEST_ID", "X-Request-Id must be a UUID.", {
        "/headers/x-request-id": "Must be a UUID.",
      }));
    }
    const requestId = candidate && isUuid(candidate) ? candidate : randomUUID();
    res.setHeader("x-request-id", requestId);
    res.locals.requestId = requestId;
    next();
  });
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok", service: "api-gateway" }));

  const resolveTargets = async (owner: Exclude<Owner, "gateway">): Promise<string[]> => {
    const fixedFallback = config.serviceUrls[owner];
    if (!config.consulUrl) return [fixedFallback];
    const cached = targetCache.get(owner);
    if (cached && Date.now() - cached.refreshedAt < config.consulCacheMs) return rotate(cached.urls);
    try {
      const response = await config.fetcher(
        `${config.consulUrl}/v1/health/service/${owner}-service?passing=true`,
        { signal: AbortSignal.timeout(1000) },
      );
      if (!response.ok) throw new Error("Consul lookup failed");
      const entries = await response.json() as ConsulEntry[];
      const urls = entries.map((entry) => {
        const address = entry.Service?.Address || entry.Node?.Address;
        const port = entry.Service?.Port;
        if (!address || !port || /[/?#@]/.test(address)) return "";
        return `http://${address}:${port}`;
      }).filter(Boolean);
      if (urls.length === 0) return [];
      targetCache.set(owner, { refreshedAt: Date.now(), urls });
      return rotate(urls);
    } catch {
      if (cached && Date.now() - cached.refreshedAt <= config.staleCacheMs) return rotate(cached.urls);
      return [fixedFallback];
    }
  };

  function rotate(urls: string[]): string[] {
    if (urls.length <= 1) return urls;
    const start = roundRobin++ % urls.length;
    return [...urls.slice(start), ...urls.slice(0, start)];
  }

  const routeHandler = (operation: OpenApiOperation, owner: Owner) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      validatePublicRequest(operation, req);
      const requiredCapabilities = [...(operation["x-required-capabilities"] as string[] | undefined ?? [])];
      const selectedView = req.query.view;
      if ((selectedView === "STUDENT" || selectedView === "TUTOR" || selectedView === "ADMIN")
          && !requiredCapabilities.includes(selectedView)) requiredCapabilities.push(selectedView);
      const actor = operation.security?.length
        ? await admitActor(req, operation.operationId, requiredCapabilities ?? [], config)
        : undefined;
      if (operation.operationId === "getHealth") {
        return res.status(200).json({ status: "ok", service: "api-gateway" });
      }
      if (operation.operationId === "getOperation") {
        return await proxyOperationStatus(req, res, config, actor, resolveTargets);
      }
      return await proxyPublicRequest(req, res, config, owner, actor, resolveTargets);
    } catch (error) {
      next(error);
    }
  };

  for (const route of routeTable) {
    const owner = route.operation["x-owner"] as Owner | undefined;
    if (!owner || !(route.method in app)) continue;
    (app as unknown as Record<string, (path: string, handler: express.RequestHandler) => void>)[route.method](
      route.path,
      routeHandler(route.operation, owner),
    );
  }

  app.use((_req, res) => {
    const requestId = String(res.locals.requestId ?? randomUUID());
    const failure = toHttpError(new AppError(404, "ROUTE_NOT_FOUND", "Route not found."), requestId);
    res.status(failure.status).json(failure.body);
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = String(res.locals.requestId ?? randomUUID());
    res.setHeader("x-request-id", requestId);
    const normalized = error instanceof SyntaxError
      ? new AppError(400, "MALFORMED_JSON", "Request body is not valid JSON.")
      : error;
    if (!(normalized instanceof AppError)) {
      console.error("[Gateway] request failed", normalized instanceof Error ? normalized.message : "unknown error");
    }
    const failure = toHttpError(normalized, requestId);
    res.status(failure.status).json(failure.body);
  });
  return app;
}

async function admitActor(req: Request, operationId: string, requiredCapabilities: string[], config: GatewayConfig): Promise<string> {
  const authorization = req.get("authorization") ?? "";
  const tokenMatch = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!tokenMatch) throw new AppError(401, "UNAUTHENTICATED", "A valid session is required.");
  const browserToken = tokenMatch[1];
  try {
    jwt.verify(browserToken, config.jwtSecret, { algorithms: ["HS256"] });
  } catch {
    throw new AppError(401, "UNAUTHENTICATED", "The session is invalid or expired.");
  }
  if (!config.workloadCredential) throw new AppError(503, "AUTH_UNAVAILABLE", "Current authorization could not be checked.", undefined, true);
  let response: globalThis.Response;
  try {
    response = await config.fetcher(`${config.authUrl}/internal/v1/auth/introspections`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.workloadCredential}`,
        "content-type": "application/json",
        "x-request-id": String(req.res?.locals.requestId ?? randomUUID()),
      },
      body: JSON.stringify({ token: browserToken }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    throw new AppError(503, "AUTH_UNAVAILABLE", "Current authorization could not be checked.", undefined, true);
  }
  if (response.status === 401) {
    throw new AppError(401, "UNAUTHENTICATED", "The session is invalid or revoked.");
  }
  if (response.status === 403) throw new AppError(403, "ACCOUNT_RESTRICTED", "The account is not allowed to continue.");
  if (!response.ok) throw new AppError(503, "AUTH_UNAVAILABLE", "Current authorization could not be checked.", undefined, true);
  let current: Introspection;
  try {
    current = await response.json() as Introspection;
  } catch {
    throw new AppError(503, "AUTH_UNAVAILABLE", "Current authorization response was invalid.", undefined, true);
  }
  try {
    validateRequest("Introspection", current);
  } catch {
    throw new AppError(503, "AUTH_UNAVAILABLE", "Current authorization response was invalid.", undefined, true);
  }
  if (current.active !== true || !isUuid(current.userId) || !isUuid(current.sessionId)
      || !Array.isArray(current.capabilities) || typeof current.accountRevision !== "string") {
    throw new AppError(503, "AUTH_UNAVAILABLE", "Current authorization response was invalid.", undefined, true);
  }
  if (requiredCapabilities.some((capability) => !current.capabilities.includes(capability))) {
    throw new AppError(403, "CAPABILITY_REQUIRED", "The account does not have the capability required for this operation.");
  }
  const requestId = String(req.res?.locals.requestId ?? randomUUID());
  const actorView = parseView(req.query.view);
  return signActorAssertion({
    userId: current.userId,
    sessionId: current.sessionId,
    admissionId: randomUUID(),
    admittedAt: new Date().toISOString(),
    requestId,
    publicOperation: operationId,
    capabilities: current.capabilities,
    accountRevision: current.accountRevision,
    ...(actorView ? { view: actorView } : {}),
    purpose: "USER_ACTION",
  }, config.gatewayPrivateKey);
}

function parseView(input: unknown): "STUDENT" | "TUTOR" | "ADMIN" | undefined {
  if (input === undefined) return undefined;
  if (input === "STUDENT" || input === "TUTOR" || input === "ADMIN") return input;
  throw new AppError(422, "VALIDATION_FAILED", "Invalid view parameter.", { "/view": "Must be STUDENT, TUTOR, or ADMIN." });
}

async function proxyOperationStatus(
  req: Request,
  res: Response,
  config: GatewayConfig,
  actor: string | undefined,
  resolveTargets: (owner: Exclude<Owner, "gateway">) => Promise<string[]>,
): Promise<void> {
  const rawOwner = req.params.owner;
  const owner = (Array.isArray(rawOwner) ? rawOwner[0] : rawOwner) as Owner;
  const rawOperationId = req.params.operationId;
  const operationId = Array.isArray(rawOperationId) ? rawOperationId[0] : rawOperationId;
  if (!Object.hasOwn(ownerToInternalPrefix, owner) || !isUuid(operationId)) {
    throw new AppError(404, "NOT_FOUND", "Operation was not found.");
  }
  const internalOwner = owner as Exclude<Owner, "gateway">;
  const targets = await resolveTargets(internalOwner);
  const suffix = `/operations/${operationId}`;
  if (targets.length === 0) throw new AppError(503, "DEPENDENCY_UNAVAILABLE", `${owner} service has no healthy instances.`, undefined, true);
  const path = `${ownerToInternalPrefix[internalOwner]}${suffix}`;
  for (const target of targets.slice(0, 2)) {
    try {
      await forward(req, res, target, path, config, actor);
      return;
    } catch {
      // Read-only status can move to the next currently healthy instance.
    }
  }
  throw new AppError(503, "DEPENDENCY_UNAVAILABLE", `${owner} service is unavailable.`, undefined, true);
}

async function proxyPublicRequest(
  req: Request,
  res: Response,
  config: GatewayConfig,
  owner: Owner,
  actor: string | undefined,
  resolveTargets: (owner: Exclude<Owner, "gateway">) => Promise<string[]>,
): Promise<void> {
  if (owner === "gateway") throw new AppError(404, "NOT_FOUND", "Route not found.");
  const ownerName = owner as Exclude<Owner, "gateway">;
  const targets = await resolveTargets(ownerName);
  const forwardedPath = req.originalUrl.replace(/^\/api(?=\/|\?|$)/, "") || "/";
  const attempts = req.method === "GET" || req.method === "HEAD" ? targets.slice(0, 2) : targets.slice(0, 1);
  for (let index = 0; index < attempts.length; index += 1) {
    try {
      await forward(req, res, attempts[index], forwardedPath, config, actor);
      return;
    } catch {
      if (index === attempts.length - 1 || !(req.method === "GET" || req.method === "HEAD")) {
        throw new AppError(503, "DEPENDENCY_UNAVAILABLE", `${owner} service is unavailable.`, undefined, true);
      }
    }
  }
  throw new AppError(503, "DEPENDENCY_UNAVAILABLE", `${owner} service is unavailable.`, undefined, true);
}

async function forward(req: Request, res: Response, target: string, forwardedPath: string, config: GatewayConfig, actor?: string): Promise<void> {
  const url = new URL(forwardedPath, `${target}/`);
  const headers = new Headers();
  for (const name of ["accept", "content-type", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "idempotency-key", "prefer"]) {
    const value = req.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-request-id", String(res.locals.requestId));
  headers.set("authorization", `Bearer ${config.workloadCredential}`);
  if (actor) headers.set("x-actor-context", actor);
  const hasBody = req.body !== undefined && !["GET", "HEAD"].includes(req.method);
  const response = await config.fetcher(url, {
    method: req.method,
    headers,
    body: hasBody ? JSON.stringify(req.body) : undefined,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  res.status(response.status);
  for (const name of ["content-type", "etag", "cache-control", "location", "retry-after", "idempotency-replayed", "x-operation-id"]) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length) res.send(body);
  else res.end();
}

function validatePublicRequest(operation: OpenApiOperation, req: Request): void {
  const params = operation.parameters ?? [];
  if (requestHasBytes(req)) {
    const mediaType = (req.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      throw new AppError(400, "UNSUPPORTED_MEDIA_TYPE", "Request body must use application/json.", {
        "/headers/content-type": "Unsupported request body media type.",
      });
    }
  }

  const matchHeader = req.get("if-match");
  const noneMatchHeader = req.get("if-none-match");
  if (operation.operationId === "putAvailabilitySlot" && !matchHeader && !noneMatchHeader) {
    throw new AppError(428, "PRECONDITION_REQUIRED", "If-Match or If-None-Match is required.");
  }
  if (operation.operationId === "putAvailabilitySlot" && matchHeader && noneMatchHeader) {
    throw new AppError(400, "CONFLICTING_PRECONDITIONS", "Use exactly one conditional request header.");
  }

  const queryParams = params.filter((item) => item.in === "query");
  const allowed = new Set(queryParams.map((item) => item.name));
  const query = new URL(req.originalUrl, "http://gateway.local").searchParams;
  const entries = [...new URL(req.originalUrl, "http://gateway.local").searchParams.entries()];
  const seen = new Set<string>();
  for (const [name] of entries) {
    if (seen.has(name)) throw new AppError(400, "DUPLICATE_QUERY_PARAMETER", `Duplicate query parameter: ${name}`);
    seen.add(name);
    if (!allowed.has(name)) throw new AppError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${name}`);
  }
  for (const parameter of params) {
    const schema = parameter.schema ? resolveSchema(parameter.schema) : undefined;
    if (parameter.in === "query") {
      const raw = query.get(parameter.name);
      if (raw === null) {
        if (parameter.required) throw new AppError(400, "MISSING_QUERY_PARAMETER", `Missing query parameter: ${parameter.name}`, {
          [`/query/${escapeJsonPointerSegment(parameter.name)}`]: "Required.",
        });
        continue;
      }
      const value = coerceQueryValue(raw, schema, parameter.name);
      if (schema) validateLocatedSchema(schema, value, "query", parameter.name);
    } else if (parameter.in === "path") {
      const raw = req.params[parameter.name];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (parameter.required && value === undefined) throw new AppError(400, "MISSING_PATH_PARAMETER", `Missing path parameter: ${parameter.name}`, {
        [`/path/${escapeJsonPointerSegment(parameter.name)}`]: "Required.",
      });
      if (schema && value !== undefined) validateLocatedSchema(schema, value, "path", parameter.name);
    } else if (parameter.in === "header") {
      const value = req.get(parameter.name);
      if (parameter.required && value === undefined) {
        const isPrecondition = ["if-match", "if-none-match"].includes(parameter.name.toLowerCase());
        throw new AppError(
          isPrecondition ? 428 : 400,
          isPrecondition ? "PRECONDITION_REQUIRED" : "MISSING_HEADER_PARAMETER",
          isPrecondition ? `${parameter.name} is required.` : `Missing header: ${parameter.name}`,
          { [`/headers/${escapeJsonPointerSegment(parameter.name.toLowerCase())}`]: "Required." },
        );
      }
      if (schema && value !== undefined) validateLocatedSchema(schema, value, "headers", parameter.name.toLowerCase());
    }
  }
  if (operation.security?.length && req.query.view !== undefined) parseView(req.query.view);
  const requestBody = operation.requestBody;
  const bodySchema = requestBody?.content?.["application/json"]?.schema;
  if (!bodySchema) return;
  if (requestBody?.required && req.body === undefined) {
    throw new AppError(422, "VALIDATION_FAILED", "Request body is required.");
  }
  if (req.body === undefined) return;
  validateSchema(resolveSchema(bodySchema), req.body);
}

function coerceQueryValue(raw: string, schema: JsonSchema | undefined, name: string): unknown {
  if (schema?.type === "integer" || schema?.type === "number") {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
      throw invalidQueryParameter(name);
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
      throw invalidQueryParameter(name);
    }
    return value;
  }
  if (schema?.type === "boolean") {
    if (raw !== "true" && raw !== "false") throw invalidQueryParameter(name);
    return raw === "true";
  }
  return raw;
}

function requestHasBytes(req: Request): boolean {
  const contentLength = Number(req.get("content-length") ?? 0);
  return req.body !== undefined || (Number.isFinite(contentLength) && contentLength > 0) || req.get("transfer-encoding") !== undefined;
}

function validateLocatedSchema(schema: JsonSchema, value: unknown, location: "query" | "path" | "headers", name: string): void {
  try {
    validateSchema(schema, value);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const base = `/${location}/${escapeJsonPointerSegment(name)}`;
    const fields = Object.fromEntries(Object.entries(error.fields ?? {}).map(([path, message]) => {
      const suffix = !path || path === "/" ? "" : path;
      return [`${base}${suffix}`, message];
    }));
    throw new AppError(error.status, error.code, error.message, fields, error.retryable);
  }
}

function invalidQueryParameter(name: string): AppError {
  return new AppError(400, "INVALID_QUERY_PARAMETER", `Invalid query parameter: ${name}`, {
    [`/query/${escapeJsonPointerSegment(name)}`]: "Invalid value.",
  });
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function resolveSchema(schema: JsonSchema, stack = new Set<string>()): JsonSchema {
  if (schema.$ref) {
    const ref = schema.$ref;
    if (stack.has(ref)) return { $ref: ref };
    const nextStack = new Set(stack).add(ref);
    if (ref.startsWith("#/components/schemas/")) {
      const name = ref.slice("#/components/schemas/".length);
      const component = publicSpec.components.schemas[name];
      if (!component) throw new AppError(500, "SCHEMA_NOT_FOUND", `OpenAPI schema ${name} is missing.`);
      return resolveSchema(component, nextStack);
    }
    if (ref.startsWith("./schemas/v1.json#/$defs/")) {
      const name = ref.slice("./schemas/v1.json#/$defs/".length);
      const definition = sharedSchemas.$defs[name];
      if (!definition) throw new AppError(500, "SCHEMA_NOT_FOUND", `Shared schema ${name} is missing.`);
      return resolveSchema(definition, nextStack);
    }
    if (ref.startsWith("#/$defs/")) {
      const name = ref.slice("#/$defs/".length);
      const definition = sharedSchemas.$defs[name];
      if (!definition) throw new AppError(500, "SCHEMA_NOT_FOUND", `Shared schema ${name} is missing.`);
      return resolveSchema(definition, nextStack);
    }
    return { $ref: ref };
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value && typeof value === "object") {
      if (Array.isArray(value)) copy[key] = value.map((item) => item && typeof item === "object" ? resolveSchema(item as JsonSchema, stack) : item);
      else copy[key] = resolveSchema(value as JsonSchema, stack);
    } else copy[key] = value;
  }
  return copy;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

if (require.main === module) {
  const config = defaultConfig();
  if (!config.jwtSecret || !config.gatewayPrivateKey || !config.workloadCredential) {
    throw new Error("JWT_SECRET, GATEWAY_PRIVATE_KEY and GATEWAY_WORKLOAD_CREDENTIAL are required.");
  }
  createGatewayApp(config).listen(config.port, "0.0.0.0", () => {
    console.log(`[Gateway] listening on port ${config.port}`);
  });
}
