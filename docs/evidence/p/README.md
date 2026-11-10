# P evidence: Wallet, Notification and financial recovery

Owner: P (Piranat Wadlom, 6732031621). Scope: [P handoff](../../handoffs/p.md). Written 7 November 2026, Asia/Bangkok.

This records what was built, how to repeat it, and, just as important, what was **not** run. Local results are separate from hosted results; there are no hosted results yet.

| Item | Value |
| --- | --- |
| Baseline | Stacked on `codex/saint-identity-on-traefik` (PR #5), which is itself stacked on `codex/traefik-swarm-gateway` (PR #4). Both are open and unmerged; merge #4, then #5, then this |
| Branch | `feat/p-wallet-notification` |
| Node | v24.15.0 locally. The Dockerfiles use `node:22-alpine`, which has **not** been built or run |
| PostgreSQL used for tests | 18.6 (throwaway local cluster). `compose.yaml` pins `postgres:16-alpine` |
| MongoDB used for tests | 8.2.7, single-member replica set. `compose.yaml` pins `mongo:7` and is a standalone server today |
| RabbitMQ / Traefik / Docker | **not available locally; nothing was run against them** (the Docker daemon is not running) |

## What was delivered

| Area | Result |
| --- | --- |
| `wallet-service/` | Rewritten in TypeScript (ADR-0002). REST on 4003, `WalletFinanceService` gRPC on 50054, PostgreSQL migration `001_wallet_target.sql`, transactional outbox publisher, earnings-clearing worker. 24 REST operations incl. demo controls and the owner status read |
| `notification-service/` | Rewritten in TypeScript. Durable RabbitMQ consumer on the versioned topology, transactional acceptance, admin audience resolution, preference-aware dispatch, simulated receipts, REST on 4007 (it previously had no HTTP port) |
| `notification-service/deploy/rabbitmq-definitions.json` | Exchange, queue, binding, dead-letter path and per-producer publish permissions for Saint to integrate |
| UI (`web/features/{wallet,notification}`, routes, `web/e2e/finance`) | Built on Saint's shell: wallet, top-up, transactions, payout accounts, payouts, disputes, admin disputes, demo provider controls, notification preferences and receipts. Verified in a real browser against **mocked** API responses only; not yet against the running backend through Traefik |

## Repeat the checks

```sh
# From the repository root: npm ci && npm run typecheck && npm run lint
# Wallet: needs PostgreSQL. WALLET_TEST_DATABASE_URL defaults to postgres://tutor@127.0.0.1:55433/wallet_test
npm test -w @tutor-matcher/wallet-service
# Notification: needs a MongoDB replica set. TEST_MONGO_URI defaults to mongodb://127.0.0.1:55434/?replicaSet=rs0&directConnection=true
npm test -w @tutor-matcher/notification-service
```

The tests `DROP SCHEMA public` in the Wallet test database and clear collections in `notification_test`. Point them only at disposable databases.

## Results (local, 7 November 2026)

| Check | Result |
| --- | --- |
| Wallet type check and build | pass |
| Wallet tests (real PostgreSQL) | **90 pass** across 7 files: financial rules and races, HTTP behaviour, gRPC server, outbox recovery, contract fixtures and event conformance, client adapters, runtime configuration, and the un-prefixed gateway path contract |
| Notification type check and build | pass |
| Notification tests (real MongoDB transactions) | **42 pass** across 5 files: durable acceptance, dispatch, REST, consumer ack decisions, client adapters, runtime configuration, gateway path contract |
| Wallet entrypoint smoke boot (after the platform rebase) | Built output booted with the actor key supplied as a mounted file (`ACTOR_ASSERTION_PUBLIC_KEY_FILE`), RabbitMQ unreachable and no Consul: migration applied, REST and gRPC listening, `/health` 200, unauthenticated `/wallet` 401. Notification was not boot-tested |
| Mutation check | Removing the financial-record row lock made 2 race tests fail, then restored. The race tests do detect a missing lock |
| Contract fixtures | The three `moneyCases`, four `cancellationBoundaryCases` and two `refundCapCases` in `contracts/examples/cases.json` run against the real service |
| Event conformance | Every event Wallet enqueues across top-up, payout, cancellation refund, dispute open/approve/reject and clearing validates against all 21 variants of `events.v1.json`, and contains no bank-number material |

### Handoff acceptance list

| Acceptance item | Status |
| --- | --- |
| Top-up success, failure, unknown, repeated outcomes **through the UI** | Backend proven; UI journeys pass in the browser against mocked responses (success, failure, unknown, polling). Not run end to end |
| Tutor-only payout accounts, masking, default, cross-user rejection | Proven by HTTP tests; UI add/default/remove with revision preconditions passes against mocked responses |
| Reservations prevent simultaneous spending and survive UNKNOWN | Proven (6 concurrent payouts of 400 against 1,000 yield exactly 2) |
| Lost charge response and late charge after close, **with Santa's Booking** | Proven against Wallet alone with a typed gRPC caller; **not** with the real Booking |
| 70% cancellation then full remaining dispute refund never exceeds payment | Proven (30.00 remainder; cumulative equals payment) |
| Dispute opening races clearing; late completion keeps the original deadline | Proven (12 concurrent open-versus-clear runs at the deadline; completion delivered 24 h late) |
| Admin inspects evidence, decides, sees remedy/audit **through the UI** | Backend proven with a Booking/Auth double; UI journey (evidence, mandatory reason, current revision, resulting status) passes against mocked responses |
| Five preferences, mandatory SYSTEM email, one effect per event/recipient/channel | Proven |
| Producer outage recovery, consumer crash/redelivery, failed-job retry, stale reminder suppression | Proven against doubles; **not** against a real RabbitMQ |
| Restored financial records resume without duplicate movements | **Not run** (no backup/restore exercise yet) |

## Not run, and why this matters

- **No RabbitMQ.** `AmqpBroker` (publisher confirms, `mandatory` return, `user_id`) and `EventConsumer` (topology, ack/nack) are exercised only through interfaces and a fake channel. The wire behaviour, the `topic_permissions` regexes and whether a passive queue check is allowed without `read` permission are unverified. Run the cases below once a broker is up.
- **No real peers.** Booking, Auth and Tutor are not implemented yet; every cross-service test uses a typed double or an in-process gRPC server built from the real `.proto` files.
- **Version skew.** Tests ran on PostgreSQL 18 and MongoDB 8; compose pins 16 and 7. Nothing used a version-specific feature, but this is unproven.
- **No load or scalability measurement.** Not part of P's handoff.

Cases to run when RabbitMQ exists (from `contracts/recovery.md`): business commit while the broker is down then publish; broker confirm with the queue absent (expect the mandatory return and a retryable outbox row); consumer killed after durable accept and before ack; two Notification workers sharing an expired lease.

## Open items

1. **UI against the real stack.** The pages exist and their browser tests pass (`web/e2e/finance`, 20 tests), but every response is mocked. Run the same journeys through Traefik, Auth and the real Wallet and Notification once the stack can start. The booking pages that link here (`/bookings/{id}`) belong to Santa and were not present to link-check.
2. **Integration.** Switch the test doubles to the real Booking and Auth at the first checkpoint, and pair with Santa on the operation identities ([contract-findings.md](contract-findings.md) items 3 and 4).
3. **Stack.** Rebased onto PR #5 (Consul removed, `ACTOR_ASSERTION_PUBLIC_KEY` and per-caller credential variables, `_FILE` secrets, un-prefixed paths behind Traefik's `strip-api-prefix`, workspace lockfile, shared actor verification, Compose build and broker provisioning). Not exercised through real Traefik with Auth admission.
4. **Deployment.** Compose wiring is done ([runtime-needs.md](runtime-needs.md)); the compose files parse (`npm run config:check`) but no image was built and nothing was started.
