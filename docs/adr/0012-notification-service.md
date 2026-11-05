---
status: accepted
recorded: 2026-11-06
---

# Extract asynchronous Notification processing

Keep notification processing separate so delivery failures cannot reverse committed business decisions. Notification owns delivery preferences and records and consumes events asynchronously.

The original record reports a successful consumer-outage demonstration. Treat it as historical evidence, not a fresh test of this revision. [ADR-0024](0024-recoverable-notifications.md) adds recovery when publishing itself fails.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 15, original ADR-012. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
