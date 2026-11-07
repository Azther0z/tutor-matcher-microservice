---
status: accepted
recorded: 2026-11-06
---

# Use PostgreSQL for Booking consistency

Booking must atomically claim related slots, create a booking, and retain durable operation and event work. Use a separate PostgreSQL database for these related records.
This supersedes only Booking's MongoDB selection in [ADR-0017](0017-mongodb-document-services.md). Auth and Wallet retain their separate PostgreSQL databases.
Tutor, Notification, Review, and Messaging retain separate MongoDB databases. The course's relational and NoSQL requirement remains satisfied.

The alternative was to retain the existing Booking MongoDB records and add replica-set transactions, or redesign around larger single-document aggregates.
The user selected PostgreSQL as the focused exception to the existing design. Do not change other owners or protocols merely because Booking changes engine.

Booking and Wallet still cannot share a transaction. [ADR-0011](0011-booking-service.md) and the [system design](../system-design.md#booking-and-payment) require durable recovery across that boundary.
Remaining MongoDB services still need replica-set configuration for their selected multi-document transactions. One member is not database failover.

Source: user-confirmed step-2 decision, 6 November 2026. The [original PDF](../sources/tutor-matcher.pdf), p. 16, is preserved unchanged.
