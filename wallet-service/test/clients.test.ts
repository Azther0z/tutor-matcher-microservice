import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Contracts } from '../src/contracts';
import { GrpcAuthClient, GrpcBookingClient } from '../src/grpc/clients';
import { CHANNEL_OPTIONS, loadProtos } from '../src/grpc/proto';
import { newId } from '../src/ids';

const contractsDir = path.resolve(__dirname, '../../contracts');
const contracts = new Contracts(contractsDir);
let server: grpc.Server; let target: string; let seen: { authorization?: string; requestId?: string }[] = [];
const BOOKING_ID = newId(); const STUDENT = newId(); const TUTOR = newId();

beforeAll(async () => {
  const proto = loadProtos(contractsDir, ['booking/v1/collaboration.proto', 'auth/v1/collaboration.proto']) as any;
  server = new grpc.Server(CHANNEL_OPTIONS);
  const note = (call: grpc.ServerUnaryCall<any, any>) => seen.push({ authorization: call.metadata.get('authorization')[0] as string, requestId: call.metadata.get('x-request-id')[0] as string });
  server.addService(proto.tutor_matcher.booking.v1.BookingEvidenceService.service, {
    GetBookingEvidence: (call: any, cb: any) => {
      note(call);
      if (call.request.bookingId !== BOOKING_ID) return cb({ code: grpc.status.NOT_FOUND, details: 'nope' });
      // completed_at / cancelled_at deliberately absent: "absent means JSON null".
      cb(null, { bookingId: BOOKING_ID, status: 'CONFIRMED', studentUserId: STUDENT, tutorUserId: TUTOR, subjectId: newId(), startsAt: '2026-11-10T03:00:00.000Z', endsAt: '2026-11-10T04:00:00.000Z', revision: '3' });
    },
    GetReminderEligibility: (_c: any, cb: any) => cb(null, {}),
    GetReviewEligibility: (_c: any, cb: any) => cb({ code: grpc.status.UNIMPLEMENTED }),
  });
  server.addService(proto.tutor_matcher.auth.v1.AuthCollaborationService.service, {
    LookupAccounts: (call: any, cb: any) => { note(call); cb(null, { items: call.request.userIds.map((id: string) => ({ id, displayName: `Name ${id.slice(0, 4)}`, email: 'x@example.com', status: 'ACTIVE', capabilities: ['STUDENT', 'TUTOR'] })) }); },
    ListActiveAdmins: (_c: any, cb: any) => cb(null, { items: [] }),
    GrantTutorCapability: (_c: any, cb: any) => cb({ code: grpc.status.UNIMPLEMENTED }),
    GetTutorGrant: (_c: any, cb: any) => cb({ code: grpc.status.UNIMPLEMENTED }),
    GetResetNotificationContent: (_c: any, cb: any) => cb({ code: grpc.status.UNIMPLEMENTED }),
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  target = `127.0.0.1:${port}`;
});
afterAll(() => { server.forceShutdown(); });

describe('Booking and Auth gRPC clients', () => {
  it('decodes Booking evidence, mapping absent nullable timestamps to null and sending identity metadata', async () => {
    seen = [];
    const client = new GrpcBookingClient(contractsDir, target, 'wallet-credential-0123', contracts);
    const requestId = newId();
    const evidence = await client.getBookingEvidence(BOOKING_ID, { requestId });
    expect(evidence).toMatchObject({ bookingId: BOOKING_ID, status: 'CONFIRMED', completedAt: null, cancelledAt: null, revision: '3' });
    expect(seen[0]).toEqual({ authorization: 'Bearer wallet-credential-0123', requestId });
  });

  it('maps NOT_FOUND to a 404 and an unreachable peer to a retryable 503 (never a guess)', async () => {
    const client = new GrpcBookingClient(contractsDir, target, undefined, contracts);
    await expect(client.getBookingEvidence(newId(), { requestId: newId() })).rejects.toMatchObject({ http: 404 });
    const dead = new GrpcBookingClient(contractsDir, '127.0.0.1:1', undefined, contracts);
    await expect(dead.getBookingEvidence(BOOKING_ID, { requestId: newId() })).rejects.toMatchObject({ http: 503, retryable: true, code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('looks up account display names', async () => {
    const client = new GrpcAuthClient(contractsDir, target, 'wallet-credential-0123');
    const [a, b] = [newId(), newId()];
    const accounts = await client.lookupAccounts([a, b], { requestId: newId() });
    expect(accounts.map((x) => x.id)).toEqual([a, b]);
    expect(accounts[0]).toMatchObject({ status: 'ACTIVE', capabilities: ['STUDENT', 'TUTOR'] });
    expect(accounts[0].displayName).toMatch(/^Name /);
  });
});
