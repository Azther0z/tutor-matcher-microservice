import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

const serviceDir = path.resolve(__dirname, '..');
const scratchRoot = path.resolve(__dirname, '../../.cache/.runtime');

test('Auth runtime secrets load from mounted files before the database pool is created', (t) => {
  const scratch = path.join(scratchRoot, `runtime-config-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const signingKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const otherKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const values = {
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/runtime_config_test',
    JWT_SECRET: 'synthetic-jwt-secret',
    RESET_CONTENT_KEY: 'synthetic-reset-content-key',
    ACTOR_ASSERTION_PRIVATE_KEY: signingKeys.privateKey,
    ACTOR_ASSERTION_PUBLIC_KEY: signingKeys.publicKey,
    RABBITMQ_URL: 'amqp://synthetic:synthetic@127.0.0.1:5672/runtime_config_test',
  };
  const fileEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const file = path.join(scratch, `${name.toLowerCase()}.secret`);
    writeFileSync(file, value, { mode: 0o600 });
    fileEnv[`${name}_FILE`] = file;
  }

  const inspectScript = `
    const { pool } = require('./src/db.ts');
    const checks = {
      database: pool.options.connectionString === process.env.EXPECTED_DATABASE_URL,
      jwt: process.env.JWT_SECRET === process.env.EXPECTED_JWT_SECRET,
      reset: process.env.RESET_CONTENT_KEY === process.env.EXPECTED_RESET_CONTENT_KEY,
      privateKey: process.env.ACTOR_ASSERTION_PRIVATE_KEY === process.env.EXPECTED_ACTOR_ASSERTION_PRIVATE_KEY,
      publicKey: process.env.ACTOR_ASSERTION_PUBLIC_KEY === process.env.EXPECTED_ACTOR_ASSERTION_PUBLIC_KEY,
      broker: process.env.RABBITMQ_URL === process.env.EXPECTED_RABBITMQ_URL,
    };
    console.log(JSON.stringify(checks));
    pool.end().catch(() => process.exitCode = 1);
  `;
  const valid = runNode(inspectScript, {
    ...fileEnv,
    EXPECTED_DATABASE_URL: values.DATABASE_URL,
    EXPECTED_JWT_SECRET: values.JWT_SECRET,
    EXPECTED_RESET_CONTENT_KEY: values.RESET_CONTENT_KEY,
    EXPECTED_ACTOR_ASSERTION_PRIVATE_KEY: values.ACTOR_ASSERTION_PRIVATE_KEY.trim(),
    EXPECTED_ACTOR_ASSERTION_PUBLIC_KEY: values.ACTOR_ASSERTION_PUBLIC_KEY.trim(),
    EXPECTED_RABBITMQ_URL: values.RABBITMQ_URL,
  });
  assert.equal(valid.status, 0, 'valid mounted secret files should allow Auth imports');
  assert.deepEqual(JSON.parse(valid.stdout.trim()), {
    database: true, jwt: true, reset: true, privateKey: true, publicKey: true, broker: true,
  });
  for (const secret of Object.values(values)) assert.ok(!valid.stdout.includes(secret), 'child output must not contain secret values');

  const conflict = runNode("require('./src/runtime-config.ts')", {
    JWT_SECRET: 'synthetic-inline-value',
    JWT_SECRET_FILE: fileEnv.JWT_SECRET_FILE,
  });
  assert.notEqual(conflict.status, 0, 'inline and mounted values must not be combined');
  assert.match(conflict.stderr, /Configure either JWT_SECRET or JWT_SECRET_FILE/);
  assert.ok(!conflict.stderr.includes('synthetic-inline-value'));

  const emptyFile = path.join(scratch, 'empty.secret');
  writeFileSync(emptyFile, '');
  const empty = runNode("require('./src/runtime-config.ts')", { JWT_SECRET_FILE: emptyFile });
  assert.notEqual(empty.status, 0, 'empty mounted secret files must fail closed');
  assert.match(empty.stderr, /JWT_SECRET_FILE must not be empty/);

  const mismatched = runNode("require('./src/runtime-config.ts')", {
    ACTOR_ASSERTION_PRIVATE_KEY_FILE: fileEnv.ACTOR_ASSERTION_PRIVATE_KEY_FILE,
    ACTOR_ASSERTION_PUBLIC_KEY_FILE: writeSecret(scratch, 'mismatched-public.secret', otherKeys.publicKey),
  });
  assert.notEqual(mismatched.status, 0, 'mismatched actor signing keys must fail closed');
  assert.match(mismatched.stderr, /ACTOR_ASSERTION signing key configuration is invalid/);
  assert.ok(!mismatched.stderr.includes(signingKeys.privateKey));

});

function runNode(script: string, env: Record<string, string>): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: serviceDir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DOTENV_CONFIG_PATH: '/dev/null', ...env },
    encoding: 'utf8',
  });
}

function writeSecret(directory: string, name: string, value: string): string {
  const file = path.join(directory, name);
  writeFileSync(file, value, { mode: 0o600 });
  return file;
}
