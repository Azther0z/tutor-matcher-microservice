const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const engine = process.env.CONTAINER_ENGINE || 'podman';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('hosted socket proxy permits discovery reads and denies writes/secrets', { timeout: 30000 }, async (t) => {
  const cfg = JSON.parse(execFileSync('python', ['-c',
    'import json,yaml; print(json.dumps(yaml.safe_load(open("deploy/compose.yaml"))["services"]["docker-api"]))'], { cwd: root }));
  mkdirSync(path.join(root, '.cache/gateway'), { recursive: true });
  const directory = mkdtempSync(path.join(root, '.cache/gateway/socket-'));
  const socket = path.join(directory, 'docker.sock');
  let writes = 0;
  const fixture = http.createServer((req, res) => {
    if (!['GET','HEAD'].includes(req.method)) writes += 1;
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  // Linux limits Unix socket address strings to 107 bytes. GitHub's checkout
  // path can exceed that once the fixture suffix is added; bind relatively.
  fixture.listen(path.relative(process.cwd(), socket)); await once(fixture, 'listening');
  assert.ok(statSync(socket).isSocket(), 'The mounted fixture path must be a Unix socket');
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  const name = `tutor-matcher-socket-test-${process.pid}`;
  // Test-only: connect to this host-process fixture on SELinux machines.
  // Its only mount is a synthetic socket; no real engine socket is accessed.
  const args = ['run', '--rm', '--name', name, '--network', 'host', '--security-opt', 'label=disable',
    '-v', `${socket}:/var/run/docker.sock:ro`,
    '-e', `BIND_CONFIG=127.0.0.1:${port}`];
  for (const [key,value] of Object.entries(cfg.environment)) args.push('-e', `${key}=${value}`);
  args.push(cfg.image);
  const proxy = spawn(engine, args);
  let output = '';
  proxy.stdout.on('data', (data) => { output += data; });
  proxy.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    try { execFileSync(engine, ['rm','--force',name], { stdio: 'ignore' }); } catch { /* Already removed. */ }
    await Promise.race([once(proxy, 'exit'), pause(1000)]);
    fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve));
    writeFileSync(path.join(root, '.cache/gateway/socket-proxy.log'), output);
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false; let lastStatus;
  for (let i = 0; i < 100; i++) {
    assert.equal(proxy.exitCode, null, 'Socket proxy exited before readiness');
    try { lastStatus = (await fetch(base+'/_ping', { signal: AbortSignal.timeout(1000) })).status; ready = lastStatus === 200; } catch { /* Starting. */ }
    if (ready) break; await pause(100);
  }
  assert.ok(ready, `Socket proxy did not become ready (last HTTP status ${lastStatus})`);
  for (const endpoint of ['/version','/v1.54/services','/v1.54/tasks','/v1.54/networks','/v1.54/nodes/test']) {
    assert.equal((await fetch(base+endpoint)).status, 200, endpoint);
  }
  for (const endpoint of ['/v1.54/secrets','/v1.54/configs','/v1.54/containers/json']) {
    assert.equal((await fetch(base+endpoint)).status, 403, endpoint);
  }
  for (const method of ['POST','PUT','PATCH','DELETE']) {
    assert.equal((await fetch(base+'/v1.54/services/create', { method, body: '{}' })).status, 403, method);
  }
  assert.equal(writes, 0, 'A write reached the Docker socket fixture');
});
