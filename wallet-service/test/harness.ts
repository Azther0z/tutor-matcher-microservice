import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import { ActorVerifier, WorkloadAuthenticator, type Capability } from '../src/auth';
import type { AccountSummary, BookingEvidence, Peers } from '../src/clients';
import { Contracts } from '../src/contracts';
import { createApp } from '../src/http/app';
import { newId } from '../src/ids';
import path from 'node:path';
import { FakeClock, T0 } from './helpers';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
export const GATEWAY_SECRET = 'gateway-secret-0123456789';
export const BOOKING_SECRET = 'booking-secret-0123456789';
export const FINGERPRINT_KEY = 'fingerprint-key-0123456789-0123456789';

export class FakePeers implements Peers {
  evidence = new Map<string, BookingEvidence>();
  accounts = new Map<string, AccountSummary>();
  booking = {
    getBookingEvidence: async (bookingId: string) => {
      const found = this.evidence.get(bookingId);
      if (!found) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
      return found;
    },
  };
  auth = {
    lookupAccounts: async (ids: string[]) => ids.map((id) => this.accounts.get(id)).filter((a): a is AccountSummary => !!a),
  };
}

export interface Harness {
  base: string; clock: FakeClock; peers: FakePeers; server: Server; contracts: Contracts;
  token(userId: string, capabilities?: Capability[], overrides?: Record<string, unknown>): string;
  call(method: string, route: string, init?: { token?: string; body?: unknown; headers?: Record<string, string>; credential?: string | null }): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
  demoMode: boolean;
}

export async function startHarness(pool: Pool, options: { demoMode?: boolean } = {}): Promise<Harness> {
  const clock = new FakeClock(T0);
  const peers = new FakePeers();
  const contracts = new Contracts(path.resolve(__dirname, '../../contracts'));
  const app = createApp({
    pool, clock, contracts, peers,
    config: { demoMode: options.demoMode ?? true, fingerprintKey: FINGERPRINT_KEY },
    workload: new WorkloadAuthenticator({ gateway: GATEWAY_SECRET, booking: BOOKING_SECRET }),
    actors: new ActorVerifier(keys.publicKey, () => clock.now()),
    ready: async () => true,
  });
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const token = (userId: string, capabilities: Capability[] = ['STUDENT'], overrides: Record<string, unknown> = {}) => {
    // Stamp times from the fake clock so expiry can be exercised deterministically.
    const iat = Math.floor(clock.now().getTime() / 1000);
    return jwt.sign({
      userId, sessionId: newId(), admissionId: newId(), admittedAt: clock.now().toISOString(), requestId: newId(), publicOperation: 'test',
      capabilities, accountRevision: '0', iat, exp: iat + 60, ...overrides,
    }, keys.privateKey, { algorithm: 'RS256', issuer: 'api-gateway', audience: 'tutor-matcher-internal', subject: userId });
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
  return { base, clock, peers, server, contracts, token, call, close: () => new Promise((r) => server.close(() => r())), demoMode: options.demoMode ?? true };
}
