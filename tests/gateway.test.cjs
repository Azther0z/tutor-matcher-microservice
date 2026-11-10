const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const express = require('../auth-service/node_modules/express');
const jwt = require('../auth-service/node_modules/jsonwebtoken');
const { createGatewayAuthorization } = require('../auth-service/src/gateway-auth');

const root = path.resolve(__dirname, '..');
const cache = path.join(root, '.cache/gateway');
const binary = process.env.TRAEFIK_BIN || path.join(cache, 'traefik');
const provider = process.env.GATEWAY_TEST_PROVIDER || 'swarm';
assert.ok(['swarm', 'docker'].includes(provider));
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'gateway-test@example.invalid' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server, port = 0, host = '127.0.0.1') {
  server.listen(port, host);
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function eventually(check, description) {
  const until = Date.now() + 12000;
  let last;
  while (Date.now() < until) {
    try { await check(); return; } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`${description}: ${last?.message}`);
}

test(`Traefik ${provider} discovery, private Auth and controlled HTTP services`, { timeout: 90000 }, async (t) => {
  mkdirSync(cache, { recursive: true });
  const stack = JSON.parse(execFileSync('python', ['-c',
    `import json,yaml; print(json.dumps(yaml.safe_load(open("${provider === 'swarm' ? 'deploy/compose.yaml' : 'compose.yaml'}"))))`], { cwd: root }));
  const children = [];
  const servers = [];
  let postmanLog = '';
  let traefikLog = '';
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), pause(3000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    writeFileSync(path.join(cache, 'traefik.log'), traefikLog);
    writeFileSync(path.join(cache, 'simulation.ndjson'), postmanLog);
  });

  const simulationPort = await freePort();
  const simulation = spawn('postman', ['simulation', 'run', 'postman/simulations/gateway/gateway.sim.yaml',
    '--port', String(simulationPort), '--no-history', '--output', 'ndjson'], { cwd: root });
  children.push(simulation);
  simulation.stdout.on('data', (data) => { postmanLog += data; });
  simulation.stderr.on('data', (data) => { postmanLog += data; });
  await eventually(async () => {
    assert.equal(simulation.exitCode, null, 'Postman simulation exited');
    const response = await fetch(`http://127.0.0.1:${simulationPort}/tutors`, { headers: { 'x-mock-slug': 'business' } });
    assert.equal(response.status, 200);
  }, 'start Postman simulation');

  const state = { database: true, account: true, authHealthy: true, discovery: true, tutorReplicas: 1, authReplicas: 1 };
  const secret = randomBytes(32).toString('hex');
  const authorization = createGatewayAuthorization({ jwtSecret: secret, pool: {
    async query(_sql, parameters) {
      if (!state.database) throw new Error('Synthetic database failure');
      return { rows: state.account && parameters[0] === user.id ? [user] : [] };
    },
  } });
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.sendStatus(state.authHealthy ? 200 : 503));
  app.get('/internal/gateway/authorize', authorization);
  app.get('/auth/me', (req, res) => res.json({ id: req.get('x-user-id'), email: req.get('x-user-email') }));
  app.post('/auth/register', (_req, res) => res.status(201).json({ route: 'register' }));
  app.post('/auth/login', (_req, res) => res.json({ route: 'login' }));
  const auth = http.createServer(app); servers.push(auth);
  const authPort = await listen(auth);

  const instances = {};
  async function business(name, host, port = 0) {
    const instance = { healthy: true, disconnect: false, writes: 0 };
    const server = http.createServer(async (req, res) => {
      if (req.url === '/health') { res.writeHead(instance.healthy ? 200 : 503); return res.end(); }
      if (!['GET', 'HEAD'].includes(req.method)) instance.writes += 1;
      if (instance.disconnect) return req.socket.destroy();
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const headers = { ...req.headers, 'x-mock-slug': 'business', 'x-test-instance': name };
        delete headers.host; delete headers['content-length']; delete headers.connection;
        const response = await fetch(`http://127.0.0.1:${simulationPort}${req.url}`, {
          method: req.method, headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
        });
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(502); res.end(); }
    });
    servers.push(server); instance.port = await listen(server, port, host); instance.host = host;
    instances[name] = instance;
    return instance;
  }
  const tutorA = await business('tutor-a', '127.0.0.2');
  await business('tutor-b', '127.0.0.3', tutorA.port);
  const booking = await business('booking', '127.0.0.1');
  const wallet = await business('wallet', '127.0.0.1');
  const ports = { 'auth-service': authPort, 'tutor-service': tutorA.port, 'booking-service': booking.port, 'wallet-service': wallet.port };
  const networkID = 'gateway-test-network';
  const network = { Id: networkID, Name: 'tutor-matcher_backend', Driver: 'overlay', Scope: 'swarm' };
  function labels(name) {
    return { ...(provider === 'swarm' ? stack.services[name].deploy.labels : stack.services[name].labels),
      'com.docker.stack.namespace': 'tutor-matcher',
      [`traefik.http.services.${name}.loadbalancer.server.port`]: String(ports[name]),
      [`traefik.http.services.${name}.loadbalancer.healthcheck.interval`]: '100ms' };
  }
  function containers() {
    return Object.keys(ports).flatMap((name) => (name === 'tutor-service'
      ? ['127.0.0.2', '127.0.0.3'].slice(0, state.tutorReplicas) : ['127.0.0.1'].slice(0, name === 'auth-service' ? state.authReplicas : 1))
      .map((address, index) => ({ Id: `${name}-${index}`, Name: `/${name}-${index}`,
        Names: [`/${name}-${index}`], Labels: labels(name),
        Config: { Labels: labels(name), ExposedPorts: { [`${ports[name]}/tcp`]: {} } },
        State: { Running: true, Health: { Status: 'healthy' } },
        HostConfig: { NetworkMode: 'tutor-matcher_backend' },
        NetworkSettings: { Networks: { 'tutor-matcher_backend': { NetworkID: networkID, IPAddress: address } } } })));
  }
  const docker = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('API-Version', '1.54');
    if (!state.discovery) { res.writeHead(503); return res.end('{}'); }
    const url = new URL(req.url, 'http://fixture');
    const endpoint = url.pathname.replace(/^\/v[0-9.]+/, '');
    if (endpoint === '/_ping') return res.end('OK');
    if (endpoint === '/version') return res.end(JSON.stringify({ Version: '29.0.0', ApiVersion: '1.54', MinAPIVersion: '1.44', Os: 'linux' }));
    if (endpoint === '/networks') return res.end(JSON.stringify([network]));
    if (endpoint === '/containers/json') return res.end(JSON.stringify(containers().map((container) => ({ ...container, State: 'running' }))));
    if (/^\/containers\/[^/]+\/json$/.test(endpoint)) {
      return res.end(JSON.stringify(containers().find((container) => container.Id === endpoint.split('/')[2])));
    }
    if (endpoint === '/events') {
      res.setHeader('Content-Type', 'application/x-ndjson'); res.flushHeaders();
      const timer = setInterval(() => {
        if (state.discovery) res.write(JSON.stringify({ Type: 'container', Action: 'start', Actor: { ID: 'fixture' } }) + '\n');
      }, 200);
      req.on('close', () => clearInterval(timer)); return;
    }
    if (endpoint === '/services') return res.end(JSON.stringify(Object.entries(ports).map(([name, port]) => ({
      ID: name,
      Spec: { Name: `tutor-matcher_${name}`, Mode: { Replicated: { Replicas: name === 'tutor-service' ? state.tutorReplicas : 1 } },
        Labels: labels(name) },
    }))));
    if (endpoint === '/tasks') {
      const filters = JSON.parse(url.searchParams.get('filters') || '{}');
      const name = Object.keys(filters.service || {})[0] || filters.service?.[0];
      const addresses = name === 'tutor-service' ? ['127.0.0.2', '127.0.0.3'].slice(0, state.tutorReplicas) : ['127.0.0.1'].slice(0, name === 'auth-service' ? state.authReplicas : 1);
      return res.end(JSON.stringify(addresses.map((address, index) => ({ ID: `${name}-${index}`, ServiceID: name, Slot: index + 1,
        Status: { State: 'running' }, NetworksAttachments: [{ Network: { ID: networkID }, Addresses: [`${address}/32`] }] }))));
    }
    res.writeHead(501); res.end(JSON.stringify({ error: 'Unmodeled Docker API request' }));
  }); servers.push(docker);
  const dockerPort = await listen(docker);
  const webPort = await freePort(); const authListenerPort = await freePort(); const pingPort = await freePort();
  const routes = path.join(cache, 'routes.yaml');
  writeFileSync(routes, readFileSync(path.join(root, 'api-gateway/routes.yaml'), 'utf8')
    .replace('http://127.0.0.1:8081/', `http://127.0.0.1:${authListenerPort}/`));
  const args = stack.services['api-gateway'].command.map((arg) => arg
    .replace('tcp://docker-api:2375', `http://127.0.0.1:${dockerPort}`)
    .replaceAll('${STACK_NAME:-tutor-matcher}', 'tutor-matcher')
    .replace('/etc/traefik/dynamic/routes.yaml', routes)
    .replace('--entrypoints.web.address=:8080', `--entrypoints.web.address=127.0.0.1:${webPort}`)
    .replace('--entrypoints.auth.address=127.0.0.1:8081', `--entrypoints.auth.address=127.0.0.1:${authListenerPort}`)
    .replace('--entrypoints.traefik.address=127.0.0.1:8082', `--entrypoints.traefik.address=127.0.0.1:${pingPort}`)
    .replace('--providers.swarm.refreshseconds=2s', '--providers.swarm.refreshseconds=200ms'));
  const traefik = spawn(binary, args, { cwd: root, env: { ...process.env, TRAEFIK_DISCOVERY_PROVIDER: provider } });
  children.push(traefik);
  traefik.stdout.on('data', (data) => { traefikLog += data; });
  traefik.stderr.on('data', (data) => { traefikLog += data; });
  const base = `http://127.0.0.1:${webPort}`;
  async function request(route, options = {}) {
    const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  }
  const token = jwt.sign({ sub: user.id, email: 'stale@example.invalid' }, secret, { expiresIn: '5m' });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  await eventually(async () => {
    assert.equal(traefik.exitCode, null, 'Traefik exited; inspect .cache/gateway/traefik.log');
    assert.equal((await request('/tutors')).status, 200);
  }, 'discover initial Swarm task');

  await t.test('the configured container readiness command reaches Traefik ping', () => {
    execFileSync(binary, ['healthcheck', '--ping', `--entrypoints.traefik.address=127.0.0.1:${pingPort}`], { stdio: 'pipe' });
  });

  await t.test('public reads strip spoofed identity and preserve the query', async () => {
    const response = await request('/tutors?subject=Math&maxRate=1000', { headers: { ...headers,
      'X-User-Id': 'forged', 'X-User-Email': 'forged@example.invalid', 'X-Actor-Context': 'forged' } });
    assert.equal(response.status, 200); assert.equal(response.body.userId, null);
    assert.equal(response.body.hasBrowserToken, false); assert.equal(response.body.hasActorContext, false);
    assert.equal(response.body.url, '/tutors?subject=Math&maxRate=1000');
  });
  await t.test('login/register stay public and private/unknown paths stay closed', async () => {
    assert.equal((await request('/auth/register', { method: 'POST' })).status, 201);
    assert.equal((await request('/auth/login', { method: 'POST' })).status, 200);
    for (const route of ['/internal/gateway/authorize', '/internal/charge', '/health', '/api/rawdata', '/tutors/id/internal', '/wallet/internal']) {
      assert.equal((await request(route, { headers: { Host: 'tutor-matcher_auth-service' } })).status, 404, route);
    }
    assert.equal((await request('/tutors', { method: 'PATCH', headers })).status, 404);
  });
  await t.test('protected routes reject missing, invalid, expired and malformed tokens', async () => {
    const badTokens = ['', 'invalid', jwt.sign({ sub: user.id }, randomBytes(32)),
      jwt.sign({ sub: user.id }, secret, { expiresIn: -1 }), jwt.sign({ sub: 'not-an-id' }, secret),
      jwt.sign({ sub: user.id }, secret, { algorithm: 'HS384' })];
    for (const bad of badTokens) {
      assert.equal((await request('/wallet', { headers: bad ? { Authorization: `Bearer ${bad}` } : {} })).status, 401);
    }
  });
  await t.test('Auth replaces spoofed identity using current database data', async () => {
    const response = await request('/wallet', { headers: { ...headers, 'X-User-Id': 'forged', 'X-User-Email': 'forged', 'X-Actor-Context': 'forged' } });
    assert.equal(response.status, 200); assert.equal(response.body.userId, user.id);
    assert.equal(response.body.email, user.email); assert.equal(response.body.hasBrowserToken, false);
    assert.equal(response.body.hasActorContext, false);
    assert.deepEqual((await request('/auth/me', { headers })).body, user);
  });
  await t.test('protected writes preserve the method and JSON body', async () => {
    for (const [method, route] of [['POST','/tutors'], ['PUT','/tutors/id'], ['DELETE','/tutors/id'],
      ['POST','/availability'], ['POST','/bookings'], ['POST','/bookings/id/pay'], ['POST','/bookings/id/cancel'],
      ['POST','/wallet/topups'], ['POST','/wallet/topups/id/confirm']]) {
      const response = await request(route, { method, headers, body: JSON.stringify({ synthetic: true }) });
      assert.equal(response.status, 200, route); assert.equal(response.body.method, method);
      assert.deepEqual(response.body.body, { synthetic: true });
    }
  });
  await t.test('account removal and database failure fail closed before a write', async () => {
    const before = wallet.writes;
    state.account = false;
    assert.equal((await request('/wallet/topups', { method: 'POST', headers })).status, 401);
    state.account = true; state.database = false;
    assert.equal((await request('/wallet/topups', { method: 'POST', headers })).status, 503);
    state.database = true; assert.equal(wallet.writes, before);
  });
  await t.test('scale and health changes update routing without app registration', async () => {
    state.tutorReplicas = 2;
    await eventually(async () => {
      const seen = new Set();
      for (let i = 0; i < 8; i++) seen.add((await request('/tutors')).body.instance);
      assert.deepEqual(seen, new Set(['tutor-a','tutor-b']));
    }, 'discover added Tutor task');
    tutorA.disconnect = true;
    for (let i = 0; i < 8; i++) assert.equal((await request('/tutors')).status, 200);
    tutorA.disconnect = false;
    tutorA.healthy = false;
    await eventually(async () => {
      for (let i = 0; i < 5; i++) assert.equal((await request('/tutors')).body.instance, 'tutor-b');
    }, 'exclude unhealthy Tutor');
    state.tutorReplicas = 1; tutorA.healthy = true;
    await eventually(async () => assert.equal((await request('/tutors')).body.instance, 'tutor-a'), 'remove Tutor task');
  });
  await t.test('discovery outage retains known routing; Auth pool outage returns 503', async () => {
    state.discovery = false; await pause(500);
    assert.equal((await request('/tutors')).status, 200);
    assert.equal((await request('/wallet', { headers })).status, 200);
    state.discovery = true; state.authHealthy = false;
    await eventually(async () => assert.equal((await request('/wallet', { headers })).status, 503), 'exclude unhealthy Auth');
    state.authHealthy = true;
    await eventually(async () => assert.equal((await request('/wallet', { headers })).status, 200), 'recover Auth');
  });
  await t.test('a lost write response never triggers a gateway retry', async () => {
    const before = wallet.writes; wallet.disconnect = true;
    assert.equal((await request('/wallet/topups', { method: 'POST', headers })).status, 502);
    wallet.disconnect = false; assert.equal(wallet.writes - before, 1);
  });
  await t.test('zero-task services return 503 without opening private paths', async () => {
    state.tutorReplicas = 0;
    await eventually(async () => assert.equal((await request('/tutors')).status, 503), 'remove all Tutor tasks');
    assert.equal((await request('/tutors/id/internal')).status, 404);
    state.tutorReplicas = 1; state.authReplicas = 0;
    await eventually(async () => assert.equal((await request('/wallet', { headers })).status, 503), 'remove all Auth tasks');
    state.authReplicas = 1;
    await eventually(async () => assert.equal((await request('/wallet', { headers })).status, 200), 'rediscover Auth');
  });
  await t.test('simulation logs establish business requests reached Postman', async () => {
    await eventually(async () => {
      const events = postmanLog.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      for (const route of ['/tutors', '/wallet']) {
        assert.ok(events.some((event) => event.event === 'request' && event.routeKey === 'business' && event.path.startsWith(route)));
      }
    }, 'record routed business requests');
  });
});
