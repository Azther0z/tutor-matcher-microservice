const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
function yaml(file) {
  return JSON.parse(execFileSync('python3', ['-c', 'import json,yaml,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', file], { cwd: root, encoding: 'utf8' }));
}
function labelsFor(compose, name) {
  const service = compose.services[name];
  return service.deploy?.labels ?? service.labels ?? {};
}
const owners = {
  auth: { http: 4002, grpc: 50051 },
  booking: { http: 4004, grpc: 50052 },
  tutor: { http: 4001, grpc: 50053 },
  wallet: { http: 4003, grpc: 50054 },
  review: { http: 4005, grpc: 50055 },
  messaging: { http: 4006 },
  notification: { http: 4007 },
};

test('Compose and Swarm expose private owner names only through internal Traefik', () => {
  const local = yaml('compose.yaml');
  const hosted = yaml('infra/hosted/compose.yaml');
  for (const [compose, replicas] of [[local, 1], [hosted, 2]]) {
    const proxy = compose.services['internal-traefik'];
    assert.ok(proxy, 'internal Traefik service exists');
    assert.equal(proxy.ports, undefined, 'internal entrypoint has no published port');
    assert.equal(proxy.deploy?.replicas ?? 1, replicas);
    assert.ok(proxy.networks.socket, 'internal Traefik can reach the restricted socket proxy');
    assert.ok(compose.services['api-gateway'].networks.includes('socket'), 'public gateway remains an independent socket client');
    for (const owner of Object.keys(owners)) assert.ok(proxy.networks.backend.aliases.includes(`${owner}.internal`));
    for (const [owner, ports] of Object.entries(owners)) {
      const labels = labelsFor(compose, `${owner}-service`);
      assert.equal(labels['tutor-matcher.internal'], 'true', `${owner} participates in private discovery`);
      assert.equal(labels['traefik.swarm.lbswarm'], 'false', `${owner} routes directly to task addresses`);
      assert.equal(labels[`traefik.http.services.internal-${owner}-http.loadbalancer.server.port`], String(ports.http));
      if (ports.grpc) {
        assert.equal(labels[`traefik.http.services.internal-${owner}-grpc.loadbalancer.server.port`], String(ports.grpc));
        assert.equal(labels[`traefik.http.services.internal-${owner}-grpc.loadbalancer.server.scheme`], 'h2c');
        assert.equal(labels[`traefik.http.services.internal-${owner}-grpc.loadbalancer.healthcheck.mode`], 'grpc');
      }
      assert.equal(compose.services[`${owner}-service`].ports, undefined, `${owner} owner ports remain unpublished`);
    }
  }
  assert.match(local.services['api-gateway'].command.join('\n'), /providers\.docker/);
  assert.match(hosted.services['api-gateway'].command.join('\n'), /providers\.swarm/);
  assert.equal(local.services['docker-api'].environment.POST, '0');
  assert.equal(hosted.services['docker-api'].environment.POST, '0');
  for (const key of ['CONTAINERS', 'NETWORKS', 'EVENTS']) assert.equal(local.services['docker-api'].environment[key], '1');
  for (const key of ['SERVICES', 'TASKS', 'NETWORKS', 'NODES']) assert.equal(hosted.services['docker-api'].environment[key], '1');
  assert.equal(local.services['internal-traefik'].environment.TRAEFIK_DISCOVERY_PROVIDER, 'docker');
  assert.equal(hosted.services['internal-traefik'].environment.TRAEFIK_DISCOVERY_PROVIDER, 'swarm');
});

test('internal route inventory covers contracted owner REST and gRPC methods, not health or admin paths', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'contracts/operation-map.json'), 'utf8'));
  const routes = [yaml('infra/internal-traefik/routes.docker.yaml'), yaml('infra/internal-traefik/routes.swarm.yaml')];
  const rest = inventory.filter((item) => item.protocol === 'REST' && item.surface === 'PUBLIC' && Object.hasOwn(owners, item.owner));
  const grpc = inventory.filter((item) => item.protocol === 'GRPC' && item.surface === 'INTERNAL' && ['auth', 'booking', 'review', 'tutor', 'wallet'].includes(item.owner));
  assert.equal(rest.length, 88);
  assert.equal(grpc.length, 20);
  for (const config of routes) {
    const routers = config.http.routers;
    for (const item of rest) {
      const route = item.path.startsWith('/api/') ? item.path.slice(4) : item.path;
      const router = routers[item.operationId];
      assert.ok(router, `${item.operationId} router exists`);
      assert.ok(router.rule.includes(`Host(\`${item.owner}.internal\`)`));
      assert.ok(router.rule.includes(`Method(\`${item.method}\`)`));
      const matcher = route.includes('{') ? `^${route.replace(/\{[^/{}]+\}/g, '[^/]+')}$` : `Path(\`${route}\`)`;
      assert.ok(router.rule.includes(matcher), `${item.operationId} path is exact`);
    }
    for (const item of grpc) assert.ok(routers[`${item.owner}-grpc`].rule.includes(`Path(\`${item.path}\`)`), `${item.operationId} gRPC path is routed`);
    const routerText = JSON.stringify(routers);
    assert.doesNotMatch(routerText, /\/health|\/internal\/v1\//, 'health and admin REST routes stay outside the proxy');
    assert.doesNotMatch(routerText, /retry:/i, 'internal proxy config adds no automatic retries');
  }
  const publicRoutes = fs.readFileSync(path.join(root, 'infra/gateway/routes.yaml'), 'utf8');
  assert.match(publicRoutes, /service: tutor-service@/);
  assert.doesNotMatch(publicRoutes, /internal-(?:auth|booking|tutor|wallet|review)-(?:http|grpc)/);
});
