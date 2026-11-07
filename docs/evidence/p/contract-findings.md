# Contract findings from implementing Wallet and Notification

The PR asked implementers to verify anything that does not hold up. These are the points found while building P's services, with what was done. Nothing under `contracts/**` was edited: that directory is Saint-coordinated and a producer/consumer review is required. Each item says who needs to look.

## Needs a decision

| # | Finding | What I did | Who |
| --- | --- | --- | --- |
| 1 | `WalletOverview.paymentDueBookings` asks Wallet for PAYMENT_DUE bookings, but Booking owns that state and Wallet has no way to list it. | Returns only bookings whose payment attempt was **declined** and whose hold is still open (Wallet's own `UNPAID` records). The real list must come from Booking, or this field should move to a Booking projection. | Santa, Saint |
| 2 | UC04 requires a successful top-up to return a booking user to the same booking, and `TopupCreate` accepts `returnToBookingId`, but the `Topup` response has no field carrying it back. | Wallet echoes an additive `returnToBookingId` (nullable) on `Topup`. The schema permits additional properties; please add it to the schema so the UI can rely on it. | Saint, UI owners |
| 3 | `PaymentResult.balance` is undefined: posted balance, or spendable balance? | Wallet returns the **available** balance (posted minus payout reservations) after the decision. Ledger `balanceAfter` stays the **posted** balance. Booking should not show one as the other. | Santa |
| 4 | Several necessary error codes are absent from the method registry's `failureCodes`. | Added: `PAYMENT_ALREADY_APPLIED`, `POLICY_AMOUNT_MISMATCH`, `PAYMENT_NOT_APPLIED`, `BOOKING_NOT_CANCELLABLE`, `BOOKING_STARTED`, `BOOKING_PARTY_MISMATCH`, `ADMISSION_MISMATCH`, `BOOKING_CANCELLED`, `COMPLETION_TOO_EARLY`, `CALLER_NOT_ALLOWED`. All are `FAILED_PRECONDITION` (409) except `PAYMENT_ALREADY_APPLIED` (`ALREADY_EXISTS`, 409) and `ADMISSION_MISMATCH` and `CALLER_NOT_ALLOWED` (`PERMISSION_DENIED`, 403). Please register them so Booking can map them. | Santa, Saint |
| 5 | The Gateway-to-owner path for public operations is not stated. | Owners serve the public path unchanged under `/api/...` on their private HTTP port, and operation status at `/internal/v1/<owner>/operations/{id}`. If the Gateway rewrites paths, only the Express mount points change. | Saint |
| 6 | The dispute DTO's `audit[].actorUserId` shows the deciding admin's account ID to the student and (by derivation) the tutor. | Kept to match the schema. Consider returning `null` for admin actions in the student view. | Saint |

## Gotchas every gRPC owner will hit

| # | Finding |
| --- | --- |
| 7 | The gRPC guide mandates `@grpc/proto-loader` with `oneofs: true`. With proto3 `optional` fields this makes every decoded message carry synthetic `_fieldName: 'fieldName'` properties, so a strict schema validator rejects every request as having unknown fields. The guide's seven normalization steps do not mention it. Wallet and Notification strip any key starting with `_` before validation (`decoded()` in `src/grpc/proto.ts`). Other owners should do the same or they will see every call fail with `INVALID_ARGUMENT`. |
| 8 | `uint64` fields such as `GetReminderEligibilityRequest.offset_minutes` decode and must be sent as strings under `longs: String`. Notification sends `String(offset)`. |

## Decisions made inside the handoff's freedom

| # | Decision | Reason |
| --- | --- | --- |
| 9 | Wallet does **not** call Tutor `GetTutorEligibility` for payouts. The `TUTOR` capability comes from the Gateway-signed assertion, which the Gateway checks against current Auth state at admission. | Auth is authoritative for the capability. An extra call adds a failure mode without a new rule. Reversible: one call inside `createPayout`. |
| 10 | Payout account numbers are never stored. Only a keyed HMAC fingerprint (duplicate detection) and the masked value are kept. | Nothing in the delivery needs the full number; Q-05 payout privacy. Requires `PAYOUT_FINGERPRINT_KEY`. |
| 11 | A cancelled booking keeps `CANCELLED` after a dispute remedy; `REFUNDED` is used for a non-cancelled booking whose remainder was refunded. | `FinancialRecord.status` has both values but the guide does not say which applies. |
| 12 | A completion arriving for a record already fully refunded (approved dispute) records the original confirmation time but no fee or earning. | "An approved remedy removes the refunded pending earning" must hold even when completion arrives later. |
| 13 | A first charge admitted at or after `holdExpiresAt` returns `CLOSED` (reason `HOLD_EXPIRED`) and closes the payment gate, instead of an error. | Gives Booking a durable terminal answer for a release decision. |
| 14 | Idempotency replays also reproduce known refusals (402 `INSUFFICIENT_BALANCE`, 409 conflicts) for the same key. A 412/428 is not recorded. | A user who tops up and wants to retry must use a new action and key, as the recovery guide says. |
| 15 | The earnings-clearing sweep runs every 30 s and on startup. | Due work always comes from the database, never from a timer that a restart would lose. |

## Observations in the baseline text

- `docs/handoffs/p.md` says "Serve the seven Wallet RPCs on private port 50054" and the registry agrees. The existing `compose.yaml` and Consul code know nothing about gRPC ports; Wallet advertises `grpc_port` metadata ([runtime-needs.md](runtime-needs.md)).
- The existing `shared/consul.js` registers Notification with port 0 and a TTL check. Notification now has an HTTP port (4007) and an HTTP check.
- Existing Postman files and the legacy `proto/booking.proto` were not touched.
