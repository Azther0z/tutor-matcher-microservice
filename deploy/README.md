# Hosted Docker Swarm stack

[`compose.yaml`](compose.yaml) is the canonical hosted stack template for the integrated platform. It uses Traefik OSS 3.7.17 with Swarm task discovery through a restricted Docker API proxy. Traefik uses the official image; there is no custom Node/Express gateway image or separate Consul registry. The root [`compose.yaml`](../compose.yaml) is the local development stack.

The identity implementation is local work. This guide is a deployment review template, not evidence of a hosted rollout. The existing homelab sources are recorded in [homelab references](../docs/evidence/saint/homelab-references.md): architecture revision [`e1f8c88`](https://github.com/azther0z-homelab/homelab-architecture/tree/e1f8c88a09793d1474d03d41d56647946004e1bf) and GitOps revision [`841efb4`](https://github.com/azther0z-homelab/homelab-gitops/tree/841efb4a3c312326ceb2856dc4532433982b4879). Those references document the existing Swarm, Doco-CD, private registry, host-level Cloudflare Tunnel and Access setup. No server, registry, GitOps or Cloudflare write was made for this stack.

## Inputs and prerequisites

- A supported Swarm manager and reviewed immutable images for Auth, the web UI and each of the six other business owners. Traefik and the restricted socket proxy use pinned images. Build application images from repository-root context. Image publication and promotion are separate release actions.
- The existing Doco-CD reconciler and one reviewed application directory under the existing GitOps repository. Do not add a second reconciler or change its polling configuration.
- The existing monolith route on host port `3333` stays reserved. Host port `3334` is only a candidate origin for the new web service; it is not deployed or known to be free. Confirm host capacity, origin firewall, hostname and placement before any rollout.
- One intended storage node and adequate persistent storage for PostgreSQL, MongoDB and RabbitMQ, with an approved isolated backup/restore procedure. A single storage host is not high availability.
- An approved HTTPS entry and firewall policy. The current host-level Cloudflare Tunnel remains the ingress path; Cloudflare DNS/tunnel routing and Access policy are separate changes. The candidate app origin must not expose databases, broker management, owner services, private Auth endpoints or the Docker API.
- Encrypted runtime configuration and mounted external secrets supplied through the existing SOPS/age workflow. Auth signing keys and the Gateway workload credential use mounted files. `GATEWAY_WORKLOAD_CREDENTIAL_FILE` is loaded by the local runtime setup; its value must not appear in Traefik configuration, logs or Git.

The stack uses distinct hosted storage names. Existing volumes are not migrated automatically. Initialization values do not change credentials in already initialized stores. Reuse or migration requires a reviewed data and credential plan; never delete persistent volumes to resolve an authentication failure.

## Review and rollout

Review the rendered stack without printing runtime secret values. Confirm the service images, mounted files, secret ownership, Docker API allowlist, manager placement, overlay membership, exposed web origin, persistence and health checks. Validate `deploy/compose.yaml` with the Docker stack parser and run the current [gateway integration checks](../docs/evidence/saint/traefik-integration.md) before asking for a hosted rollout.

After separate release and server authorization, the existing deployment owner can apply the reviewed manifest through Doco-CD. Swarm does not wait for Compose `depends_on`; services must restart safely when a dependency is not ready. Inspect task convergence before exercising login, session revocation, account settings, protected owner routes, durable business workflows, notifications, restart persistence and isolated restoration. Use synthetic accounts and funds.

Traefik keeps previously discovered routes when the Docker API is temporarily unavailable, while active health checks continue. A restarted gateway needs the Docker API to discover routes again; tasks created during an API outage remain unknown. Record the tested revision, host and results. Do not promise zero errors during detection or permanent service without a manager API.

## Rollback and remaining work

Use the existing deployment owner to restore reviewed immutable image and configuration revisions. Application rollback does not roll back schema or business data. Keep the local Compose path ready if hosted access is unavailable.

Before a hosted rollout, verify host capacity, candidate origin availability, storage placement, trusted image publication, owner migrations, encrypted runtime inputs, HTTPS/Access audience, firewall rules and isolated restoration. The synthetic local tests do not establish real Swarm behavior, Cloudflare routing, or host policy. No server initialization, node labeling, secret provisioning, image publication, GitOps promotion or deployment was performed here.
