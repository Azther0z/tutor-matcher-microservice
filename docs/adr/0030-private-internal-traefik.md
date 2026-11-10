---
status: accepted
recorded: 2026-11-11
---

# Route private owner calls through internal Traefik

Run a separate internal Traefik instance for interservice REST and gRPC traffic. Local Compose runs one internal proxy; hosted Swarm runs two replicas. Each owner has a private DNS alias on the backend network that resolves to this proxy. No internal proxy port is published.

Internal Traefik discovers owner tasks through Docker locally and Swarm when hosted. Its HTTP services use provider-discovered task addresses directly. Auth, Booking, Tutor, Wallet and Review expose separate gRPC services over h2c; Auth, Booking, Tutor, Wallet, Review, Messaging and Notification expose their contracted REST application routes. Standard gRPC Health and HTTP readiness checks remove unready task endpoints. The proxy forwards request headers and gRPC metadata without changing caller credentials or actor context.

The public gateway keeps its independent route inventory and continues to discover and reach owner tasks directly. Public authorization, admission and operation-status paths remain on that direct gateway path. Database and RabbitMQ connections remain direct. Direct owner access remains possible on the shared backend network; network-enforced proxy traversal is not part of this decision.

The internal proxy has no automatic retries. Client call deadlines and method-aware mutation recovery remain in force. If Docker API discovery fails, the proxy retains its last known task set and continues active health checks. Calls fail when no cached endpoint is healthy; direct service DNS is not a fallback. New tasks are unavailable until discovery recovers.

The isolated real Compose qualification and a single-node real Swarm qualification passed. The Swarm fixture verified persistent HTTP and gRPC distribution, authentication and readiness, task addition/removal, zero-backend failure and recovery within 15 seconds, cached endpoint health and task replacement during discovery loss, and new-call recovery through the surviving proxy within 15 seconds. The Swarm stack, services, and networks were removed after the run. These synthetic fixtures do not qualify the full application, a hosted deployment, or a multi-node Swarm. See the [qualification evidence](../evidence/internal-traefik.md).

This decision supersedes the private-service-DNS paragraph in [ADR-0029](0029-traefik-swarm-discovery.md). See the [internal Traefik configuration and qualification guide](../../infra/internal-traefik/README.md).
