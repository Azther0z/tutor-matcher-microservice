---
status: accepted
recorded: 2026-11-06
---

# Monorepo with npm workspaces

Retain one repository with npm workspaces, shared formatting and quality commands, and one workspace lockfile. Each application or service keeps its own package, build command, and runtime responsibility.

One change can coordinate UI, API, and tests across the four-person team. A build orchestrator remains deferred. Both this checkout and the pinned monolith currently use separate package lockfiles, so their existing layout does not establish compliance.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 11, original ADR-004. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
