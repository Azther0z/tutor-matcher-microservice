# Internal Traefik qualification evidence

Date: 2026-11-11

## Runtime qualification

- `node scripts/qualify-internal-traefik-compose.mjs` — passed the isolated Compose fixture. Coverage included persistent HTTP and gRPC distribution, authentication, task scaling, separate HTTP and gRPC readiness, zero backends, Docker API discovery outage with task replacement, and recovery. Fixture resources were removed.
- `DOCKER_CONTEXT=desktop-linux INTERNAL_TRAEFIK_SWARM_QUALIFY=1 node scripts/qualify-internal-traefik-swarm.mjs` — passed on the approved single-node local Swarm. All five checkpoint groups passed: persistent HTTP/gRPC distribution with auth and readiness; task addition/removal; zero-backend failure and recovery within 15 seconds; cached endpoint health and replacement discovery during Docker API outage; and new-call recovery through the surviving proxy within 15 seconds. The test stack, services, and networks were removed, and the local Swarm was returned to inactive state.
- `node scripts/qualify-internal-traefik-swarm.mjs --render-only` — passed without changing Swarm state.

An initial Swarm fixture run failed at task scale-up because it set `--providers.swarm.watch=false`. Traefik v3.7.17 creates the Swarm refresh ticker only when watch is enabled; the fixture flag was removed to use the provider default and match hosted configuration. The subsequent approved Swarm run passed.

These synthetic fixtures qualify the routing and failure behaviors exercised above. They do not qualify the full application, a hosted deployment, or a multi-node Swarm.

## Repository checks

- `node scripts/check-manifests.mjs` — passed local and hosted manifest parsing.
- `node scripts/generate-internal-traefik-routes.mjs --check` — passed.
- `node --test tests/internal-traefik.test.cjs` — passed, 2 tests.
- `npm run typecheck` — passed.
- `node contracts/check-proto.cjs` — passed all 7 protos and 20 methods.
- `npm test -w @tutor-matcher/shared` — passed all 14 tests, including standard gRPC health wire calls, dependency failure and shutdown behavior.
- `npm run contracts` — initially stopped on missing offline dependencies. After downloading the same pinned dependencies, contract validation passed its gRPC fixture checks and stopped on the pre-existing stale `docs/handoffs/p.md` assertion. Contract inputs and that handoff file are unchanged from the fetched base. The proto codec check above was run separately.
- `npm run lint` — failed on the existing missing `react-hooks/exhaustive-deps` rule at `apps/web/features/booking/bookings.tsx:30`. The two new health-helper `any` warnings seen in that run were subsequently removed; service typechecks passed afterward.
- Wallet tests were attempted: 6 passed, 84 skipped, and 5 suites failed during setup because PostgreSQL at `127.0.0.1:55433` was unavailable. This is not a passing database qualification.
