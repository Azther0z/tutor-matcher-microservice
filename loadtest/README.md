# Target search measurement

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

`environment.json` records the base revision, uncommitted source fingerprint, environment, collaborators, fixtures and exit codes. Each k6 summary has a matching text output. The actual final course comparison remains pending until Santa's real Booking peer and a working container runtime are available.
