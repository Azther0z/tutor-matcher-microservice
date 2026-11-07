# Runtime needs for Saint (compose, Consul, secrets, lockfile)

Everything here is what Wallet and Notification need to run. None of it has been applied: `compose.yaml`, `docker/**` and the root lockfile are Saint's.

## Ports and stores

| Service | HTTP | gRPC | Store | Consul |
| --- | --- | --- | --- | --- |
| wallet-service | 4003 | 50054 (server) | PostgreSQL `wallet_db` | HTTP check on `/health`, metadata `grpc_port=50054` |
| notification-service | 4007 | none (client only) | MongoDB `notification_db` | HTTP check on `/health` (replaces the old TTL check) |

`/health` returns 200 when ready and 503 otherwise, with no diagnostics. Wallet is ready when PostgreSQL answers; a RabbitMQ outage does **not** make it unready (committed outbox work waits). Notification is ready only when MongoDB answers **and** the queue topology is installed and consuming.

## Databases

- `docker/postgres-init.sql` already creates `wallet_db`. Wallet applies its own migrations at start (`migrations/001_wallet_target.sql`, guarded by an advisory lock so replicas do not race).
- **MongoDB must be a replica set.** Notification accepts events in multi-document transactions, which a standalone `mongo:7` rejects. Start it with `--replSet rs0`, run `rs.initiate()` once, and use `MONGO_URI=mongodb://mongo:27017/?replicaSet=rs0`. The same applies to every other Mongo owner that uses transactions.

## Environment variables

Both services have a complete `.env.example`. Secrets come from SOPS/age, never from the example files.

| Variable | Wallet | Notification | Notes |
| --- | --- | --- | --- |
| `GATEWAY_PUBLIC_KEY` | required | required | RS256 public key for the actor assertion |
| `WORKLOAD_CREDENTIALS` | required | required | JSON `caller -> credential` (>= 16 chars). Wallet needs `gateway` and `booking`; Notification needs `gateway` |
| `WALLET_WORKLOAD_CREDENTIAL` / `NOTIFICATION_WORKLOAD_CREDENTIAL` | optional | optional | Credential each presents to Auth/Booking (their registry allowlists must contain `wallet` / `notification`) |
| `PAYOUT_FINGERPRINT_KEY` | required (>= 32 chars) | | Never log it; rotating it changes duplicate detection |
| `DEMO_MODE` | `true` for the course deployment | | Required for the simulated provider controls, in a production build too |
| `RABBITMQ_URL`, `RABBITMQ_USER` | required | `RABBITMQ_URL` | Wallet connects as broker user `wallet`; Notification as `notification` |
| `AUTH_GRPC_URL`, `BOOKING_GRPC_URL`, `TUTOR_GRPC_URL` | yes | Auth, Booking | `service:port`; use the deployment DNS name, never the Consul HTTP port |
| `CONTRACTS_DIR` | image default `/app/contracts` | same | The images copy `contracts/schemas` and `contracts/grpc` |

## RabbitMQ

Import `notification-service/deploy/rabbitmq-definitions.json` (exchange `tutor-matcher.events`, queue `notification.events.v1`, binding `v1.#`, dead-letter exchange `tutor-matcher.dead` and queue `notification.events.v1.dead`). Create one broker user per producer named exactly `auth`, `tutor`, `booking`, `wallet`, `review`, `messaging`, and `notification`. The definitions give each producer `write` on the exchange only, restricted by topic permission to its own `v1.<producer>.` prefix. Producers are **not** allowed to declare anything.

Notification installs the same topology itself at startup (idempotent) and refuses to report ready before it succeeds. Wallet publishes with `mandatory` and publisher confirms and never declares the exchange.

The legacy queue `notification.events` and the old Notification code are gone from this branch; remove the queue after migration.

## Gateway expectations

- Owners serve public operations at their public path under `/api/...` and read status at `/internal/v1/<owner>/operations/{id}`.
- Calls carry `Authorization: Bearer <gateway credential>` and `X-Actor-Context` (RS256, `iss=api-gateway`, `aud=tutor-matcher-internal`, 60 s). An unsigned `X-User-Id` is ignored.
- `Idempotency-Key`, `If-Match` and `X-Request-Id` pass through unchanged.

## Dependencies and lockfile

ADR-0004 wants one root workspace lockfile. Until it exists, each service keeps its own `package-lock.json` (regenerated with `npm install`). Production dependencies to fold into the root:

- Wallet: `@grpc/grpc-js`, `@grpc/proto-loader`, `protobufjs`, `ajv`, `ajv-formats`, `amqplib`, `dotenv`, `express@5`, `jsonwebtoken`, `pg`
- Notification: the same except `pg`, plus `mongodb`

Dev: `typescript`, `tsx`, `vitest`, and the `@types/*` packages in each `package.json`. The Dockerfiles build from the repository root context (`docker build -f wallet-service/Dockerfile .`) and are **untested**.

## Duplicated code to consolidate

`errors.ts`, `auth.ts`, `contracts.ts`, `time.ts`, `ids.ts` and `grpc/proto.ts` are near-identical in both services (a service cannot import across Docker contexts). They are good candidates for the shared `packages/contracts` if Saint introduces it.
