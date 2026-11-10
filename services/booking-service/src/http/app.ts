import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import { ActorVerifier, requireCapability, WorkloadAuthenticator, type Actor, type Capability } from '../auth';
import type { Peers } from '../clients';
import type { Config } from '../config';
import type { Contracts } from '../contracts';
import { createBooking, getBooking, listBookings, tutorNeedsConfirmation, tutorUpcoming } from '../domain/bookings';
import { cancelBooking, issueQuote } from '../domain/cancellation';
import type { Ctx } from '../domain/context';
import { completeBooking, putMeetingOverride, setDemoOutcome } from '../domain/lifecycle';
import { etag } from '../domain/model';
import { readOperation } from '../domain/operations';
import { payBooking } from '../domain/payments';
import type { Page, Reply } from '../domain/reply';
import { ownCalendar, ownDay, putSlot } from '../domain/slots';
import { AppError, asAppError, forbidden, malformed, notFound, preconditionRequired, validation } from '../errors';
import { isUuid, newId } from '../ids';
import type { Clock } from '../time';
import { IdempotencyStore, inputHash, type IdempotencyScope } from './idempotency';

export interface AppDeps {
  pool: Pool;
  clock: Clock;
  config: Pick<Config, 'demoMode'>;
  contracts: Contracts;
  workload: WorkloadAuthenticator;
  actors: ActorVerifier;
  peers: Peers;
  /** Reports whether the service can currently serve (database reachable). */
  ready: () => Promise<boolean>;
}

declare module 'express-serve-static-core' {
  interface Request { actor: Actor; requestId: string }
}

const FALLBACK_REQUEST_ID = '00000000-0000-4000-8000-000000000000';

function errorBody(error: AppError, requestId: string) {
  return { code: error.code, message: error.message, requestId, retryable: error.retryable, fields: error.fields, ...(error.operationId ? { operationId: error.operationId } : {}) };
}

const send = (res: Response, reply: Reply) => {
  for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
  if (reply.body === undefined) res.status(reply.status).end();
  else res.status(reply.status).json(reply.body);
};

/** Rejects unknown and duplicate query parameters. */
function query(req: Request, allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.query)) {
    if (!allowed.includes(name)) throw malformed('UNKNOWN_QUERY_PARAMETER', `Unknown query parameter ${name}`);
    if (typeof value !== 'string') throw malformed('DUPLICATE_QUERY_PARAMETER', `Query parameter ${name} must appear once`);
    out[name] = value;
  }
  return out;
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

function ifMatch(req: Request): string {
  const header = req.get('if-match');
  if (header === undefined) throw preconditionRequired('PRECONDITION_REQUIRED', 'If-Match is required');
  const match = /^"((?:0|[1-9]\d*))"$/.exec(header.trim());
  if (!match) throw malformed('INVALID_IF_MATCH', 'If-Match must be a quoted revision');
  return match[1];
}

/** Slot writes take exactly one of If-Match (edit) or If-None-Match: * (create). */
function slotPrecondition(req: Request): { ifMatch?: string; ifNoneMatchStar: boolean } {
  const match = req.get('if-match');
  const none = req.get('if-none-match');
  if (match !== undefined && none !== undefined) throw malformed('CONFLICTING_PRECONDITIONS', 'Send either If-Match or If-None-Match, not both');
  if (none !== undefined) {
    if (none.trim() !== '*') throw malformed('INVALID_IF_NONE_MATCH', 'If-None-Match must be *');
    return { ifNoneMatchStar: true };
  }
  return { ifMatch: ifMatch(req), ifNoneMatchStar: false };
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const idem = new IdempotencyStore(deps.pool);
  const ctx: Ctx = { pool: deps.pool, clock: deps.clock, peers: deps.peers, contracts: deps.contracts, idem, config: deps.config };

  app.use((req, res, next) => {
    const supplied = req.get('x-request-id');
    if (supplied !== undefined && !isUuid(supplied)) {
      res.setHeader('X-Request-Id', FALLBACK_REQUEST_ID);
      res.status(400).json({ code: 'INVALID_REQUEST_ID', message: 'X-Request-Id must be a UUID', requestId: FALLBACK_REQUEST_ID, retryable: false, fields: [] });
      return;
    }
    req.requestId = supplied ?? newId();
    res.setHeader('X-Request-Id', req.requestId);
    // Booking responses are private to their participants: never cacheable.
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', async (_req, res) => {
    const ok = await deps.ready().catch(() => false);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable' });
  });

  app.use(express.json({ limit: '64kb', type: ['application/json', 'application/*+json'] }));

  // Everything below is reachable only through the Gateway: workload credential plus a signed actor assertion.
  const authenticate: RequestHandler = (req, _res, next) => {
    try {
      deps.workload.require(req.get('authorization'), ['gateway']);
      req.actor = deps.actors.verify(req.get('x-actor-context'));
      next();
    } catch (error) { next(error); }
  };

  const handle = (capability: Capability | null, fn: (req: Request, res: Response) => Promise<Reply>): RequestHandler =>
    async (req, res, next) => {
      try {
        if (capability) requireCapability(req.actor, capability);
        send(res, await fn(req, res));
      } catch (error) { next(error); }
    };

  const rawBody = (req: Request): unknown => {
    if (req.body === undefined || req.body === null || typeof req.body !== 'object') throw malformed('INVALID_BODY', 'A JSON object body is required');
    return req.body;
  };

  const scopeOf = (req: Request, route: string, hashInput: unknown): IdempotencyScope => {
    const key = req.get('idempotency-key');
    if (!key || !isUuid(key)) throw malformed('IDEMPOTENCY_KEY_REQUIRED', 'A UUID Idempotency-Key header is required');
    return { actorUserId: req.actor.userId, method: req.method, route, key, inputHash: inputHash(hashInput), now: deps.clock.now(), requestId: req.requestId };
  };
  const callContext = (req: Request) => ({ requestId: req.requestId });

  const api = express.Router();
  api.use(authenticate);

  // ---- tutor availability ----
  api.get('/profiles/me/tutor/availability/calendar', handle('TUTOR', async (req) => {
    const q = query(req, ['from', 'to']);
    if (q.from === undefined || q.to === undefined) throw validation([{ path: '/query', code: 'REQUIRED', message: 'from and to are required' }]);
    return { status: 200, body: await ownCalendar(ctx, req.actor, q.from, q.to) };
  }));
  api.get('/profiles/me/tutor/availability/:date', handle('TUTOR', async (req) => {
    query(req, []);
    return { status: 200, body: await ownDay(ctx, req.actor, String(req.params.date)) };
  }));
  api.put('/profiles/me/tutor/availability/:date/:time', handle('TUTOR', async (req) => {
    query(req, []);
    const { date, time } = req.params as { date: string; time: string };
    const pre = slotPrecondition(req);
    const body = rawBody(req);
    return putSlot(ctx, req.actor, {
      date, time, body, ifMatch: pre.ifMatch, ifNoneMatchStar: pre.ifNoneMatchStar,
      scope: scopeOf(req, `PUT /api/profiles/me/tutor/availability/${date}/${time}`, { body, extra: pre }), context: callContext(req),
    });
  }));

  // ---- bookings (fixed tutor paths first so they are never read as a booking id) ----
  api.get('/bookings/tutor/upcoming', handle('TUTOR', async (req) => ({ status: 200, body: await tutorUpcoming(ctx, req.actor, pageOf(query(req, ['page', 'pageSize']))) })));
  api.get('/bookings/tutor/needs-confirmation', handle('TUTOR', async (req) => ({ status: 200, body: await tutorNeedsConfirmation(ctx, req.actor, pageOf(query(req, ['page', 'pageSize']))) })));
  api.get('/bookings', handle('STUDENT', async (req) => {
    const q = query(req, ['page', 'pageSize', 'view', 'status']);
    if (q.view !== undefined && q.view !== 'STUDENT' && q.view !== 'TUTOR') throw validation([{ path: '/query/view', code: 'INVALID', message: 'view must be STUDENT or TUTOR' }]);
    const view = (q.view ?? 'STUDENT') as 'STUDENT' | 'TUTOR';
    if (view === 'TUTOR') requireCapability(req.actor, 'TUTOR');
    return { status: 200, body: await listBookings(ctx, req.actor, { page: pageOf(q), view, status: q.status }) };
  }));
  api.post('/bookings', handle('STUDENT', async (req) => {
    query(req, []);
    const body = rawBody(req);
    return createBooking(ctx, req.actor, { body, scope: scopeOf(req, 'POST /api/bookings', body), context: callContext(req) });
  }));
  api.get('/bookings/:bookingId', handle('STUDENT', async (req) => {
    query(req, []);
    const booking = await getBooking(ctx, req.actor, idParam(req, 'bookingId'));
    return { status: 200, body: booking, headers: { ETag: etag(booking.revision) } };
  }));
  api.post('/bookings/:bookingId/confirm-payment', handle('STUDENT', async (req) => {
    query(req, []);
    const bookingId = idParam(req, 'bookingId');
    const match = ifMatch(req);
    return payBooking(ctx, req.actor, { bookingId, ifMatch: match, scope: scopeOf(req, `POST /api/bookings/${bookingId}/confirm-payment`, { match }), context: callContext(req) });
  }));
  api.get('/bookings/:bookingId/cancellation-quote', handle('STUDENT', async (req) => {
    query(req, []);
    return { status: 200, body: await issueQuote(ctx, req.actor, idParam(req, 'bookingId'), 'STUDENT') };
  }));
  api.get('/bookings/:bookingId/tutor-cancellation-quote', handle('TUTOR', async (req) => {
    query(req, []);
    return { status: 200, body: await issueQuote(ctx, req.actor, idParam(req, 'bookingId'), 'TUTOR') };
  }));
  const cancel = (as: 'STUDENT' | 'TUTOR') => handle(as, async (req) => {
    query(req, []);
    const bookingId = idParam(req, 'bookingId');
    const match = ifMatch(req);
    const raw = rawBody(req);
    const body = deps.contracts.assertDef<{ quoteId: string; reason?: string }>(as === 'TUTOR' ? 'TutorCancellationWrite' : 'CancellationWrite', raw, '/body');
    const route = `POST /api/bookings/${bookingId}/${as === 'TUTOR' ? 'tutor-cancel' : 'cancel'}`;
    return cancelBooking(ctx, req.actor, { bookingId, as, ifMatch: match, body, scope: scopeOf(req, route, { body, match }), context: callContext(req) });
  });
  api.post('/bookings/:bookingId/cancel', cancel('STUDENT'));
  api.post('/bookings/:bookingId/tutor-cancel', cancel('TUTOR'));
  api.patch('/bookings/:bookingId/meeting-link', handle('TUTOR', async (req) => {
    query(req, []);
    const bookingId = idParam(req, 'bookingId');
    const match = ifMatch(req);
    const body = rawBody(req);
    return putMeetingOverride(ctx, req.actor, { bookingId, ifMatch: match, body, scope: scopeOf(req, `PATCH /api/bookings/${bookingId}/meeting-link`, { body, match }) });
  }));
  api.post('/bookings/:bookingId/confirm-completion', handle('TUTOR', async (req) => {
    query(req, []);
    const bookingId = idParam(req, 'bookingId');
    const match = ifMatch(req);
    return completeBooking(ctx, req.actor, { bookingId, ifMatch: match, scope: scopeOf(req, `POST /api/bookings/${bookingId}/confirm-completion`, { match }) });
  }));

  // ---- simulated meeting provider control: ADMIN + DEMO_MODE + synthetic booking ----
  api.post('/demo/meetings/:bookingId/outcome', handle('ADMIN', async (req) => {
    query(req, []);
    if (!deps.config.demoMode) throw forbidden('DEMO_DISABLED', 'Demo provider controls are disabled');
    const bookingId = idParam(req, 'bookingId');
    const body = rawBody(req);
    return setDemoOutcome(ctx, req.actor, { bookingId, body, scope: scopeOf(req, `POST /api/demo/meetings/${bookingId}/outcome`, body), context: callContext(req) });
  }));

  // Fixed private owner-status path used by the Gateway's /operations/{owner}/{operationId} route.
  const internal = express.Router();
  internal.use(authenticate);
  internal.get('/booking/operations/:operationId', handle(null, async (req) => {
    query(req, []);
    return { status: 200, body: await readOperation(deps.pool, idParam(req, 'operationId'), req.actor) };
  }));
  app.use('/internal/v1', internal);

  // Traefik strips the public `/api` prefix before forwarding, so public operations are served un-prefixed.
  app.use(api);

  app.use((req, _res, next) => next(notFound('NOT_FOUND', `No route for ${req.method} ${req.path}`)));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const syntax = error as { type?: string };
    const app = syntax?.type === 'entity.parse.failed' ? malformed('INVALID_JSON', 'The request body is not valid JSON')
      : syntax?.type === 'entity.too.large' ? malformed('BODY_TOO_LARGE', 'The request body is too large')
      : syntax?.type === 'charset.unsupported' || syntax?.type === 'encoding.unsupported' ? malformed('UNSUPPORTED_MEDIA', 'Unsupported encoding')
      : asAppError(error);
    if (app.http >= 500 && app.code === 'INTERNAL') console.error(`[Booking] request ${req.requestId ?? '-'} failed`, error);
    const requestId = req.requestId ?? FALLBACK_REQUEST_ID;
    res.setHeader('X-Request-Id', requestId);
    res.status(app.http).json(errorBody(app, requestId));
  });
  return app;
}
