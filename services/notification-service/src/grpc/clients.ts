import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { PeerRejected, PeerUnavailable, type AuthPeer, type BookingPeer, type CallContext, type ReminderQuery, type ResetContentMeta } from '../clients';
import { CHANNEL_OPTIONS, decoded, loadProtos } from './proto';

const READ_DEADLINE_MS = 2000; // read-only internal calls have a 2-second total budget

function unary<T>(client: grpc.Client, method: string, request: unknown, credential: string | undefined, context: CallContext): Promise<T> {
  const metadata = new grpc.Metadata();
  if (credential) metadata.set('authorization', `Bearer ${credential}`);
  metadata.set('x-request-id', context.requestId || randomUUID());
  return new Promise<T>((resolve, reject) => {
    (client as any)[method](request, metadata, { deadline: new Date(Date.now() + READ_DEADLINE_MS) }, (error: grpc.ServiceError | null, response: T) => {
      if (!error) return resolve(response);
      // A refusal (the peer answered) is distinct from an outage (timeout, transport, internal): only the latter leaves work pending.
      if (error.code === grpc.status.NOT_FOUND || error.code === grpc.status.FAILED_PRECONDITION || error.code === grpc.status.PERMISSION_DENIED || error.code === grpc.status.INVALID_ARGUMENT) {
        return reject(new PeerRejected(error.code === grpc.status.NOT_FOUND ? 'RESET_TOKEN_INVALID' : 'REJECTED'));
      }
      reject(new PeerUnavailable(`gRPC ${grpc.status[error.code] ?? error.code}`));
    });
  });
}

export class GrpcAuthPeer implements AuthPeer {
  private readonly client: grpc.Client;
  constructor(contractsDir: string, target: string, private readonly credential: string | undefined) {
    const proto = loadProtos(contractsDir, ['auth/v1/collaboration.proto']) as any;
    this.client = new proto.tutor_matcher.auth.v1.AuthCollaborationService(target, grpc.credentials.createInsecure(), CHANNEL_OPTIONS);
  }

  async listActiveAdmins(context: CallContext): Promise<string[]> {
    const raw = decoded<{ items?: Array<{ id?: string; status?: string; capabilities?: string[] }> }>(
      await unary(this.client, 'ListActiveAdmins', {}, this.credential, context));
    return (raw.items ?? []).filter((a) => a.id && (a.status === undefined || a.status === 'ACTIVE') && (a.capabilities ?? ['ADMIN']).includes('ADMIN')).map((a) => a.id!);
  }

  async checkResetContent(contentRef: string, context: CallContext): Promise<ResetContentMeta> {
    const raw = decoded<{ recipientUserId?: string; expiresAt?: string }>(
      await unary(this.client, 'GetResetNotificationContent', { contentRef }, this.credential, context));
    // Subject/text are deliberately dropped here: decrypted content is not retained, cached or logged.
    if (!raw.recipientUserId || !raw.expiresAt) throw new PeerUnavailable('Auth returned an incomplete reset content reply');
    return { recipientUserId: raw.recipientUserId, expiresAt: raw.expiresAt };
  }
}

export class GrpcBookingPeer implements BookingPeer {
  private readonly client: grpc.Client;
  constructor(contractsDir: string, target: string, private readonly credential: string | undefined) {
    const proto = loadProtos(contractsDir, ['booking/v1/collaboration.proto']) as any;
    this.client = new proto.tutor_matcher.booking.v1.BookingEvidenceService(target, grpc.credentials.createInsecure(), CHANNEL_OPTIONS);
  }

  async getReminderEligibility(query: ReminderQuery, context: CallContext) {
    const raw = decoded<{ eligible?: boolean; reason?: string }>(
      await unary(this.client, 'GetReminderEligibility', { bookingId: query.bookingId, scheduleVersion: query.scheduleVersion, offsetMinutes: String(query.offsetMinutes) }, this.credential, context));
    // Missing "eligible" is not "false": do not suppress a reminder on an incomplete reply.
    if (raw.eligible === undefined) throw new PeerUnavailable('Booking returned an incomplete eligibility reply');
    return { eligible: raw.eligible, reason: raw.reason ?? null };
  }
}
