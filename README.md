# Tutor Matcher

The [accepted requirements and constraints](docs/requirements.md) define the 10 November delivery for the four-person team. See the [ADR index](docs/adr/README.md), [glossary](GLOSSARY.md), [original PDFs](docs/sources/README.md), and [reference monolith](https://github.com/Azther0z/tutor-matcher).

The [accepted system design](docs/system-design.md) defines the target services, database ownership, recovery, flows, and deployment. The [interface contracts](contracts/README.md) define the target REST, gRPC, events, authorization and recovery behavior. The target uses 20 private domain RPCs, 86 public REST operations and RabbitMQ. Implementation is in progress; this is not a completed nine-use-case delivery.

The [four-member implementation handoffs](docs/handoffs/README.md) assign parallel work to Saint, Ideal, Santa and P, with UI ownership, integration checkpoints and evidence responsibilities.

## Current implementation: platform and identity

Saint's slice adds a root npm workspace, TypeScript Auth, shared authorization/validation adapters and a Next.js identity shell. Traefik OSS 3.7.17 is the public gateway; the earlier custom Node/Express Gateway is removed. Auth owns PostgreSQL sessions, capabilities, restrictions, outbox work and private ForwardAuth actor issuance. Other owners' business implementations remain separate work.

Use Node.js 22 or newer and run `npm ci` from the repository root. Follow [platform setup and deployment](docs/platform.md) for runtime configuration, local Compose, hosted templates, CI and restoration. See [implementation evidence](docs/evidence/saint/README.md) for checks actually run and remaining acceptance work. Use `npm run typecheck`, `npm run lint`, `npm test`, `npm run contracts` and `npm run build` for local quality checks.

Root Compose defaults to the identity slice. Its `target` profile requires the other owners' real images; it does not use test doubles as business services. Traefik routes the exact public methods and paths in OpenAPI under `/api`; the former demo paths without `/api` are not promised as aliases. See [gateway behavior](infra/gateway/README.md), [local and hosted platform setup](docs/platform.md), and [Traefik integration evidence](docs/evidence/saint/traefik-integration.md).

The earlier standalone backend demo (Express gateway, Consul, legacy paths, k6 results) is preserved in [docs/history/legacy-demo.md](docs/history/legacy-demo.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `services/` | Backend owner services, one npm workspace each: auth, tutor, review, wallet and notification in TypeScript, plus the legacy JavaScript booking service pending migration |
| `apps/web/` | Next.js UI and Playwright end-to-end tests |
| `packages/shared/` | Shared authorization, validation, gRPC and runtime-environment helpers |
| `contracts/` | Target REST, gRPC and event contracts; `contracts/legacy/` holds the old Booking protobuf |
| `infra/docker/` | Workspace Dockerfile and container bootstrap scripts used by Compose |
| `infra/gateway/` | Traefik route allowlist and gateway guide |
| `infra/hosted/` | Docker Swarm stack template, hosted examples and deployment guide |
| `compose.yaml` | Local development stack |
| `scripts/` | Local runner, manifest checks, smoke tests and route generation |
| `tests/` | Cross-service gateway, broker-provisioning and runtime tests |
| `loadtest/` | k6 measurements and saved results |
| `postman/` | Target public collection; `postman/legacy/` holds the earlier demo collections |
| `docs/` | Requirements, design, ADRs, evidence, handoffs and `history/` |
