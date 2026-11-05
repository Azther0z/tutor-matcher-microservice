# Ideal handoff: Tutor, Review and discovery

Own Tutor and Review, including their UI and tests.
Deliver the application-to-publication journey, discovery and the complete review/moderation journey.
Own the two required load-test types and their interpretation.

## Baseline and owned paths

Start with the [shared handoff](README.md), [requirements](../requirements.md), [system design](../system-design.md) and [contracts](../../contracts/README.md).
Use the [pinned monolith](https://github.com/Azther0z/tutor-matcher/tree/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1) and UC-01, UC-02, UC-03 and UC-08 evidence links.
The [source index](../sources/README.md) links both original PDFs.
Use the shared reviewed baseline commit containing the requirements, design, contracts and handoffs.

Existing Tutor code starts in `tutor-service/src/`. Review is a new service in this checkout.
The existing public profile/availability callback is not the target catalogue interface.

| Area | Your implementation ownership |
| --- | --- |
| Backend | `tutor-service/**`, new `review-service/**` |
| Frontend features | `web/features/tutor/**`, `web/features/review/**` |
| Frontend routes | `web/app/discover/**`, `web/app/tutors/**`, `web/app/teach/application/**`, `web/app/teach/profile/**`, `web/app/teach/subjects/**`, `web/app/reviews/**` |
| Admin routes | `web/app/admin/tutor-requests/**`, `web/app/admin/review-flags/**` |
| Browser tests | `web/e2e/marketplace/**` |
| Measurement | `loadtest/**`, separate new results and interpretation |
| Evidence | Planned `docs/evidence/ideal/**` |

Treat frontend routes above as paths under `web/app/`. Use Saint's shared shell and API/session adapter.
Santa owns availability editing at `web/app/teach/availability/**`.
Link that editor from your tutor pages. Do not build a second slot store or editor.

## First deliverable

1. Expose the catalogue-only `getBookableSubject` operation.
2. Expose `getTutorEligibility` with real approval, activation and publication state.
3. Expose `getRatingSummaries`, including genuine empty summaries.
4. Publish Tutor/Review migrations, seed entry points and typed peer test fixtures.
5. Load the versioned availability protobuf and connect the client to Santa's server when available.
6. Build application, subject and discovery feature components while Saint completes the common shell.

Tutor's catalogue read must not call Booking availability.
Your separate discovery client calls Booking's gRPC availability interface.
This separation prevents the old profile callback from recreating a dependency loop.

## Tutor behavior and UI

Implement UC-01, UC02-01–UC02-03 and the discovery portion of UC-03.
Use separate MongoDB `tutor_db` storage and the configured replica set for required transactions.

Applications use bio, identification-document URL, introduction-video URL and consent.
Support incomplete drafts, edit/delete, submit, withdraw, history and copying a rejected or withdrawn version.
Allow at most one pending application or listing revision per account.
Keep submitted versions immutable and private documents visible only to the owner and authorized admins.

Admin approval creates an unpublished listing and durable Auth activation work.
Preserve the original grant identity until Saint confirms its outcome.
Show activation-pending state instead of claiming that Tutor access already works.
Profile revisions retain the current approved listing during review.
Approval replaces approved content without changing publication status. Rejection preserves existing approved content.

Implement publication and owned subjects with positive rates, Online format and one to three learning areas.
Existing bookings keep their captured subject and price snapshots.
Unpublishing blocks new discovery/bookings while preserving existing bookings and conversations.

Implement public search, tutor pages and subject pages against the pinned monolith journeys.
Preserve filters, recommendation rules, sorting, pagination and Bangkok availability display.
Batch rating and availability requests before ranking and pagination.
A missing collaborator returns an explicit dependency failure. It cannot become fabricated zero ratings or empty availability.
Public responses expose approved content and visible reviews without identity-document URLs.
Link booking selection to Santa's booking flow using the selected subject and slots.

## Review behavior and UI

Implement UC-08 in separate MongoDB `review_db` storage.
Ask Booking for immutable participants and completion eligibility before admitting a review.
Enforce one review per booking in your database.
Allow the assigned tutor one reply and each reporter one flag with a reason.

Build the review form, public review/reply/flag controls and admin moderation queue.
The admin queue must show the flagged review and reporter details from its private DTO.
An admin records KEEP, HIDE or REMOVE with a reason.
Hiding/removing affects the whole review, reply and rating contribution in the same local transaction.
Keep the audit and required author/reporter notifications.
Use the public review projection for all public lists and profiles.

Tutor and Review each own their own transactional outbox and publisher retries.
Implement their six event variants from the [event catalogue](../../contracts/events.md).
P consumes those events. Notification does not create missing producer-side event work for you.

## Search measurement

Adapt the existing k6 script to the target API, identity flow and approved synthetic catalogue.
Its legacy endpoints and direct publication setup do not represent the target journey.
Use repeatable owner-controlled fixture preparation. Keep preparation outside the measured request interval.

Run a steady-load comparison with one and three Tutor replicas.
Use the Q-03 target: 50 concurrent users for 30 seconds, p95 below 500 ms and errors below 1%.
Compare throughput with matching data, resource limits, infrastructure and full collaborator calls.
Run a distinct stress test with increasing demand. Changing replica count alone is not the second load-test type.
Interpret failures and bottlenecks, including Review/Booking/database latency and Gateway behavior.
Report an unmet target honestly. Do not omit required collaborators to improve the measured result.
Coordinate local or authorized hosted execution with Saint. Keep historical results unchanged and separate from new results.

## Interfaces and parallel work

| Peer | You provide | You consume |
| --- | --- | --- |
| Saint | Approved submission identity, service runtime needs and catalogue evidence | Current actor/capability adapters, account names and recoverable Tutor grant |
| Santa | Catalogue-only reads, owned subjects and tutor eligibility | Both availability RPCs and review eligibility |
| P | Tutor/Review versioned events and recipient selection | Durable Notification acceptance and delivery receipts |

Start with typed Auth/Booking test doubles and local MongoDB transactions.
The integrated application must use the real internal services.
Give Santa catalogue operations before completing every application/admin screen.
Coordinate any protobuf or payload change with both its producer and consumer through Saint.

## Acceptance and evidence

- Complete application, withdrawal, rejection, approval and activation through the UI.
- Prove unapproved users cannot publish or manage tutor-only resources.
- Prove private document URLs never appear in public profiles.
- Prove a pending/rejected revision leaves current public content intact.
- Prove catalogue reads do not call Booking and discovery uses the new gRPC methods.
- Prove filtering/ranking occurs before pagination and dependency failures remain visible.
- Prove review ownership, completed-booking eligibility, one review, one reply and duplicate-flag rejection.
- Prove hidden/removed reviews disappear from lists, replies and rating summaries together.
- Prove approval recovery and Tutor/Review outbox recovery after outages.
- Save both load-test types, replica comparison, environment, tested revision and result interpretation.

Draft C-08/C-09 goals, constraints, decisions and C4 explanations from the actual implementation.
Give Saint your slide section, live walkthrough, sanitized test evidence and unresolved risks.
Your handoff is complete when these journeys work with real peers and the measurements can be reproduced.

## Owned REST inventory

This index is derived from the step-3 route inventory. OpenAPI owns payloads, authorization and error meanings.
Implement all listed operations for your owners. Coordinate contract changes before changing this index.

| Owner | Surface | Operation ID | Method and path |
| --- | --- | --- | --- |
| review | INTERNAL | `getReviewOperation` | `GET /internal/v1/review/operations/{operationId}` |
| review | INTERNAL | `getRatingSummaries` | `POST /internal/v1/review/rating-summaries` |
| review | PUBLIC | `listReviewFlags` | `GET /api/admin/review-flags` |
| review | PUBLIC | `moderateReview` | `POST /api/admin/reviews/{reviewId}/moderation` |
| review | PUBLIC | `createReview` | `POST /api/bookings/{bookingId}/review` |
| review | PUBLIC | `listPublicReviews` | `GET /api/reviews` |
| review | PUBLIC | `flagReview` | `POST /api/reviews/{reviewId}/flags` |
| review | PUBLIC | `replyToReview` | `POST /api/reviews/{reviewId}/reply` |
| tutor | INTERNAL | `getTutorOperation` | `GET /internal/v1/tutor/operations/{operationId}` |
| tutor | INTERNAL | `getBookableSubject` | `GET /internal/v1/tutor/subjects/{subjectId}/bookable` |
| tutor | INTERNAL | `getTutorEligibility` | `GET /internal/v1/tutor/users/{userId}/eligibility` |
| tutor | PUBLIC | `listTutorRequests` | `GET /api/admin/tutor-requests` |
| tutor | PUBLIC | `getTutorRequest` | `GET /api/admin/tutor-requests/{submissionId}` |
| tutor | PUBLIC | `reviewTutorSubmission` | `POST /api/admin/tutor-requests/{submissionId}/review` |
| tutor | PUBLIC | `getLearningAreas` | `GET /api/discovery/learning-areas` |
| tutor | PUBLIC | `getSearchPriceRange` | `GET /api/discovery/price-range` |
| tutor | PUBLIC | `searchTutorSubjects` | `GET /api/discovery/tutors` |
| tutor | PUBLIC | `getPublicTutor` | `GET /api/discovery/tutors/{tutorId}/profile` |
| tutor | PUBLIC | `getPublicSubject` | `GET /api/discovery/tutors/{tutorId}/subjects/{subjectId}` |
| tutor | PUBLIC | `getTutorWorkspace` | `GET /api/profiles/me/tutor` |
| tutor | PUBLIC | `createTutorDraft` | `POST /api/profiles/me/tutor/drafts` |
| tutor | PUBLIC | `deleteTutorDraft` | `DELETE /api/profiles/me/tutor/drafts/{draftId}` |
| tutor | PUBLIC | `updateTutorDraft` | `PUT /api/profiles/me/tutor/drafts/{draftId}` |
| tutor | PUBLIC | `submitTutorDraft` | `POST /api/profiles/me/tutor/drafts/{draftId}/submit` |
| tutor | PUBLIC | `setTutorPublication` | `PATCH /api/profiles/me/tutor/publication` |
| tutor | PUBLIC | `listOwnSubjects` | `GET /api/profiles/me/tutor/subjects` |
| tutor | PUBLIC | `createSubject` | `POST /api/profiles/me/tutor/subjects` |
| tutor | PUBLIC | `updateSubject` | `PUT /api/profiles/me/tutor/subjects/{subjectId}` |
| tutor | PUBLIC | `copyTutorSubmission` | `POST /api/profiles/me/tutor/submissions/{submissionId}/copy` |
| tutor | PUBLIC | `withdrawTutorSubmission` | `POST /api/profiles/me/tutor/withdraw` |
