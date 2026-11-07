---
status: "accepted; Booking selection superseded by ADR-0026"
recorded: 2026-11-06
---

# MongoDB for document-oriented services

The original decision selected MongoDB for Tutor, Booking, and Notification. Step 2 retains it for Tutor and Notification and selects it for Review and Messaging.
Each owns a separate logical database. [ADR-0026](0026-booking-postgresql.md) supersedes only the Booking selection with a separate PostgreSQL database.

Keep MongoDB transactions available through a persistent single-member replica set when business changes and durable event work span documents.
This does not provide database failover. Use unique identities and expected revisions to protect duplicate and concurrent operations.
Booking's slot consistency now follows its own PostgreSQL transaction design instead of the original per-slot MongoDB approach.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 16, original ADR-017. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
