---
status: accepted
recorded: 2026-11-06
---

# API gateway with centralized authentication

Keep the API gateway as the public entry point. Traefik delegates Auth-issued JWT/current-account checks to a private Auth ForwardAuth adapter and forwards trustworthy identity, as amended by [ADR-0029](0029-traefik-swarm-discovery.md). Internal operations must remain unavailable through public gateway routing.

Services still enforce ownership and capabilities. Public client headers cannot establish identity. Hosted network boundaries must prevent clients from calling trusted internal endpoints directly.

The [system design](../system-design.md#identity-permissions-and-tutor-activation) requires current Auth permission checks for protected new requests and replacement of client-supplied identity headers.
Keep business workflows in their owners. The gateway does not become a payment, review, or approval coordinator.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 17, original ADR-018. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
