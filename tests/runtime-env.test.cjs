const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');

test('runtime configuration accepts mounted files and rejects ambiguous/empty inputs', (t) => {
  const root = path.resolve(__dirname, '..');
  mkdirSync(path.join(root, '.cache/gateway'), { recursive: true });
  const directory = mkdtempSync(path.join(root, '.cache/gateway/runtime-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic-value');
  const empty = path.join(directory, 'empty');
  writeFileSync(file, 'synthetic-test-value\n'); writeFileSync(empty, '\n');
  function run(env, assertion) {
    execFileSync(process.execPath, ['-e', `const assert = require('node:assert/strict');
      const { loadRuntimeEnv } = require('./shared/runtime-env'); ${assertion}`], { cwd: root, env, stdio: 'pipe' });
  }
  for (const name of ['DATABASE_URL','JWT_SECRET','MONGO_URI','RABBITMQ_URL']) {
    run({ [`${name}_FILE`]: file }, `loadRuntimeEnv(); assert.equal(process.env.${name}, 'synthetic-test-value');`);
  }
  run({ DATABASE_URL: 'synthetic-inline-value' }, "loadRuntimeEnv(); assert.equal(process.env.DATABASE_URL, 'synthetic-inline-value');");
  run({ JWT_SECRET: 'synthetic-inline-value', JWT_SECRET_FILE: file }, "assert.throws(loadRuntimeEnv, /either JWT_SECRET or JWT_SECRET_FILE/);");
  run({ MONGO_URI_FILE: empty }, "assert.throws(loadRuntimeEnv, /must not be empty/);");
  run({ RABBITMQ_URL_FILE: path.join(directory,'missing') }, "assert.throws(loadRuntimeEnv, {code:'ENOENT'});");
});
