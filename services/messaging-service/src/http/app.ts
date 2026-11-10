import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ActorVerifier, requireCapability, WorkloadAuthenticator, type Actor } from '../auth';
import type { MessagingService, Page, Reply, View } from '../domain';
import { AppError, asAppError, malformed, notFound, validation } from '../errors';
import { isUuid, newId } from '../ids';

export interface AppDeps {
  service: MessagingService;
  workload: WorkloadAuthenticator;
  actors: ActorVerifier;
  /** Reports whether the service can currently serve (database reachable). */
  ready: () => Promise<boolean>;
}

declare module 'express-serve-static-core' {
  interface Request { actor: Actor; requestId: string }
}

const FALLBACK_REQUEST_ID = '00000000-0000-4000-8000-000000000000';

const errorBody = (error: AppError, requestId: string) => ({ code: error.code, message: error.message, requestId, retryable: error.retryable, fields: error.fields });

const send = (res: Response, reply: Reply) => {
  for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
  if (reply.body === undefined) res.status(reply.status).end();
  else res.status(reply.status).json(reply.body);
};

function query(req: Request, allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.query)) {
    if (!allowed.includes(name)) throw malformed('UNKNOWN_QUERY_PARAMETER', `Unknown query parameter ${name}`);
    if (typeof value !== 'string') throw malformed('DUPLICATE_QUERY_PARAMETER', `Query parameter ${name} must appear once`);
    out[name] = value;
  }
  return out;
}

function viewOf(q: Record<string, string>): View {
  if (q.view === undefined) return 'STUDENT';
  if (q.view !== 'STUDENT' && q.view !== 'TUTOR' && q.view !== 'ADMIN') throw validation([{ path: '/query/view', code: 'INVALID', message: 'view must be STUDENT, TUTOR or ADMIN' }]);
  return q.view;
}

function pageOf(q: Record<string, string>): Page {
  const fields = [];
  const page = q.page === undefined ? 1 : Number(q.page);
  const pageSize = q.pageSize === undefined ? 20 : Number(q.pageSize);
  if (!Number.isInteger(page) || page < 1) fields.push({ path: '/query/page', code: 'INVALID', message: 'page must be an integer of at least 1' });
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fields.push({ path: '/query/pageSize', code: 'INVALID', message: 'pageSize must be between 1 and 100' });
  if (fields.length) throw validation(fields);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function idParam(req: Request, name: string): string {
  const value = req.params[name];
  if (!isUuid(value)) throw validation([{ path: `/path/${name}`, code: 'INVALID', message: 'Must be a UUID' }]);
  return value;
}

function idempotencyKey(req: Request): string {
  const key = req.get('idempotency-key');
  if (!key || !isUuid(key)) throw malformed('IDEMPOTENCY_KEY_REQUIRED', 'A UUID Idempotency-Key header is required');
  return key;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const supplied = req.get('x-request-id');
    if (supplied !== undefined && !isUuid(supplied)) {
      res.setHeader('X-Request-Id', FALLBACK_REQUEST_ID);
      res.status(400).json({ code: 'INVALID_REQUEST_ID', message: 'X-Request-Id must be a UUID', requestId: FALLBACK_REQUEST_ID, retryable: false, fields: [] });
      return;
    }
    req.requestId = supplied ?? newId();
    res.setHeader('X-Request-Id', req.requestId);
    // Private conversations are never cacheable.
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', async (_req, res) => {
    const ok = await deps.ready().catch(() => false);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable' });
  });

  app.use(express.json({ limit: '64kb', type: ['application/json', 'application/*+json'] }));

  const authenticate: RequestHandler = (req, _res, next) => {
    try {
      deps.workload.require(req.get('authorization'), ['gateway']);
      req.actor = deps.actors.verify(req.get('x-actor-context'));
      next();
    } catch (error) { next(error); }
  };

  const handle = (fn: (req: Request) => Promise<Reply>): RequestHandler => async (req, res, next) => {
    try {
      requireCapability(req.actor, 'STUDENT');
      send(res, await fn(req));
    } catch (error) { next(error); }
  };

  const rawBody = (req: Request): unknown => {
    if (req.body === undefined || req.body === null || typeof req.body !== 'object') throw malformed('INVALID_BODY', 'A JSON object body is required');
    return req.body;
  };

  const api = express.Router();
  api.use(authenticate);

  api.post('/messages', handle(async (req) => {
    query(req, []);
    return deps.service.send(req.actor, { body: rawBody(req), key: idempotencyKey(req), context: { requestId: req.requestId } });
  }));
  api.get('/messages/inbox', handle(async (req) => {
    const q = query(req, ['page', 'pageSize', 'view']);
    return { status: 200, body: await deps.service.inbox(req.actor, viewOf(q), pageOf(q)) };
  }));
  api.get('/messages/thread/:userId', handle(async (req) => {
    const q = query(req, ['view', 'cursor', 'limit']);
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw validation([{ path: '/query/limit', code: 'INVALID', message: 'limit must be between 1 and 100' }]);
    if (q.cursor !== undefined && (q.cursor.length < 1 || q.cursor.length > 2048)) throw validation([{ path: '/query/cursor', code: 'INVALID', message: 'cursor is not valid' }]);
    return { status: 200, body: await deps.service.thread(req.actor, idParam(req, 'userId'), viewOf(q), { cursor: q.cursor, limit }) };
  }));
  api.put('/messages/thread/:userId/read', handle(async (req) => {
    const q = query(req, ['view']);
    idempotencyKey(req);
    await deps.service.markRead(req.actor, idParam(req, 'userId'), viewOf(q), rawBody(req));
    return { status: 204 };
  }));

  // Messaging has no asynchronous public work, so no operation can exist behind the Gateway's status path.
  const internal = express.Router();
  internal.use(authenticate);
  internal.get('/messaging/operations/:operationId', (_req, _res, next) => next(notFound('NOT_FOUND', 'Operation not found')));
  app.use('/internal/v1', internal);

  // Traefik strips the public `/api` prefix before forwarding, so public operations are served un-prefixed.
  app.use(api);

  app.use((req, _res, next) => next(notFound('NOT_FOUND', `No route for ${req.method} ${req.path}`)));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const syntax = error as { type?: string };
    const mapped = syntax?.type === 'entity.parse.failed' ? malformed('INVALID_JSON', 'The request body is not valid JSON')
      : syntax?.type === 'entity.too.large' ? malformed('BODY_TOO_LARGE', 'The request body is too large')
      : asAppError(error);
    if (mapped.http >= 500 && mapped.code === 'INTERNAL') console.error(`[Messaging] request ${req.requestId ?? '-'} failed`, error);
    const requestId = req.requestId ?? FALLBACK_REQUEST_ID;
    res.setHeader('X-Request-Id', requestId);
    res.status(mapped.http).json(errorBody(mapped, requestId));
  });
  return app;
}
