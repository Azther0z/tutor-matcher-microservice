# Platform implementation and integration

This guide covers the local Auth identity slice and the Traefik gateway, with the remaining business services selected through the target profile. Traefik OSS 3.7.17 is the HTTP gateway; there is no custom Gateway application image. A local identity-slice startup does not prove nine-use-case completion.

## Development

Use Node.js 22 or newer and `npm ci` at the repository root. The root `package-lock.json` is the install authority. Do not run independent installs or create lockfiles in service directories. Other owners add workspace scripts and request root dependency changes through the platform owner.

Run `npm run build -w @tutor-matcher/shared` before using the shared package. Use `npm run dev:auth` and `npm run dev:web` in separate terminals with runtime configuration provided through the approved environment mechanism. Run Traefik through the local Compose stack. The browser entry is `http://localhost:3000`; Traefik publishes port 8080 on loopback. The web production build includes its private Traefik URL; changing that URL requires rebuilding the web image.

For services running directly on the development host, set the Auth URL and `API_GATEWAY_URL=http://127.0.0.1:8080`; container service names belong to the Compose environment. Supply a development database connection through the environment. New owner workspaces must add their package manifest to the Docker dependency-copy layer when the shared root lockfile is updated.

The root quality commands are `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run contracts`, `npm run build` and `npm run test:browser`. Auth integration tests require `TEST_DATABASE_URL` pointing to a disposable PostgreSQL database. Never point them at an existing application database. Browser tests use synthetic identities. Tests against peer stand-ins are not proof that the other owners' services are implemented.

The earlier `npm run test:integrated` evidence exercised Auth through the custom TypeScript Gateway and is documented as historical. Current Traefik/Auth/owner integration checks are listed in the [integration evidence scaffold](evidence/saint/traefik-integration.md). `CONTAINER_CLI=podman npm run test:db` can create an isolated PostgreSQL container when Docker is unavailable.

## Local Compose

Root `compose.yaml` defaults to PostgreSQL, RabbitMQ, a restricted Docker API proxy, Traefik, Auth and web. It initializes the local Auth database with a distinct owner role. No database, broker, registry or owner service port is published. Traefik and web bind to loopback only.

Supply stable runtime credentials through approved process environment injection for any persistent environment. Required variable names appear in Compose; there are no default application secrets. Use URL-safe credentials in connection strings. Keep the JWT, reset-content encryption, replay fingerprint and actor-signing keys stable across restarts and backup restoration. Never print expanded `docker compose config` with real runtime values.

For a completely new disposable demo, `COMPOSE_PROJECT_NAME=<new-isolated-project> npm run local -- up` generates credentials in process memory and starts the foreground Compose session. It never writes or prints them. Do not use that mode for data that must survive container recreation: the generated values are not recoverable after the process exits. `npm run local -- restart` restarts existing containers without replacing their environment. Set the same project name for every command. `stop`, `ps`, `logs` and `down` are supported; `down` never includes `--volumes`. Dispose of synthetic storage only with a separately reviewed explicit command.

Wallet and Notification have workspace scripts (`npm run dev:wallet`, `npm run dev:notification`). Their tests need a disposable PostgreSQL (`WALLET_TEST_DATABASE_URL`) and a MongoDB replica set (`TEST_MONGO_URI`); never point them at an application database. Local Compose provisions their RabbitMQ users with the one-shot `rabbitmq-provision` job (`infra/docker/rabbitmq-provision.mjs`); in Swarm run it once before the owner workers start.

The `target` profile contains the remaining owner services and MongoDB replica set. It requires real owner-supplied images and migration procedures; `:pending` images deliberately cannot impersonate implemented services. Mongo initialization creates one read/write owner per database. PostgreSQL initialization is for new volumes only; existing legacy volumes require a reviewed migration, never a volume deletion workaround.

The initial RabbitMQ user is Auth's publisher. Auth ensures its required versioned queue binding before marking outbox work sent. P must provide the remaining per-producer broker users, permissions and Notification consumer topology before enabling the full target. Keep each producer's RabbitMQ username aligned with its event producer identity. A running broker alone is not notification recovery evidence.

Auth supplies an explicit `seed` command for stable synthetic identities. It requires DEMO_MODE and an injected AUTH_DEMO_PASSWORD, never overwrites a non-synthetic account, and does not grant Tutor capability to the candidate before Tutor approval. Run it inside the Auth workspace/container after migration with the approved runtime environment. Do not print the password or turn seeding into an automatic startup reset.

The authoritative fixture list is `DEMO_ACCOUNTS` in [Auth's seed entry point](../services/auth-service/src/seed.ts). The fixed user IDs end in `0001` (Admin), `0002` (Student) and `0003` (Tutor candidate), under prefix `10000000-0000-4000-8000-00000000`. Other owners reference those identities through their own seeds or Auth APIs; they do not read Auth tables.

## Hosted review templates

The current [homelab references](evidence/saint/homelab-references.md) establish the existing Ubuntu Server, Swarm, Doco-CD, private registry and host-level Cloudflare Tunnel design. Use `homelab-architecture` and `homelab-gitops` as the current sources, rather than the historical shopping wiki. No live host check was performed in this implementation.

The canonical hosted stack is [`infra/hosted/compose.yaml`](../infra/hosted/compose.yaml). It uses published images, a private overlay network, persistent volumes and storage-node placement. It has no source builds or development mounts. Traefik is the official pinned image; do not build or publish a custom Gateway image. Every business service must have a reviewed image before the full target can run. The proposed web origin port `3334` is only a candidate for the existing host-level cloudflared daemon. The monolith's existing hostname and port `3333` stay reserved. The candidate hostname/port, origin firewall, capacity and storage-node placement remain release checks. TLS terminates at the existing Cloudflare edge; no new Caddy installation or public backend ports are needed.

The resource limits are initial protective defaults, not a measured capacity guarantee. Existing remote-development and Ignis limits already total 12 GB on the documented 16 GB host. Measure actual use and reserve an approved project budget before rollout; do not silently reduce other applications' allocations. Mongo initialization is a one-completion Swarm job; verify the installed engine and reconciler's job handling during the authorized rehearsal.

The manually triggered image workflow targets an explicitly approved trusted runner and the existing private registry through rootless BuildKit. It builds Auth, web and owner service images; Traefik uses its official pinned image and has no custom image. GitHub-hosted PR quality checks remain separate. This personal project repository's eligibility for the homelab runner must be approved before the release workflow can run. No runner access was changed and no image was published during implementation.

Publication does not change GitOps. After separate release authorization, use the existing homelab reusable custom-image promotion workflow to update only `services.<name>.image` under the approved app. That workflow writes GitOps main and can trigger Doco-CD; it is a deployment action, not just documentation publication. Other owners still supply their own tested images.

The hosted template is [`infra/hosted/compose.yaml`](../infra/hosted/compose.yaml), with helper assets under `infra/hosted/`. Review those files before proposing a copy under `homelab-gitops/apps/`; the existing root auto-discovery and reconciler remain authoritative. Do not add another poll or bootstrap another Doco-CD instance.

Supply the approved encrypted runtime environment and mounted secrets through the existing SOPS/age workflow. Auth's private signing key and service workload credentials remain mounted runtime files; do not copy their values into Traefik configuration or commit an encrypted placeholder. Doco-CD v0.129.0 source supports per-app overrides and `env_files`; check the actual installed version before release. The SOPS example is not a replacement for the existing homelab encryption rules.

`infra/hosted/cloudflare-route.tf.example` describes the narrow DNS/tunnel patch for the proposed new entry. It does not create or replace a Terraform root or include account/tunnel identifiers. Review any Cloudflare Access policy separately: routing a hostname does not itself grant or restrict access. The instructor/demo audience must be able to reach Tutor Matcher's own authentication flow.

The template follows the current homelab source, [Doco-CD v0.129.0 configuration](https://github.com/kimdre/doco-cd/blob/v0.129.0/internal/config/deploy/deploy.go), [nested discovery](https://github.com/kimdre/doco-cd/blob/v0.129.0/internal/config/deploy/auto_discovery.go) and [Docker's placement specification](https://docs.docker.com/reference/compose-file/deploy/). Swarm does not wait for Compose `depends_on`; applications need startup retries or restart on unavailable dependencies. A persistent single-member Mongo replica set is not database failover. Stateful storage placement must stay on its owning host.

## Rollout and local fallback

Before requesting a server change, collect the host facts, review immutable image revisions and encrypted configuration, confirm the HTTPS route and placement label, and review migrations against a restored copy. Confirm all owners' health checks, variable names, volume ownership and broker permissions. Apply infrastructure initialization before owner migrations and workers. Start the web entry only after Auth/Gateway are healthy. Record the actual revision and observed outcomes; never infer hosted success from this template.

Rehearse signup, login/logout, current-session revocation, account settings, restrictions/restoration and simulated reset delivery. Then test one failed Tutor replica, Docker API discovery interruption and broker interruption after all peer implementations are available. Use the same synthetic dataset and published revision for local fallback. A business mutation must not be replayed under a new identity after a timeout.

## Backup and isolated restoration

Prepare an approved, encrypted backup destination. Quiesce every owner API and worker that can write, including scheduled and outbox workers, before taking a cross-store checkpoint. Record the revision, database migration versions, broker topology and timestamp. Back up each PostgreSQL database with `pg_dump --format=custom` under its owner, each Mongo database with `mongodump` under its owner, and the broker definitions. Preserve pending outbox/operation/job rows and the encrypted keys needed to read retained reset material. Do not include decrypted configuration in evidence.

Restore into a separately named, isolated environment with fresh network boundaries, not over a running database. Restore the stores and broker topology before starting any workers. Owners verify their records and financial invariants; then resume pending operations under their original IDs. Notification must deduplicate events whose outbox publication state was restored from before the broker acknowledgement. Check that session revocations remain revoked. A backup command exiting successfully is not restoration evidence.

Do not release the full target until every owner has supplied an isolated restore check, all nine UI journeys and required failure evidence. Keep the local Compose rehearsal available for hosted connectivity failure. The exact 10 November submission time and instructor acceptance of simulations remain open course inputs.
