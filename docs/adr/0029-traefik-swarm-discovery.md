---
status: accepted
recorded: 2026-11-08
---

# Replace the custom gateway and Consul with Traefik and Swarm discovery

The user explicitly selected Traefik plus Docker Swarm on 8 November 2026, replacing the custom Express API gateway and Consul. This supersedes [ADR-0021](0021-consul-discovery.md). Hosted Swarm/Doco-CD, local Compose fallback, production builds, simulated providers, image publishing and SOPS/age remain selected.

Use Traefik OSS as the gateway. Hosted discovery reads Docker Swarm services/tasks through a restricted read-only Docker API proxy. Services no longer register themselves with a separate registry. Local Compose uses Traefik's Docker provider. Both use one explicit public method/path allowlist, opt-in discovered services, private backend networking and active backend health checks.

Delegate protected admission to a private Auth ForwardAuth endpoint. Traefik strips caller identity headers and forwards only verified identity. Auth owns token validation and current account/session/capability policy; services retain resource ownership checks. The full target's short-lived signed actor assertion remains required and is issued by the Auth admission adapter for the logical gateway boundary, not by a custom routing proxy. Its logical issuer remains `api-gateway`.

The current demo implements token verification, current-account existence and trusted user ID/email headers. Full sessions, restrictions, capability assertions and per-workload credentials remain implementation work. Adding Traefik does not complete that target authorization model.

When the Docker API is unavailable, Traefik retains its last discovered configuration while probing backend health. No known healthy backend returns 503. Discovery/health detection has delay; startup requires discovery, and new tasks cannot be discovered during an API outage. Replace the old Consul/fixed-name gateway fallback demonstrations with these measured cases. Private domain calls continue using configured service DNS and their gRPC ports.

Public routes and current port 8080 remain compatible with the backend demo. Private Auth, health, broker, database and Docker API interfaces are not public routes. Selected reads have bounded retries for connection failures and 502–504 responses; mutation routes have no gateway retry middleware. Finite deployment validation is separate from a hosted rollout.

Alternatives were retaining the custom proxy/Consul, Traefik with Consul Catalog, Caddy with Consul DNS, and a Kubernetes migration. The user selected Traefik with native Swarm discovery. See the [comparison research](../research/gateway-and-deployment-comparison.md), [gateway configuration](../../api-gateway/README.md) and [hosted deployment procedure](../../deploy/README.md).
