# Durable operation and recovery contract

This guide specifies behavior the step-4 implementation must demonstrate. No fault case below has been executed against target services yet.
Public operations are owned by the service named in OperationRef. Gateway only routes status reads. Owner status reads authorize the initiating actor, affected owner or responsible admin; an ID alone grants no access.

## Identity and state

An Idempotency-Key identifies one public action within caller identity, method and canonical route. Save the normalized input hash, actor admission, resource and owner operation ID in the owner's transaction before sending dependent writes. A replay with different input returns 409 IDEMPOTENCY_CONFLICT; an authorized same-input replay returns the recorded result or pending operation, including after a stale If-Match. Anonymous credential flows use the restricted fingerprints in the interface guide.

Do not derive financial operation IDs from a new HTTP attempt. Booking saves one charge ID per accepted payment attempt and reuses it for charge, query and close. A genuinely declined attempt can be retried after a top-up with a new public action and new attempt ID. Wallet's per-booking guard still permits at most one applied payment. Refund IDs are distinct from charge IDs, and cancellation-refund IDs are distinct from dispute-remedy IDs. Tutor grants retain one ID for an approved submission/revision. Provider IDs and receipt IDs are stable across redelivery.

Public state is PENDING, SUCCEEDED or REJECTED. UNKNOWN is a provider/technical observation that leaves the public operation PENDING; it is never proof of failure. A worker may expose NEEDS_ATTENTION internally after repeated failures without making the business operation terminal. Retain financial deduplication, closed-operation tombstones and immutable inputs for the lifetime of the booking/ledger history. No time-to-live may permit an old request to debit/refund again. Retain other course-demo idempotency records through submission; an eventual retention change requires an explicit policy.

No database transaction remains open during an HTTP or gRPC call. Use short local transactions, compare-and-swap versions and durable work. Workers claim a lease with a fence, compare that fence before local commit, and reuse the remote operation ID if a lease expires. A stale worker cannot finalize over a newer local result. Remote uniqueness guards remain necessary even when local leases work.

## Payment, cancellation and expiry

1. Booking validates subject/tutor and atomically holds every slot with the PAYMENT_DUE booking. Failed validation or a contested slot leaves no partial hold.
2. On payment, save the attempt and immutable PaymentCommand before calling Wallet. Lock/mark the booking so cancellation and expiry cannot release slots while an outcome is uncertain.
3. Wallet authenticates Booking, validates the recorded admission and immutable actor/booking/amount/times, then serializes on the booking financial record. It records APPLIED with one debit, DECLINED with no debit, or returns an existing same-input result. A first charge after holdExpiresAt cannot apply. New attempts cannot bypass a closed booking payment gate or an already-applied charge.
4. A known APPLIED receipt confirms Booking in a local transaction with its event work. A lost response leaves the operation pending, not cancelled. Wallet GET 404 only means no outcome was visible at that instant.
5. Before releasing a hold after an uncertain attempt, Booking calls resolve-or-close with the original command. Wallet takes the same financial-record/operation lock as charge. If applied, return that receipt. If not applied, atomically create a CLOSED tombstone, including when no prior operation row exists. A late charge using that ID must observe CLOSED. Preserve the original charge admission inside the close command for immutable matching; the actual cancellation actor and quote stay in Booking and in any separate refund command. Mismatched original command input is a conflict, not a new close.
6. CANCEL_REQUESTED or HOLD_EXPIRED additionally closes the per-booking payment gate against other attempts. ABORT_PAYMENT closes only that attempt and permits a new admitted attempt while the original hold is still valid. If an applied charge races expiry/cancellation, Booking must either confirm it or execute the accepted cancellation refund; it cannot simply free slots and forget the charge.
7. A paid cancellation binds the recorded quote, actor admission time and booking revision. Wallet independently checks the payment, parties, policy amount, previous refunds and cap; it does not accept an arbitrary amount from a public caller. The cancellation refund command atomically records the refunded amount and CANCELLED financial state. Finalize Booking and release/reopen or close slots only with the known outcome. Unknown refund outcomes leave cancellation visibly pending and block joining/conflicting lifecycle commands.

For an unpaid cancellation no refund command is needed. Close the payment gate with any admitted attempt fenced before release. There is no completed Wallet movement for a zero financial effect. A cancelled booking's residual money is not a tutor earning; the approved cancelled-booking dispute window remains enforceable against that financial record.

## Completion, disputes and payout

Booking captures the first tutorConfirmedAt at/after lesson end with the completed state and durable completion work. The Wallet completion PUT is idempotent on bookingId and immutable original confirmation time/source operation. A conflicting replacement time is 409 COMPLETION_CONFLICT. Wallet sets clearingDueAt to exactly that original time plus 24 hours, even if it receives the command late.

Wallet evaluates dispute opening and earning clearing under the same booking financial-record lock. It verifies Booking evidence before the decision and rechecks its own financial state inside the lock. A completed lesson can remain disputed until clearing; cancellation residual claims instead use `[startsAt, endsAt+24h)`. If a valid dispute locks first, clearing is blocked. If clearing commits first, the pre-clearing claim is closed. At the exact clearing deadline, lock order resolves the race; no wall-clock-only check overrides the committed result.

Opening a dispute saves the hold and notification work together. Permit at most one OPEN case per booking. Repeated concurrent submissions cannot create multiple open holds. A rejected case stays in audit history; a later distinct claim must still satisfy the original window and remaining-payment rules. An approved full remedy refunds `paid−priorRefunds`, clears the pending earning, records the decision/reason and releases the hold in one Wallet transaction. Rejection removes the hold and leaves the original clearing deadline. The timer cannot skip or duplicate a financial movement.

Payout creation reserves funds in the same Wallet transaction that saves the immutable masked destination/provider work. Use the same provider operation ID when recovering. Success converts the reservation into one completed payout movement; definitive failure releases it. UNKNOWN preserves it. Neither timeout nor removal of the saved payout account permits a second transfer or early release. The stored destination snapshot remains the accepted one.

## Required implementation acceptance cases

| Fixture / injected condition | Required observation |
| --- | --- |
| Two students choose overlapping slots | One atomic hold succeeds; the other has no partial booking/holds. |
| Charge commits; its response is lost | Same attempt ID resolves APPLIED; one debit and one confirmed booking. |
| Charge request arrives after close on an absent operation | CLOSED tombstone prevents debit; eligible hold release is safe. |
| Expiry races an applied charge | Booking confirms or records the cancellation refund; no unexplained loss. |
| Same operation ID with changed amount/actor | 409; original receipt/tombstone unchanged. |
| Cancellation crosses the 24-hour boundary | Stale quote cannot silently change refund; fresh confirmation required. |
| Refund commits; Booking crashes | Same refund ID resolves once; slot finalization resumes. |
| Student receives 70%, then wins dispute | Remaining 30% only; cumulative refund equals payment; no earning clears. |
| Dispute races clearing | Financial lock permits hold or settled result, never both a cleared earning and approved duplicate money. |
| Wallet receives completion a day late | Clearing deadline derives from original tutor confirmation, not delivery time. |
| Payout times out, browser retries | Same reservation/provider operation remains pending; no second transfer. |
| Approval commits; Auth is unavailable | Approved activation-pending is visible; same grant eventually activates TUTOR once. |
| Business commit succeeds while RabbitMQ is down | Outbox survives; later publication delivers the original event ID. |
| Broker confirms but required queue is absent | Topology readiness fails or mandatory routing returns; outbox remains retryable. |
| Consumer crashes after durable accept / before ack | Redelivery reuses accepted event and jobs; one simulated receipt per channel. |
| Two Notification workers share expired lease | Effect uniqueness prevents duplicate receipt despite remote work overlap. |
| Reminder queued, then booking cancelled | Eligibility check suppresses the stale reminder. |
| Account banned with an unexpired browser JWT | New protected admission fails; recorded financial recovery still finishes. |

Synthetic schema examples in [cases.json](examples/cases.json) cover data shape and boundary calculations. The above stateful scenarios must be implemented and exercised in step 4, with results retained for course evidence.
