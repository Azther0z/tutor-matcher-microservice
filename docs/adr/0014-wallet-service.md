---
status: accepted
recorded: 2026-11-06
---

# Extract Wallet as the financial owner

Keep Wallet as the only writer of wallet balances and financial history, including payments, refunds, earnings, and payouts. Booking calls internal operations through contracts rather than accessing Wallet data.

Separation removes the shared transaction. [ADR-0011](0011-booking-service.md) governs unknown outcomes and recovery. The selected fee, clearing period, payout permissions, and dispute remedies are defined once in the [requirements](../requirements.md).

The [system design](../system-design.md#completion-settlement-and-disputes) keeps dispute holds, cumulative refunds, pending earnings, and settlement behind one Wallet financial record and transaction.
Separate financial operation identities permit a cancellation refund and a later approved remainder refund without exceeding the original payment.
There is no separate Dispute or Settlement service sending an asynchronous freeze that can arrive after clearing.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 15, original ADR-014. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
