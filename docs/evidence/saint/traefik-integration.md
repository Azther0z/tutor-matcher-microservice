# Traefik and Saint identity integration evidence

Date: 8 November 2026, Asia/Bangkok. This record covers the local integration of Saint's implementation checkpoint `6454891` with PR4 head `23db6f8`, on `codex/saint-identity-on-traefik`. It does not describe a deployed environment. Earlier Express/Consul results remain [historical evidence](README.md).

## Verified boundary

Traefik OSS 3.7.17 is the HTTP gateway. The generated configuration maps 86 public method/path operations under `/api` to 92 concrete routers, including seven fixed owner-status polling routes, with matching unavailable fallbacks and one private authorization router. The generator checks the OpenAPI and operation inventory together. This is route coverage, not implementation of every owner or business use case.

For protected requests, Auth's private `GET /internal/gateway/authorize` verifies Gateway workload proof, current session/account state, required capability and request metadata. It issues a 60-second RS256 actor assertion with logical issuer `api-gateway`. The signing key stays in Auth. Traefik strips caller identity/proof headers, preserves the browser token only for authorization, and forwards the signed assertion with Gateway workload Authorization to the owner. The loopback-only authorization listener trusts forwarding metadata only from loopback; the public listener does not trust caller forwarding headers. Owners still validate request bodies and resource ownership.

Auth application errors use the shared JSON Error DTO. Native ingress 404/502/503/504 responses can be plain text without a UUID request ID; the public OpenAPI records transport failures. Clients retain the original mutation key when recovering an uncertain outcome. Anonymous request IDs are handled by owners; protected request IDs are normalized by Auth before signing. No UUID plugin is required.

Public REST remains 86 operations, private REST eight (retained introspection plus seven owner polls), and private domain gRPC 20. ForwardAuth and private health are infrastructure interfaces outside that inventory.

## Local verification

All accounts, credentials, provider messages and database contents used below were synthetic. PostgreSQL 16 and RabbitMQ ran in disposable rootless Podman containers. Tests used separate databases for Auth/unit, integrated HTTP, browser and broker checks.

| Check | Result and practical scope |
| --- | --- |
| Clean dependency installation | `npm ci --ignore-scripts --no-audit --no-fund` passed after removing the Node gateway workspace. |
| Type checks, production builds and lint | Shared, Auth and Next.js builds pass; lint has zero errors and 41 `no-explicit-any` warnings. |
| Contract and collection checks | 114 operations, 129 shared schemas, 21 event variants, 86 target collection requests, schema/money/time fixtures and all 20 protobuf methods pass the existing validators. |
| Deterministic route configuration | OpenAPI/inventory generator and `--check` pass. The real Traefik binary loads the generated configuration. |
| Auth/shared tests | Nine shared tests and two Auth suites pass without database skips. Auth covers sessions, account lifecycle, durable operations, gRPC permissions, private admission, capability/resource failures and mounted-file configuration. |
| Mounted-file runtime | Separate processes prove database configuration loads before Pool creation, supported values load from synthetic files, and ambiguous/empty values and mismatched signing keys fail. |
| Real identity HTTP flow | `npm run test:integrated` passes 72 status/schema/invariant checks through real Traefik, Auth and PostgreSQL. Includes signup/login, revisions, replay and operation polling, password changes/reset, session revocation, restriction/restoration, deactivation and permanent bans. |
| Browser journeys with intercepted APIs | All 14 Playwright tests pass. These test UI behavior against explicit response stand-ins. |
| Real browser integration | `npm run smoke:browser` passes through Chrome, Next.js, Traefik, Auth and PostgreSQL without API interception. Signup, profile save, ETags, password change, old-password rejection and fresh login work. Four desktop/mobile screenshots were regenerated and visually inspected. |
| Broker interruption/recovery | `npm run smoke:outbox` passes: committed reset work survives broker outage, publishes with confirms/mandatory routing after recovery, and is not republished after restart. The harness acknowledges messages; Notification delivery is not claimed. |
| Docker socket proxy | The pinned proxy image passes discovery-read and write/secrets/config-denial checks against a synthetic Unix socket. No actual engine socket is exposed to this test. |
| Postman routing simulation | A local `postman simulation run ... --no-history` echo probe passes through real Traefik for target public discovery: `/api` is stripped, a spoofed actor is removed, and workload Authorization is present. This uses a controlled Auth responder and private health adapter, not an owner business implementation. |
| Local application images | Auth image `717a8a28ba3c` and web image `fa6970d96cf1` build locally with production dependency smoke checks. Gateway uses the official Traefik image; no Node gateway image is built. No image was published. |
| Compose, Swarm and bundle preparation | Docker Compose and stack parsers accept the templates using synthetic interpolation, without deployment. `prepare-hosted` exports the canonical `infra/hosted/compose.yaml`, route config and required helpers into a new ignored local directory. |
| Native Docker/Swarm discovery, header boundaries, health changes, task changes and retries | All 21 gateway checks pass with the real Traefik binary and controlled discovery/HTTP APIs. Covers protected/public headers and forwarding metadata, body isolation, fixed owner polling, host bypass, task add/remove, unhealthy replicas, cached routing during API outage, zero-task/Auth outage recovery, bounded GET disconnect/502 retries and no mutation retry. This does not prove a real Docker or Swarm deployment. |

The gateway test harness waits for public health and an anonymous protected request returning 401 before starting identity tests. This checks both entrypoints and avoids confusing authorization-route startup with a failed business operation.

## Remaining delivery work

A full Compose startup with all owner images and a real Swarm manager/overlay were not tested. Peer owner implementations, all nine business journeys, live provider delivery, throughput, hosted backup/restore and course acceptance remain separate evidence. No homelab resource, firewall, ingress or capacity change was made.

Hosted references remain the current homelab architecture `e1f8c88` and GitOps `841efb4`. The existing monolith origin on port `3333` stays reserved; port `3334` is a review candidate, not verified free or deployed. Registry publication, mounted secret provisioning, GitOps promotion and hosted rollout require their existing authorization gates.
