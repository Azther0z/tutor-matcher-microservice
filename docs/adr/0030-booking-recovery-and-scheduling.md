# ADR-0030: Booking recovery, scheduling and contract gaps

Status: Accepted. Supplements ADR-0011, ADR-0020, ADR-0026 and ADR-0027; it does not change them.

## Context

The Booking service now implements the published contracts. The contracts leave a few behaviours open. These are the choices
made so every owner can rely on them.

## Decisions

- **Quote errors** use the OpenAPI codes `QUOTE_CHANGED` and `QUOTE_EXPIRED` (not `QUOTE_STALE`). A quote expires after five
  minutes, at lesson start or at the next 24-hour policy boundary, whichever is first.
- **Reminder schedule.** `scheduleVersion` is `"1"` because there is no reschedule operation. Reminders for offsets already
  in the past at confirmation time are never created.
- **Tutor lists.** Upcoming means CONFIRMED with a start in the future; awaiting-payment holds are not upcoming lessons.
  Needs-confirmation means CONFIRMED with a scheduled end in the past.
- **Expired or unpaid holds** become CANCELLED with `cancelledBy: EXPIRY` and a 0.00 refund. A hold that has an unresolved
  payment attempt is never released until Wallet has resolved or closed that attempt.
- **Unpaid cancellation** closes the payment gate at Wallet first; if a charge turns out to have applied, the stale quote is
  rejected with `QUOTE_CHANGED` and the student requests a new one.
- **Paid cancellation** finalizes only after the refund outcome is known; the refund command and its identity are saved first
  and repeated until Wallet answers.
- **Slot subjects** are validated through Tutor's catalogue RPC, which only knows published subjects, so a tutor can only open
  slots for published subjects.
- **Demo outcome control** requires `DEMO_MODE`, the ADMIN capability and both participants on `.test` addresses.

## Consequences

Booking never holds a database transaction across a Wallet, Tutor or Auth call, and never retries a mutation under a new
identity. Operators see unresolved work as `needs_attention` rows after ten failed attempts.
