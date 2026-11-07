import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ActorVerifier, requireCapability, WorkloadAuthenticator, type Actor } from '../auth';
import type { Contracts } from '../contracts';
import { preferenceView, replacePreferences, loadPreferences, PREFERENCE_KEYS } from '../domain/preferences';
import { asAppError, conflict, malformed, notFound, preconditionRequired, validation } from '../errors';
import { isUuid, newId } from '../ids';
import { canonicalHash } from '../domain/events';
import { inTransaction, type DeliveryDoc, type Store } from '../store';
import type { Clock } from '../time';

export interface AppDeps {
  store: Store;
  clock: Clock;
  contracts: Contracts;
  workload: WorkloadAuthenticator;
  actors: ActorVerifier;
  ready: () => Promise<boolean>;
}

declare module 'express-serve-static-core' {
  interface Request { actor: Actor; requestId: string }
}

interface Reply { status: number; body?: unknown; headers?: Record<string, string> }
const FALLBACK_REQUEST_ID = '00000000-0000-4000-8000-000000000000';

const send = (res: Response, reply: Reply) => {
  for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
  if (reply.body === undefined) res.status(reply.status).end(); else res.status(reply.status).json(reply.body);
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

function paging(q: Record<string, string>) {
  const page = q.page === undefined ? 1 : Number(q.page);
  const pageSize = q.pageSize === undefined ? 20 : Number(q.pageSize);
  const fields = [];
  if (!Number.isInteger(page) || page < 1) fields.push({ path: '/query/page', code: 'INVALID', message: 'page must be an integer of at least 1' });
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fields.push({ path: '/query/pageSize', code: 'INVALID', message: 'pageSize must be between 1 and 100' });
  if (fields.length) throw validation(fields);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** Internal reasons stay internal; only user-meaningful skip reasons are shown. */
const SKIP_REASON: Record<string, string | null> = { PREFERENCE_DISABLED: 'PREFERENCE_DISABLED', REMINDER_SUPPRESSED: 'NO_LONGER_RELEVANT', EXPIRED: null };

export function receiptView(d: DeliveryDoc) {
  return {
    id: d._id, eventId: d.eventId, recipientUserId: d.recipientUserId, channel: d.channel, category: d.category, status: d.status, demo: true as const,
    createdAt: d.createdAt.toISOString(), deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
    // Additive, non-sensitive fields: what the event was, and why a notification was skipped (if the user should know).
    eventType: d.eventType, summary: d.summary, skipReason: d.status === 'SKIPPED' ? (SKIP_REASON[d.reason ?? ''] ?? null) : null,
  };
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const { store } = deps;

  app.use((req, res, next) => {
    const supplied = req.get('x-request-id');
    if (supplied !== undefined && !isUuid(supplied)) {
      res.setHeader('X-Request-Id', FALLBACK_REQUEST_ID);
      res.status(400).json({ code: 'INVALID_REQUEST_ID', message: 'X-Request-Id must be a UUID', requestId: FALLBACK_REQUEST_ID, retryable: false, fields: [] });
      return;
    }
    req.requestId = supplied ?? newId();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', async (_req, res) => {
    const ok = await deps.ready().catch(() => false);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable' });
  });

  app.use(express.json({ limit: '64kb' }));

  const authenticate: RequestHandler = (req, _res, next) => {
    try {
      deps.workload.require(req.get('authorization'), ['gateway']);
      req.actor = deps.actors.verify(req.get('x-actor-context'));
      next();
    } catch (error) { next(error); }
  };
  const handle = (fn: (req: Request) => Promise<Reply>): RequestHandler => async (req, res, next) => {
    try { send(res, await fn(req)); } catch (error) { next(error); }
  };

  const api = express.Router();
  api.use(authenticate);

  api.get('/notifications', handle(async (req) => {
    requireCapability(req.actor, 'STUDENT');
    const { page, pageSize, skip } = paging(query(req, ['page', 'pageSize']));
    const filter = { recipientUserId: req.actor.userId };
    const [total, rows] = await Promise.all([
      store.deliveries.countDocuments(filter),
      store.deliveries.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(pageSize).toArray(),
    ]);
    return { status: 200, body: { items: rows.map(receiptView), pagination: { page, pageSize, totalItems: total, totalPages: total === 0 ? 0 : Math.ceil(total / pageSize) } } };
  }));

  api.get('/notifications/preferences', handle(async (req) => {
    requireCapability(req.actor, 'STUDENT');
    query(req, []);
    const prefs = await loadPreferences(store, req.actor.userId, deps.clock.now());
    return { status: 200, body: preferenceView(prefs), headers: { ETag: `"${prefs.revision}"` } };
  }));

  api.put('/notifications/preferences', handle(async (req) => {
    requireCapability(req.actor, 'STUDENT');
    query(req, []);
    const match = req.get('if-match');
    if (match === undefined) throw preconditionRequired('PRECONDITION_REQUIRED', 'If-Match is required');
    const revisionMatch = /^"((?:0|[1-9]\d*))"$/.exec(match.trim());
    if (!revisionMatch) throw malformed('INVALID_IF_MATCH', 'If-Match must be a quoted revision');
    const key = req.get('idempotency-key');
    if (!key || !isUuid(key)) throw malformed('IDEMPOTENCY_KEY_REQUIRED', 'A UUID Idempotency-Key header is required');
    const input = deps.contracts.assertDef<Record<(typeof PREFERENCE_KEYS)[number], { email: boolean; push: boolean }>>('PreferencesWrite', req.body);

    const scopeId = `${req.actor.userId}|PUT|/api/notifications/preferences|${key}`;
    const hash = canonicalHash(input);
    const run = () => inTransaction(store, async (session) => {
      const existing = await store.idempotency.findOne({ _id: scopeId }, { session });
      if (existing) {
        // A replay is resolved before the stale-precondition check, so a lost success stays recoverable.
        if (existing.hash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with different input');
        return { status: existing.status, body: existing.body, headers: { ...existing.headers, 'Idempotent-Replay': 'true' } } as Reply;
      }
      const now = deps.clock.now();
      const updated = await replacePreferences(store, req.actor.userId, revisionMatch[1], input, now, session);
      const operationId = newId();
      await store.operations.insertOne({
        _id: operationId, kind: 'notification.preferences', initiatorUserId: req.actor.userId, status: 'SUCCEEDED',
        resource: { type: 'notification-preferences', id: req.actor.userId, url: '/api/notifications/preferences' }, error: null, createdAt: now, updatedAt: now,
      }, { session });
      const reply: Reply = { status: 200, body: preferenceView(updated), headers: { ETag: `"${updated.revision}"` } };
      await store.idempotency.insertOne({ _id: scopeId, hash, status: reply.status, body: reply.body, headers: reply.headers!, createdAt: now }, { session });
      return reply;
    });
    try { return await run(); } catch (error) {
      // Two first requests with one key race on the unique _id: the loser reruns and replays the winner.
      if ((error as { code?: number }).code === 11000) return run();
      throw error;
    }
  }));

  app.use('/api', api);

  const internal = express.Router();
  internal.use(authenticate);
  internal.get('/notification/operations/:operationId', handle(async (req) => {
    query(req, []);
    if (!isUuid(req.params.operationId)) throw validation([{ path: '/path/operationId', code: 'INVALID', message: 'Must be a UUID' }]);
    const op = await store.operations.findOne({ _id: req.params.operationId });
    // The initiating user or a responsible admin may read it; anyone else sees 404.
    if (!op || (op.initiatorUserId !== req.actor.userId && !req.actor.capabilities.includes('ADMIN'))) throw notFound('NOT_FOUND', 'Operation not found');
    return { status: 200, body: { id: op._id, owner: 'notification', status: op.status, kind: op.kind, resource: op.resource, error: null, createdAt: op.createdAt.toISOString(), updatedAt: op.updatedAt.toISOString() } };
  }));
  app.use('/internal/v1', internal);

  app.use((req, _res, next) => next(notFound('NOT_FOUND', `No route for ${req.method} ${req.path}`)));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const parse = error as { type?: string };
    const app = parse?.type === 'entity.parse.failed' ? malformed('INVALID_JSON', 'The request body is not valid JSON')
      : parse?.type === 'entity.too.large' ? malformed('BODY_TOO_LARGE', 'The request body is too large') : asAppError(error);
    if (app.code === 'INTERNAL') console.error(`[Notification] request ${req.requestId ?? '-'} failed`, error);
    const requestId = req.requestId ?? FALLBACK_REQUEST_ID;
    res.setHeader('X-Request-Id', requestId);
    res.status(app.http).json({ code: app.code, message: app.message, requestId, retryable: app.retryable, fields: app.fields });
  });
  return app;
}

