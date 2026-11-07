import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PeerRejected, PeerUnavailable } from '../src/clients';
import { GrpcAuthPeer, GrpcBookingPeer } from '../src/grpc/clients';
import { CHANNEL_OPTIONS, loadProtos } from '../src/grpc/proto';
import { newId } from '../src/ids';

const contractsDir = path.resolve(__dirname, '../../contracts');
let server: grpc.Server; let target: string;
const ADMIN = newId(); const SUSPENDED = newId(); const RECIPIENT = newId();
let seenReminder: any;

beforeAll(async () => {
  const proto = loadProtos(contractsDir, ['booking/v1/collaboration.proto', 'auth/v1/collaboration.proto']) as any;
  server = new grpc.Server(CHANNEL_OPTIONS);
  server.addService(proto.tutor_matcher.booking.v1.BookingEvidenceService.service, {
    GetReminderEligibility: (call: any, cb: any) => {
      seenReminder = call.request;
      if (call.request.bookingId === 'incomplete') return cb(null, { bookingId: 'incomplete' }); // "eligible" missing
      cb(null, { bookingId: call.request.bookingId, eligible: false, reason: 'CANCELLED', checkedAt: '2026-11-10T03:00:00.000Z' });
    },
    GetBookingEvidence: (_c: any, cb: any) => cb({ code: grpc.status.UNIMPLEMENTED }),
    GetReviewEligibility: (_c: any, cb: any) => cb({ code: grpc.status.UNIMPLEMENTED }),
  });
  server.addService(proto.tutor_matcher.auth.v1.AuthCollaborationService.service, {
    ListActiveAdmins: (_c: any, cb: any) => cb(null, { items: [
      { id: ADMIN, displayName: 'Admin', email: 'a@example.com', status: 'ACTIVE', capabilities: ['STUDENT', 'ADMIN'] },
      { id: SUSPENDED, displayName: 'Gone', email: 'g@example.com', status: 'SUSPENDED', capabilities: ['STUDENT', 'ADMIN'] },
    ] }),
    GetResetNotificationContent: (call: any, cb: any) => {
      if (call.request.contentRef === 'missing') return cb({ code: grpc.status.NOT_FOUND, details: 'x' });
      if (call.request.contentRef === 'down') return cb({ code: grpc.status.UNAVAILABLE, details: 'x' });
      cb(null, { contentRef: call.request.contentRef, recipientUserId: RECIPIENT, subject: 'Reset', text: 'SECRET-LINK', sensitive: true, expiresAt: '2026-11-10T04:00:00.000Z' });
    },
    LookupAccounts: (_c: any, cb: any) => cb({ code: grpc.status.UNIMPLEMENTED }),
    GrantTutorCapability: (_c: any, cb: any) => cb({ code: grpc.status.UNIMPLEMENTED }),
    GetTutorGrant: (_c: any, cb: any) => cb({ code: grpc.status.UNIMPLEMENTED }),
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  target = `127.0.0.1:${port}`;
});
afterAll(() => { server.forceShutdown(); });

describe('Auth and Booking gRPC peers', () => {
  const ctx = () => ({ requestId: newId() });

  it('returns only active admins', async () => {
    expect(await new GrpcAuthPeer(contractsDir, target, 'c-0123456789abcdef').listActiveAdmins(ctx())).toEqual([ADMIN]);
  });

  it('returns reset metadata only: the sensitive body never leaves the adapter', async () => {
    const meta = await new GrpcAuthPeer(contractsDir, target, undefined).checkResetContent(newId(), ctx());
    expect(meta).toEqual({ recipientUserId: RECIPIENT, expiresAt: '2026-11-10T04:00:00.000Z' });
    expect(JSON.stringify(meta)).not.toContain('SECRET-LINK');
  });

  it('distinguishes a refusal (expired/consumed token) from an outage', async () => {
    const peer = new GrpcAuthPeer(contractsDir, target, undefined);
    await expect(peer.checkResetContent('missing', ctx())).rejects.toBeInstanceOf(PeerRejected);
    await expect(peer.checkResetContent('down', ctx())).rejects.toBeInstanceOf(PeerUnavailable);
    await expect(new GrpcAuthPeer(contractsDir, '127.0.0.1:1', undefined).listActiveAdmins(ctx())).rejects.toBeInstanceOf(PeerUnavailable);
  });

  it('sends the reminder identity and decodes an explicit eligible=false, but treats a missing flag as unknown', async () => {
    const peer = new GrpcBookingPeer(contractsDir, target, undefined);
    const bookingId = newId();
    expect(await peer.getReminderEligibility({ bookingId, scheduleVersion: '2', offsetMinutes: 60 }, ctx())).toEqual({ eligible: false, reason: 'CANCELLED' });
    expect(seenReminder).toMatchObject({ bookingId, scheduleVersion: '2', offsetMinutes: '60' });
    await expect(peer.getReminderEligibility({ bookingId: 'incomplete', scheduleVersion: '1', offsetMinutes: 10 }, ctx())).rejects.toBeInstanceOf(PeerUnavailable);
  });
});
