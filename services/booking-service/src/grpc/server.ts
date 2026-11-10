import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import type { WorkloadAuthenticator } from '../auth';
import type { Contracts } from '../contracts';
import type { Ctx } from '../domain/context';
import { batchGetAvailability, getAvailability, type AvailabilityQuery } from '../domain/slots';
import { bookingEvidence, reminderEligibility, reviewEligibility } from '../domain/lifecycle';
import { AppError, asAppError } from '../errors';
import { isUuid } from '../ids';
import { CHANNEL_OPTIONS, decoded, encodeErrorDetail, loadProtos, toWire } from './proto';

type Unary = (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => void;

interface Deps {
  contractsDir: string;
  contracts: Contracts;
  workload: WorkloadAuthenticator;
  ctx: Ctx;
}

/** Allowed callers per RPC, from contracts/grpc/operations.v1.json. */
const CALLERS = {
  availability: ['tutor'],
  review: ['review'],
  evidence: ['wallet', 'notification'],
  reminder: ['notification'],
} as const;

export function buildHandlers(deps: Deps): { availability: Record<string, Unary>; evidence: Record<string, Unary> } {
  const { contracts, workload, ctx } = deps;

  const wrap = (
    callers: readonly string[], view: string,
    check: (response: unknown) => void,
    run: (request: any) => Promise<unknown>,
  ): Unary => async (call, callback) => {
    const supplied = call.metadata.get('x-request-id')[0];
    const requestId = typeof supplied === 'string' && isUuid(supplied) ? supplied : randomUUID();
    const initial = new grpc.Metadata();
    initial.set('x-request-id', requestId);
    call.sendMetadata(initial);
    try {
      workload.require(call.metadata.get('authorization')[0] as string | undefined, callers);
      const request = contracts.assertView<any>(view, normalize(decoded(call.request)));
      const result = await run(request);
      check(result); // a response that breaks the contract is our bug, never the caller's
      callback(null, toWire(result));
    } catch (error) {
      const app = error instanceof AppError ? error : asAppError(error);
      const trailer = new grpc.Metadata();
      trailer.set('x-request-id', requestId);
      trailer.set('tutor-error-bin', encodeErrorDetail(deps.contractsDir, {
        code: app.code, message: app.message, requestId, retryable: app.retryable, fields: app.fields, ...(app.operationId ? { operationId: app.operationId } : {}),
      }));
      if (app.code === 'INTERNAL') console.error(`[Booking] gRPC request ${requestId} failed`, error);
      callback({ code: app.grpc, details: app.message.slice(0, 200), metadata: trailer }, null);
    }
  };

  const def = (name: string) => (response: unknown) => { contracts.assertDef(name, response); };
  const view = (name: string) => (response: unknown) => { contracts.assertView(name, response); };

  return {
    availability: {
      GetAvailability: wrap(CALLERS.availability, 'GetAvailabilityRequest', view('GetAvailabilityResponse'), (r) => getAvailability(ctx, r.query as AvailabilityQuery)),
      BatchGetAvailability: wrap(CALLERS.availability, 'BatchGetAvailabilityRequest', view('BatchGetAvailabilityResponse'), (r) => batchGetAvailability(ctx, r.queries as AvailabilityQuery[])),
    },
    evidence: {
      GetReviewEligibility: wrap(CALLERS.review, 'GetReviewEligibilityRequest', def('ReviewEligibility'), (r) => reviewEligibility(ctx, r.bookingId)),
      GetBookingEvidence: wrap(CALLERS.evidence, 'GetBookingEvidenceRequest', def('BookingEvidence'), (r) => bookingEvidence(ctx, r.bookingId)),
      GetReminderEligibility: wrap(CALLERS.reminder, 'GetReminderEligibilityRequest', def('ReminderEligibility'), (r) => reminderEligibility(ctx, r)),
    },
  };
}

/** `longs: String` delivers uint64 values as strings; convert the one numeric field before schema validation. */
function normalize<T>(request: T): T {
  const copy = { ...(request as Record<string, unknown>) };
  if (typeof copy.offsetMinutes === 'string') copy.offsetMinutes = Number(copy.offsetMinutes);
  return copy as T;
}

export async function startGrpcServer(deps: Deps, port: number, host = '0.0.0.0'): Promise<{ server: grpc.Server; port: number }> {
  const proto = loadProtos(deps.contractsDir, ['booking/v1/availability.proto', 'booking/v1/collaboration.proto']) as any;
  const handlers = buildHandlers(deps);
  const server = new grpc.Server(CHANNEL_OPTIONS);
  server.addService(proto.tutor_matcher.booking.v1.AvailabilityService.service, handlers.availability);
  server.addService(proto.tutor_matcher.booking.v1.BookingEvidenceService.service, handlers.evidence);
  // The private overlay network plus the per-caller workload credential protect this port; it is never published.
  const bound = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (error, actual) => (error ? reject(error) : resolve(actual)));
  });
  return { server, port: bound };
}
