# Runtime needs and platform integration (Traefik, secrets, workspace)

Wallet and Notification run on the shared platform from the Traefik/Auth stack: Traefik discovers them by label, the root workspace lockfile is the install authority, and both images build from `infra/docker/workspace.Dockerfile`. This page lists what each service expects and what is still unverified. Nothing here was run against Docker, Swarm, Traefik or RabbitMQ.

## Ports and stores

| Service | HTTP | gRPC | Store | Traefik health check |
| --- | --- | --- | --- | --- |
| wallet-service | 4003 | 50054 (server) | PostgreSQL `wallet_db` | `/health` |
| notification-service | 4007 | none (client only) | MongoDB `notification_db` | `/health` |

`/health` returns 200 when ready and 503 otherwise, with no diagnostics. Wallet is ready when PostgreSQL answers; a RabbitMQ outage does **not** make it unready (committed outbox work waits). Notification is ready only when MongoDB answers **and** the queue topology is installed and consuming. Services do not register anywhere; Traefik finds them through opt-in labels.

## Public paths

Traefik strips `/api` (`strip-api-prefix`) before forwarding, so both services serve public operations at un-prefixed paths such as `/wallet` and `/notifications`. The private `/internal/v1/<owner>/operations/{id}` status read is reached through the fixed `replace-operation-prefix` route. Calls carry `Authorization: Bearer <gateway credential>` and `X-Actor-Context` (RS256, `iss=api-gateway`, `aud=tutor-matcher-internal`, 60 s). Verification uses `@tutor-matcher/shared`, so it requires the same claims Auth signs, including `userId`.

## Environment variables

Names follow `compose.yaml`. Any secret may instead be a mounted file through `<NAME>_FILE`; configuring both fails at startup.

| Variable | Wallet | Notification | Notes |
| --- | --- | --- | --- |
| `ACTOR_ASSERTION_PUBLIC_KEY` | required | required | Auth's RS256 public key |
| `GATEWAY_WORKLOAD_CREDENTIAL` | required | required | Inbound credential Traefik presents (>= 16 chars) |
| `BOOKING_WORKLOAD_CREDENTIAL` | required | | Inbound credential for Booking's gRPC calls |
| `WALLET_WORKLOAD_CREDENTIAL` / `NOTIFICATION_WORKLOAD_CREDENTIAL` | outbound | outbound | What each presents to Auth/Booking/Tutor |
| `PAYOUT_FINGERPRINT_KEY` | required (>= 32 chars) | | Never log it; rotating it changes duplicate detection |
| `DEMO_MODE` | `true` for the course deployment | | Enables simulated provider controls, in a production build too |
| `DATABASE_URL` / `MONGO_URI` | PostgreSQL | MongoDB | Owner-only credentials from the platform init scripts |
| `RABBITMQ_URL` | broker user `wallet` | broker user `notification` | |
| `AUTH_GRPC_URL`, `BOOKING_GRPC_URL`, `TUTOR_GRPC_URL` | yes | Auth, Booking | `service:port` DNS names |

## RabbitMQ

Auth declares the versioned topology (identical arguments to Notification's, so both may assert it) and keeps the bootstrap `auth` user. `infra/docker/rabbitmq-provision.mjs` then creates one restricted user for every producer whose `RABBITMQ_<NAME>_PASSWORD` is supplied, using the permissions in `services/notification-service/deploy/rabbitmq-definitions.json` (write only to `tutor-matcher.events`, only under `v1.<producer>.`, no declare rights). Local Compose runs it as the one-shot `rabbitmq-provision` job. In Swarm it is a rollout step before owner workers start: run it once with the same variables. Tutor, Booking, Review and Messaging owners add their own password variable to be provisioned. The script is tested against a stub management API only.

Verified against a real RabbitMQ 4.4.0 by `npm run smoke:p-broker` (see the evidence README): confirms with `mandatory`, the permission and topic-permission regexes, and `user_id` verification. Wallet cannot do a passive queue check, so its broker check is connectivity only. The script declares the topology itself because topic permissions need the exchange to exist. Not run on the pinned `4.3.6` image.

## Dependencies

No per-service lockfiles. `@tutor-matcher/wallet-service` and `@tutor-matcher/notification-service` are workspaces, so their dependencies (including `vitest` and `mongodb`) live in the root `package-lock.json`. The Docker dependency-copy layer already lists both manifests.

## Duplicated code to consolidate

`errors.ts`, `contracts.ts`, `time.ts`, `ids.ts`, `secrets.ts` and `grpc/proto.ts` are near-identical in both services. Actor-assertion verification now delegates to `@tutor-matcher/shared`, but the services keep their own richer `AppError` (it carries gRPC status and idempotent-replay durability), which `shared` does not model. Folding the rest into `shared` is a follow-up for the platform owner.
