---
status: accepted
recorded: 2026-11-06
---

# Synchronous money decisions and asynchronous side effects

Booking calls Wallet synchronously for charges and refunds, with stable operation identities and recovery for unknown outcomes. A booking is confirmed only after its charge is known to succeed.

Notifications consume asynchronous events and do not decide business success. The original record acknowledged event loss after a committed database write. [ADR-0024](0024-recoverable-notifications.md) replaces that limitation following the user's confirmed requirement.

System design must choose recovery mechanisms. These requirements do not claim a distributed database transaction.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 18, original ADR-020. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.

[ADR-0028](0028-private-domain-grpc.md) changes private domain calls to typed gRPC. Booking/Wallet financial recovery, immutable identities and transaction ownership remain required. A gRPC timeout does not establish financial failure.
