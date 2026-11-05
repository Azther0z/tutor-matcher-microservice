---
status: accepted
recorded: 2026-11-06
---

# Evidence and safeguards for service extraction

The original path keeps contexts together until measured scaling, isolation, or release needs justify extraction. Each extraction requires explicit contracts, owned persistence, recovery procedures, and monitoring.

This checkout already runs separate services. The historical sequence does not require rebuilding the monolith or repeating an earlier migration. Keep its safeguards for current services and later splits.

Containers alone do not prove that extraction gates or recovery requirements are complete. Record measured evidence separately.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 13, original ADR-009. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
