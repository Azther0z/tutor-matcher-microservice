# Platform and identity implementation evidence

Date: 8 November 2026, Asia/Bangkok. Base revision: `c28ba3b`; this record describes Saint's identity slice before it was stacked with PR4's Traefik gateway. It is local implementation evidence, not verification of the integrated stack. See the [Traefik integration record](traefik-integration.md) for the current verification boundary. No image publication, remote CI, PR update or server deployment is claimed.

Three GPT-6 Luna subagents implemented Auth, Gateway/shared adapters and the web identity shell in separate directories. The parent integrated their work and prepared workspace, deployment and CI files. This is Saint's slice; it does not replace the other three handoffs.

## Verification record

The checks below ran against the recorded `c28ba3b` worktree before the PR4 Traefik stack was integrated. A contract fixture or test against a peer stand-in is not evidence that a peer service exists. Auth database tests used isolated PostgreSQL 16 databases in a disposable rootless Podman container, with separate databases for unit, HTTP, browser, broker and restore checks. No existing application database was used.

| Check | Verified result |
| --- | --- |
| Workspace type checks and production builds | Shared, Auth, Gateway and Next.js build/typecheck commands pass. |
| Shared and Gateway tests | The shared tests and seven TypeScript Gateway tests passed on the recorded base. The TypeScript Gateway is being removed from the stacked architecture; its route, identity-admission and discovery results are historical and do not establish current Traefik behavior. Gateway peer/Consul fixtures were stand-ins, not hosted services. |
| Auth database/gRPC integration suite | Pass with no skip. Covers concurrent signup replay, stable error codes, password hashing, session revocation, restriction/restoration, injected reset expiry/replacement, gRPC caller permissions and durable tutor-grant recovery, terminal operation reads, seed stability and revision ETags. |
| Real HTTP integration (recorded base) | `npm run test:integrated` passed 72 status/schema/invariant checks through real Auth, the then-current TypeScript Gateway and PostgreSQL. Includes idempotent profile replay and operation polling. This does not verify the stacked Traefik gateway. |
| Browser component journeys | All 14 Playwright tests pass against explicitly intercepted API responses. |
| Real browser integration | `npm run smoke:browser` passes without API interception: signup, account/profile reads, revision-based profile save, password change, revoked access, rejected old password and login with the new password. |
| Broker interruption/recovery | `npm run smoke:outbox` passes against real Auth, PostgreSQL and disposable RabbitMQ 4.3.6. Work persists during outage, publishes with confirms/mandatory routing after recovery and is not republished after publisher restart. The harness acknowledges the event; Notification delivery is not claimed. See [broker evidence](outbox.md). |
| Database ownership | Three owner roles connect to their own PostgreSQL databases; all six cross-owner connection attempts fail. Auth migrations also apply as `auth_owner`, without a superuser. |
| Isolated Auth restoration | Custom-format backup restored to a separate database. User/profile/session counts, revoked sessions, operations, pending outbox records, audits and both migration records match. This does not establish cross-store financial or Notification recovery. |
| Contract consistency | Existing schema/examples, all 114 operation IDs, 20 RPC descriptors/codecs and all 86 target Postman requests pass the contract checker. Only Auth's five domain RPCs are implemented in this slice. |
| Style | Formatting and whitespace checks pass. Lint exits successfully with zero errors and 39 explicit-`any` warnings; these warnings remain technical debt. |

The earlier HTTP and browser integration checks exercised the TypeScript Gateway implementation. They remain evidence for Auth and the identity UI behavior they covered, but do not establish that Traefik now routes all 86 public operations or that the current ForwardAuth boundary issues and forwards the actor assertion. Those integrated checks are pending in [the Traefik integration record](traefik-integration.md).

At that recorded revision, Docker's local Compose and Swarm parsers accepted both manifests with synthetic interpolation values. The local homelab export command also prepared its app bundle without replacing existing files. No runtime environment values were printed. The Docker daemon was unavailable: individual local images and fixtures used rootless Podman; full Compose startup and Swarm rollout were not executed. These parse/export results need to be rerun against the stacked manifest.

The image build at the recorded revision used Node.js 22, compiled the selected workspace and shared package, removed development dependencies and ran a production dependency smoke check. Local Auth, the then-current custom Gateway, and web image builds passed. Auth's HTTP factory/gRPC descriptors loaded, the custom Gateway's private health request succeeded and the production web login page responded. The Gateway image and its results are historical; Traefik uses its official pinned image. No registry publication is claimed. The old local tags were `localhost/tutor-matcher-{auth,gateway,web}:saint-local`.

The same checks also passed when running the final images as their configured non-root `node` user. Local image IDs are `4c86bf55c945` (Auth), `90740fc3eeaf` (Gateway) and `e6ddf296183b` (web). These are local image IDs, not published registry digests.

Desktop and mobile [login](visual/login-desktop.png) and [account](visual/account-mobile.png) screenshots were rendered in Chrome and visually inspected. All four images are under `visual/`; they contain synthetic data, mask the account email and contain no reset content. The screenshots are UI evidence, not nine-use-case completion evidence.

The temporary database and broker containers and test application servers were stopped after verification. Local image tags and sanitized evidence remain; no production data was captured.

## Repeat locally

Run `npm ci`, `npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run contracts` and `npm run config:check` from the repository root. Use distinct disposable databases for repeated Auth, HTTP, browser and broker test runs so rate-limit and fixture state cannot interfere. Auth's suite requires `TEST_DATABASE_URL`; it never falls back to the ordinary application database.

Run `npm test` with the Auth unit database, `npm run test:integrated` with the HTTP database, `npm run smoke:browser` with a local database named `saint_browser_test`, and `npm run smoke:outbox` with a disposable local `_test` database. Browser tests require Playwright Chromium or the configured `CHROME_BIN`; broker tests require Docker or `CONTAINER_CLI=podman`. `npm run test:browser` runs the intercepted API cases. Never point these commands at real application records.

CI definitions were prepared but were not executed remotely. The private image publication workflow is manual and requires an explicitly approved trusted runner. No PR, GitOps, registry or Cloudflare write was made.

## Course acceptance status

| Requirement | Current evidence responsibility | Remaining full-delivery evidence |
| --- | --- | --- |
| C-01 live UI | Identity shell and Auth journeys | Other owners' nine business journeys and hosted demonstration |
| C-02 service protocols | Auth/Gateway HTTP and Auth domain gRPC | Real cross-owner calls and all 20 RPCs |
| C-03 discovery | PR4 standalone Traefik provider and proxy tests; integrated proof is pending | Current 86-route `/api` integration, actual owner replicas and hosted task discovery |
| C-04 relational/NoSQL | Auth PostgreSQL migration and transactions | Other owners' actual Mongo/PostgreSQL records and flows |
| C-05 two load-test types | Workspace supports owner test commands | Ideal's final measurements on the integrated revision |
| C-06 risk matrix | Server capacity, ingress, simulation acceptance and recovery gaps | P's consolidated matrix with at least three issues |
| C-07 quality measurement | Repeatable quality scripts and identity checks | Measured final quality attributes |
| C-08 goals/constraints/decisions | Requirements, glossary and ADRs | Confirm all owners' implementations match decisions |
| C-09 C4 | Existing target diagrams | Update from observed integrated implementation |
| C-10 sequence/failure | Identity revocation and transport failures | Santa/P's booking/financial recovery sequence |
| C-11 deployment | Local manifest and hosted Swarm/Doco-CD templates | Authorized rollout, HTTPS, persistent startup and local fallback |
| C-12 presentation | Owner evidence can feed slides | Final slides and live 15-minute rehearsal plus Q&A |
| C-13 contributions | Local implementation files | Actual reviewed history and available submission links |
| Q-08 backup/restore | Isolated Auth backup/restore check and procedure | Other owners' restored records and resumed pending work |

## Known integration gates

The [current homelab repositories](homelab-references.md) establish the existing Swarm/Doco-CD/private-registry/Cloudflare Tunnel configuration; the user confirmed that services are exposed through the tunnel. This implementation did not inspect live host capacity, approve a storage node label, change the existing monolith route or apply the candidate microservice hostname/port. Encrypted runtime configuration requires the existing approved key workflow; no dummy encrypted secret is presented as a working configuration. Peer images, owner migrations, producer broker permissions and Notification's consumer must arrive before the full target is enabled. The Node.js Auth publisher's tested queue setup is not a Notification consumer implementation. Instructor acceptance of simulations and the exact submission time remain unresolved course inputs.
