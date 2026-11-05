# Private gRPC collaborations v1

The user selected this split on 6 November 2026: private domain collaborations use gRPC.
Public APIs remain REST. Gateway introspection and owner-operation polling remain private REST. Notification delivery uses RabbitMQ.
This replaces the earlier 18 private domain HTTP operations and retains both availability RPCs. There are 20 unary methods.
No new business service or business use case is added.

## Contract authority

The `.proto` files own wire fields, field numbers, types, services and methods.
The [method registry](operations.v1.json) owns caller allowlists, deadlines, validation-schema references and operation-identity fields.
The [message validation views](messages.v1.json) and [shared schemas](../schemas/v1.json) own required fields and value constraints.
The [derived operation map](../operation-map.json) combines REST and gRPC ownership for implementation handoffs.
The [examples](examples.v1.json) are independent synthetic codec/schema fixtures. They are not one executable business journey or live results.

Do not tunnel arbitrary JSON through bytes or strings to implement these RPCs.
Use typed messages and preserve the value/presence rules below.
Removed HTTP operations have no parallel target REST alias. Gateway must not route these private RPCs as public endpoints.

## Servers and callers

| Owner | Private target | Proto service | Methods | Callers |
| --- | --- | --- | --- | --- |
| Auth | `auth-service:50051` | [AuthCollaborationService](auth/v1/collaboration.proto) | 5 | Tutor, Booking, Wallet, Review, Messaging, Notification, as allowed per method |
| Booking | `booking-service:50052` | [AvailabilityService](booking/v1/availability.proto), [BookingEvidenceService](booking/v1/collaboration.proto) | 5 | Tutor, Review, Wallet, Notification, as allowed per method |
| Tutor | `tutor-service:50053` | [TutorCatalogueService](tutor/v1/catalogue.proto) | 2 | Auth, Booking, Wallet, Messaging, as allowed per method |
| Wallet | `wallet-service:50054` | [WalletFinanceService](wallet/v1/finance.proto) | 7 | Booking |
| Review | `review-service:50055` | [ReviewRatingService](review/v1/ratings.proto) | 1 | Tutor |

Messaging and Notification are gRPC clients. They do not need gRPC servers for this scope.
Each owner still exposes its existing public REST operations and private HTTP health/status interfaces.
Gateway uses REST to Auth for introspection and to owners for operation polling. It does not translate public business requests into these RPCs.

Use `<OWNER>_GRPC_URL` from the registry for the configured private target.
Keep Booking's existing port 50052. The other four gRPC ports are target configuration choices for implementation.
Register the reachable HTTP address in Consul and advertise `grpc_port` metadata for owners that serve RPCs.
Domain clients use the configured private service DNS names and explicit gRPC ports from the deployment.
Do not mistake an HTTP registration port for a gRPC port or select an arbitrary Swarm interface address.

## Method catalogue

| Provider | Method | Allowed callers | Business purpose |
| --- | --- | --- | --- |
| Auth | `LookupAccounts` | Tutor, Booking, Wallet, Review, Messaging, Notification | Permitted participant/contact lookup |
| Auth | `ListActiveAdmins` | Notification | Resolve the admin audience for durable jobs |
| Auth | `GrantTutorCapability` | Tutor | Apply the approved grant once |
| Auth | `GetTutorGrant` | Tutor | Resolve a grant outcome |
| Auth | `GetResetNotificationContent` | Notification | Fetch recipient-bound, expiring sensitive content |
| Tutor | `GetTutorEligibility` | Auth, Booking, Wallet, Messaging | Authoritative approval/publication state |
| Tutor | `GetBookableSubject` | Booking | Catalogue-only snapshot, without availability callback |
| Booking | `GetAvailability` | Tutor | Public free-slot snapshot |
| Booking | `BatchGetAvailability` | Tutor | Complete availability summaries for discovery |
| Booking | `GetReviewEligibility` | Review | Captured participants and completion eligibility |
| Booking | `GetBookingEvidence` | Wallet, Notification | Minimum lifecycle evidence |
| Booking | `GetReminderEligibility` | Notification | Suppress stale reminder work |
| Wallet | `ApplyLessonCharge` | Booking | One immutable charge attempt |
| Wallet | `GetLessonCharge` | Booking | Recorded charge outcome |
| Wallet | `ResolveOrCloseLessonCharge` | Booking | Resolve applied work or prevent late execution |
| Wallet | `ApplyCancellationRefund` | Booking | Apply the accepted cancellation refund once |
| Wallet | `GetRefundOutcome` | Booking | Resolve a recorded refund |
| Wallet | `RecordLessonCompletion` | Booking | Preserve original confirmation time and clearing deadline |
| Wallet | `GetBookingFinancialRecord` | Booking | Authoritative payment/refund/clearing state |
| Review | `GetRatingSummaries` | Tutor | Batch visible-review summaries before search pagination |

The registry records the exact fully qualified method, request/response types, schema references and requirement IDs.
Read operations have a two-second total caller budget. Mutations have a three-second remote-attempt budget.
Set an explicit deadline on every call. Bound a nested call by the smaller remaining parent budget.

Configure client/server send and receive limits to 32 MiB (`grpc.max_send_message_length` and `grpc.max_receive_message_length`).
This covers the bounded 93-day slot response with up to 100 advertised subjects per slot. Field and batch limits still apply.
Discovery uses compact batch summaries, not full slot responses for every search card.

## Identity and mutation admission

Send `authorization: Bearer <workload credential>` and `x-request-id: <UUID>` metadata on every call.
Receivers map that credential to one caller identity and enforce the method's exact allowlist.
A method name, caller-supplied owner field or a DNS address does not establish identity.

Send the gateway-signed `x-actor-context` assertion when delegating a newly admitted user action.
The owner verifies the assertion and its resource policy before accepting new work.
Read-only internal jobs use their permitted workload purpose and resource scope.
A grant, payment, refund or completion command carries the original Admission in its typed body.
Recovery uses the allowlisted owner and its persisted admission/operation binding after the browser session expires.
It cannot authorize a fresh unrelated user action.

`operation_id` in request messages replaces the former HTTP path parameter for financial attempts and Tutor grants.
`booking_id` plus the original source operation and confirmation time bind completion recording.
Keep those values and the command immutable across calls.
A changed amount, actor, booking or confirmation time under the same identity is a conflict.
Do not create a new identity because a transport attempt timed out.

## Presence and JSON validation

Use proto3 optional scalar fields to distinguish an omitted field from explicit `false`, zero or an empty string.
Do not enable decoder defaults that make an omitted required scalar look present.
With `@grpc/proto-loader`, use `keepCase: false`, `defaults: false`, `enums: String`, `longs: String` and `oneofs: true`.
Generated clients must preserve equivalent presence information.
Add fields with new numbers and reserve removed field numbers/names. Never reuse field numbers or enum numeric values.
Unknown wire fields are ignored for compatible evolution. Unknown business enum values are rejected after decoding.

Normalize decoded data to the schema view before business logic:

1. Map protobuf snake_case field names to the documented camelCase DTO names.
2. Map an absent nullable field to JSON null. Keep an absent required non-null scalar missing so validation rejects it.
3. Map absent repeated fields to empty arrays, then enforce array minimums, uniqueness and batch limits.
4. Map enum names to their declared string values. Reject `*_UNSPECIFIED`, unknown enum numbers and unexpected values.
5. Convert uint64 counters to JSON numbers only within the safe integer range. Reject values outside that range.
6. Preserve UUIDs, revisions, timestamps and decimal amounts as strings. Do not convert money through floating point.
7. Apply all referenced JSON Schema constraints, including required messages, constants, nullable fields and conditional payment receipts.

Proto3 cannot enforce these business requirements by itself.
A Money message still requires THB and the permitted decimal representation.
A charge still requires a positive amount. A successful charge requires its transaction receipt.
Explicit false eligibility is a valid response and differs from a missing eligibility field.
A genuinely unrated subject uses null average, zero count and five zero distribution counts.

The JSON request view places former path/query values beside `command` when a command body also existed.
For example, ApplyLessonChargeRequest contains `operationId` and `command: PaymentCommand`.
Read requests carry only their typed identifiers or query fields.
Schema views validate values after decoding. They do not introduce an HTTP/JSON transport for these operations.

## Errors and financial uncertainty

Use gRPC's status code and a sanitized status message.
For application errors, attach encoded [common ErrorDetail](common/v1/types.proto) in trailing binary metadata `tutor-error-bin`.
That message carries the stable error code, request ID, retryability, field errors and optional operation ID.
Libraries and network intermediaries can return an error without that trailer. Callers must handle that case.
Return `x-request-id` in response metadata when possible. Request identity never authorizes an operation.

| gRPC status | Meaning | Owning public REST mapping when applicable |
| --- | --- | --- |
| INVALID_ARGUMENT | Missing/invalid fields, malformed IDs or batches | 422 with field errors |
| UNAUTHENTICATED | Missing/invalid workload or required actor assertion | 401 |
| PERMISSION_DENIED | Authenticated caller or actor lacks access | 403 |
| NOT_FOUND | Missing or caller-invisible resource/outcome | 404 |
| ALREADY_EXISTS | A conflicting resource already exists | 409 |
| FAILED_PRECONDITION | Invalid lifecycle/quote/immutable input or refund cap | 409, or 412 for REVISION_MISMATCH |
| ABORTED | Retryable transaction contention before a known result | Retry the same operation, otherwise pending/503 |
| RESOURCE_EXHAUSTED | Admission/rate limit with no accepted work | 429 |
| UNAVAILABLE | Dependency/transport unavailable | 503 before durable acceptance, otherwise pending |
| DEADLINE_EXCEEDED / CANCELLED | Caller stopped waiting; outcome can be unknown | Reconcile the original operation, show pending when accepted |
| INTERNAL / DATA_LOSS / UNKNOWN | Unexpected server/codec failure | Sanitized failure; reconcile any mutation that can have committed |

APPLIED, DECLINED and CLOSED are PaymentResult outcomes returned with OK status.
A known insufficient-funds DECLINED result maps to the public payment operation's 402 response.
CLOSED means this attempt cannot charge later. It is not a network failure.
`GetLessonCharge` returning NOT_FOUND does not prove that an in-flight charge cannot commit.
Only `ResolveOrCloseLessonCharge` under Wallet's financial lock provides the required terminal decision.

A deadline or client cancellation does not undo an accepted database transaction.
Disable automatic mutation retries that invent or hide operation identities.
The owning durable worker resumes the same command and follows the [recovery contract](../recovery.md).
Keep public 202 polling, refund caps, dispute/clearing locks and transaction boundaries unchanged.

## Sensitive content and event separation

GetResetNotificationContent is allowlisted to Notification and bound to its recipient/content reference and expiry.
Keep decrypted content in memory only for delivery. Do not cache or log it, put it into ordinary receipts, or publish it through RabbitMQ.
Expired or consumed-token work is skipped according to the event policy.
The public Admin demo reset endpoint retains its HTTP no-store policy and synthetic-account checks.

RabbitMQ events retain their versioned schemas, producers, audience rules and durable delivery behavior.
Adding gRPC does not move notifications into synchronous business transactions.
The existing [public target Postman collection](../../postman/collections/Tutor%20Matcher%20Target%20Public%20v1/.resources/definition.yaml) still describes the 86 public REST requests.
Import the relevant `.proto` separately for private gRPC exploration with an authorized test workload.
Never publish runtime credentials in a collection.

## Validation and implementation

Run the commands in [VALIDATION.md](../VALIDATION.md).
The checks cover all 20 request/response schema pairs, invalid fixtures, method registration, field presence and both installed protobuf codecs.
They do not run a server or establish authorization, database recovery, concurrency or deployment success.
The four handoffs assign each RPC server and its clients. Implement and integrate both sides before claiming the method works.

The transport behavior follows official [status-code](https://grpc.io/docs/guides/status-codes/), [metadata](https://grpc.io/docs/guides/metadata/) and [deadline](https://grpc.io/docs/guides/deadlines/) guidance.
Explicit presence follows the [Protocol Buffers field-presence guide](https://protobuf.dev/programming-guides/field_presence/).
