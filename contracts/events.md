# Event catalogue v1

This table is generated from `schemas/events.v1.json`. The schema owns payload shape. The recipient rules below own recipient selection; callers cannot supply arbitrary recipients.

| Type | Producer | Group | Audience |
| --- | --- | --- | --- |
| `auth.password-reset-requested` | auth | SYSTEM | USERS |
| `auth.account-restricted` | auth | SYSTEM | USERS |
| `tutor.submission-submitted` | tutor | SYSTEM | ADMINS |
| `tutor.submission-withdrawn` | tutor | SYSTEM | ADMINS |
| `tutor.submission-decided` | tutor | SYSTEM | USERS |
| `tutor.activated` | tutor | SYSTEM | USERS |
| `booking.confirmed` | booking | BOOKING_UPDATES | USERS |
| `booking.cancelled` | booking | BOOKING_UPDATES | USERS |
| `booking.completed` | booking | BOOKING_UPDATES | USERS |
| `booking.meeting-updated` | booking | BOOKING_UPDATES | USERS |
| `booking.reminder-due` | booking | LESSON_REMINDERS | USERS |
| `wallet.topup-resolved` | wallet | WALLET_PAYMENTS | USERS |
| `wallet.refund-applied` | wallet | WALLET_PAYMENTS | USERS |
| `wallet.earning-cleared` | wallet | WALLET_PAYMENTS | USERS |
| `wallet.payout-resolved` | wallet | WALLET_PAYMENTS | USERS |
| `wallet.dispute-opened` | wallet | SYSTEM | ADMINS |
| `wallet.dispute-held` | wallet | SYSTEM | USERS |
| `wallet.dispute-decided` | wallet | SYSTEM | USERS |
| `review.flagged` | review | SYSTEM | ADMINS |
| `review.moderated` | review | SYSTEM | USERS |
| `messaging.message-sent` | messaging | NEW_MESSAGES | USERS |

## Recipient selection

- Password reset and restriction: affected Auth user. Never emit reset work for an unknown address.
- Submission submitted/withdrawn: current active admins. Decision/activation: applicant. Approval email says activation is pending until `tutor.activated`; it must not claim access was already granted.
- Booking confirmation/cancellation/completion: both participants, deduplicated. Meeting update: student. Reminder: both participants.
- Top-up and payout: wallet owner. Refund: student. Cleared earning: tutor.
- Dispute opened: active admins. Held/decided: student and tutor.
- Flag: active admins. Moderation: author and all reporters, deduplicated.
- Message: recipient only. An admin-support message follows the same rule. No message content in the event.

Notification resolves an ADMINS audience through Auth once, saves the recipient snapshot with jobs, then retries those jobs. An unavailable Auth service leaves durable resolution work pending. USERS are chosen by the producer from its owned records, never from client notification fields. If a decision has more than 100 recipients, persist deterministic recipient chunks as separate events in the same business transaction, with each recipient in exactly one chunk and stable per-chunk event IDs across retries.

## RabbitMQ topology and acceptance

Use durable topic exchange `tutor-matcher.events`, routing key `v1.<type>`, durable queue `notification.events.v1`, binding `v1.#`. Install exchange, queue, binding and dead-letter topology before readiness. Retain the old queue only during the step-4 migration; versioned traffic must not feed the old parser.

Publish persistent messages with AMQP `message_id=eventId`, `type=type`, `content_type=application/json`, `delivery_mode=2`. The producer saves the immutable event with its business transaction and preserves its eventId across retries. Use publisher confirms plus mandatory routing; an unroutable return or nack is not success. A confirm alone does not prove a required subscriber was bound. Readiness verifies topology; an outbox row is sent only after a routed confirm.

Publishers set AMQP user_id to their own RabbitMQ username; the broker verifies it. Notification validates type/schema and matches this authenticated publisher identity to envelope.producer and its allowed event prefix. The received routing key must equal `v1.` plus envelope.type. It writes the accepted event, audience-resolution work and durable jobs in one local transaction before ack. Duplicate eventIds with the same canonical payload are no-ops; a different payload for the same ID is quarantined and alerted. Queue permissions restrict each producer to its own routing prefix; they do not replace application validation.

Use durable direct dead-letter exchange `tutor-matcher.dead` and queue `notification.events.v1.dead`, routing `notification.invalid`. Invalid/unknown-version payloads are dead-lettered without requeue. Transient storage failures nack with bounded delayed retry; do not hot-loop a requeue. Poison work and exhausted attempts remain inspectable and manually retryable with their original identities.

Ordering is not guaranteed across aggregates or producers. Aggregate.version is a producer-owned decimal sequence. Do not discard an older independent notification only because a later event arrived. Recheck reminder eligibility before sending; otherwise use the immutable event snapshot for historical messages.

## Delivery and scheduled work

SYSTEM always creates EMAIL work, regardless of all five preference toggles. Other groups check current recipient preferences at dispatch, immediately before an undelivered effect attempt. Record the preference revision with that attempt. A failed attempt rechecks preferences before retry; an existing DELIVERED or SKIPPED receipt remains terminal, so retries cannot resend it. A later opt-in does not retroactively reopen skipped notifications. Missing preferences use the defaults in the interface guide. SYSTEM has no Push toggle and no preference group is added. There is no product-news publishing API in this delivery.

The simulated provider stores its receipt with unique `(eventId,recipientUserId,channel)`; this receipt is the provider effect. Consumer retries cannot duplicate it. DELIVERED and SKIPPED are terminal; FAILED is inspectable and retryable. Receipt DTOs omit private bodies and reset links. A sensitive reset-content fetch uses an authenticated Auth endpoint, `Cache-Control: no-store`, redacted logs, and an expiry check. An expired or consumed-token reset job becomes SKIPPED with internal reason EXPIRED, never sends an expired token.

Booking owns reminder schedules at 60 and 10 minutes before start. Do not send missed reminders when confirmation happens after a due time. Save due work and its event atomically, with unique `(bookingId,scheduleVersion,offsetMinutes)`. Notification checks the Booking eligibility endpoint immediately before the simulated effect. Cancelled, completed, stale-version or already-started lessons suppress it. A dependency failure leaves the job pending.

Workers use bounded leases and a monotonically increasing fence on each claim. Compare the fence before local commit; use the same external operation/effect identity after lease expiry. Never use a lease alone as a money or delivery uniqueness guarantee. See [recovery cases](recovery.md).
