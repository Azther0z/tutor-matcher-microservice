import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import { ActorVerifier, requireCapability, WorkloadAuthenticator, type Actor, type Capability } from '../auth';
import type { Peers } from '../clients';
import type { Config } from '../config';
import type { Contracts } from '../contracts';
import { adminDisputeParts, decideDispute, getOwnDispute, listAdminDisputes, listOwnDisputes, openDispute } from '../domain/disputes';
import { readOperation } from '../domain/operations';
import {
  BANKS, createPayout, createPayoutAccount, deletePayoutAccount, fingerprint, getPayout, listPayoutAccounts, listPayouts, setDefaultPayoutAccount, setPayoutOutcome,
} from '../domain/payouts';
import type { Page, Reply } from '../domain/reply';
import { createTopup, decideTopup, getSlip, getTopup, listReviewTopups, listTopups, setTopupOutcome, topupView, type TopupRequest } from '../domain/topups';
import { getTransaction, listTransactions, walletOverview } from '../domain/wallet';
import { AppError, asAppError, forbidden, malformed, notFound, preconditionRequired, validation } from '../errors';
import { isUuid, newId } from '../ids';
import { money } from '../money';
import type { Clock } from '../time';
import { IdempotencyStore, inputHash } from './idempotency';

export interface AppDeps {
  pool: Pool;
  clock: Clock;
  config: Pick<Config, 'demoMode' | 'fingerprintKey'>;
  contracts: Contracts;
  workload: WorkloadAuthenticator;
  actors: ActorVerifier;
  peers: Peers;
  /** Reports whether the service can currently serve (database reachable, background work healthy). */
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

/** Rejects unknown and duplicate query parameters, and validates page/pageSize. */
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

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const idem = new IdempotencyStore(deps.pool);

  app.use((req, res, next) => {
    const supplied = req.get('x-request-id');
    if (supplied !== undefined && !isUuid(supplied)) {
      res.setHeader('X-Request-Id', FALLBACK_REQUEST_ID);
      res.status(400).json({ code: 'INVALID_REQUEST_ID', message: 'X-Request-Id must be a UUID', requestId: FALLBACK_REQUEST_ID, retryable: false, fields: [] });
      return;
    }
    req.requestId = supplied ?? newId();
    res.setHeader('X-Request-Id', req.requestId);
    // Wallet, payout-account and dispute responses are private: never cacheable.
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', async (_req, res) => {
    const ok = await deps.ready().catch(() => false);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable' });
  });

  // Only the top-up request carries a transfer slip (up to 2 MB as base64); every other body stays small.
  const smallJson = express.json({ limit: '64kb', type: ['application/json', 'application/*+json'] });
  const slipJson = express.json({ limit: '3mb', type: ['application/json', 'application/*+json'] });
  app.use((req, res, next) => (req.method === 'POST' && req.path === '/wallet/topups' ? slipJson : smallJson)(req, res, next));

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

  const body = <T>(req: Request, schema: string): T => {
    if (req.body === undefined || req.body === null || typeof req.body !== 'object') throw malformed('INVALID_BODY', 'A JSON object body is required');
    return deps.contracts.assertDef<T>(schema, req.body);
  };

  const idempotent = (req: Request, route: string, hashInput: unknown, work: Parameters<IdempotencyStore['run']>[1]) => {
    const key = req.get('idempotency-key');
    if (!key || !isUuid(key)) throw malformed('IDEMPOTENCY_KEY_REQUIRED', 'A UUID Idempotency-Key header is required');
    return idem.run({ actorUserId: req.actor.userId, method: req.method, route, key, inputHash: inputHash(hashInput), now: deps.clock.now(), requestId: req.requestId }, work);
  };

  const api = express.Router();
  api.use(authenticate);

  // ---- wallet (every account has the Student capability) ----
  api.get('/wallet', handle('STUDENT', async (req) => {
    query(req, []);
    return { status: 200, body: await walletOverview(deps.pool, req.actor, deps.clock.now()) };
  }));
  api.get('/wallet/transactions', handle('STUDENT', async (req) => {
    const q = query(req, ['page', 'pageSize', 'type']);
    if (q.type !== undefined && !['TOP_UP', 'LESSON_PAYMENT', 'LESSON_EARNING', 'REFUND', 'PAYOUT'].includes(q.type)) {
      throw validation([{ path: '/query/type', code: 'INVALID', message: 'Unknown transaction type' }]);
    }
    return { status: 200, body: await listTransactions(deps.pool, req.actor.userId, q.type, pageOf(q)) };
  }));
  api.get('/wallet/transactions/:transactionId', handle('STUDENT', async (req) => {
    query(req, []);
    return { status: 200, body: await getTransaction(deps.pool, req.actor.userId, idParam(req, 'transactionId')) };
  }));
  api.post('/wallet/topups', handle('STUDENT', async (req) => {
    query(req, []);
    if (req.body === undefined || req.body === null || typeof req.body !== 'object') throw malformed('INVALID_BODY', 'A JSON object body is required');
    const input = req.body as TopupRequest;
    // The (large) slip is hashed by the idempotency store, so a retry with the same key and the same slip replays safely.
    return idempotent(req, 'POST /api/wallet/topups', input, (tx) => createTopup(tx, req.actor, input, deps.clock.now()));
  }));
  api.get('/wallet/topups', handle('STUDENT', async (req) => {
    const q = query(req, ['page', 'pageSize']);
    return { status: 200, body: await listTopups(deps.pool, req.actor.userId, pageOf(q)) };
  }));
  api.get('/wallet/topups/:topupId', handle('STUDENT', async (req) => {
    query(req, []);
    return { status: 200, body: await getTopup(deps.pool, req.actor, idParam(req, 'topupId')) };
  }));

  // ---- payout accounts and payouts (Tutor only) ----
  api.get('/payout-accounts/banks', handle('TUTOR', async (req) => { query(req, []); return { status: 200, body: { items: BANKS } }; }));
  api.get('/payout-accounts', handle('TUTOR', async (req) => ({ status: 200, body: await listPayoutAccounts(deps.pool, req.actor.userId, pageOf(query(req, ['page', 'pageSize']))) })));
  api.post('/payout-accounts', handle('TUTOR', async (req) => {
    query(req, []);
    const input = body<{ bankCode: string; accountHolderName: string; accountNumber: string; makeDefault?: boolean }>(req, 'PayoutAccountCreate');
    // The replay hash covers a keyed fingerprint, never the raw account number.
    const digits = input.accountNumber.replace(/[ -]/g, '');
    const hashed = { bankCode: input.bankCode, accountHolderName: input.accountHolderName, makeDefault: input.makeDefault ?? false, fp: fingerprint(deps.config.fingerprintKey, input.bankCode, digits) };
    return idempotent(req, 'POST /api/payout-accounts', hashed,
      (tx) => createPayoutAccount(tx, req.actor, input, deps.clock.now(), deps.config.fingerprintKey));
  }));
  api.patch('/payout-accounts/:accountId/default', handle('TUTOR', async (req) => {
    query(req, []);
    const id = idParam(req, 'accountId'); const match = ifMatch(req);
    return idempotent(req, `PATCH /api/payout-accounts/${id}/default`, {}, (tx) => setDefaultPayoutAccount(tx, req.actor, id, match, deps.clock.now()));
  }));
  api.delete('/payout-accounts/:accountId', handle('TUTOR', async (req) => {
    query(req, []);
    const id = idParam(req, 'accountId'); const match = ifMatch(req);
    return idempotent(req, `DELETE /api/payout-accounts/${id}`, {}, (tx) => deletePayoutAccount(tx, req.actor, id, match, deps.clock.now()));
  }));
  api.post('/payouts', handle('TUTOR', async (req) => {
    query(req, []);
    const input = body<{ amount: string; payoutAccountId: string }>(req, 'PayoutCreate');
    return idempotent(req, 'POST /api/payouts', input, (tx) => createPayout(tx, req.actor, input, deps.clock.now()));
  }));
  api.get('/payouts', handle('TUTOR', async (req) => ({ status: 200, body: await listPayouts(deps.pool, req.actor.userId, pageOf(query(req, ['page', 'pageSize']))) })));
  api.get('/payouts/:payoutId', handle('TUTOR', async (req) => {
    query(req, []);
    return { status: 200, body: await getPayout(deps.pool, req.actor, idParam(req, 'payoutId')) };
  }));

  // ---- disputes ----
  api.post('/disputes', handle('STUDENT', async (req) => {
    query(req, []);
    const input = body<{ bookingId: string; reason: string }>(req, 'DisputeCreate');
    const scope = () => {
      const key = req.get('idempotency-key');
      if (!key || !isUuid(key)) throw malformed('IDEMPOTENCY_KEY_REQUIRED', 'A UUID Idempotency-Key header is required');
      return { actorUserId: req.actor.userId, method: 'POST', route: 'POST /api/disputes', key, inputHash: inputHash(input), now: deps.clock.now(), requestId: req.requestId };
    };
    // Resolve a replay before the slow Booking call; never hold a transaction across it.
    const replay = await idem.peek(scope());
    if (replay) return replay;
    const evidence = await deps.peers.booking.getBookingEvidence(input.bookingId, { requestId: req.requestId });
    return idem.run(scope(), (tx) => openDispute(tx, req.actor, input, evidence, deps.clock.now()));
  }));
  api.get('/disputes', handle('STUDENT', async (req) => ({ status: 200, body: await listOwnDisputes(deps.pool, req.actor.userId, pageOf(query(req, ['page', 'pageSize']))) })));
  api.get('/disputes/:disputeId', handle('STUDENT', async (req) => {
    query(req, []);
    const dispute = await getOwnDispute(deps.pool, req.actor, idParam(req, 'disputeId'));
    return { status: 200, body: dispute, headers: { ETag: `"${dispute.revision}"` } };
  }));
  api.get('/admin/disputes', handle('ADMIN', async (req) => {
    const q = query(req, ['page', 'pageSize', 'status']);
    if (q.status !== undefined && !['OPEN', 'APPROVED', 'REJECTED'].includes(q.status)) throw validation([{ path: '/query/status', code: 'INVALID', message: 'Unknown dispute status' }]);
    return { status: 200, body: await listAdminDisputes(deps.pool, q.status, pageOf(q)) };
  }));
  api.get('/admin/disputes/:disputeId', handle('ADMIN', async (req) => {
    query(req, []);
    const parts = await adminDisputeParts(deps.pool, idParam(req, 'disputeId'));
    const context = { requestId: req.requestId };
    const [booking, accounts] = await Promise.all([
      deps.peers.booking.getBookingEvidence(parts.row.booking_id, context),
      deps.peers.auth.lookupAccounts([parts.row.student_user_id, parts.row.tutor_user_id], context),
    ]);
    const name = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? 'Unavailable account';
    return {
      status: 200,
      headers: { ETag: `"${parts.dispute.revision}"` },
      body: {
        dispute: parts.dispute, booking, financial: parts.financial,
        transactions: parts.ledger.map((r) => ({
          id: r.id, type: r.type, amount: money(BigInt(r.amount_satang)), direction: r.direction, balanceAfter: money(BigInt(r.balance_after_satang)),
          operationId: r.operation_id, bookingId: r.booking_id, payoutAccountId: r.payout_account_id, createdAt: r.created_at.toISOString(),
        })),
        studentDisplayName: name(parts.row.student_user_id), tutorDisplayName: name(parts.row.tutor_user_id),
      },
    };
  }));
  api.post('/admin/disputes/:disputeId/decision', handle('ADMIN', async (req) => {
    query(req, []);
    const id = idParam(req, 'disputeId'); const match = ifMatch(req);
    const input = body<{ decision: 'APPROVE_FULL_REMAINDER' | 'REJECT'; reason: string }>(req, 'DisputeDecision');
    return idempotent(req, `POST /api/admin/disputes/${id}/decision`, input, (tx) => decideDispute(tx, req.actor, id, match, input, deps.clock.now()));
  }));

  // ---- manual top-up review (Admin only) ----
  api.get('/admin/topups', handle('ADMIN', async (req) => {
    const q = query(req, ['page', 'pageSize', 'status']);
    if (q.status !== undefined && !['PENDING', 'SUCCEEDED', 'FAILED'].includes(q.status)) {
      throw validation([{ path: '/query/status', code: 'INVALID', message: 'status must be PENDING, SUCCEEDED or FAILED' }]);
    }
    const page = pageOf(q);
    const { rows, total } = await listReviewTopups(deps.pool, { status: q.status }, page);
    const accounts = await deps.peers.auth.lookupAccounts([...new Set(rows.map((row) => row.user_id))], { requestId: req.requestId }).catch(() => []);
    const name = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? 'Unavailable account';
    return {
      status: 200,
      body: {
        items: rows.map((row) => ({ ...topupView(row), userDisplayName: name(row.user_id) })),
        pagination: { page: page.page, pageSize: page.pageSize, totalItems: total, totalPages: total === 0 ? 0 : Math.ceil(total / page.pageSize) },
      },
    };
  }));
  api.get('/admin/topups/:topupId/slip', async (req, res, next) => {
    try {
      requireCapability(req.actor, 'ADMIN');
      query(req, []);
      const slip = await getSlip(deps.pool, idParam(req, 'topupId'));
      res.setHeader('Content-Type', slip.contentType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).end(slip.bytes);
    } catch (error) { next(error); }
  });
  api.post('/admin/topups/:topupId/decision', handle('ADMIN', async (req) => {
    query(req, []);
    const id = idParam(req, 'topupId');
    if (req.body === undefined || req.body === null || typeof req.body !== 'object') throw malformed('INVALID_BODY', 'A JSON object body is required');
    const input = req.body as { decision?: unknown; reason?: unknown };
    if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') throw validation([{ path: '/body/decision', code: 'INVALID', message: 'decision must be APPROVE or REJECT' }]);
    if (input.reason !== undefined && typeof input.reason !== 'string') throw validation([{ path: '/body/reason', code: 'INVALID', message: 'reason must be text' }]);
    const decision: { decision: 'APPROVE' | 'REJECT'; reason?: string } = { decision: input.decision, reason: input.reason as string | undefined };
    return idempotent(req, `POST /api/admin/topups/${id}/decision`, decision, (tx) => decideTopup(tx, req.actor, id, decision, deps.clock.now()));
  }));

  // ---- simulated provider controls: ADMIN + DEMO_MODE + synthetic resource ----
  const demo = (kind: 'topups' | 'payouts') => handle('ADMIN', async (req) => {
    query(req, []);
    if (!deps.config.demoMode) throw forbidden('DEMO_DISABLED', 'Demo provider controls are disabled');
    const id = idParam(req, kind === 'topups' ? 'topupId' : 'payoutId');
    const input = body<{ outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; providerReference: string }>(req, 'DemoOutcome');
    const apply = kind === 'topups' ? setTopupOutcome : setPayoutOutcome;
    return idempotent(req, `POST /api/demo/${kind}/${id}/outcome`, input, (tx) => apply(tx, id, input, deps.clock.now(), deps.config.demoMode));
  });
  api.post('/demo/topups/:topupId/outcome', demo('topups'));
  api.post('/demo/payouts/:payoutId/outcome', demo('payouts'));

  // Fixed private owner-status path used by the Gateway's /operations/{owner}/{operationId} route.
  const internal = express.Router();
  internal.use(authenticate);
  internal.get('/wallet/operations/:operationId', handle(null, async (req) => {
    query(req, []);
    return { status: 200, body: await readOperation(deps.pool, idParam(req, 'operationId'), req.actor) };
  }));
  app.use('/internal/v1', internal);

  // Traefik strips the public `/api` prefix before forwarding (infra/gateway/routes.yaml strip-api-prefix), so owners
  // serve public operations at their un-prefixed paths. The private `/internal/v1` namespace is mounted first and is
  // never reachable through the public route allowlist.
  app.use(api);

  app.use((req, _res, next) => next(notFound('NOT_FOUND', `No route for ${req.method} ${req.path}`)));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const syntax = error as { type?: string; status?: number };
    const app = syntax?.type === 'entity.parse.failed' ? malformed('INVALID_JSON', 'The request body is not valid JSON')
      : syntax?.type === 'entity.too.large' ? malformed('BODY_TOO_LARGE', 'The request body is too large')
      : syntax?.type === 'charset.unsupported' || syntax?.type === 'encoding.unsupported' ? malformed('UNSUPPORTED_MEDIA', 'Unsupported encoding')
      : asAppError(error);
    if (app.http >= 500 && app.code === 'INTERNAL') console.error(`[Wallet] request ${req.requestId ?? '-'} failed`, error);
    const requestId = req.requestId ?? FALLBACK_REQUEST_ID;
    res.setHeader('X-Request-Id', requestId);
    res.status(app.http).json(errorBody(app, requestId));
  });
  return app;
}
