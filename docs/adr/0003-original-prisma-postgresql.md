---
status: superseded by ADR-0015 for extracted services
recorded: 2026-11-06
---

# Prisma and PostgreSQL in the original backend

The original backend chose Prisma over PostgreSQL for typed data access and local transactions covering Booking and Wallet.

[ADR-0015](0015-database-per-service.md) limits this decision to the original single-backend version. Extracted services use their own databases under ADR-0016 and ADR-0017. Do not require shared Prisma access or claim that separate Booking and Wallet commits form one transaction.

The replacement must meet [ADR-0011](0011-booking-service.md), including durable attempts and reconciliation.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 10, original ADR-003. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
