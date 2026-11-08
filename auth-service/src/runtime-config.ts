import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';

const runtimeSecrets = [
  'DATABASE_URL', 'JWT_SECRET', 'IDEMPOTENCY_SECRET', 'AUTH_FINGERPRINT_KEY',
  'RESET_TOKEN_PEPPER', 'RESET_CONTENT_KEY', 'ACTOR_ASSERTION_PRIVATE_KEY',
  'ACTOR_ASSERTION_PUBLIC_KEY', 'GATEWAY_WORKLOAD_CREDENTIAL',
  'TUTOR_WORKLOAD_CREDENTIAL', 'NOTIFICATION_WORKLOAD_CREDENTIAL',
  'BOOKING_WORKLOAD_CREDENTIAL', 'WALLET_WORKLOAD_CREDENTIAL',
  'REVIEW_WORKLOAD_CREDENTIAL', 'MESSAGING_WORKLOAD_CREDENTIAL',
  'ADMIN_SIGNUP_KEY', 'AUTH_DEMO_PASSWORD', 'RABBITMQ_URL',
];

for (const name of runtimeSecrets) {
  const file = process.env[`${name}_FILE`];
  if (!file) continue;
  if (process.env[name]) throw new Error(`Configure either ${name} or ${name}_FILE`);
  const value = readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`${name}_FILE must not be empty`);
  process.env[name] = value;
}

if (process.env.ACTOR_ASSERTION_PRIVATE_KEY && process.env.ACTOR_ASSERTION_PUBLIC_KEY) {
  try {
    const derived = createPublicKey(createPrivateKey(process.env.ACTOR_ASSERTION_PRIVATE_KEY))
      .export({ type: 'spki', format: 'pem' }).toString();
    const configured = createPublicKey(process.env.ACTOR_ASSERTION_PUBLIC_KEY)
      .export({ type: 'spki', format: 'pem' }).toString();
    if (derived !== configured) throw new Error('key pair mismatch');
  } catch {
    throw new Error('ACTOR_ASSERTION signing key configuration is invalid');
  }
}
