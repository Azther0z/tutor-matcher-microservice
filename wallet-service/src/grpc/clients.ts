import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import type { AccountSummary, AuthClient, BookingClient, BookingEvidence, CallContext } from '../clients';
import type { Contracts } from '../contracts';
import { AppError, notFound, unavailable } from '../errors';
import { CHANNEL_OPTIONS, decoded, loadProtos, withNulls } from './proto';

const READ_DEADLINE_MS = 2000; // read-only internal calls have a 2-second total budget

function unary<T>(client: grpc.Client, method: string, request: unknown, credential: string | undefined, context: CallContext): Promise<T> {
  const metadata = new grpc.Metadata();
  if (credential) metadata.set('authorization', `Bearer ${credential}`);
  metadata.set('x-request-id', context.requestId || randomUUID());
  return new Promise<T>((resolve, reject) => {
    (client as any)[method](request, metadata, { deadline: new Date(Date.now() + READ_DEADLINE_MS) }, (error: grpc.ServiceError | null, response: T) => {
      if (!error) return resolve(response);
      // Never expose a peer's trailer or stack. A timeout leaves the outcome unknown, so say "unavailable".
      if (error.code === grpc.status.NOT_FOUND) return reject(notFound('NOT_FOUND', 'The requested resource was not found'));
      reject(error instanceof AppError ? error : unavailable('DEPENDENCY_UNAVAILABLE', 'A required service is unavailable'));
    });
  });
}

export class GrpcBookingClient implements BookingClient {
  private readonly client: grpc.Client;
  constructor(contractsDir: string, target: string, private readonly credential: string | undefined, private readonly contracts: Contracts) {
    const proto = loadProtos(contractsDir, ['booking/v1/collaboration.proto']) as any;
    this.client = new proto.tutor_matcher.booking.v1.BookingEvidenceService(target, grpc.credentials.createInsecure(), CHANNEL_OPTIONS);
  }

  async getBookingEvidence(bookingId: string, context: CallContext): Promise<BookingEvidence> {
    const raw = await unary<Record<string, unknown>>(this.client, 'GetBookingEvidence', { bookingId }, this.credential, context);
    return this.contracts.assertDef<BookingEvidence>('BookingEvidence', withNulls(raw, ['completedAt', 'cancelledAt']));
  }
}

export class GrpcAuthClient implements AuthClient {
  private readonly client: grpc.Client;
  constructor(contractsDir: string, target: string, private readonly credential: string | undefined) {
    const proto = loadProtos(contractsDir, ['auth/v1/collaboration.proto']) as any;
    this.client = new proto.tutor_matcher.auth.v1.AuthCollaborationService(target, grpc.credentials.createInsecure(), CHANNEL_OPTIONS);
  }

  async lookupAccounts(userIds: string[], context: CallContext): Promise<AccountSummary[]> {
    const raw = await unary<{ items?: Array<Record<string, unknown>> }>(this.client, 'LookupAccounts', { userIds }, this.credential, context);
    return (decoded<{ items?: Array<Record<string, unknown>> }>(raw).items ?? []).map((item) => ({
      id: String(item.id), displayName: String(item.displayName), status: item.status as AccountSummary['status'],
      capabilities: (item.capabilities ?? []) as AccountSummary['capabilities'],
    }));
  }
}
