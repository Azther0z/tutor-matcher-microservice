# Ideal delivery evidence

Implemented locally on 10 November 2026, on `feat/ideal-marketplace` based on Saint's published identity/Traefik revision `8dff5c3`. This branch contains Tutor, Review, their marketplace UI, tests, runtime integration and new search measurement tools. It has not been pushed, deployed or submitted.

## Verified locally

| Check | Result |
| --- | --- |
| Tutor tests | 14 passed with zero skips, including real MongoDB transactions and HTTP/gRPC transport. |
| Review tests | 21 passed with zero skips, including concurrency, moderation, outbox recovery and HTTP/gRPC transport. |
| Shared and Auth tests | Nine shared checks and two Auth checks passed with the disposable PostgreSQL database. |
| Browser regression | All 30 browser cases passed: 16 marketplace cases plus 14 existing identity cases, using synthetic API fixtures. See [UI evidence](ui.md). |
| Real combined backend | Auth/PostgreSQL, Tutor/MongoDB, Review/MongoDB and Traefik passed approval, pending activation, real Auth grant, publication, discovery, reviews, reply, flag, hide, rating exclusion and explicit collaborator failure. |
| Real combined browser | Six journeys passed against those running services, without intercepting their APIs: login/profile, subject editing, pending revision, private admin rejection/history, discovery and selected slots, and private moderation/public exclusion. |
| Static and build | Root typecheck, lint, production build and format checks passed. Lint retains dynamic gRPC typing warnings in existing Auth and Review code. |
| Contracts | Pinned jsonschema 4.26.0/PyYAML 6.0.3 check passed all 114 operations and fixtures. Seven protobuf files and all 20 RPC codecs passed. |
| Runtime packaging | Tutor/Review production module and protobuf factory checks passed. Local Compose and hosted Swarm manifests parsed with synthetic configuration. No container image was built. |

The databases were native isolated PostgreSQL and MongoDB replica-set processes on the Mac. Generated credentials existed only in process memory. Integration creates separate synthetic databases and removes them afterward.

The combined test uses Santa's typed Booking interface as a test fixture and a Swarm discovery API fixture. Traefik, Auth, Tutor and Review are real implementations. This does not establish real Booking lifecycle, a real Swarm deployment or Notification delivery.

## Repeat the owned integration

Build the shared, Auth, Tutor and Review workspaces. Supply `PG_TEST_ADMIN_URL` for a disposable local PostgreSQL cluster and `MONGO_TEST_URI` for a disposable local replica set. The defaults in the script are the isolated ports used for this run, not application databases. It creates its own uniquely named test databases.

Run `npm run test:marketplace:integrated`. Set `MARKETPLACE_BROWSER=1` to include the real browser journeys. The browser check starts and closes its own Next development server and Chrome process. It needs installed Chrome or `CHROME_BIN`. The gateway harness uses the pinned Traefik binary in the ignored cache or `TRAEFIK_BIN`.

Set `MARKETPLACE_K6=1` to run the separate steady and increasing-demand stress diagnostics. Read the [measurement guide](../../../loadtest/README.md) before interpreting them.

## Remaining integration gates

- Santa's target Booking availability, eligibility and UI are absent from the published branches inspected on 10 November. The selection link is `/bookings/new?tutorId=...&subjectId=...&slotIds=...`; the availability editor link is `/teach/availability`. Their end-to-end journeys require Santa's implementation.
- Docker Desktop cannot reach its VM on this Mac. Actual container image startup, broker/Notification receipts, Swarm replica tests and hosted rollout did not run. The existing multi-replica gateway fixture suite also fails to bind `127.0.0.2` on this Mac; the single-backend real Traefik integration passed. The socket-proxy test needs a working container engine. These checks remain enabled in the Linux CI workflow.
- P must provision the `tutor` and `review` RabbitMQ producer users, routing permissions and Notification topology/consumer. Local manifests now carry each producer URL. Hosted manifests use separate external broker URL secrets. No credentials were provisioned here.
- The baseline lacks a Booking aggregate for taught-class counts. Search uses `classesTaught: null` with `classesTaughtAvailable: false`; it never substitutes zero. The shared schema now permits that explicit unavailable value. This remains a visible missing peer interface.
- Final Q-03 evidence still needs one-versus-three Tutor replicas under matching CPU limits and real Booking/Review collaborators. Native diagnostics cannot stand in for that comparison.

The public search API adds an optional comma-separated `preferredLearningAreas` hint sourced by the UI from the signed-in Student profile. The backend applies the original recommendation weights. This input affects ranking only. It cannot grant capabilities or ownership. Search responses stay private and uncached.

## Files for assembly

- [Tutor evidence](tutor.md), [Review evidence](review.md), [UI evidence](ui.md).
- [Architecture and live explanation](architecture.md), for C-08/C-09 and the group's slide assembly.
- [Measurement commands and limits](../../../loadtest/README.md).
- The source requirement remains [Ideal's handoff](../../handoffs/ideal.md). No requirement is marked complete solely because its page or API exists.
