# Gateway replacement validation

Validated locally on 8 November 2026, Asia/Bangkok. This is local implementation evidence, not a hosted rollout or the full delivery acceptance record.

| Check | Result and scope |
| --- | --- |
| Real Traefik 3.7.17, Swarm provider | Pass: 12 gateway scenarios, using the hosted manifest's service labels and controlled Docker API responses |
| Real Traefik 3.7.17, Docker provider | Pass: the same 12 scenarios using local Compose labels and container/event fixtures |
| Public/private routing | Pass: public registration/login and tutor reads, protected operations, unsupported methods, private Auth/internal/health paths and host-header routing bypass attempts |
| Authentication boundary | Pass: missing/invalid/expired/wrong-signature/wrong-algorithm/malformed-subject tokens, spoofed identity headers, database-sourced current identity, removed account, failed account lookup, unhealthy or absent Auth tasks |
| Forwarding and retry behavior | Pass: method/query/JSON forwarding, browser-token removal, bounded read retries after a lost response, no gateway write retry after a received request loses its response |
| Discovery and backend health | Pass: added/removed Tutor tasks, exclusion of an unhealthy replica, last-discovered configuration during Docker API outage, zero tasks returning 503 and recovery |
| Actual socket-proxy image | Pass: pinned `tecnativa/docker-socket-proxy:v0.5.0` under rootless Podman, connected only to a synthetic Unix socket; permitted discovery reads, denied write methods, secrets/config reads and hosted container inspection |
| Runtime mounted-file configuration | Pass: all four supported file values, unchanged inline configuration, missing/empty file failure and conflict rejection, using synthetic values |
| Manifest parsing | Pass: `docker compose config --quiet` and `docker stack config --skip-interpolation --compose-file deploy/compose.yaml`, with rendered output suppressed |
| Target contract consistency | Pass: existing offline validator checks 114 unique REST/gRPC operations, 129 schemas, 21 event variants, 82 schema fixtures, nine money/time cases, 40 gRPC message fixtures, 12 invalid gRPC fixtures, and the 86-request target collection |
| Source/document checks | JavaScript/shell syntax, Git whitespace, YAML parsing and local Markdown file links checked |

Postman simulation request events show that business requests reached the stand-in. The real Auth handler uses a synthetic account lookup; neither PostgreSQL nor actual login/payment/booking transactions were exercised. The mock observes routing and does not claim business correctness. The simulation runs locally with `--no-history`; no Postman account/workspace resources were created or published. CLI 1.77.0 does not expose the skill's `postman status` command; no workspace-binding claim is made.

The local Docker CLI has no reachable daemon at its default socket. No real Swarm manager, overlay, service image rollout, mounted runtime credentials, persistent data, HTTPS entry, backup/restore or throughput was tested. Podman was used only for pinned test images, binary extraction and the synthetic socket-proxy check. The socket test's SELinux setting is test-specific; it does not change host policy or the deployed manifest.

The larger target's sessions, bans, capabilities, signed actor admissions, per-workload credentials, owner-operation routing and `/api` inventory remain implementation work. Old Express/Consul load-test outputs and rendered deployment assets remain historical evidence. See [gateway verification](README.md#verification) for repeatable commands and [hosted prerequisites](../deploy/README.md) before any authorized rollout.
