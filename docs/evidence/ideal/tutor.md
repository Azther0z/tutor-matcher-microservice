# Tutor implementation evidence

Date: 10 November 2026. Working tree based on `8dff5c3`, Saint's identity and Traefik integration branch. This record covers the Tutor implementation before the final parent integration commit.

## Implemented

- All Tutor REST operations in the handoff, owner status polling and both versioned catalogue RPCs.
- Incomplete drafts, replacement edits, deletion, submission validation, one pending submission per account, withdrawal, source-preserving copies and admin approval/rejection.
- Approved profile version separate from pending/rejected revisions. Private document data stays in owner/admin submissions. Public projection excludes it.
- Durable initial activation work and stable Auth grant command. Initial listing stays unpublished and activation-pending until a known Auth outcome.
- Tutor-only publication and subject management, exact decimal hourly rates, supported learning areas and immutable returned catalogue snapshots.
- Batch rating and availability composition before filtering/ranking/pagination. Public subject pages use a Bangkok calendar day.
- Four versioned Tutor events, local transactional outbox, publisher confirms, mandatory routing, worker fencing, backoff/exhaustion and controlled identity-preserving retry.
- Owner migrations, typed fixtures, synthetic seed entry point, TypeScript build and a production nonroot Dockerfile.

## Checks run

`npm run build -w @tutor-matcher/tutor-service` passed.

`npm run typecheck -w @tutor-matcher/tutor-service` passed.

`TUTOR_TEST_MONGO_URI=<disposable-local-replica-set> TUTOR_SOCKET_TESTS=1 npm run test -w @tutor-matcher/tutor-service` passed 14 tests, zero skipped. The URI is omitted here because connection configuration does not belong in evidence. Tests used a uniquely named synthetic `ideal_tutor_test_*` database and removed it afterwards.

The tests establish:

1. An incomplete draft is editable, but missing application fields prevent submission and create no event work.
2. Concurrent submission attempts admit one pending version. Submitted content cannot be edited.
3. Withdrawal preserves history. Copies get a different draft identity.
4. A same-input replay returns the saved result before a stale revision check. Changed input conflicts; another owner cannot edit the draft.
5. An Auth outage leaves activation pending. Recovery reuses the same grant ID, activates once and finishes the original owner operation.
6. Pending and rejected revisions leave public content unchanged. Approval replaces it without unpublishing.
7. Public profile JSON excludes identification documents. The bookable catalogue read succeeds with Booking unavailable and makes no Booking request.
8. Unapproved users cannot create subjects. Zero prices and unknown learning areas fail. Updating a subject does not mutate an earlier returned booking snapshot.
9. Rating filtering and ordering run before pagination. Review or Booking failures do not become zero-rating or empty-availability success.
10. A broker failure leaves the original event pending. A later successful publisher sees the same event ID. A stale lease cannot mark newer work sent.
11. The retry policy is exponential with jitter, capped at 60 seconds, and stops automatic attempts at ten.
12. Real Mongo transactions serialize the competing submissions and persist activation/outbox work across a new service/store instance. Manual exhausted-work recovery preserves the event payload and identity.
13. Real HTTP owner routes accept stripped gateway paths, reject forged/wrong-operation admission and enforce capability and DTO validation.
14. Real gRPC transport checks caller allowlists, rejects missing scalar presence with a structured error trailer and preserves explicit false eligibility values.

The service tests use typed peer doubles. The socket tests exercise real HTTP/gRPC transport, with synthetic signatures and workload credentials. The Mongo test uses a real disposable local replica set. These are not hosted or full-peer acceptance results.

## Remaining coordination and evidence

The parent integration must record its own actual peer and UI observations. Santa's target Booking availability/completion implementation is not part of this branch. The parent has a typed Booking stand-in for independent integration; that does not establish real Booking acceptance.

The baseline has no completed-booking-count RPC for discovery. Returning a fake zero would misstate evidence. Search exposes null plus `classesTaughtAvailable: false`; the parent coordinates the additive schema change. Preference hints from the student's profile preserve the reference recommendation weights without introducing another owner's database reads.

P must provide a dedicated Tutor broker publisher identity with the accepted topology permissions. The publisher code and failure-retention tests do not establish deployment of those credentials or the real broker outage/topology acceptance cases. The Dockerfile is prepared; no image-build or hosted-run result is claimed here.

Load tests, final browser journeys, real-peer recovery, hosted deployment and presentation assembly are recorded separately by the parent and other owners. Historical load-test results remain untouched.
