---
status: accepted
recorded: 2026-11-06
---

# PostgreSQL for Auth and Wallet

Use separate PostgreSQL databases for Auth and Wallet. Accounts need uniqueness guarantees. Money movements need transactions, concurrency control, non-negative available funds, and unique financial operation references.

Step 2 also selects a separate PostgreSQL database for Booking under [ADR-0026](0026-booking-postgresql.md). This does not merge Booking with Wallet or restore cross-service transactions.

Completed wallet movements and posted balances must agree. Pending attempts, earnings, reservations, and disputes must not appear as completed movements before their outcomes are known.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 16, original ADR-016. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
