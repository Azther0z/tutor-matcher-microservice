---
status: superseded
recorded: 2026-11-06
---

# Consul discovery and health-aware gateway routing

Superseded on 8 November 2026 by [ADR-0029 Traefik and Swarm discovery](0029-traefik-swarm-discovery.md), following the user's explicit replacement decision. The original decision below is retained as history.

Retain Consul registration and automatic service health checks. The gateway selects healthy instances and uses fixed service names when Consul is unavailable.

Fallback routing has less health information. Fixed-name service-to-service calls remain an acknowledged limitation. The registry and gateway have their own failure boundaries, which must appear in the risk matrix and failure demonstrations.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 18, original ADR-021. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
