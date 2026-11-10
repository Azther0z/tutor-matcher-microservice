# Hosted backend demo on Docker Swarm

`compose.yaml` deploys the existing backend demo with Traefik's Swarm provider. It is separate from root local Compose and does not claim implementation of the nine-use-case target, Next.js, Review, Messaging, PostgreSQL Booking, signed admissions or the planned outbox workers. Nothing in this change deploys to the homelab.

## Inputs and prerequisites

- A supported Docker Swarm manager and a reachable registry containing all five application images. Set `AUTH_IMAGE`, `TUTOR_IMAGE`, `BOOKING_IMAGE`, `WALLET_IMAGE` and `NOTIFICATION_IMAGE` to immutable release references. Build each from its service Dockerfile using repository-root context. Traefik and the socket proxy use pinned version tags. Image publication is separate authorized work; no publishing workflow is added here.
- `STACK_NAME`, default `tutor-matcher`, must match the name passed to `docker stack deploy`. Set `CONFIG_REVISION` to a unique source revision when releasing configuration, so immutable Swarm configs receive versioned names.
- Exactly one intended storage node labeled `tutor-matcher.data=true`, with sufficient persistent storage and a tested backup/restore procedure. MongoDB, PostgreSQL and RabbitMQ stay on that node. This is a single-storage-host demo, not a highly available data tier.
- An approved HTTPS entry and firewall configuration. The manifest publishes only gateway HTTP 8080. Restrict that port to the intended entry/demo network; Swarm does not enforce the root Compose loopback binding. No database, broker-management, application, private Auth, ping or Docker API port is published.
- The external Swarm secrets below, provisioned through the approved SOPS/age/runtime mechanism. The stack deliberately refuses to start with missing inputs. No plaintext runtime credentials or encrypted secret contents are supplied by this change.

| External secret suffix | Consumer and meaning |
| --- | --- |
| `postgres_password` | PostgreSQL initialization password for its configured `tutor` account |
| `mongo_password` | MongoDB initialization password for its configured `tutor` admin account |
| `rabbitmq_password` | RabbitMQ initialization password for its configured `tutor` account |
| `auth_database_url` | Auth's PostgreSQL URL selecting `auth_db` |
| `wallet_database_url` | Wallet's PostgreSQL URL selecting `wallet_db` |
| `mongo_uri` | Authenticated MongoDB URL reachable as `mongo:27017`; the application selects its owned logical database |
| `rabbitmq_url` | Authenticated AMQP URL reachable as `rabbitmq:5672` |
| `jwt_secret` | Auth's HS256 signing/verification key |

Each actual external secret name is `${STACK_NAME}_<suffix>`. URL credentials must match the initialized infrastructure accounts and be URL-encoded where required. Startup reads mounted files through `shared/runtime-env.js`; Traefik receives no signing key. The RabbitMQ wrapper exports its mounted password only to the broker process.

The hosted volumes have distinct `hosted-` names so they do not accidentally mount root Compose data. Existing data does not migrate automatically. Changing initialization secrets does not change credentials inside an already initialized database or broker. Reuse or migration of existing storage requires an approved data/credential plan; never delete a volume to resolve authentication failure.

## Review and rollout

Run these commands from the repository root. Validate the manifests locally without resolving or printing runtime values:

```sh
docker compose config --quiet
docker stack config --skip-interpolation --compose-file deploy/compose.yaml > /dev/null
node --test tests/gateway.test.cjs
```

The test needs the dependencies and binary described in [gateway verification](../api-gateway/README.md#verification). Ensure every release image exists before updating the desired deployment revision. Doco-CD can deploy this manifest using the same reviewed inputs; retain one deployment owner.

After server authorization, the selected deployer can apply the reviewed manifest using the configured stack name:

```sh
docker stack deploy --with-registry-auth --compose-file deploy/compose.yaml "${STACK_NAME:-tutor-matcher}"
```

There is no dependency-start ordering in Swarm. Applications restart on startup failure until infrastructure is ready, and health checks prevent early routing. Inspect task convergence before testing public registration/login, tutor reads, authenticated writes, wallet/payment/cancellation, Notification consumption, restart persistence and isolated restoration. These checks use synthetic accounts and funds. The gateway-boundary test does not replace them.

Rehearse one Tutor replica and multiple replicas with controlled traffic, then fail one task while observing errors and recovery. Use access logs for the chosen task address. Record the tested revision and environment; old Consul load-test numbers are historical evidence only.

Traefik keeps previously discovered routes when discovery temporarily fails, while its active health checks continue. A restarted gateway with no Docker API cannot rediscover services. Do not promise zero errors during detection or permanent operation without a manager API.

## Rollback and remaining work

Application services use one-at-a-time start-first updates with rollback on failed rollout. Revert to known image/config revisions through the selected deployment owner. Gateway configuration is delivered as immutable, revision-named Swarm configs. Application rollback does not roll back schema or business data.

Before a hosted rollout, supply real reviewed image references, encrypted runtime inputs/external secrets, node placement, registry access and HTTPS/network configuration. Verify the socket proxy and actual manager/overlay behavior on the host, including the host's Docker-socket access policy if SELinux is enabled. The synthetic-socket test does not establish that host policy. No manager initialization, node labeling, secret creation, credential access, publication or deployment was executed here.
