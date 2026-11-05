# Tutor Matcher interface contracts v1

Status: step-3 target, recorded 6 November 2026. These interfaces are not implemented or deployed yet.
The [requirements](../docs/requirements.md) own scope and policy. The [system design](../docs/system-design.md) owns service boundaries and flows.
The [pinned monolith](https://github.com/Azther0z/tutor-matcher/tree/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1) supplies established user journeys, not the target service topology.
See the unchanged [source PDFs](../docs/sources/README.md) for provenance.

The confirmed product decisions remain in requirements. UUIDs, actor-assertion signing, deadline/quote defaults, rounding, conditional revisions and initial preference values are technical choices selected in this step. They are not claimed as original PDF or monolith values. The eight-slot limit comes from the monolith validator; mandatory SYSTEM email was explicitly confirmed by the user.

## Contract authority and navigation

| Artifact | Owns |
| --- | --- |
| [Public OpenAPI](public.openapi.json) | Gateway paths, methods, request/response types, capabilities, errors, owner routing and requirement links. |
| [Internal OpenAPI](internal.openapi.json) | Private REST collaborations and caller allowlists. Never expose these through the gateway. |
| [Shared JSON Schema](schemas/v1.json) | Request and response data shapes, including cross-protocol identifiers and amounts. |
| [Availability protobuf](grpc/booking/v1/availability.proto) | Tutor → Booking read-only gRPC wire messages and methods. |
| [Event schema](schemas/events.v1.json) and [event guide](events.md) | Typed payloads, producer, recipient selection, subscriptions, preferences and durable delivery. |
| [Recovery guide](recovery.md) | Operation identities, unknown outcomes, close/fence semantics and required fault cases. |
| [Examples](examples/cases.json) | Synthetic positive/negative schema examples and expected outcomes. These are contract fixtures, not evidence of runtime behavior. |
| [Operation map](operation-map.json) | Derived route/owner/requirement inventory. Regenerate with the validator after changing OpenAPI. |

Use OpenAPI 3.1.1 and JSON Schema 2020-12. The public API's logical version is v1 under `/api`, preserving the monolith's resource paths where useful. Internal REST starts `/internal/v1`; gRPC uses `tutor_matcher.booking.v1`; events use schemaVersion 1 and `v1.<type>` routing.
An additive optional response field is compatible. A new required input, changed enum meaning, removed field, or changed financial rule requires a reviewed contract change and a major version or coordinated pre-release migration.
Requests reject unknown fields; consumers tolerate additional response fields, but servers must still enforce explicit public projections. Private fields are not permitted merely because an output permits additive fields.

## Shared values and boundaries

- IDs are lowercase UUID v4 strings. Auth userId, Tutor tutorId, subjectId and slotId are different domain identities. Foreign references never authorize database access.
- Revisions are non-negative decimal strings, starting at `0`, advanced on every relevant owner change. They do not wrap a JavaScript number. An ETag is the revision in double quotes, such as `"3"`.
- Instants use UTC with exactly three fractional digits, for example `2026-11-06T03:00:00.000Z`. Dates and half-hour time paths use Asia/Bangkok. A slot lasts 30 minutes. A booking contains 1–8 unique consecutive slots on one Bangkok day, all owned by the same tutor and advertising the same subject.
- The tutor calendar uses inclusive Bangkok dates `from` and `to`, with at most 93 dates. The gRPC availability window instead uses instants with an exclusive `to`. Slot creation/edit rejects elapsed slots.
- Time intervals are start-inclusive and end-exclusive. Reads can be stale; a command rechecks eligibility inside the owning transaction. Capture server time at durable command admission and preserve it on retries. Do not trust browser time.
- Money is THB only. Amounts and hourly rates are fixed two-decimal strings. Do not parse them through floating-point arithmetic. Store integral satang or use exact decimal arithmetic. Transfer requests are positive and at most `100000.00`; balances and ledger totals can exceed that limit.
- Booking total is `ROUND_HALF_UP(hourlyRate × slotCount ÷ 2, 2)` once for the whole booking. Fee is `ROUND_HALF_UP(paid × 0.15, 2)` and net earning is `paid − fee`. The sum must equal the payment. A 70% refund uses `ROUND_HALF_UP(paid × 0.70, 2)`; a full remaining refund uses `paid − priorRefunds`, with no rounding beyond satang.
- A new hold ends at `min(createdAt + 15 minutes, startsAt)`. Payment admission at or after that instant fails. A started lesson cannot be ordinarily cancelled. Student cancellation is full only when `startsAt − admittedAt > 24 hours`; exactly 24 hours is 70%. Tutor cancellation is full at any eligible pre-start time.
- Cancellation quotes are stored server-side, bound to actor, booking revision, policy version and computed amounts. A quote expires after five minutes, at lesson start, or at the next 24-hour policy boundary, whichever comes first. At the boundary issue a quote with the new terms. CancellationQuote.fee records cancellation retention (`paid−refund`); FinancialRecord.fee records the completed lesson platform fee. A consumed quote replay uses the original operation; another action cannot reuse it. Changed terms return `409 QUOTE_STALE` and require a new user confirmation.
- Completion is eligible at `now >= endsAt`. Clearing is eligible at `now >= tutorConfirmedAt + 24 hours`, under the same Wallet record lock that checks disputes. An active lesson can be disputed at `now >= startsAt` while its paid earning remains unsettled. Cancelled residual-payment claims end exclusively at `endsAt + 24 hours`. A claim exactly at that end is closed.

## HTTP behavior

Gateway retains Consul discovery, round-robin selection and last-known healthy addresses from the system design. Discovery failure uses that bounded fallback; it never routes to a caller-supplied address. With no usable owner instance return 503. The required replica/failure and load-test evidence remains step 4.

Booking keeps the existing private gRPC port 50052 (`booking-service:50052`, configured through BOOKING_GRPC_URL). Tutor resolves the reachable private Booking address and that gRPC port, rather than using the HTTP port for an RPC. Private owner HTTP `/health` routes remain Consul checks: 200 when ready and 503 when unavailable, with no sensitive diagnostics. Runtime broker outages leave committed outbox work pending and must not turn a successful business transaction into failure.

The public base is `http://127.0.0.1:8080/api` for local target deployment; hosted deployments use HTTPS. Gateway maps each OpenAPI method/path to x-owner, passes query/body unchanged, and strips caller-supplied internal identity headers. Fixed paths such as `/bookings/tutor/upcoming` precede `/{bookingId}`. No wildcard proxy to internal or demo namespaces is allowed.
The `/operations/{owner}/{operationId}` route uses a fixed owner allowlist and forwards to that owner's operation store. It forwards to the selected owner's private `/internal/v1/<owner>/operations/{operationId}` path from the internal spec. It is not a new service or a caller-selected hostname.

Every response returns X-Request-Id. A caller may supply a valid UUID; otherwise generate one. Invalid request IDs are rejected. IDs are diagnostic, not credentials. JSON responses use application/json; responses with no body use 204. Sensitive responses use Cache-Control: no-store, including sessions, account settings, reset material, payout accounts and private conversations.

Mutations marked x-idempotency REQUIRED require a UUID Idempotency-Key, including those returning 204. Anonymous login/reset-request are rate-limited; signup/reset-confirm keys are scoped to a canonical request hash and the relevant identity/token fingerprint, never stored as plaintext credentials. Auth uses keyed fingerprints for credential-bearing replay inputs, including reset tokens, rather than unsalted hashes of passwords or tokens. Never retain signup passwords or reset bodies in a generic idempotency cache. Return the original signup session only while still valid; otherwise return 409 SESSION_EXPIRED_LOGIN_REQUIRED without minting a session on replay.

Revision writes require If-Match; missing is 428, mismatch is 412. Slot creation requires If-None-Match: `*`; existing-slot writes require If-Match. Exactly one is allowed. GET-day returns per-slot revision for slot edits; PUT-slot returns the slot ETag. Tutor submission updates use submission revision, publication uses workspace revision, account restriction uses account revision, moderation uses review revision, and dispute decisions use dispute revision. Related changes that invalidate a quote also advance booking revision.
An authorized idempotent replay is resolved before stale preconditions, so a lost successful response remains recoverable. Do not use stale revisions to mask an unrelated ownership or authentication failure.

| Result | Caller meaning |
| --- | --- |
| 200 / 201 / 204 | The documented result committed. A 201 Location names the resource. |
| 202 + OperationRef + Location | Work was durably accepted but has no final result. Poll the operation URL; retain its identity. The reset-request acknowledgement is the deliberate enumeration-safe exception. |
| 400 | Malformed syntax, duplicate query keys, conflicting conditional headers, unsupported media or invalid request ID. |
| 401 / 403 | Invalid session/workload identity / authenticated caller lacks capability or is restricted. |
| 404 | Missing resource or resource not visible to this caller. Never use it as proof that a timed-out charge did not happen. |
| 402 | Known insufficient available funds; no debit/reservation. |
| 409 | Business transition, immutable-input, quote or duplicate-resource conflict. It is not a retryable dependency error. |
| 412 / 428 | Revision mismatch / required conditional header absent. Refresh before making a new decision. |
| 422 | Report all applicable field errors in `fields`, with JSON Pointer paths for body fields and `/query/name` for queries. |
| 429 | Admission rate exceeded; honor Retry-After seconds. |
| 503 | Dependency unavailable before a durable outcome can be reported. Use the same key to reconcile any ambiguous transport result. |

Error.code is stable machine-readable text; message is for people. Core codes include VALIDATION_FAILED, INVALID_CREDENTIALS, TOKEN_INVALID, ACCOUNT_RESTRICTED, FORBIDDEN, NOT_FOUND, REVISION_MISMATCH, PRECONDITION_REQUIRED, IDEMPOTENCY_CONFLICT, RATE_LIMITED and DEPENDENCY_UNAVAILABLE; operation-specific codes are listed in x-failure-codes. Never show provider stack traces, credentials or account existence through reset errors. retryable means repeat the same logical operation with its same identity, not create a fresh one.
Once a command is durably pending, use 202 when possible. A broken connection remains ambiguous even if no 202 was received. For success or known rejection, expose a terminal owner operation. A terminal rejection carries Error; a success carries resource. No transport timeout becomes a terminal rejection by itself.

Lists use page>=1, pageSize 1–100, default 20. Empty lists return items=[], totalItems=0, totalPages=0. Sort ties by stable ID. Default history lists use descending createdAt/id; upcoming lessons use ascending startsAt/id, needs-confirmation uses ascending endsAt/id, pending application queues use ascending submittedAt/id, owned subjects use name/id, and payout accounts put the default first then ascending createdAt/id. Discovery uses its selected ranking before paging. Message threads use an opaque cursor over `(createdAt,id)` and return ascending messages within a page. A cursor is bound to caller, view and thread; it is not authorization. Reject duplicate/unknown query parameters. Dates default to the current Bangkok date only on the public subject page.

## Identity, capability and privacy

Auth owns sessions and current account capabilities. A registered account has STUDENT; an approved application obtains TUTOR through the durable Tutor→Auth grant. ADMIN comes only from the existing controlled admin-signup mechanism. New protected requests check Auth's current account and session state; an unexpired JWT alone does not bypass a new ban or logout. If Auth cannot establish current authorization, fail closed with 503 before admission.

Gateway verifies the browser JWT, introspects it through Auth, and issues a 60-second RS256 actor assertion with `iss=api-gateway`, `aud=tutor-matcher-internal`, `sub=userId`, `sessionId`, `admissionId`, `admittedAt`, `requestId` and `publicOperation`, `capabilities` and `accountRevision`. Owners enforce the signed capability claim and their resource policy; the gateway checks current Auth state at admission. The gateway private key stays in encrypted runtime configuration. Owners verify signature, expiry and claims with the configured public key. Never trust an unsigned X-User-Id or X-Actor-Context supplied by a browser.

Every private call also uses a per-caller workload bearer credential from SOPS/age runtime configuration. Receivers map it to a caller name and enforce the operation's x-authorized-callers. Do not reuse one credential across all workloads. Consul resolves private addresses; it does not authenticate a caller. HTTP and gRPC metadata carry only the required caller/actor context; never put a browser token in an event.

The first user operation requires the valid actor assertion and current admission. The owner saves the minimum Admission with its durable operation before any dependent write. An owner recovering that exact operation can use its workload identity and recorded admission after the browser session/assertion expires; this cannot authorize a new user action. Receivers verify the allowlisted owner, immutable source operation identity, original actor/resource binding and prior admission time. Read-only workload jobs such as rating composition or reminder checks need no fictitious user assertion. Password reset is its separately validated anonymous token flow.

Internal account lookup returns minimal display/capability/contact data only to its allowlisted callers. Review can query immutable Booking eligibility; it cannot query booking_db. Wallet obtains Booking evidence and locks its own financial record for the decision. Auth never re-decides a tutor application during activation. Capability grants are keyed by submission ID plus approval revision; approval remains visibly activation-pending until Auth confirms it.

A student's and tutor's views share one identity but cannot edit each other's resources. A view parameter selects context, not capability. ListBookings defaults STUDENT; tutor inbox/upcoming views require TUTOR. Resource owners enforce participant checks even behind Gateway. Internal paths and private document URLs cannot be reached by changing a public route parameter.

## Owner-specific behavior

| Owner | Required integration semantics |
| --- | --- |
| Auth | Create account and empty student profile at revision 0; account changes require current password for email/password/deactivation. Password confirmation must match. Reset responses are enumeration-safe; tokens are expiring, single-use, and new-password reset revokes prior sessions. |
| Tutor | Drafts can be incomplete; submit validates bio, ID URL, video URL and consent. At most one pending application/revision; submitted content is immutable. A rejected/withdrawn version can be copied to a new draft. An approved revision replaces public content only on approval; rejection leaves current listing unchanged. |
| Tutor discovery | Preserve the monolith ranking and personalisation in its pinned [journey](https://github.com/Azther0z/tutor-matcher/blob/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1/docs/user-journeys.md). Obtain ratings and next availability in batches of <=100 before filtering, ranking and pagination. Missing Review/Booking returns 503, never zero ratings or empty availability disguised as a valid search. A genuinely unrated subject has reviewCount=0, average=null and five zero distribution counts. The batch returns exactly one summary per input subject, in input order. Public profile embeds only visible reviews. |
| Booking | Revalidate owned subject snapshot, active published tutor, self-booking prohibition, future continuous slots and price; hold all slots and booking atomically. Availability gRPC is advisory and never a reservation. A current held/booked slot cannot be edited closed or reassigned. Legacy trial pricing is absent. |
| Booking lessons | Generated meeting URL is synthetic. Participant-only projection exposes it only after confirmation and before lesson end; otherwise URLs are null and canJoin=false. Tutor override is HTTPS, editable only by the assigned tutor before end; clearing it restores generated URL. Completion captures the first accepted tutor confirmation time and propagates it durably. |
| Wallet | Calculate/refuse charges, refunds and fee/net values using exact money. Check participant identities and the immutable Booking command. Reservations reduce available balance; pending earnings never increase it. Dispute open/reject/refund/clearing share the financial-record lock and refund cap. |
| Wallet accounts | Normalize bank account input by removing spaces/dashes, then require 10–15 digits. Limit five active accounts, one default, unique active bank/number per owner. First account becomes default; removing it chooses the oldest remaining account. Snapshot the masked destination for payouts; account removal does not invalidate accepted payouts or erase history. |
| Review | One review per completed booking, one assigned-tutor reply, one flag per reporter/review. Fetch immutable Booking eligibility before admitting a review and enforce a unique bookingId locally. Moderation affects the whole review/reply and rating summary in one local transaction. Hidden/removed reviews are absent from all public profiles, lists and summaries. Resolve all open flags for the moderated review with the same decision audit. |
| Messaging | Reject self-message and an unapproved/non-Tutor target in STUDENT view. TUTOR may reply only to an existing student conversation; ADMIN_SUPPORT permits an active admin to start a conversation with a selected user, or a user to contact an active admin, with replies by those participants only. ADMIN view requires ADMIN; it grants no access to a support thread with a different admin. No ordinary user reads an unrelated thread; admin capability alone is not a global inbox permission. There is one conversation per unordered pair of user IDs; switching Student/Tutor/Admin view never creates another thread or another privacy boundary for those same two participants. kind describes the conversation, and all reads remain participant-only. Store messages separately; read cursor only advances to an existing received message in that thread. Default view STUDENT; cursor order never moves backward. |
| Notification | Create defaults lazily at revision 0: Email/Push on for booking, reminders, messages and wallet; off for product news. Keep five groups. SYSTEM is mandatory EMAIL for security and decisions. Delivery outages do not reverse business decisions. See the exact [event policy](events.md). |

Booking, Review and Messaging resolve counterpart display names through the permitted Auth lookup and return them in their participant DTOs; the UI never needs a public account-directory bypass. Review keeps the author display-name snapshot with the review. Admin dispute detail includes minimum Booking evidence, the Wallet financial record and relevant ledger movements. The admin moderation queue includes each flagged review and reporter display name, while the reporter-facing flag DTO stays minimal. Only the relevant current ADMIN can read these private projections.

No use case requires a cross-service database join. Discovery composition can cache immutable snapshots but must report dependency failure rather than inventing success. Read-only internal calls have a 2-second total deadline. A synchronous mutation attempt has a 3-second remote deadline and retains durable pending work if incomplete. Retry transient work with jittered exponential delay (1s base, 60s cap); after ten consecutive failures mark NEEDS_ATTENTION internally, retain the operation and permit retry. Never expire an unresolved financial operation to release money. These are initial operational defaults, not measured latency guarantees.

## Simulated providers

Only current ADMIN users with DEMO_MODE enabled can call `/demo/*`; each resource and reset account must also be marked synthetic. Normal student/tutor APIs cannot declare payment or payout success. A user creates a simulated top-up or payout; the demo control changes only the corresponding provider outcome. Generate no payable QR and make every representation and receipt visibly synthetic.

Outcome SUCCEEDED commits a single receipt and financial effect; FAILED is a definitive no-effect outcome; UNKNOWN preserves pending operation/reservation. Repeating the same outcome is safe. UNKNOWN may later resolve SUCCEEDED/FAILED. A contradictory terminal outcome returns 409 and cannot reverse an earlier success. providerReference must match the stored synthetic provider operation returned by the resource; a new reference cannot create a second outcome. For meeting simulation the same values mean READY, MISSING, or provisioning-pending; retries keep one provider operation identity. Demo reset content is short-lived, no-store and admin-only, and must not appear in logs or screenshots with actual data.

## Implementation handoff and validation

See the [local validation record](VALIDATION.md) for verified checks and remaining runtime evidence.

The service owner implements both its producer contract and its consumer checks. Agree contract changes before changing consumers. Each operation in OpenAPI has requirement references; [operation-map.json](operation-map.json) makes gateway routing and ownership reviewable. Shared schemas can generate TypeScript types and mock fixtures in step 4; the runtime must still perform semantic validation.

Run `uv run --offline --with jsonschema==4.26.0 python contracts/validate.py` when that dependency is cached; otherwise use a normally provisioned environment with jsonschema 4.26.0. The script validates schemas, examples, references, every AUTH/UC/SUP annotation and route inventory. Add `--with pyyaml==6.0.3` to the uv command and `--collection "postman/collections/Tutor Matcher Target Public v1"` to check all derived requests and their JSON bodies as well. It emits temporary bundled OpenAPI through `--bundle-dir /tmp/tutor-matcher-contract-bundle` for tools that cannot resolve external shared schemas. Generated bundles are not another authority.
Run `node contracts/check-proto.cjs` after Booking dependencies are installed. It loads, resolves and round-trips the protobuf with the repository's existing protobufjs dependency. It does not run a gRPC server.
Run `postman spec lint /tmp/tutor-matcher-contract-bundle/public.openapi.json --issueType syntax --no-report-events -o json` and the corresponding internal spec. No CLI/cloud init or publication is part of this step.

The generated [target Postman collection](../postman/collections/Tutor%20Matcher%20Target%20Public%20v1/.resources/definition.yaml) contains one request per public operation, grouped by owner. It is derived from the bundled public spec with `postman spec generate collection <bundle> -n "Tutor Matcher Target Public v1" --folder-strategy Tags`. After fresh CLI generation, run `python contracts/prepare-collection.py <collection-directory> --fresh-generated` with PyYAML 6.0.3. This corrects generator const/date examples and URL encoding, removes generic unvalidated response examples, and uses the validated synthetic input fixtures. It refuses collections with maintained scripts. Its token variable is empty; the requestId/idempotencyKey/revision variables and generated example values must be set per logical action (retain the same idempotencyKey for retries) and replaced with synthetic fixture IDs and the applicable caller session. It has not been run against a target server. Existing collections are unchanged. Regenerate into a separate temporary directory for comparison before replacing it, preserving any later maintained scripts.

The current [legacy protobuf](../proto/booking.proto), JavaScript services, Compose configuration and maintained Postman collection still describe the existing demo. Step 4 must migrate callers and servers together. Public IDs move from Mongo IDs where applicable to UUIDs; prices become decimal strings; direct user-confirmed top-ups become controlled simulated outcomes; reset validation moves from a query token to a POST body; private profile fields are removed from public projections. Legacy isTrial and reschedule endpoints are not part of the required target delivery. Do not claim drop-in compatibility.

The documented interfaces and fixtures must pass before parallel implementation starts. Runtime acceptance still requires the nine UI journeys, concurrency/failure exercises, deployment and syllabus evidence; schema validation alone does not establish those outcomes.

## Requirement coverage

All AUTH, UC01–UC09 and SUP behavior IDs have an operation annotation in OpenAPI. The route inventory is generated from those annotations; protocol semantics and quality criteria also need the following checks.

| Requirement | Contract location and remaining evidence |
| --- | --- |
| Q-01 correctness | Recovery guide and immutable financial commands; step 4 executes races and interrupted writes. |
| Q-02 money/time | Shared schemas, boundary rules and exact-decimal fixtures; verify UI and persistence agree. |
| Q-03 scalability | Batched rating/availability composition and full-result ranking before pagination; perform the required one/three-replica k6 runs. |
| Q-04 resilience | Gateway discovery/fallback rule, gRPC failure statuses and recoverable notification jobs; demonstrate actual failure recovery. |
| Q-05 authorization | Capability annotations, caller allowlists, actor admission and owner checks; exercise cross-user requests. |
| Q-06 recovery | Owner operation status, financial close/fence and event effect identities; execute all recovery cases. |
| Q-07 deployment | Target base URLs and private routing; complete the system-design Swarm/Compose deployment and restart evidence. |
| Q-08 secrets/backup | Runtime-only credentials, private projections and synthetic examples; perform the required isolated restore. |
| Q-09 usability | Field errors, pending status, quotes and meeting states; implement and walk through the UI. |
| Q-10 maintainability | Reusable schemas, route/protobuf checks and spec/collection lint; step 4 adds application static/build checks. |

Course constraints C-01–C-13 remain in requirements and system design. Interfaces provide the retained REST/gRPC/event boundaries and database ownership but do not fulfil presentation, teamwork, progress, deployment or measurement deliverables on their own.

The wire formats follow [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html), [JSON Schema 2020-12](https://json-schema.org/draft/2020-12), [Protocol Buffers proto3](https://protobuf.dev/programming-guides/proto3/), and [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html). Their standards do not define Tutor Matcher business policy; the accepted requirements do.
