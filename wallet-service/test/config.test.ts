import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertRunnable, loadConfig } from '../src/config';

const secret = (n: string) => n.repeat(32).slice(0, 32);
const base = {
  DATABASE_URL: 'postgresql://wallet_owner:x@postgres:5432/wallet_db',
  ACTOR_ASSERTION_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----',
  PAYOUT_FINGERPRINT_KEY: secret('f'),
  GATEWAY_WORKLOAD_CREDENTIAL: secret('g'),
  BOOKING_WORKLOAD_CREDENTIAL: secret('b'),
  WALLET_WORKLOAD_CREDENTIAL: secret('w'),
};

describe('runtime configuration', () => {
  it('reads the platform variable names and maps each caller to its own credential', () => {
    const config = loadConfig({ ...base });
    expect(config.workloadCredentials).toEqual({ gateway: secret('g'), booking: secret('b') });
    expect(config.outboundCredential).toBe(secret('w'));
    expect(config.actorPublicKey).toContain('\nabc\n');
    expect(() => assertRunnable(config)).not.toThrow();
  });

  it('accepts a mounted secret file and rejects a value configured both ways', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wallet-secret-'));
    const file = path.join(dir, 'database_url');
    writeFileSync(file, `${base.DATABASE_URL}\n`);
    const { DATABASE_URL: _unused, ...rest } = base;
    void _unused;
    expect(loadConfig({ ...rest, DATABASE_URL_FILE: file }).databaseUrl).toBe(base.DATABASE_URL);
    expect(() => loadConfig({ ...base, DATABASE_URL_FILE: file })).toThrow(/either DATABASE_URL or DATABASE_URL_FILE/);
  });

  it('refuses to start without a distinct gateway or booking credential, or a short one', () => {
    const { BOOKING_WORKLOAD_CREDENTIAL: _unused, ...withoutBooking } = base;
    void _unused;
    expect(() => assertRunnable(loadConfig(withoutBooking))).toThrow(/BOOKING_WORKLOAD_CREDENTIAL/);
    expect(() => loadConfig({ ...base, GATEWAY_WORKLOAD_CREDENTIAL: 'short' })).toThrow(/at least 16/);
  });
});
