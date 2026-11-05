---
status: accepted
recorded: 2026-11-06
---

# Consul discovery and health-aware gateway routing

Retain Consul registration and automatic service health checks. The gateway selects healthy instances and uses fixed service names when Consul is unavailable.

Fallback routing has less health information. Fixed-name service-to-service calls remain an acknowledged limitation. The registry and gateway have their own failure boundaries, which must appear in the risk matrix and failure demonstrations.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 18, original ADR-021. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
