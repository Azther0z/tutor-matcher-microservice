---
status: accepted
recorded: 2026-11-06
---

# Separate database ownership for every service

Each service owns a separate database and reads or writes only its own data. Other services obtain information through APIs or events. Sharing an infrastructure engine does not permit cross-service table or collection access.

This supersedes the shared-database application of [ADR-0003](0003-original-prisma-postgresql.md) for extracted services. That original decision remains historical context. There are no cross-service database joins or transactions.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 16, original ADR-015. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
