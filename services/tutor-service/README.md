# Tutor service

Tutor owns application drafts and submitted versions, approval decisions, public listings, subjects and discovery. It uses its own MongoDB `tutor_db`. Public routes use `/profiles`, `/admin/tutor-requests` and `/discovery` behind the gateway `/api` entry. The old JavaScript demo endpoints are not registered by the TypeScript entry point.

Build from the root with `npm run build -w @tutor-matcher/shared` and `npm run build -w @tutor-matcher/tutor-service`. Start with `npm run start -w @tutor-matcher/tutor-service`.

## Runtime

| Variable                        | Meaning                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| `MONGO_URI`                     | Owned Tutor database connection, using a persistent replica set     |
| `PORT`                          | HTTP port, default 4001                                             |
| `GRPC_PORT`                     | Catalogue gRPC port, default 50053                                  |
| `GATEWAY_WORKLOAD_CREDENTIAL`   | Gateway workload bearer credential                                  |
| `ACTOR_ASSERTION_PUBLIC_KEY`    | Gateway admission verification key                                  |
| `TUTOR_WORKLOAD_CREDENTIAL`     | Tutor outbound workload credential                                  |
| `AUTH_WORKLOAD_CREDENTIAL`      | Authorized Auth caller for eligibility                              |
| `BOOKING_WORKLOAD_CREDENTIAL`   | Authorized Booking caller for catalogue and eligibility             |
| `WALLET_WORKLOAD_CREDENTIAL`    | Authorized Wallet caller for eligibility                            |
| `MESSAGING_WORKLOAD_CREDENTIAL` | Authorized Messaging caller for eligibility                         |
| `AUTH_GRPC_URL`                 | Auth collaboration server, default auth-service:50051               |
| `BOOKING_GRPC_URL`              | Booking availability server, default booking-service:50052          |
| `REVIEW_GRPC_URL`               | Review rating server, default review-service:50055                  |
| `REVIEW_HTTP_URL`               | Public Review projection server, default http://review-service:4005 |
| `RABBITMQ_URL`                  | Dedicated Tutor publisher account and broker address                |
| `CONTRACTS_GRPC_DIR`            | Optional deployment-specific contract directory                     |

Runtime file-backed variables use the existing shared loader. No browser token is forwarded to peers. Public Review composition calls its read-only public `/reviews` projection; all private domain collaborations use the versioned protobuf contracts.

`npm run migrate -w @tutor-matcher/tutor-service` installs owner indexes. Startup does this too and rejects standalone MongoDB. It never reads another service's database. A single account document serializes its submissions, listing and owned subjects. MongoDB transactions commit that document with idempotency records, grants and event work. The transaction does not contain a remote call.

Approval records a stable grant command and returns 202 until Auth confirms it. A worker retries the original grant identity after failures, including after the approving browser assertion expires. Listing revisions preserve the existing approved version and publication state. Public DTOs are built from the approved version and never include verification documents.

Catalogue RPCs do not call Booking. Search batches real rating and availability collaborators before filtering and pagination. A collaborator failure stays an explicit failure. Ratings are genuinely empty only when Review returns a successful empty summary. All RPCs use workload credentials, UUID trace IDs, explicit deadlines, presence-aware decoding and schema validation.

Search uses the reference recommendation weights. Without preference areas, the score is 0.6 times normalized rating plus 0.4 times next-availability freshness. With `preferredLearningAreas` supplied from the signed-in student's profile, it is 0.5 area relevance plus 0.3 rating plus 0.2 freshness. The optional comma-separated preference list is a ranking hint, not an authorization input. A missing completed-booking-count interface is represented as `classesTaught: null` and `classesTaughtAvailable: false`.

## Durable work

Each of the four Tutor notification variants is schema-validated and recorded in the business transaction. The publisher installs/checks the versioned queue topology and requires mandatory routing and publisher confirmation before marking work sent. It sets its authenticated RabbitMQ publisher username on messages.

Grant and outbox workers claim bounded leases with an increasing fence. Retries use exponential backoff from one second, with jitter and a 60-second cap. Ten failed attempts leave internal work in `NEEDS_ATTENTION`. It keeps the original immutable command/event.

After building, inspect and manually retry exhausted owner work with:

```sh
node services/tutor-service/dist/work.js grants <operation-id>
node services/tutor-service/dist/work.js outbox <event-id>
node services/tutor-service/dist/work.js grants <operation-id> retry
node services/tutor-service/dist/work.js outbox <event-id> retry
```

These commands use the configured owned database and must run with service-owner access. A manual retry retains history and identities, invalidates an old worker fence and permits ten further attempts. They do not add a public operation or allow an arbitrary caller to grant Tutor capability.

## Synthetic fixtures

`fixtures.ts` contains typed peer fixtures for service tests only. The production entry point always constructs real gRPC collaborators.

The owner seed entry point requires `DEMO_MODE=true`, existing active synthetic `.test` Student and Admin accounts, and `TUTOR_SEED_USERS` containing JSON pairs of `userId` and `adminUserId`. It saves a draft, submits it, approves it, performs the real Auth grant, publishes and creates a subject through Tutor's domain operations. Stable seed action keys make a repeated run recover the original work. It does not seed Booking slots or another owner's records.

Run the seed after building with `npm run seed -w @tutor-matcher/tutor-service`. Keep fixture preparation outside measured traffic.

## Checks

```sh
npm run typecheck -w @tutor-matcher/tutor-service
npm run test -w @tutor-matcher/tutor-service
```

Set `TUTOR_TEST_MONGO_URI` to an isolated local replica set to run the real Mongo transaction test. It creates and removes a uniquely named test database. Set `TUTOR_SOCKET_TESTS=1` to run the HTTP and gRPC wire tests. Without these variables those three integration checks are explicitly skipped.
