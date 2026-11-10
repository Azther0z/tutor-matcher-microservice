import { describe, expect, it } from 'vitest';
import { assertRunnable, loadConfig } from '../src/config';

const base = {
  MONGO_URI: 'mongodb://notification_owner:x@mongo:27017/notification_db?authSource=notification_db&replicaSet=rs0',
  ACTOR_ASSERTION_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----',
  GATEWAY_WORKLOAD_CREDENTIAL: 'g'.repeat(32),
  NOTIFICATION_WORKLOAD_CREDENTIAL: 'n'.repeat(32),
};

describe('runtime configuration', () => {
  it('reads the platform variable names', () => {
    const config = loadConfig({ ...base });
    expect(config.workloadCredentials).toEqual({ gateway: 'g'.repeat(32) });
    expect(config.outboundCredential).toBe('n'.repeat(32));
    expect(config.actorPublicKey).toContain('\nabc\n');
    expect(() => assertRunnable(config)).not.toThrow();
  });

  it('refuses to start without the gateway credential, actor key or database', () => {
    const { GATEWAY_WORKLOAD_CREDENTIAL: _g, ...noGateway } = base;
    void _g;
    expect(() => assertRunnable(loadConfig(noGateway))).toThrow(/GATEWAY_WORKLOAD_CREDENTIAL/);
    const { ACTOR_ASSERTION_PUBLIC_KEY: _k, ...noKey } = base;
    void _k;
    expect(() => assertRunnable(loadConfig(noKey))).toThrow(/ACTOR_ASSERTION_PUBLIC_KEY/);
    expect(() => assertRunnable(loadConfig({ ...base, MONGO_URI: '' }))).toThrow(/MONGO_URI/);
  });
});
