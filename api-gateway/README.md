# Traefik gateway

The gateway is Traefik OSS 3.7.17, not a Node application. [ADR-0029](../docs/adr/0029-traefik-swarm-discovery.md) records the replacement of the Express proxy and Consul.

`routes.yaml` is the public method/path allowlist for the current backend demo. It is shared by local Compose and hosted Swarm. The file provider expands `TRAEFIK_DISCOVERY_PROVIDER` to `docker` or `swarm`. Container/service labels supply backend ports and active `/health` checks, not public route definitions. The discovery provider's default route deliberately never matches. Services without the gateway opt-in label are excluded.

The current public base stays `http://127.0.0.1:8080`; paths such as `/auth/login`, `/tutors`, `/bookings` and `/wallet` remain unchanged. The larger `/api` target contract is still implementation work. Add future routes explicitly; do not expose all paths on a backend. Unmatched routes return Traefik's plain-text 404, rather than the removed proxy's JSON 404.

## Protected request flow

1. Traefik strips incoming internal identity headers.
2. ForwardAuth sends the browser token to a loopback-only authorization listener inside Traefik.
3. That listener selects a healthy Auth task and calls `GET /internal/gateway/authorize`.
4. Auth verifies the HS256 token and reads the current account from its database. A missing account returns 401; an unavailable lookup returns 503.
5. Traefik copies the verified account ID/email to the original request, removes the browser token, and forwards to the domain service.

The internal listener uses the discovered Auth pool, so no healthy Auth backend returns 503 before admission. It is bound to `127.0.0.1:8081` inside the gateway, has no published port, and has no route on the public entrypoint. Auth's endpoint is not publicly routed. Domain ownership checks remain the services' responsibility.

Current account existence is checked; the current database does not implement bans, sessions, capabilities or signed actor admissions. The accepted full Auth/actor contract remains future work. Traefik delegates that future admission/signing work to the Auth adapter; it does not implement JWT signing or financial workflows itself.

## Discovery and failure behavior

Local Compose uses the Docker provider. Hosted deployment uses the Swarm provider, service `deploy.labels`, private task addresses and a two-second discovery refresh. Traefik probes each HTTP backend every two seconds with a one-second timeout. Docker also probes HTTP-service readiness for task health. Notification stays a broker consumer without a public route.

Traefik retains the last successfully discovered configuration when the Docker API is unavailable. Active backend checks continue excluding unavailable targets. An empty known backend pool returns 503. This is not the old fixed-DNS fallback and is not a guarantee of uninterrupted routing: discovery/health detection has delay, a gateway restart needs fresh discovery, and new tasks are unknown while the API is down.

Only selected read-only routers retry connection failures or 502–504 responses, at most twice in total. The mixed GET/POST bookings-collection router deliberately has no retry middleware. Writes, payments and refunds have no gateway retry middleware. Owners still need durable operation identities for caller retries and uncertain outcomes.

The Docker socket is mounted only by a separate socket proxy. Traefik reaches its read-only allowlisted API over an isolated discovery network. The hosted proxy is manager-constrained; application containers cannot join that network through this manifest. Docker API access remains privileged information access even when write methods are denied. Lower-priority fallback routers share the exact allowlist via YAML anchors and return 503 when a provider removes a service with no tasks; they never forward to another owner.

The dashboard is disabled. Readiness ping is loopback-only on 8082. JSON access logs identify router, backend address, status and retry count; authorization headers are not logged. The removed Express `x-served-by` header is no longer generated.

## Verification

Install Auth's existing dependencies with `npm ci --prefix auth-service`. The integration test requires Python/PyYAML, Postman CLI 1.70+ and a Traefik 3.7.17 binary. Set `TRAEFIK_BIN` to that binary, then run:

```sh
node --test tests/gateway.test.cjs
GATEWAY_TEST_PROVIDER=docker node --test tests/gateway.test.cjs
node --test tests/runtime-env.test.cjs
CONTAINER_ENGINE=podman node --test tests/socket-proxy.test.cjs
```

The gateway test runs real Traefik with the selected manifest's labels, the real Auth authorization handler with a synthetic account lookup, a controlled Docker/Swarm API fixture, and local Postman HTTP stand-ins. It checks public/private routes, spoofed identity, token rejection, current-account lookup failure, JSON/method/query forwarding, scaling, backend health, discovery outage, Auth outage, zero tasks and no write retry. The socket-proxy test runs the pinned image against a synthetic Unix socket, not the host's Docker socket; on SELinux hosts it disables labeling for that test container only. Only gateway-boundary behavior is established; a real Swarm rollout and database-backed business journey remain separate checks. See the [validation record](VALIDATION.md).

For an isolated binary obtained from the pinned image, use a container engine to create a temporary container, copy `/usr/local/bin/traefik`, and remove that temporary container. The local test outputs belong under ignored `.cache/gateway/`. It creates no cloud workspace or deployed mocks.
