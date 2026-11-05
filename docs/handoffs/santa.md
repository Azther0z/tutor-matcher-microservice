# Santa handoff: Booking, Messaging and lesson lifecycle

Own Booking and Messaging, including their UI, tests and migrations.
Deliver tutor availability, booking/payment coordination, lesson access/completion, cancellation and private conversations.
Wallet owns money. Booking owns the lifecycle and durable coordination between the two services.

## Baseline and owned paths

Start with the [shared handoff](README.md), [requirements](../requirements.md), [system design](../system-design.md) and [contracts](../../contracts/README.md).
Read the [recovery contract](../../contracts/recovery.md) before replacing the current payment/cancellation code.
Use the [pinned monolith](https://github.com/Azther0z/tutor-matcher/tree/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1) and evidence for UC02-04, UC-03, UC-05, UC-06 and SUP-01.
The [source index](../sources/README.md) links both original PDFs.
Use the shared reviewed baseline commit containing the requirements, design, contracts and handoffs.

Existing code starts in `booking-service/src/`. Messaging is a new service in this checkout.
The current Booking models use MongoDB. The accepted target uses a separate PostgreSQL `booking_db`.

| Area | Your implementation ownership |
| --- | --- |
| Backend | `booking-service/**`, new `messaging-service/**` |
| Frontend features | `web/features/booking/**`, `web/features/messaging/**` |
| Frontend routes | `web/app/teach/availability/**`, `web/app/bookings/**`, `web/app/teach/lessons/**`, `web/app/messages/**`, `web/app/demo/meetings/**` |
| Browser tests | `web/e2e/lessons/**` |
| Evidence | Planned `docs/evidence/santa/**`, including lifecycle sequence and paired recovery results |

Treat frontend routes above as paths under `web/app/`. Use Saint's shared shell and API/session adapter.
Ideal owns subject/profile pages and the review form. P owns wallet/top-up pages and all financial decisions.
Link these flows while preserving the booking destination and original hold deadline.

## First deliverable

1. Create Booking PostgreSQL migrations, constraints and service-local transaction tests.
2. Expose both RPCs in the [versioned availability protobuf](../../contracts/grpc/booking/v1/availability.proto).
3. Expose `getBookingEvidence`, `getReviewEligibility` and `getReminderEligibility`.
4. Implement atomic hold creation against Ideal's catalogue contract.
5. Publish typed Wallet client fixtures for applied, declined, closed and unresolved outcomes.
6. Create the Messaging participant model and first authorized send/thread flow.

Keep gRPC on private port 50052 and HTTP on 4004.
Coordinate the new proto client/server migration with Ideal. Do not remove the old proto before callers migrate.
Provide the read/evidence interfaces before completing every lifecycle screen.
Messaging uses separate MongoDB `messaging_db`, not Booking tables or Notification storage.

## Booking behavior and UI

Implement UC02-04, booking portions of UC-03, UC-05 and UC-06.
Open tutor-owned future half-hour slots and assign owned subjects.
Reject past, held, booked, overlapping and stale edits. Use the agreed conditional revisions.
Validate catalogue ownership/eligibility through Tutor's catalogue-only REST operations.

A booking contains 1–8 unique consecutive half-hour slots on one Bangkok day.
Reject self-booking and past slots. Capture the subject/rate snapshot and server-calculated total.
Save all holds and the PAYMENT_DUE booking in one local transaction.
Hold expiry is 15 minutes after creation, capped at lesson start.
Login/top-up navigation must not extend that deadline.

Persist the payment operation before calling Wallet.
Keep Wallet calls outside Booking database transactions.
An unknown response leaves durable pending work and protects the slots from conflicting release.
A Wallet GET 404 cannot prove that the charge never happened.
Use the original operation with `resolveOrCloseLessonCharge` before releasing an uncertain hold.
A known applied charge confirms the booking once or follows the accepted cancellation/refund recovery path.

Implement server-issued cancellation quotes and explicit reconfirmation when terms change.
Student cancellation refunds 100% beyond 24 hours and 70% at exactly 24 hours or less, before start.
Tutor cancellation refunds 100%, records a reason, and closes freed slots.
Student cancellation reopens eligible free future slots.
Finalize paid cancellation and slot release only after the refund outcome is known.

Implement participant-only meeting access, generated synthetic links and tutor HTTPS overrides.
Removing an override restores the generated link when available.
Provisioning failure does not reverse payment. Hide Join after cancellation, completion or scheduled end.
Use Admin-only synthetic meeting outcome controls and clearly labeled provider states.

Only the assigned tutor confirms completion, at or after scheduled end.
Save the first confirmation time and durable Wallet handoff together.
Send that original time again after a retry. Review eligibility begins from Booking's completed state.
P owns the 15% fee, pending earning, 24-hour clearing and dispute hold.

Booking owns reminder schedules at 60 and 10 minutes before start.
Save reminder event work with stable schedule/offset identity.
The eligibility endpoint must suppress stale, cancelled, completed or started lessons.
P's Notification worker calls that endpoint before delivery.

## Messaging behavior and UI

Implement SUP-01 with participant-only inbox, thread, unread indicators and Student/Tutor context switching.
Students can start conversations with tutors before or after booking.
Tutors reply to eligible existing conversations. Admin support remains the explicit authorized workflow.
A current Admin can contact a selected user without gaining access to unrelated conversations.

Reject self-message, blank content and content over 2,000 characters.
Keep one conversation per unordered user pair, with separate message records and caller-owned read state.
Do not store an unbounded array of messages in one document.
Return participant display names through the permitted Auth lookup.
Advance a read cursor only within the caller's thread. Keep cursor paging stable.

Save each accepted message and its notification event in the same local transaction.
Messaging owns its publisher retries. A Notification outage cannot erase an accepted message.
Follow the [event catalogue](../../contracts/events.md) for all Booking and Messaging events.
Do not put private message content or meeting URLs into those events.

## Interfaces and parallel work

| Peer | You provide | You consume |
| --- | --- | --- |
| Saint | Booking/Messaging runtime needs and current actor requirements | Shared identity adapters, account lookup and application shell |
| Ideal | Availability RPCs, review eligibility and selection destination | Catalogue-only subject snapshot, subjects and tutor eligibility |
| P | Booking evidence, completion command, reminder eligibility and producer events | Charge/query/close, refund/query and completion recording |

Start lifecycle tests with typed Tutor/Wallet doubles and real local PostgreSQL constraints.
Start Messaging tests against its MongoDB replica set with typed Auth/Tutor doubles.
Replace internal doubles with live peers at the first integration checkpoint.
Pair early with P on payment/refund identities and with Ideal on catalogue/gRPC behavior.

Provide owner-controlled migrations and synthetic fixtures to Saint.
If existing identifiers need conversion, agree their mapping with affected owners before changing references.
Use a separate synthetic test environment. Do not drop the existing MongoDB records as an implicit migration step.

## Acceptance and evidence

- Prove two competing students cannot partially or jointly hold overlapping slots.
- Prove slot edits preserve held/booked slots and reject stale revisions.
- Prove insufficient funds, top-up return, successful payment and hold expiry through the UI.
- Prove lost charge response and late charge after close with P's actual Wallet implementation.
- Prove student/tutor cancellation on both sides of the exact 24-hour boundary.
- Prove interrupted refund recovery finalizes slots once without duplicate credit.
- Prove missing meeting links, overrides, participant access and early/unauthorized completion rejection.
- Prove completion retries preserve the original time for P's clearing calculation.
- Prove stale reminder suppression and producer recovery after broker downtime.
- Prove chat ownership, allowed initiation/reply, unread updates and redelivery without lost messages.

Use injected test time for boundaries and labeled historical fixtures for the live walkthrough.
Save commands, revision, environment, state observations and unresolved failures in your evidence directory.
Draft C-10's representative payment/recovery sequence from observed calls and events.
Give Saint your slide/demo section and any architecture differences that need coordinated documentation updates.
Your handoff is complete when the lifecycle and chat work through the UI with real internal peers and recover after interruptions.

## Owned REST inventory

This index is derived from the step-3 route inventory. OpenAPI owns payloads, authorization and error meanings.
Implement all listed operations for your owners. Coordinate contract changes before changing this index.

| Owner | Surface | Operation ID | Method and path |
| --- | --- | --- | --- |
| booking | INTERNAL | `getBookingEvidence` | `GET /internal/v1/booking/bookings/{bookingId}/evidence` |
| booking | INTERNAL | `getReminderEligibility` | `GET /internal/v1/booking/bookings/{bookingId}/reminder-eligibility` |
| booking | INTERNAL | `getReviewEligibility` | `GET /internal/v1/booking/bookings/{bookingId}/review-eligibility` |
| booking | INTERNAL | `getBookingOperation` | `GET /internal/v1/booking/operations/{operationId}` |
| booking | PUBLIC | `listBookings` | `GET /api/bookings` |
| booking | PUBLIC | `createBooking` | `POST /api/bookings` |
| booking | PUBLIC | `getNeedsConfirmation` | `GET /api/bookings/tutor/needs-confirmation` |
| booking | PUBLIC | `getTutorUpcoming` | `GET /api/bookings/tutor/upcoming` |
| booking | PUBLIC | `getBooking` | `GET /api/bookings/{bookingId}` |
| booking | PUBLIC | `cancelBooking` | `POST /api/bookings/{bookingId}/cancel` |
| booking | PUBLIC | `getStudentCancellationQuote` | `GET /api/bookings/{bookingId}/cancellation-quote` |
| booking | PUBLIC | `completeBooking` | `POST /api/bookings/{bookingId}/confirm-completion` |
| booking | PUBLIC | `payBooking` | `POST /api/bookings/{bookingId}/confirm-payment` |
| booking | PUBLIC | `putMeetingOverride` | `PATCH /api/bookings/{bookingId}/meeting-link` |
| booking | PUBLIC | `tutorCancelBooking` | `POST /api/bookings/{bookingId}/tutor-cancel` |
| booking | PUBLIC | `getTutorCancellationQuote` | `GET /api/bookings/{bookingId}/tutor-cancellation-quote` |
| booking | PUBLIC | `setDemoMeetingsOutcome` | `POST /api/demo/meetings/{bookingId}/outcome` |
| booking | PUBLIC | `getOwnAvailabilityCalendar` | `GET /api/profiles/me/tutor/availability/calendar` |
| booking | PUBLIC | `getOwnAvailabilityDay` | `GET /api/profiles/me/tutor/availability/{date}` |
| booking | PUBLIC | `putAvailabilitySlot` | `PUT /api/profiles/me/tutor/availability/{date}/{time}` |
| messaging | INTERNAL | `getMessagingOperation` | `GET /internal/v1/messaging/operations/{operationId}` |
| messaging | PUBLIC | `sendMessage` | `POST /api/messages` |
| messaging | PUBLIC | `getInbox` | `GET /api/messages/inbox` |
| messaging | PUBLIC | `getThread` | `GET /api/messages/thread/{userId}` |
| messaging | PUBLIC | `markThreadRead` | `PUT /api/messages/thread/{userId}/read` |
