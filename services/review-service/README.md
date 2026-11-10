# Review service

Review owns completed-booking reviews, one tutor reply, reports, moderation audit and public rating summaries in `review_db`.
Booking supplies immutable completion/participant evidence over gRPC. Auth supplies minimal account display data over gRPC.
Tutor receives batch visible-rating summaries over gRPC on port 50055. HTTP listens on 4005.

The gateway strips `/api` before forwarding. Owner HTTP routes are `/reviews`, `/bookings/:bookingId/review`, `/reviews/:reviewId/reply`, `/reviews/:reviewId/flags`, `/admin/review-flags` and `/admin/reviews/:reviewId/moderation`.
The private poll is `/internal/v1/review/operations/:operationId`. Public resource URLs retain `/api`.

Protected requests require Gateway workload authentication plus a valid signed actor assertion for the exact operation.
Bodies, IDs, capability, ownership, conditional revisions and idempotency remain enforced by Review.
No caller-supplied student, tutor or subject identity is accepted when creating a review.

## Runtime

Set the variables in `.env.example` using runtime secrets. `MONGO_URI` must authenticate the Review owner to a replica set.
Auth, Booking and Review credentials are distinct workload credentials. Review uses its own credential for outgoing RPCs and accepts Tutor's credential only on the rating RPC.
`RABBITMQ_URL` uses the Review publisher's broker identity. Keep all ports private behind the gateway.

```bash
npm run build -w @tutor-matcher/shared
npm run build -w @tutor-matcher/review-service
npm run migrate -w @tutor-matcher/review-service
npm start -w @tutor-matcher/review-service
```

Startup creates/checks owned indexes and requires durable notification topology before admitting traffic.
Later broker outages leave transactional outbox work pending without reversing successful moderation or reporting.
MongoDB health gates `/health`. An unavailable database cannot become an empty rating response.
A genuine empty summary has a null average, zero count and all five zero buckets.

## Transactions and recovery

MongoDB transactions save each business change with its operation result, required audit and required outbox rows.
Unique indexes enforce one review per booking and one report per review/reporter. A revision write serializes reports with moderation.
The public review projection is explicit. Hiding or removing updates the whole review's visibility; public lists and summaries use that same field.
The private admin report projection includes the report, review and reporter display name.

`review.flagged` targets current admins. `review.moderated` targets the author and all reporters, deduplicated into chunks of at most 100.
The event IDs and immutable payloads survive retries. A publisher uses persistent mandatory AMQP publications and publisher confirms.
A returned message or nack leaves work retryable. Claims have a 30-second lease and increasing fence. Stale claims cannot overwrite a later result.
Retries use exponential delay plus jitter. After ten failed attempts, work remains inspectable and requires an explicit owner retry.

```bash
npm run outbox -w @tutor-matcher/review-service -- inspect
npm run outbox -w @tutor-matcher/review-service -- retry EVENT_UUID
```

The retry command preserves the original event ID and payload. Its output omits notification bodies and credentials.
Notification owns durable acceptance and delivery receipts. Review does not claim exactly-once real email delivery.

## Fixtures and checks

`src/fixtures.ts` exports typed Booking/Auth test fixtures and real local gRPC fixture servers.
They are imported by tests only. The running service always constructs real Auth/Booking clients.
All calls have a two-second deadline, workload metadata, request UUID, codec presence handling and shared contract validation.
The rating RPC accepts only Tutor and configures the contract's 32 MiB message limits.

```bash
REVIEW_TEST_MONGO_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0' npm test -w @tutor-matcher/review-service
npm run typecheck -w @tutor-matcher/review-service
```

The integration tests create and remove a separate synthetic database. Without `REVIEW_TEST_MONGO_URI`, database/socket cases are explicitly skipped.
The seed is an owner-controlled historical demonstration fixture, not evidence of elapsed lesson completion:

```bash
REVIEW_SEED_SYNTHETIC=1 npm run seed -w @tutor-matcher/review-service
```

Actual verification and remaining integration limits are recorded in `docs/evidence/ideal/review.md`.
