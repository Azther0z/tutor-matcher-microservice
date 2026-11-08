# Traefik gateway

The public gateway is Traefik OSS 3.7.17. There is no custom Express or Node request proxy. [ADR-0029](../docs/adr/0029-traefik-swarm-discovery.md) records the replacement of the earlier gateway and Consul registry.

The public route allowlist is derived from the 86 operations in [public OpenAPI](../contracts/public.openapi.json). Traefik routes only those exact `/api` methods and paths to their `x-owner`; private owner health checks, internal REST, gRPC, database, broker, and Docker API interfaces are not public. The public `/api/health` operation remains an explicit exception for the gateway health response. Unmatched paths and unsupported methods receive Traefik ingress responses. Legacy demo paths without `/api` are not a compatibility promise.

Local Compose uses Traefik's Docker provider. Hosted Swarm reads opt-in services and tasks through the restricted, read-only Docker API proxy. Traefik receives task addresses and health-check configuration from labels; the public method/path list remains the OpenAPI-derived route configuration. The Docker socket is mounted only in the proxy, which is isolated from application containers. The dashboard is disabled. Local Compose publishes gateway port 8080 and web port 3000 on loopback. The hosted review template publishes only the candidate web origin on port 3334; web forwards `/api` to the private gateway.

## Protected request flow

1. Traefik matches the exact public OpenAPI method/path and strips caller-supplied actor, user, caller, and workload identity headers.
2. For protected operations, ForwardAuth calls the private `GET /internal/gateway/authorize` listener inside Traefik. It sends the browser `Authorization: Bearer <JWT>` separately from `X-Workload-Authorization: Bearer <gateway credential>`, with the request context, and selects a healthy Auth task. This loopback-only entrypoint trusts forwarded metadata only from loopback addresses; the public entrypoint does not trust caller-supplied forwarding metadata.
3. Auth verifies the Gateway workload proof, browser token, current session, account status and operation capability. It signs a short-lived RS256 actor assertion (60 seconds, logical issuer `api-gateway`) only after those checks.
4. A successful authorization returns `X-Actor-Context` and `X-Request-Id` to Traefik. Traefik removes the browser token and proof header, replaces caller identity headers, and forwards the assertion plus `Authorization: Bearer <gateway credential>` to the owning service.
5. The owner validates the body against its contract and checks actor/resource ownership and business policy. Gateway admission does not replace owner authorization.

The Auth signing key remains in Auth's protected runtime configuration. Traefik and the browser never receive it. The ForwardAuth endpoint is a private control-plane interface, outside the eight-operation internal OpenAPI inventory: that inventory still contains retained introspection plus seven owner-status polls. Private owner `/health` checks are likewise not public operations. Private domain gRPC remains the existing 20-method contract.

Auth returns its standard top-level JSON Error DTO and `X-Request-Id` on errors: 400 for invalid request metadata, 401 for missing or invalid proof/session, 403 for a restricted account or missing capability, and 503 when Auth storage prevents a current authorization check. Owner schema and resource failures use the owner's application Error response. Traefik can also generate 404, 502, 503, or 504 responses without an application JSON body or UUID request ID. Clients must handle non-JSON ingress errors and keep the same idempotency key when retrying a mutation.

Owners validate or generate `X-Request-Id` for anonymous requests. Protected admission normalizes it before Auth signs it into the actor assertion, and successful ForwardAuth returns it to Traefik. No UUID plugin is used. Traefik-native ingress failures can omit the request ID.

## Discovery, health and retries

Traefik probes HTTP owners on `/health` with a two-second interval and one-second timeout; the gateway's health route is part of the public operation inventory. In the target, Notification owns public preference/inbox operations as well as a RabbitMQ consumer. The older standalone Notification consumer does not implement that target HTTP API. Swarm discovery refreshes through the restricted proxy; the local Docker provider uses Compose service labels. Internal REST and gRPC collaborators use their configured private service DNS names and ports.

When the Docker API becomes unavailable, Traefik retains its last discovered configuration and continues active health checks. A known owner with no healthy task returns 503. Detection takes time, a restarted gateway needs fresh discovery, and new tasks are unknown while the API is unavailable. This does not provide a fixed-DNS fallback or an availability guarantee.

Only contract-designated safe reads may use bounded connection/502–504 retries. Mutations, payments and refunds have no gateway retry middleware. Callers preserve their idempotency key and owners use durable operation identities to resolve uncertain outcomes. Gateway retries do not establish business correctness.

## Evidence

The [Traefik integration evidence](../docs/evidence/saint/traefik-integration.md) records verification for the combined Traefik, Auth, route inventory and owner boundary. Its pending rows must not be reported as passed until the checks run against the current merged stack. The [earlier PR4 validation record](VALIDATION.md) describes standalone Traefik discovery and proxy checks; it does not establish the integrated identity slice, all 86 `/api` routes, database-backed admission, owner behavior, or hosted deployment.
