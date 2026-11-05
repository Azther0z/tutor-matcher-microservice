---
status: accepted
recorded: 2026-11-06
---

# Extract Booking with payment recovery

Keep Booking independently deployable with owned persistence and explicit contracts. Replacing the shared Booking/Wallet transaction requires durable payment attempts and a stable operation identity for retries.

Reconcile an uncertain charge before releasing held slots or completing cancellation. A lost response must not leave a charged student without a confirmed lesson or an accounted refund. Recovery requires tests and operational evidence, not only an idempotent Wallet endpoint.

The later service design groups availability, booking lifecycle, and lesson delivery under Booking. Do not create a separate Fulfillment service solely from historical collaborator wording.

The [system design](../system-design.md#booking-and-payment) uses a Booking-owned PostgreSQL transaction for slot claims, lifecycle state, durable operations, and event work.
Wallet calls run after commit. Recovery must resolve an applied charge or durably close an unexecuted operation against late execution before releasing protected slots.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 14, original ADR-011. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.

[ADR-0028](0028-private-domain-grpc.md) changes private domain calls to typed gRPC. Booking/Wallet financial recovery, immutable identities and transaction ownership remain required. A gRPC timeout does not establish financial failure.
