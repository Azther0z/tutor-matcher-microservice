# Target search measurement

For the baseline-led Load and Stress experiment comparing `1/1/1` and `3/1/1` Tutor/Booking/Review replicas, use [the discovery experiment guide](DISCOVERY.md). It finds usable baseline capacity, then compares both configurations at 80%, 100%, and 150% of that rate.

`tutor-search.js` and its original saved results describe the earlier demo and remain unchanged. Use `marketplace-search.js` for the target `/api/discovery/tutors` API.

## Prepare an isolated synthetic environment

Run the real Auth, Tutor, Booking and Review services with the reviewed gateway. Configure stable owner credentials, migrations and synthetic Admin access. Fixture preparation must finish before the measured interval.

Supply `SYNTHETIC_LOADTEST=true`, `BASE_URL`, and `LOADTEST_ADMIN_TOKEN` through the process environment. Optionally set `FIXTURE_OUTPUT` to a new JSON file. Run `npm run loadtest:prepare`.

Preparation creates 20 synthetic accounts through signup, saves/submits applications, approves them with Admin, waits for real Auth activation, creates subjects, publishes them and opens future slots through Booking's owner API. New slots use `If-None-Match: *`. It never edits another service's database or prints session tokens/passwords. The output contains only synthetic fixture IDs, its query marker and expected result count.

## Required final measurements

Use the fixture output's search marker as `SEARCH_QUERY`, and its count as `MIN_RESULTS`. Keep the catalogue, infrastructure, resource limits and complete collaborator calls identical across runs. Record the tested commit in `TESTED_REVISION` and the actual replica count in `TUTOR_REPLICAS`.

With one Tutor replica, run `TEST_TYPE=steady k6 run --summary-export <new-result-file> loadtest/marketplace-search.js`. The default is 50 virtual users for 30 seconds. Repeat with three actual Tutor replicas and a separate result file. Preserve the 0.5 CPU per-Tutor limit in the deployment configuration, and record the limits of the other services too.

Run `TEST_TYPE=stress k6 run --summary-export <new-result-file> loadtest/marketplace-search.js` as the distinct second type. It ramps demand through 10, 25, 50 and 100 users. Changing replica count alone is not a second type.

The script first checks that the prepared catalogue and collaborator-backed public DTOs are present. Its checks fail if discovery hides an error as empty success or leaks identification-document fields. It does not create users, subjects or slots during measurement. The target is p95 below 500 ms, errors below 1%, and complete response checks above 99%. An unmet threshold is a measured result to explain, not a reason to omit a collaborator.

Compare request throughput, p95, errors and capacity limits. Check Gateway, Tutor, Review, Booking and database pressure. Keep all historical results and clearly distinguish native diagnostics from actual deployed replica evidence.

## Local diagnostics recorded here

`results/ideal-2026-11-10/` contains separate steady and stress results from `MARKETPLACE_K6=1 npm run test:marketplace:integrated`. They use real Traefik, Auth, Tutor, Review, PostgreSQL, MongoDB and real gRPC transport. Booking availability and the Swarm discovery API are typed test fixtures. The processes run natively without per-service CPU caps; the first exploratory steady run also overlapped the workspace build. These are development diagnostics, not Q-03 acceptance or evidence of a one-versus-three replica comparison.

`environment.json` records the base revision, uncommitted source fingerprint, environment, collaborators, fixtures and exit codes. Each k6 summary has a matching text output. The Docker Compose measurement at the end of this file replaces these for the course.

## Docker Compose measurements (2026-11-10)

`results/compose-2026-11-10/` is the course measurement. It runs the full stack from `npm run demo` (Docker Compose, Traefik gateway, real Auth, Tutor, Review, Booking, Wallet, Notification, Messaging, PostgreSQL, MongoDB, RabbitMQ) with no fixtures. Tutor is scaled with `docker compose --env-file .env.demo -p <project> --profile target up -d --scale tutor-service=3 tutor-service`. Each Tutor replica is capped at 0.5 CPU by `compose.yaml`; every other service runs as one container. k6 and the stack share one 12 CPU laptop. Each run follows a 10 s warm-up. `environment.json` has the details and the runs that were excluded and why.

| Type | Tutor replicas | Requests | Throughput | p95 | Errors |
|---|---|---|---|---|---|
| Steady, 50 users, 30 s | 1 | 15,986 | 531 req/s | 172 ms | 0.00% |
| Steady, 50 users, 30 s | 3 | 36,611 | 1,218 req/s | 98 ms | 0.00% |
| Stress, ramp 10 to 100 users, 80 s | 1 | 40,438 | 505 req/s | 195 ms | 0.00% |
| Stress, ramp 10 to 100 users, 80 s | 3 | 77,203 | 965 req/s | 122 ms | 0.00% |

All runs pass p95 < 500 ms, errors < 1% and checks > 99%. Three replicas raise steady throughput by about 2.3 times and cut p95 from 172 to 98 ms. The stress run did not reach a limit at 100 users. Stress throughput is lower than steady for three replicas because the ramp spends part of its time at low user counts.

Load balancing: each replica's network receive bytes were read before and after each run. Steady split 33/33/33%, stress 33/33/33%, so Traefik spreads requests evenly.

Failover: `kill-one-replica` stops one of three replicas 10 s into a 30 s steady run. 23 of 23,061 requests failed (0.10%, HTTP 502 and 504 within about 5 s, until Traefik's 2 s health check removed the replica), and the run still passed its thresholds.

### Competing bookings

`k6 run loadtest/competing-bookings.js` (also `npm run loadtest:booking-race` as a plain Node script). 20 synthetic students book the same half-hour slot at once with different Idempotency-Keys, then one student sends the same request 10 times with the same key.

| Check | Result |
|---|---|
| Bookings that won the slot | 1 (threshold: exactly 1) |
| Refused with 409 | 19 |
| Server errors | 0 |
| Duplicate bookings from the 10 same-key requests | 0 |

The test cancels the bookings it created. Result: `booking-race-k6.json`; the earlier Node run is in `../live-2026-11-10/booking-race.json`.

### Auth signup under concurrency (fixed)

Signing up 20 accounts at once used to return HTTP 500 for 25% to 40% of requests. Cause: Auth hashes passwords with the pure JavaScript `bcryptjs` at cost 12, which runs on the event loop. Twenty hashes at once starved the PostgreSQL driver, whose connection timer (2 s, `services/auth-service/src/db.ts`) fired as `Connection terminated due to connection timeout`, and the shared error handler turned that into a generic 500. Auth now lets two hashes run at a time (`AUTH_MAX_CONCURRENT_HASHES`) and the shared error mapper returns a retryable 503 for pool timeouts instead of 500. After the change, 80 concurrent signups across four rounds all succeeded.

### Earlier runs

`results/live-2026-11-10/` is the same search test on a single-instance stack, `results/ideal-2026-11-10/` is the native diagnostic, and the three `.txt` files directly in `results/` come from the earlier Consul stack.
