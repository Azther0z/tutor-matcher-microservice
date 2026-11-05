# Saint handoff: platform, Auth and Gateway

Own the shared application foundation, Auth and Gateway. Deliver their UI, tests and operational files.
Your work lets the other three members connect independently built features.
Publish a small usable foundation first, then complete the remaining platform work.

## Baseline and owned paths

Start with the [shared handoff](README.md), [requirements](../requirements.md), [system design](../system-design.md) and [contracts](../../contracts/README.md).
Use the [pinned monolith](https://github.com/Azther0z/tutor-matcher/tree/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1) and the evidence links under AUTH-01–AUTH-05 and SUP-04.
The [source index](../sources/README.md) links both original PDFs.
Use the same approved baseline commit before creating implementation branches. It must include the requirements, design, contracts and handoffs.

Existing code starts in `auth-service/src/`, `api-gateway/src/` and `shared/consul.js`.
The current services use JavaScript. Their existing behavior is not the complete target.

| Area | Your implementation ownership |
| --- | --- |
| Backend | `auth-service/**`, `api-gateway/**`, `shared/**` |
| Workspace | Root package/lockfile, TypeScript and quality configuration, shared transport types if needed |
| Frontend foundation | `web/package.json`, root layout/home, shared navigation, UI primitives and `web/lib/**` |
| Frontend features | `web/features/identity/**` |
| Frontend routes | `web/app/login/**`, `web/app/signup/**`, `web/app/password-reset/**`, `web/app/account/**`, `web/app/admin/users/**`, `web/app/demo/password-resets/**` |
| Browser tests | Shared test configuration, `web/e2e/support/**`, `web/e2e/identity/**` |
| Operations | Root Compose, `docker/**`, hosted manifests and `.github/**` |
| Evidence | Planned `docs/evidence/saint/**` and root documentation and final evidence assembly |

Treat frontend routes above as paths under `web/app/`. They do not change public API paths.
Other members own their feature pages, feature tests and service Dockerfiles.
Coordinate shared changes instead of rewriting another owner's service.

## First deliverable

1. Define the root npm workspaces and the single root lockfile.
2. Publish TypeScript service conventions and the minimal Next.js shell.
3. Publish the shared API/session adapter and consistent field/pending/error handling.
4. Publish synthetic identity fixtures and stable IDs through approved runtime configuration.
5. Expose Auth introspection, account lookup and idempotent tutor activation grants.
6. Connect Gateway to one real Auth request and one routed service request.

The first shell needs navigation, session handling and feature mount points. It does not need completed feature pages.
Let each member create their assigned feature directories immediately.
Expose small typed adapters for actor verification and workload identity. Keep business decisions inside their service owners.
Do not make peers wait for a general-purpose service framework.

## Required behavior

Implement AUTH-01–AUTH-05 and SUP-04 end to end.
Registration requires password confirmation, Terms and Privacy agreement. Every account starts with Student capability.
Implement login, logout, account/student settings, destination return after login, and controlled Admin provisioning.
A reset link lasts 30 minutes, works once, and becomes invalid when a new reset is requested.
Registered and unknown reset addresses receive the same acknowledgement.

Own PostgreSQL `auth_db`, migrations, sessions, restrictions and the student profile.
Check current session/account state for new protected requests. A valid but revoked or restricted session must fail.
Record restriction reasons and notify the affected account. Preserve paid bookings and financial history.
Tutor decides approval. Auth applies the original approved grant once and exposes its outcome for recovery.

Implement the [identity contract](../../contracts/README.md#identity-capability-and-privacy) in Gateway and shared adapters.
Strip client identity headers, sign actor admission, and require current capabilities.
Each private caller has its own workload identity and operation allowlist.
Recovery of a recorded action must not depend on an expired browser session.
The service owner still enforces resource ownership after Gateway authentication.

Route the exact public method/path inventory to the correct owner.
Keep fixed routes before identifier routes. Keep internal paths outside public routing.
Route operation polling through the fixed owner allowlist to each owner's private status endpoint.
Use Consul health routing and the agreed fixed-name fallback. Register reachable private addresses on Swarm.

Own the simulated reset-content access control and its Admin-only page.
Keep reset material out of events, logs, ordinary receipts and screenshots with actual data.
P implements the simulated delivery worker. Auth retains recipient-bound content for that worker's permitted fetch.

Auth owns its transactional outbox and publisher worker.
Produce `auth.password-reset-requested` and `auth.account-restricted` from the [event contract](../../contracts/events.md).
P owns Notification acceptance, jobs and delivery. That does not cover Auth's producer-side recovery.

## Deployment and shared configuration

Prepare reproducible local Compose and hosted Swarm/Doco-CD configuration.
Add all target services, three PostgreSQL databases and four MongoDB databases with owner access boundaries.
Configure the persistent MongoDB replica set required by the other owners' transactions.
Preserve persistent storage, appropriate host placement, broker queues and reachable Consul addresses.
Only the web entry becomes public in the hosted target.

Collect each owner's ports, environment variable names, migrations, health checks and volume needs before merging manifests.
Keep demo provider controls available under explicit DEMO_MODE in production-built images.
Keep deployment secrets encrypted with SOPS/age. Obtain runtime values through the approved mechanism.
Prepare CI for quality commands, service/web builds and commit-traceable images.
Follow the repository approval rules before publication or server changes.

Coordinate the first authorized hosted smoke test while feature development continues.
Prepare backup/restore and local fallback procedures before the final rehearsal.
Each database owner verifies their records and pending work after restoration.

## Interfaces and parallel work

| Peer | You provide | You consume |
| --- | --- | --- |
| Ideal | Tutor grant/write outcome, account lookup and current actor identity | Tutor's authoritative approval decision and catalogue behavior |
| Santa | Actor/session adapters, account names and shared web shell | Booking/Messaging routes, health, ports and migration needs |
| P | Reset-content fetch, active-admin resolution, account lookup and shared adapters | Notification delivery and Wallet routes, topology requirements and operational evidence |

Start platform/Auth tests against typed peer doubles. Replace them with real owners at the first integration checkpoint.
Use the same shared baseline and the endpoint inventory below. Do not introduce public capability-grant endpoints.

## Acceptance and evidence

- Prove signup, login, logout and account settings through the UI.
- Prove reset expiry, replacement, single use and enumeration-safe acknowledgements.
- Prove a recent ban blocks a new request with an otherwise unexpired JWT.
- Prove forged identity headers and direct unauthorized owner requests fail.
- Prove Ideal can resume one approval grant after Auth downtime.
- Prove Auth events survive broker downtime without duplicate delivery effects.
- Prove Gateway rejects internal paths and unauthorized demo outcome requests.
- Prove Gateway handles one failed Tutor replica and Consul downtime within the documented limits.
- Prove local startup, persistent restart, isolated restoration and the authorized hosted smoke test.

Save commands, tested revision, environment, outcomes and unresolved failures in your evidence directory.
Assemble the C-01–C-13 acceptance matrix and keep actual implementation status accurate in root documentation.
Collect each member's slide section. Rehearse the 15-minute live presentation and demo, then 5 minutes of Q&A.
A historical load result or schema check does not prove the final revision works.

Your handoff is complete when peers can use real identity/routing, your pages pass their journeys, and deployment procedures are reviewable.
Report missing authorization or runtime access separately from completed local files.

## Owned REST inventory

This index is derived from the step-3 route inventory. OpenAPI owns payloads, authorization and error meanings.
Implement all listed operations for your owners. Coordinate contract changes before changing this index.

| Owner | Surface | Operation ID | Method and path |
| --- | --- | --- | --- |
| auth | INTERNAL | `lookupAccounts` | `POST /internal/v1/auth/accounts/lookup` |
| auth | INTERNAL | `listActiveAdmins` | `GET /internal/v1/auth/admins` |
| auth | INTERNAL | `introspectToken` | `POST /internal/v1/auth/introspections` |
| auth | INTERNAL | `getResetNotificationContent` | `GET /internal/v1/auth/notification-content/{contentRef}` |
| auth | INTERNAL | `getAuthOperation` | `GET /internal/v1/auth/operations/{operationId}` |
| auth | INTERNAL | `getTutorGrant` | `GET /internal/v1/auth/tutor-grants/{operationId}` |
| auth | INTERNAL | `grantTutorCapability` | `PUT /internal/v1/auth/tutor-grants/{operationId}` |
| auth | PUBLIC | `searchAccounts` | `GET /api/admin/users` |
| auth | PUBLIC | `getAdminAccount` | `GET /api/admin/users/{userId}` |
| auth | PUBLIC | `restrictAccount` | `POST /api/admin/users/{userId}/restrictions` |
| auth | PUBLIC | `login` | `POST /api/auth/login` |
| auth | PUBLIC | `logout` | `POST /api/auth/logout` |
| auth | PUBLIC | `getCurrentAccount` | `GET /api/auth/me` |
| auth | PUBLIC | `confirmPasswordReset` | `POST /api/auth/password-reset/confirm` |
| auth | PUBLIC | `requestPasswordReset` | `POST /api/auth/password-reset/request` |
| auth | PUBLIC | `validatePasswordReset` | `POST /api/auth/password-reset/validate` |
| auth | PUBLIC | `signup` | `POST /api/auth/signup` |
| auth | PUBLIC | `getDemoResetContent` | `GET /api/demo/password-resets/{contentRef}` |
| auth | PUBLIC | `getAccountSettings` | `GET /api/profiles/me/account` |
| auth | PUBLIC | `updateAccountSettings` | `PUT /api/profiles/me/account` |
| auth | PUBLIC | `getStudentProfile` | `GET /api/profiles/me/student` |
| auth | PUBLIC | `putStudentProfile` | `PUT /api/profiles/me/student` |
| gateway | PUBLIC | `getHealth` | `GET /api/health` |
| gateway | PUBLIC | `getOperation` | `GET /api/operations/{owner}/{operationId}` |
