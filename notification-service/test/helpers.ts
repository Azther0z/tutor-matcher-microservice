import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { ActorVerifier, WorkloadAuthenticator, type Capability } from '../src/auth';
import { PeerUnavailable, type Peers, type ReminderQuery } from '../src/clients';
import { Contracts } from '../src/contracts';
import { createApp } from '../src/http/app';
import { newId } from '../src/ids';
import { ensureIndexes, openStore, type Store } from '../src/store';
import type { Clock } from '../src/time';

export const MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:55434/?replicaSet=rs0&directConnection=true';
export const contractsDir = path.resolve(__dirname, '../../contracts');
export const T0 = new Date('2026-11-10T03:00:00.000Z');
export const GATEWAY_SECRET = 'gateway-secret-0123456789';

export class FakeClock implements Clock {
  constructor(private current: Date = T0) {}
  now() { return new Date(this.current); }
  set(d: Date | string) { this.current = new Date(d); }
  advance(ms: number) { this.current = new Date(this.current.getTime() + ms); }
}

export async function freshStore(): Promise<Store> {
  const store = await openStore(MONGO_URI, 'notification_test');
  return store;
}

export async function resetStore(store: Store): Promise<void> {
  await Promise.all(['events', 'deliveries', 'quarantine', 'preferences', 'idempotency', 'operations'].map((c) => store.db.collection(c).deleteMany({})));
  await ensureIndexes(store);
}

export class FakePeers implements Peers {
  admins: string[] = [];
  authDown = false;
  bookingDown = false;
  bookingRefuses = false;
  eligible = true;
  reminderCalls: ReminderQuery[] = [];
  reset = new Map<string, { recipientUserId: string; expiresAt: string } | 'INVALID'>();
  auth = {
    listActiveAdmins: async () => { if (this.authDown) throw new PeerUnavailable('auth down'); return [...this.admins]; },
    checkResetContent: async (ref: string) => {
      if (this.authDown) throw new PeerUnavailable('auth down');
      const found = this.reset.get(ref);
      if (!found || found === 'INVALID') { const { PeerRejected } = await import('../src/clients'); throw new PeerRejected('RESET_TOKEN_INVALID'); }
      return found;
    },
  };
  booking = {
    getReminderEligibility: async (query: ReminderQuery) => {
      this.reminderCalls.push(query);
      if (this.bookingDown) throw new PeerUnavailable('booking down');
      if (this.bookingRefuses) { const { PeerRejected } = await import('../src/clients'); throw new PeerRejected('REJECTED'); }
      return { eligible: this.eligible, reason: this.eligible ? null : 'CANCELLED' };
    },
  };
}

type EventType = 'wallet.topup-resolved' | 'booking.reminder-due' | 'auth.password-reset-requested' | 'tutor.submission-submitted' | 'wallet.dispute-opened' | 'booking.confirmed';

export function envelope(type: EventType, userIds: string[] = [newId()], overrides: Record<string, unknown> = {}): Record<string, any> {
  const money = { currency: 'THB', amount: '250.00' };
  const bodies: Record<EventType, { producer: string; group: string; targets: unknown; data: Record<string, unknown> }> = {
    'wallet.topup-resolved': { producer: 'wallet', group: 'WALLET_PAYMENTS', targets: { kind: 'USERS', userIds }, data: { topupId: newId(), status: 'SUCCEEDED', amount: money } },
    'booking.reminder-due': { producer: 'booking', group: 'LESSON_REMINDERS', targets: { kind: 'USERS', userIds }, data: { bookingId: newId(), scheduleVersion: '2', offsetMinutes: 60, startsAt: '2026-11-10T06:00:00.000Z' } },
    'auth.password-reset-requested': { producer: 'auth', group: 'SYSTEM', targets: { kind: 'USERS', userIds }, data: { contentRef: newId(), expiresAt: '2026-11-10T04:00:00.000Z' } },
    'tutor.submission-submitted': { producer: 'tutor', group: 'SYSTEM', targets: { kind: 'ADMINS' }, data: { submissionId: newId(), applicantUserId: newId(), kind: 'APPLICATION' } },
    'wallet.dispute-opened': { producer: 'wallet', group: 'SYSTEM', targets: { kind: 'ADMINS' }, data: { disputeId: newId(), bookingId: newId() } },
    'booking.confirmed': { producer: 'booking', group: 'BOOKING_UPDATES', targets: { kind: 'USERS', userIds }, data: { bookingId: newId(), scheduleVersion: '1', startsAt: '2026-11-10T06:00:00.000Z', endsAt: '2026-11-10T07:00:00.000Z' } },
  };
  const b = bodies[type];
  return {
    eventId: newId(), type, schemaVersion: 1, occurredAt: T0.toISOString(), producer: b.producer, aggregate: { type: 'x', id: newId(), version: '1' },
    correlationId: newId(), targets: b.targets, notificationGroup: b.group, data: b.data, ...overrides,
  };
}

export function inbound(env: Record<string, any>, overrides: Partial<{ userId: string | undefined; routingKey: string; messageId: string | undefined }> = {}) {
  return {
    body: Buffer.from(JSON.stringify(env)),
    routingKey: overrides.routingKey ?? `v1.${env.type}`,
    userId: 'userId' in overrides ? overrides.userId : env.producer,
    messageId: 'messageId' in overrides ? overrides.messageId : env.eventId,
    type: env.type,
  };
}

const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

export interface Harness {
  call(method: string, route: string, init?: { token?: string; body?: unknown; headers?: Record<string, string>; credential?: string | null }): Promise<{ status: number; body: any; headers: Headers }>;
  token(userId: string, capabilities?: Capability[]): string;
  close(): Promise<void>;
}

export async function startHttp(store: Store, clock: FakeClock): Promise<Harness> {
  const contracts = new Contracts(contractsDir);
  const app = createApp({
    store, clock, contracts, workload: new WorkloadAuthenticator({ gateway: GATEWAY_SECRET }),
    actors: new ActorVerifier(keys.publicKey, () => clock.now()), ready: async () => true,
  });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (userId: string, capabilities: Capability[] = ['STUDENT']) => {
    const iat = Math.floor(clock.now().getTime() / 1000);
    return jwt.sign({ userId, sessionId: newId(), admissionId: newId(), admittedAt: clock.now().toISOString(), requestId: newId(), publicOperation: 'test', capabilities, accountRevision: '0', iat, exp: iat + 60 },
      keys.privateKey, { algorithm: 'RS256', issuer: 'api-gateway', audience: 'tutor-matcher-internal', subject: userId });
  };
  const call: Harness['call'] = async (method, route, init = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) };
    if (init.credential !== null) headers.authorization = `Bearer ${init.credential ?? GATEWAY_SECRET}`;
    if (init.token) headers['x-actor-context'] = init.token;
    // Tests address the public path; like Traefik's strip-api-prefix, drop `/api` before the owner sees it.
    const response = await fetch(base + route.replace(/^\/api(?=\/|$)/, ''), { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
  };
  return { call, token, close: () => new Promise((r) => server.close(() => r())) };
}
