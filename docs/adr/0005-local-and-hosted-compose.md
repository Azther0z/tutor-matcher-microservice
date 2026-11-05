---
status: accepted
recorded: 2026-11-06
---

# Separate local and hosted deployment manifests

Keep separate local and hosted Docker Compose manifests. Local development can build source and enable development settings. Hosted deployment consumes published images without building source or mounting development code.

The user retained hosted deployment for 10 November and requires a local fallback. The hosted course demo must explicitly support simulated providers while using production builds. It is not a real-money environment.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 12, original ADR-005. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
