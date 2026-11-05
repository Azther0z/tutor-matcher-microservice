# Four-member implementation handoff

Prepared: 6 November 2026, Asia/Bangkok. Delivery deadline: 10 November 2026. The exact submission time remains unconfirmed.
These files divide step 4 across Saint, Ideal, Santa, and P. They also assign evidence for step 5.
This is a work allocation, not a claim that implementation started or passed acceptance.
The names come from the user. The allocation uses service boundaries, not assumed member experience.

| Member | Backend ownership | UI ownership | Shared delivery responsibility |
| --- | --- | --- | --- |
| [Saint](saint.md) | Auth and Gateway | Access, account/student settings, user administration, shared application shell | Workspace, integration, CI, deployment and final assembly |
| [Ideal](ideal.md) | Tutor and Review | Applications, publication, subjects, discovery, reviews and their admin pages | Search measurements and architecture evidence |
| [Santa](santa.md) | Booking and Messaging | Availability, bookings, lessons, meeting controls and conversations | Lifecycle recovery and sequence evidence |
| [P](p.md) | Wallet and Notification | Wallet, top-ups, payouts, disputes, preferences, receipts and finance controls | Financial recovery, notification recovery and risk evidence |

Each member owns backend rules, matching pages, tests, migrations and evidence for their services.
An API without its required UI journey does not complete a handoff.
There is no separate frontend team and no member responsible for writing every other service's events.

## Read the same baseline

1. Read the [requirements](../requirements.md) and your relevant acceptance criteria.
2. Read the [system design](../system-design.md), [glossary](../../GLOSSARY.md) and [ADR index](../adr/README.md).
3. Read the [interface guide](../../contracts/README.md), [recovery rules](../../contracts/recovery.md) and [event guide](../../contracts/events.md).
4. Use [public OpenAPI](../../contracts/public.openapi.json), [internal OpenAPI](../../contracts/internal.openapi.json) and [shared schemas](../../contracts/schemas/v1.json).
5. Use the [pinned monolith](https://github.com/Azther0z/tutor-matcher/tree/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1) for journeys, code and tests.
6. Use each requirement's linked PRs and issues to distinguish implemented reference behavior from intended work.

The original [Tutor Matcher PDF](../sources/tutor-matcher.pdf) and [course syllabus](../sources/swarch-syllabus-2026-11-04.pdf) remain in the repository.
Explicit user decisions in requirements resolve their recorded conflicts. An open issue alone does not override the baseline.

These handoffs were prepared against repository base `578865c`.
The requirements, design, contracts and handoffs belong to one shared baseline change.
Before members branch, use the same approved commit containing that complete change.
After the baseline PR merges, update `main` and create implementation branches from that shared revision.
Starting from `578865c` alone omits the new baseline. Preserve existing unrelated Postman work.
The baseline PR publishes documentation and contracts. It does not deploy or implement the target services.

## Parallel work and shared files

Keep the existing root service directories. Add `review-service/`, `messaging-service/` and `web/` as planned implementation locations.
These paths do not exist at handoff preparation. The Next.js pages below are frontend routes, not new REST endpoints.

| Files or directories | Editor | Coordination rule |
| --- | --- | --- |
| `auth-service/**`, `api-gateway/**`, `shared/**` | Saint | Publish identity and discovery adapters early. |
| `tutor-service/**`, `review-service/**`, `loadtest/**` | Ideal | Keep performance results separate from historical runs. |
| `booking-service/**`, `messaging-service/**` | Santa | Own Booking PostgreSQL migration and gRPC server. |
| `wallet-service/**`, `notification-service/**` | P | Own money, consumer jobs, simulated delivery and broker topology definitions. |
| Root `package.json`, root lockfile, root quality configuration | Saint | Other owners supply dependency requests. Saint updates the single lockfile. |
| `web/package.json`, root layout, shared API/session adapter, navigation and common UI components | Saint | Share a small working shell first. Feature owners add their assigned paths. |
| `packages/contracts/**`, if a shared type package is introduced | Saint | Generate transport types from contracts. Keep business rules inside their owners. |
| `compose.yaml`, `docker/**`, hosted manifests, `.github/**` | Saint | Owners supply ports, migrations, health, volumes and variable names. |
| Each service's package manifest, Dockerfile, migrations and tests | That service owner | Coordinate dependencies with Saint before updating the root lockfile. |
| `contracts/**`, `proto/**`, governing requirements and ADRs | Saint coordinates reviewed changes | The affected producer and consumer review a contract change before implementation diverges. |
| Root README, current architecture description and final submission assembly | Saint | Each member supplies accurate service notes and evidence. |
| `docs/evidence/<member>/**` | Named member | Planned output location for sanitized commands, results and demonstration notes. |

Saint owns `web/app/layout.tsx`, `web/app/page.tsx`, `web/lib/**`, `web/components/ui/**` and shared navigation.
Saint also owns the browser-test configuration and `web/e2e/support/**`.
Members own their feature directories and matching tests, as listed in their handoffs.
Do not edit a shared root file independently in four branches. Request its change through Saint.
A service owner still fixes that service's failures after integration.

Saint must publish the small workspace and web shell before completing platform features.
Ideal, Santa and P can immediately implement their services, database constraints, tests and feature components against the contracts.
Use service-local test doubles for unavailable peers. Keep them isolated from the integrated application.
At the first integration checkpoint, switch to real internal services. Only the agreed external providers remain simulated in the demo.

## Runtime map

Use the target addresses in the contracts. Hosted backend ports stay private behind the web entry.
The local Gateway remains reachable on loopback port 8080. Saint coordinates the web entry and its local port.

| Owner | HTTP port | Store | Other interface |
| --- | --- | --- | --- |
| Gateway | 8080 | None | Public API routing through the web entry |
| Auth | 4002 | PostgreSQL `auth_db` | Private identity/grant operations |
| Tutor | 4001 | MongoDB `tutor_db` | Availability gRPC client |
| Booking | 4004 | PostgreSQL `booking_db` | Availability gRPC server on 50052 |
| Wallet | 4003 | PostgreSQL `wallet_db` | Private financial operations |
| Review | 4005 | MongoDB `review_db` | Private rating-summary reads |
| Messaging | 4006 | MongoDB `messaging_db` | Versioned message events |
| Notification | 4007 | MongoDB `notification_db` | Versioned RabbitMQ consumer |

Each backend exposes private health checks and registers the appropriate reachable address in Consul.
Each owner supplies migrations and runtime requirements to Saint. The database name alone does not grant another service access.

## First integration contracts

The operation IDs below come from the [route inventory](../../contracts/operation-map.json).
Each member's file contains the full inventory for their owners.

| Provider | First deliverable | Consumer and paired exercise |
| --- | --- | --- |
| Saint | `introspectToken`, `lookupAccounts`, `grantTutorCapability`, `getTutorGrant`; shared session/actor adapters | All owners authorize requests. Ideal proves approval can resume after Auth downtime. |
| Ideal | `getBookableSubject`, `getTutorEligibility`, `getRatingSummaries` | Santa validates catalogue without a profile callback. Discovery receives genuine empty rating summaries. |
| Santa | Both availability RPCs, `getBookingEvidence`, `getReviewEligibility`, `getReminderEligibility` | Ideal composes discovery and review eligibility. P obtains dispute evidence and suppresses stale reminders. |
| P | `applyLessonCharge`, `getLessonCharge`, `resolveOrCloseLessonCharge`, `applyCancellationRefund`, `getRefundOutcome` | Santa and P prove one debit/refund and safe recovery after a lost response. |
| Santa and P | `completeBooking` → `recordLessonCompletion` | Original confirmation time survives delayed delivery. A dispute blocks clearing. |
| P | Versioned queue, durable event acceptance, preferences and one simulated receipt | Every producer proves its own transaction/outbox survives a broker outage. |

The critical path is current identity → published catalogue and slots → charge/close → booking confirmation → completion/refund/dispute recovery.
These are integration dependencies, not reasons to stop independent implementation.
The dependency owner supplies a typed test fixture before their full feature set is complete.
Use the new availability protobuf in both callers. Keep the old protobuf until its callers migrate together.

## Common implementation rules

- Preserve all nine use cases, authentication, chat and supporting admin journeys.
- Use TypeScript services, Next.js, npm workspaces and one root lockfile.
- Use PostgreSQL for Auth, Booking and Wallet, with separate owned databases.
- Use separate MongoDB databases for Tutor, Review, Messaging and Notification.
- Use the persistent single-member MongoDB replica set when local transactions require it. Do not claim database failover.
- Preserve REST, gRPC, RabbitMQ, Gateway and Consul in actual business flows.
- Implement UUID identities, exact THB calculations, UTC timestamps and Bangkok display from the contracts.
- Save business changes and event work in the same owner transaction. Each producer owns its own outbox and publisher retries.
- Preserve operation IDs on retries. Reconcile uncertain money before releasing funds or slot holds.
- Keep private endpoints, private documents, payout numbers and conversations behind backend authorization.
- Keep five preference groups. Deliver SYSTEM email for the required security and administrative decisions.
- Keep all providers visibly simulated. Protect provider outcome controls with current Admin capability and DEMO_MODE.
- Keep Google login, certificate collection, file uploads and real provider integration outside this delivery.

Saint coordinates synthetic users and stable IDs. Each service owner provides that service's fixture creation and migration procedure.
A shared fixture runner calls owner APIs or owner-controlled seed entry points. It does not become a cross-database business backend.
Use a separate synthetic environment for testing. Preserve existing data and historical evidence.
Use injected time in automated tests for holds, clearing and claim windows. Keep the actual 24-hour clearing policy unchanged.
Label historical demo fixtures so they are not presented as observed elapsed-time evidence.

## Milestones

These are proposed coordination targets. They do not change the user-confirmed deadline.
All dates use Asia/Bangkok.

| Date | Shared exit condition |
| --- | --- |
| 6 November | Shared baseline is available. Saint publishes the minimal workspace/shell. All four owners run local service tests and expose their first contracts. |
| 7 November | Real Auth, approval activation, catalogue/availability, payment/refund and notification delivery connect. Prepare the first hosted smoke test for authorized execution. |
| 8 November | All nine use cases and chat work through the integrated UI. Run the critical cross-owner recovery cases. |
| 9 November | Complete hosted/local rehearsals, backup restoration, both load-test types, risk matrix and presentation draft. |
| 10 November | Use the remaining time for demonstrated defects, final evidence and submission rehearsal. Confirm the actual submission time with the course source. |

Do not leave integration, deployment configuration or test evidence until one member finishes every feature.
If a checkpoint slips, report the failed requirement, owner, blocking contract and next concrete deliverable.
Escalate scope changes to the user. Do not silently drop a use case or weaken a financial rule.

## Completion and submission

Each member delivers a reviewable change, migration instructions, tests, a UI walkthrough and sanitized evidence in their own evidence directory.
Record the tested revision and environment. Mark tests that did not run and separate local results from hosted results.
Follow the repository's approval rules before commits, pushes, account changes, image publication or server actions.
Prepare deployable files and a reviewable rollout procedure before requesting release authorization.

| Evidence | Lead | Contributions |
| --- | --- | --- |
| C-01, C-02, C-04: UI, protocols and stores | Every feature owner | Saint assembles the acceptance matrix. Each owner demonstrates their service and UI. |
| C-03, C-11: discovery and deployment | Saint | Others supply runtime needs, service health and recovery checks. |
| C-05, C-07: two load-test types and quality measurement | Ideal | Saint provides comparable replica/resource configurations. |
| C-06: risk matrix, at least three issues | P | Saint supplies access/deployment risks. Santa supplies lifecycle risks. Ideal supplies search risks. |
| C-08, C-09: goals, constraints, decisions and C4 diagrams | Ideal drafts, Saint assembles | Every owner confirms that the diagrams match the tested implementation. |
| C-10: representative sequence with failure/recovery | Santa | P supplies Wallet/Notification observations. |
| C-12: final slides and live demo | Saint assembles, all present | Plan 15 minutes plus 5 minutes Q&A. Demonstrate all scope during acceptance. Select at least three business use cases plus auth for the final live slot. |
| C-13: contributions and progress evidence | Every member | Retain actual history and available submission links. Record missing historical evidence honestly. |
| Q-08: backup and isolated restore | Saint coordinates, all verify | Every owner checks their own records and pending operations after restoration. |

The final demonstration must be live. Progress clips do not replace it.
Instructor acceptance of simulated providers remains unconfirmed. Keep it visible in the risk matrix.

The [contract validation record](../../contracts/VALIDATION.md) records only step-3 consistency checks.
Saint must add repeatable root commands for formatting, lint, type checking, tests, contracts, application builds and browser tests.
Those root commands do not exist at handoff preparation. Service owners supply the scripts that their workspaces need.
Runtime acceptance requires the [recovery cases](../../contracts/recovery.md#required-implementation-acceptance-cases), owner-specific negative tests and real UI walkthroughs.
