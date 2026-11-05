# Tutor Matcher requirements and constraints

Status: Accepted delivery baseline. Updated: 6 November 2026, Asia/Bangkok.

The four-person team must deliver all nine business use cases by 10 November 2026. This baseline governs the course submission in this repository.
Acceptance criteria below describe required behavior. They do not claim that the current implementation already provides it.

## Authority and sources

Use this file for delivery scope, business rules, quality requirements, and acceptance criteria. Use the [system design](system-design.md) for ownership, consistency, flows, and deployment, and the [ADR index](adr/README.md) for decisions.
Use the [glossary](../GLOSSARY.md) for domain terms. [ARCHITECTURE.md](../ARCHITECTURE.md) describes the current implementation, rather than the complete delivery target.

| Source | What it establishes |
| --- | --- |
| User decisions confirmed in this chat, 5–6 November 2026 | Four members, deadline, all nine use cases, retained technical decisions, provider simulation, and the reconciled policies below. |
| [Course syllabus updated 4 November 2026](sources/swarch-syllabus-2026-11-04.pdf), pp. 2–6 | Course constraints, assessment evidence, presentation format, and submission requirements. |
| [Tutor Matcher proposal and ADRs](sources/tutor-matcher.pdf), pp. 1–25 | Original product scope and ADR-001 through ADR-022, subject to the explicit changes below. |
| [Monolith repository](https://github.com/Azther0z/tutor-matcher), pinned at [ce3ec82](https://github.com/Azther0z/tutor-matcher/tree/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1) | Reference journeys, implemented behavior, tests, merged decisions, and outstanding work. |

Explicit user decisions resolve the listed product conflicts. Course requirements remain mandatory for submission.
For other product details, use the PDF and the pinned monolith evidence together. Report a material disagreement before changing this baseline.
An open issue states intended work. A merged PR and its code establish implemented behavior in the reference system.
Neither a closed issue nor an existing endpoint proves that every acceptance criterion works.
Future monolith changes do not automatically change this baseline. Original PDF copies remain unchanged. [Source details](sources/README.md) identify both files.

## Delivery scope

The release includes UC-01 through UC-09, authentication, student–tutor messaging, notification preferences, and supporting admin journeys.
Every included journey must work through the web UI with backend enforcement. A placeholder page or an isolated API response does not complete a journey.
The deadline is 10 November 2026. An exact submission time was not provided.

The hosted course demo must run on Docker Swarm through Doco-CD. A repeatable local Docker Compose deployment must remain available as a fallback.
Payment, bank payout, meeting, and notification providers are simulated. Internal permissions, state changes, financial rules, and recovery must still work.
The hosted demo must support explicit simulation configuration while using production builds. The reference monolith's production simulation restriction cannot block the hosted demo.
No real money is transferred. Simulated payment and payout controls and provider outcomes must be clearly labeled.

The following capabilities are outside this delivery:

- Google sign-in, real external-provider integrations, and real-money operation.
- Teaching-certificate collection and actual file upload or storage. Applications use document URLs and synthetic demonstration documents.
- Attendance-based automatic completion. The assigned tutor confirms completion after the scheduled end.
- Partial dispute awards, disputes after settlement, and recovery of earnings after a payout.
- In-person lessons, recurring bookings, group lessons, lesson packages, promotional posts, and native mobile applications.
- Transfer-slip submission and manual top-up approval from the monolith's [open PR #222](https://github.com/Azther0z/tutor-matcher/pull/222).

Student–tutor messaging stays in scope. It is not deferred with Google sign-in.
Provider simulation is a user-approved delivery choice. The syllabus does not explicitly confirm instructor acceptance of simulated providers.
That acceptance remains an external uncertainty to report in the submission risk matrix.

## Actors and shared rules

Every account has the Student capability. Tutor approval adds the Tutor capability to the same account.
Admin is an additional controlled capability. Public clients cannot grant capabilities or ownership by supplying role fields.

A subject is the bookable offering. A booking contains one student, one tutor, one subject, and a continuous block of dated 30-minute slots.
Availability belongs to the tutor. Each open slot advertises one or more subjects owned by that tutor.
A tutor cannot sell overlapping time through different subjects or duplicate slot records.

Each user has one wallet. Pending earnings and reserved payout funds are excluded from spendable funds.
Wallet history records completed money movements and remains read-only. Pending attempts have separate status and must not appear as completed movements.
The backend calculates prices, fees, refunds, ownership, eligibility, and state transitions. Browser controls alone cannot enforce these rules.

## Functional requirements

### Authentication and account access

AUTH-01: Registration requires name, email, password confirmation, and agreement to Terms and Privacy Policy. New accounts receive Student capability.
AUTH-02: Email/password login, logout, and password reset must work. Protected pages return users to their original destination after login.
AUTH-03: A password-reset link lasts 30 minutes and works once. A new request invalidates earlier links.
Reset requests give the same response for registered and unknown email addresses. Delivery uses the simulated notification provider.
AUTH-04: The backend must enforce capabilities and resource ownership on every protected action. Admin provisioning must use a controlled mechanism.
AUTH-05: Account settings support name, email, password, and account deactivation, following the monolith journey.

Evidence: [account journeys][journeys], [authentication issues #122–#138](https://github.com/Azther0z/tutor-matcher/issues/123), and [admin provisioning issue #193](https://github.com/Azther0z/tutor-matcher/issues/193).

### UC-01 Apply to become a tutor

UC01-01: A signed-in student can save, edit, and delete application drafts. Submission requires bio, identification-document URL, introduction-video URL, and consent.
UC01-02: At most one submitted application or listing revision can await review per account. Other drafts remain editable.
UC01-03: The owner can withdraw a pending submission. Submitted versions remain immutable in submission history.
Rejected or withdrawn versions can be copied into new drafts without altering their source records.
UC01-04: An admin can approve or reject a pending submission. Rejection requires a reason that the applicant can see.
Initial approval grants Tutor capability and creates an unpublished listing. The tutor chooses when to publish.
UC01-05: Identification-document URLs are visible only to the owner and authorized admins. Public pages show approved public content and verification status.

Acceptance: Apply, withdraw, resubmit, reject, and approve through the UI. A pending or rejected applicant cannot use tutor capabilities.
Evidence: PDF p. 3, [issue #139](https://github.com/Azther0z/tutor-matcher/issues/139), [PR #195](https://github.com/Azther0z/tutor-matcher/pull/195), and [PR #188](https://github.com/Azther0z/tutor-matcher/pull/188).

### UC-02 Publish subjects and availability

UC02-01: An approved tutor can submit profile and verification-document revisions for admin review. Existing approved content stays public during review.
Approval replaces the current approved version without changing publication status. Rejection preserves current content and records a reason.
UC02-02: A tutor can publish or unpublish their listing. Unpublishing blocks discovery and new bookings while preserving existing bookings and conversations.
UC02-03: A tutor can manage owned subjects with name, description, positive hourly rate, Online format, and one to three learning areas.
Subject changes take effect independently of profile review. Existing bookings retain snapshots of their subject details and price.
UC02-04: A tutor can open future dated half-hour slots and assign owned subjects. Past, booked, and actively held slots cannot be changed or closed.
Overlapping tutor slots are rejected, including across subjects. A stale edit fails without losing the tutor's draft.

Acceptance: Approve a revision, publish an offering, and discover its assigned availability. Reject unauthorized edits and changes to locked slots.
Evidence: PDF pp. 3, 8, [PR #206](https://github.com/Azther0z/tutor-matcher/pull/206), [PR #189](https://github.com/Azther0z/tutor-matcher/pull/189), and [PR #190](https://github.com/Azther0z/tutor-matcher/pull/190).

### UC-03 Discover and pay for a booking

UC03-01: Public discovery lists approved, published tutors' subjects. Search supports keyword, tutor name, learning area, price, rating, and Online format.
Sorting, pagination, tutor profiles, subject details, and Bangkok availability calendars follow the [monolith discovery journey][journeys].
UC03-02: A student chooses one subject and 1–8 consecutive available half-hour slots on one Bangkok calendar day (at most four hours, as in the monolith booking validator). Self-booking and past slots are rejected.
The UI shows the schedule, duration, price, and learning-goal note before creating the booking.
UC03-03: Continuing creates a payment-due booking and holds its slots. Price equals slot count multiplied by half the captured hourly rate.
The hold lasts 15 minutes, capped at the lesson start. Top-up and login preserve the booking destination without extending its hold.
UC03-04: Payment requires sufficient available funds. A successful charge confirms the booking immediately, with no tutor acceptance step.
Both participants can see the confirmed lesson. Repeated payment requests cannot debit twice.
UC03-05: Expired or cancelled unpaid bookings release their slots without a wallet movement. An uncertain charge outcome must be reconciled before releasing slots.
A timeout must not leave a charged student with a cancelled booking and no recorded refund or confirmed lesson.

Acceptance: Discover, hold, top up, return, pay, and view the booking through the UI. Exercise expiry, insufficient funds, retries, and concurrent slot selection.
Evidence: PDF p. 4, [issues #140, #143, #144](https://github.com/Azther0z/tutor-matcher/issues/144), [booking code][booking-code], and [PR #209](https://github.com/Azther0z/tutor-matcher/pull/209).

### UC-04 Top up the wallet

UC04-01: A signed-in user selects a preset or custom positive THB amount, up to THB 100,000, with at most two decimal places.
UC04-02: The UI displays a clearly labeled, non-payable demonstration QR or payment representation. The simulated provider supports success, failure, and unresolved outcomes.
UC04-03: Only a confirmed successful outcome credits available funds and creates one top-up movement. Failure or an unresolved outcome does not credit funds.
Duplicate confirmations cannot credit twice. A successful top-up returns a booking-related user to the same booking if its hold remains valid.

Acceptance: Show successful, failed, duplicate, and unresolved confirmations. Display the updated balance and completed transaction without manual database edits.
Evidence: PDF p. 4, [PR #182](https://github.com/Azther0z/tutor-matcher/pull/182), and the pinned [wallet implementation][wallet-code].

### UC-05 Deliver and complete a lesson

UC05-01: Confirmed bookings provide participant-only access to the simulated meeting. Provisioning failure cannot reverse payment or cancel the confirmed booking.
UC05-02: Preserve the monolith's generated-link and tutor-override journey. The assigned tutor can add, replace, or remove a custom HTTPS URL until the scheduled end.
A custom link takes priority. Removing it restores the generated link when available. Show missing-link status and the latest change time.
UC05-03: Join is available after confirmation when a link exists, until the scheduled end. Cancelled and completed bookings have no Join action.
Removing access inside Tutor Matcher does not promise to revoke an external URL that someone already copied.
UC05-04: Only the assigned tutor can confirm completion, at or after the scheduled end. No automatic completion or attendance threshold applies.
Completion enables the student's review action and starts the earnings-clearing period. It must not immediately make earnings spendable.
UC05-05: Record the tutor's net earning using the agreed 15% platform fee. Keep it pending until 24 hours after tutor confirmation.
An open dispute blocks clearing. Clearing produces one earning movement, even after repeated requests or recovery from a failure.

Acceptance: Exercise missing meeting links, the tutor override, unauthorized or early completion, review eligibility, pending earnings, and eventual clearing.
Evidence: PDF p. 5, [meeting-link ADR][meeting-adr], [PR #217](https://github.com/Azther0z/tutor-matcher/pull/217), and reconciled [issues #212](https://github.com/Azther0z/tutor-matcher/issues/212) and [#160](https://github.com/Azther0z/tutor-matcher/issues/160).

### UC-06 Cancel a booking

UC06-01: A participant can cancel their own eligible booking before its scheduled start. Ordinary cancellation is unavailable once the lesson starts.
UC06-02: Student cancellation refunds 100% when the lesson is more than 24 hours away. At exactly 24 hours or less, it refunds 70%.
The backend supplies the refund quote. Changed terms require the student to review and confirm a new quote.
UC06-03: Tutor cancellation always refunds the student's full payment. Require a reason of at most 500 characters and show a late-cancellation warning within 24 hours.
Show the reason to the student. Freed tutor-cancelled slots remain closed until the tutor reopens them.
UC06-04: Student-cancelled free future slots return to availability. Cancelled lessons leave upcoming schedules and lose the in-app Join action.
Keep the booking and financial history. Show unresolved refunds as pending and prevent duplicate credits.

Acceptance: Exercise both actors, both sides of the 24-hour boundary, changed quotes, duplicate requests, unauthorized requests, and provider/service failures.
Evidence: PDF p. 5, [student policy][student-policy], [tutor policy][tutor-policy], [PR #205](https://github.com/Azther0z/tutor-matcher/pull/205), and [PR #207](https://github.com/Azther0z/tutor-matcher/pull/207).

### UC-07 Request a payout

UC07-01: Only tutors can manage payout accounts and request payouts. A tutor uses the same wallet for top-ups and cleared earnings.
UC07-02: Preserve the [monolith account journey][journeys]: up to five owned accounts, one default, masked numbers after saving, and no duplicate active bank/number pair.
Removing an account preserves historical payout references. Users cannot select another person's account.
UC07-03: A tutor requests a positive amount up to THB 100,000 that does not exceed available funds. Pending earnings cannot fund a payout.
Show the amount and masked destination before confirmation. Clearly label the simulated transfer.
UC07-04: Reserve the requested funds against other spending while the outcome is unresolved. Success creates one completed payout movement.
Definitive failure releases the reservation. An unknown outcome remains pending and must be reconciled before funds are released or transferred again.

Acceptance: Exercise account ownership, defaults, insufficient funds, success, failure, unknown outcomes, and repeated request references.
Evidence: PDF p. 6, [PR #211](https://github.com/Azther0z/tutor-matcher/pull/211), and the [tutor-only confirmation][tutor-only-policy] implemented in [PR #221](https://github.com/Azther0z/tutor-matcher/pull/221).

### UC-08 Review a completed booking

UC08-01: Only the student who owns a completed booking can submit its review. Allow one review per booking, with rating 1–5, text, and optional headline.
UC08-02: Link the review to the captured tutor and subject. Show subject-specific reviews and public rating summaries. A tutor can reply once to their review.
UC08-03: A user can flag a review with a reason. Reject duplicate flags by the same user.
UC08-04: An admin records a keep, hide, or remove decision with a reason. Hiding or removing a review hides the whole public review and its reply.
Exclude its rating from public summaries. Preserve the audit record and notify the author and reporter.

Acceptance: Reject incomplete, other-student, and duplicate reviews. Publish, reply, flag, moderate, and recalculate public summaries through the UI.
Evidence: PDF p. 6 and open [review issues #168–#171](https://github.com/Azther0z/tutor-matcher/issues/131). Reference review-writing services are placeholders, not completed functionality.

### UC-09 Resolve a payment dispute

UC09-01: A student can report a lesson-related payment issue after the lesson starts and before its earnings clear. Capture the booking and issue details.
For a cancelled booking with a remaining paid amount, the window runs from scheduled lesson start until 24 hours after scheduled lesson end.
Fully refunded bookings have no remaining financial claim. This separate window does not extend the pre-clearing window for completed lessons.
The tutor's completion confirmation alone cannot prevent a dispute. Opening a dispute freezes that booking's pending earnings.
UC09-02: An authorized admin reviews the case, booking, and financial history. The decision and reason remain visible to the affected user and in audit history.
UC09-03: The admin can reject the dispute or approve a refund of the full remaining paid amount to the student's wallet.
Count previous refunds toward the cap. Total refunds cannot exceed the original payment.
UC09-04: Apply an approved remedy once. An unresolved adjustment stays pending without clearing disputed earnings or duplicating its financial effect.
An approved full refund removes the refunded lesson's pending earning. A rejection removes the dispute hold but does not bypass the clearing deadline.

Acceptance: File, freeze, reject, and approve cases through the UI. Exercise prior refunds, concurrent settlement, retries, and an interrupted financial adjustment.
Evidence: PDF p. 7, open [issue #158](https://github.com/Azther0z/tutor-matcher/issues/158), and open [issue #175](https://github.com/Azther0z/tutor-matcher/issues/175), reconciled by the confirmed delivery policy.

### Messaging notifications and account safety

SUP-01: Students can start conversations with tutors before or after booking. Only participants and authorized admin workflows can access conversation content.
Preserve inbox, thread, unread indicator, and Student/Tutor context switching. Reject blank messages and text over 2,000 characters.
SUP-02: Notification preferences cover booking updates, lesson reminders, new messages, wallet/payments, and product news, with Email and Push choices.
Security and administrative decision messages outside those groups use mandatory SYSTEM email: password resets, tutor-application outcomes, account restrictions, and moderation outcomes. SYSTEM is not a sixth configurable group. This rule was confirmed by the user in step 3.
Respect preferences at dispatch. Lesson reminders use the reference journey's one-hour and ten-minute times.
SUP-03: Simulated delivery records must make the recipient, event, channel, and outcome inspectable. Recover required notification work after publishing or consumer failures.
Retries must not create duplicate delivery effects. Notification failures cannot reverse a committed business action.
SUP-04: Admins can search users by name, filter account capabilities, message a selected user, and suspend or ban with a reason.
Restricted accounts lose protected access. Record and notify the reason, reject duplicate bans, and preserve bookings and financial audit history.
Restrictions do not silently delete or settle existing paid bookings. Any financial remedy follows UC-09.

Evidence: PDF pp. 7–9, [messaging PR #76](https://github.com/Azther0z/tutor-matcher/pull/76), [notification issue #156](https://github.com/Azther0z/tutor-matcher/issues/156), and [account-safety issue #172](https://github.com/Azther0z/tutor-matcher/issues/172).

## Quality and operational acceptance

| ID | Required outcome | Evidence required before delivery |
| --- | --- | --- |
| Q-01 Correctness | No overlapping sale, double spending, duplicate financial credit, duplicate earning, or premature release of uncertain funds. | Concurrent, retry, and interrupted-operation checks across booking, payment, cancellation, settlement, payout, and disputes. |
| Q-02 Money and time | THB amounts support satang precision. Direct amount inputs accept at most two decimals. Display dates and calendars consistently in Asia/Bangkok. | Price, fee, refund, and balance examples agree across UI, stored history, and services. The interface design must specify consistent decimal arithmetic and rounding. |
| Q-03 Scalability | With 50 concurrent users for 30 seconds, adding Tutor replicas raises search throughput, with p95 latency below 500 ms and errors below 1%. | Comparable one-replica and three-replica runs, saved scripts/results, fixed resource limits, and interpretation of bottlenecks. |
| Q-04 Resilience | The gateway continues serving when one Tutor instance fails or Consul becomes unavailable. Notifications cannot reverse successful business decisions. | Failure demonstrations with observed errors, delays, recovery, and the limits of fallback routing. |
| Q-05 Authorization | Enforce account capabilities, ownership, private document access, payout privacy, and participant-only meeting access on the backend. | Cross-user and cross-role negative checks, including direct requests that bypass UI controls. |
| Q-06 Recovery | Retain uncertain payment/payout attempts and required notification work. Reconcile outcomes before releasing funds or slot holds. | Recovery after committed writes, lost responses, broker outages, and repeated callbacks. |
| Q-07 Deployment | Separate local and hosted deployment configuration. Persist service data and document infrastructure dependencies. | Clean startup, restart with data retained, documented configuration, and a local fallback rehearsal. |
| Q-08 Secrets and backup | Encrypt deployment secrets with SOPS/age. Keep plaintext secrets out of Git, logs, and demonstration evidence. Test backup and restore. | Configuration review and recorded restoration to an isolated environment. Use synthetic accounts, documents, and funds for the demo. |
| Q-09 Usability | Show field errors, empty states, missing meeting links, payment/dispute/payout status, and cancellation consequences clearly. | Browser walkthrough of happy and failure paths without manual ID copying or database changes. |
| Q-10 Maintainability | Keep presentation separate from backend rules. Automate formatting, static checks, tests, and application builds. | Repeatable commands and successful required checks for the submitted revision. |

p95 means that 95% of measured requests finish within that latency. These targets come from PDF p. 9 and ADR-022.
Existing saved load results are historical evidence. Rerun relevant checks after implementation changes before claiming that the final revision meets them.
No production security, availability, provider capacity, or deployment success is implied by an accepted requirement.

## Retained architectural constraints

The [ADR records](adr/README.md) preserve the PDF numbering. Their accepted status records a decision, rather than implementation completion.
The microservice architecture remains the target. Do not rebuild a shared backend to satisfy wording from the historical extraction sequence.
System design and interface design must meet the following retained constraints:

| Constraint | Governing decisions |
| --- | --- |
| Next.js for presentation and routing. Backend APIs own business rules and data access. | ADR-0001, ADR-0002 |
| Express services in TypeScript. One monorepo with npm workspaces, shared quality commands, and one workspace lockfile. | ADR-0002, ADR-0004 |
| Each service owns its persistence. Use separate PostgreSQL databases for Auth, Booking, and Wallet; separate MongoDB databases for Tutor, Notification, Review, and Messaging. | ADR-0015–ADR-0017, ADR-0025–ADR-0026 |
| REST, gRPC, RabbitMQ-based asynchronous processing, and an API gateway participate in actual business journeys. | ADR-0010–ADR-0020 and course constraints |
| Gateway JWT verification and trustworthy downstream identity. Internal-only endpoints remain unreachable through public routing. | ADR-0013, ADR-0018 |
| Consul registration and health checks, gateway routing to healthy instances, and fixed-name fallback when Consul is unavailable. | ADR-0021 |
| Separate local and hosted manifests, commit-traceable images built/published with GitHub Actions, Swarm/Doco-CD deployment, and SOPS/age secrets. | ADR-0005–ADR-0008 |
| Booking/Wallet recovery and recoverable asynchronous notification work replace assumptions about a shared transaction. | ADR-0011, ADR-0020, ADR-0024 |

The old Prisma/shared PostgreSQL decision applies to the original single-backend version only. ADR-0015 explicitly changes that scope for extracted services.
Kubernetes is not required by the supplied syllabus or this baseline. A switch to Kubernetes requires another explicit decision.
The [accepted system design](system-design.md) records step-2 service ownership, workflows, and deployment prerequisites. The [interface contracts](../contracts/README.md) record the step-3 routes, schemas, money/time rules, authorization, events and recovery behavior.

## Course submission requirements

| ID | Mandatory requirement | Required evidence | Syllabus |
| --- | --- | --- | --- |
| C-01 | At least three business use cases plus authentication, through a frontend UI. This project's scope is all nine. | Working UI for all included journeys, with at least three business use cases and authentication in the final live demonstration. | pp. 4, 6 |
| C-02 | At least one REST service, one gRPC service, one broker-based service, and an API gateway. | Live business interactions and explanations of their communication mechanisms. | pp. 4, 6 |
| C-03 | Explain service discovery. | Registry, health checks, routing, fallback behavior, and limitations. | pp. 4, 6 |
| C-04 | At least one relational and one NoSQL database type. | Architecture and demonstration showing actual service use of PostgreSQL and MongoDB. | pp. 4, 6 |
| C-05 | At least two load-test types, with result interpretation. | Reproducible scripts and saved results. Use the existing steady-load scalability comparison plus a distinct stress test with increasing demand. | p. 4 and p. 6 |
| C-06 | A risk matrix covering at least three issues. | Likelihood, impact, mitigation, and remaining risk. Include payment inconsistency, access violations, and deployment/dependency failure. | pp. 4, 6 |
| C-07 | One measurable quality attribute. | The Q-03 scalability target, measurements, comparison, and explanation of limits. | pp. 4, 6 |
| C-08 | Architecture goals, constraints, and key decisions. | Slides traceable to this baseline and the accepted ADRs. | p. 5 |
| C-09 | C4 Level 1 System Context and Level 2 Container diagrams. | Users, external systems, services, stores, and communication. Clearly label simulated providers. Level 3 is optional; Level 4 is not required. | p. 5 |
| C-10 | A sequence diagram for one representative business scenario. | Interservice calls and events for a real scenario, including a meaningful failure or recovery path. | p. 5 |
| C-11 | A deployment overview. | Hosted Swarm/Doco-CD shape, connections, storage, configuration, and local fallback. | p. 5 |
| C-12 | Final slides and a live UI demonstration. | 15 minutes for presentation/demo and 5 minutes for Q&A. Recorded video cannot replace the final live demo. | pp. 5–6 |
| C-13 | Progress 1–3 and Git contributions are assessed. Progress clips use 3–5 minutes. | Retain existing contribution history and submission links. Report missing historical evidence rather than fabricating completion. | pp. 2–4 |

Page 4 explicitly requires two load-test types. Page 6 uses the singular without removing that requirement, so this baseline follows the stricter wording.
Changing replica counts alone does not count as the second type. Replica failure tests provide additional resilience evidence.
The syllabus requires final slides, not a separate written report. The PDFs and repository documents support the slides but do not replace them.
Presentation dates are 11 and 15 November in the syllabus. The user-confirmed delivery deadline remains 10 November.

## Resolved source conflicts

| Topic | Earlier or conflicting evidence | Accepted delivery decision |
| --- | --- | --- |
| Scope and team | Three-flow microservice demo; a larger team appears in the monolith's historical documentation. | Four members, all nine use cases by 10 November 2026. |
| External systems | Real PromptPay, bank, meeting, and email providers in the PDF and monolith target. | Simulate all four providers in local and hosted course demos. Keep real internal rules and recovery. |
| Authentication | Google sign-in in the PDF. | Defer Google sign-in. Keep email/password access, password reset, and messaging. |
| Applications | Mandatory teaching certification in PDF p. 3 and issue #135. Later PR #188 removes collection. | Use bio, identification-document URL, introduction-video URL, and consent. No certification collection or file uploads in this delivery. |
| Payouts | PDF p. 6 permits any user. Later monolith confirmation and PR #221 make accounts tutor-only. | Tutor-only payout accounts and payouts. |
| Completion | PDF p. 5 uses attendance evidence. Monolith PR #217 implements tutor confirmation. | Assigned tutor confirms after scheduled end. No attendance-based completion. |
| Settlement | Issue #212 releases on confirmation; issue #160 requires a clearing period. | 15% fee; clear 24 hours after tutor confirmation, with disputed earnings held. |
| Disputes | Broad PDF remedies and unresolved monolith issues. | Full remaining-payment wallet refunds before settlement, admin reason/audit, cumulative refund cap, no partial awards or post-settlement claims. |
| Cancelled-booking claims | Cancelled lessons never reach completion or earning clearance, leaving the original window undefined. | With a remaining payment, allow claims from scheduled start until 24 hours after scheduled end. Fully refunded bookings have no remaining claim. |
| Cancellation | Microservice code uses a 50% late refund. Confirmed monolith policies use 70% and distinct tutor behavior. | Adopt the confirmed monolith policies in UC-06, including the exact 24-hour boundary. |
| Moderation | Issue #171 removes a comment; the PDF permits review moderation. | Hide/remove the whole review and exclude its rating, with audit and notifications. |
| Event loss | ADR-020 acknowledges loss after a database write. ADR-009 requires recovery. | Preserve recoverable notification work and prevent duplicate delivery effects. |
| Deployment | Deferral of production tooling was proposed during discussion. | Retain hosted Swarm/Doco-CD, image publishing, SOPS/age, and local Compose fallback. Kubernetes is optional and not selected. |
| Data access | ADR-003 describes shared Prisma/PostgreSQL transactions. | Retain it as original-version history. ADR-0015–ADR-0017 govern extracted services. |
| Booking database | PDF ADR-017 and current code use MongoDB for Booking. | Step 2 selects a separate PostgreSQL Booking database for related slot, hold, operation, and outbox transactions. Wallet remains separate. |
| Conversations | Chat is required but has no owner in the original service map. | Add Messaging with its own MongoDB database. Retain Review and Notification as separate owners. |

## Completion and change control

Step 1 produces this accepted baseline, the ADR records, glossary, and linked source evidence. It does not complete implementation or submission evidence.
Step 2 is recorded in the [accepted system design](system-design.md). Step 3 is recorded in the [interface contracts](../contracts/README.md), including shared monetary/time semantics. Application implementation and runtime acceptance remain step 4.
Step 4 implements and integrates the system across four members. Step 5 assembles and rehearses the final submission documentation and live demo.
Maintain documentation as decisions change during earlier steps. Do not wait until step 5 to record a changed rule.

A use case is complete only when its UI journey, backend rules, authorization, relevant failure recovery, and evidence agree with this baseline.
Record any later scope or policy change here first. Link the affected ADR, contract, implementation, and checks without creating another active requirements baseline.
Instructor acceptance of simulated providers and the exact deadline time remain unconfirmed. Neither is implied by this document.

[journeys]: https://github.com/Azther0z/tutor-matcher/blob/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1/docs/user-journeys.md
[booking-code]: https://github.com/Azther0z/tutor-matcher/blob/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1/apps/backend/src/modules/booking/booking.service.ts
[wallet-code]: https://github.com/Azther0z/tutor-matcher/blob/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1/apps/backend/src/modules/wallet/wallet.service.ts
[student-policy]: https://github.com/Azther0z/tutor-matcher/blob/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1/docs/sources/book-3-policy-confirmation.md
[tutor-policy]: https://github.com/Azther0z/tutor-matcher/blob/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1/docs/sources/book-4-policy-confirmation.md
[tutor-only-policy]: https://github.com/Azther0z/tutor-matcher/blob/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1/docs/sources/prof-7-tutor-only-confirmation.md
[meeting-adr]: https://github.com/Azther0z/tutor-matcher/blob/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1/docs/adr/0004-google-meet-lesson-links.md
