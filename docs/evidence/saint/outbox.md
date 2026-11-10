# Auth outbox recovery smoke evidence

Date: 8 November 2026. Result: pass on the local uncommitted worktree. The smoke used the isolated Auth test database, a synthetic signup/reset request, and a disposable rootless Podman RabbitMQ 4.3.6 management container. No Notification service, cloud resource, or production server was used.

## Verified

- Auth accepted signup and password-reset requests through its real HTTP app and committed one `auth.password-reset-requested` event to PostgreSQL.
- With `RABBITMQ_URL` pointed at a closed loopback port, the real outbox publisher claimed the row and increased its attempt count while leaving `published_at` empty.
- After RabbitMQ started, the publisher recovered and marked the same row published after its publisher-confirm and mandatory-routing checks completed.
- The envelope passed the local `contracts/schemas/events.v1.json` schema. Its event ID, user audience, routing key, and AMQP `message_id`, `type`, `content_type`, persistence mode, and authenticated publisher `user_id` matched the contract.
- Reset event data contained only `contentRef` and `expiresAt`; the event contained no reset token or link.
- The smoke harness directly fetched and acknowledged the queued event. After stopping and restarting the publisher, the outbox attempt count and published timestamp stayed unchanged, and the queue remained empty. This verifies the publisher does not reclaim an already published row; it does not claim Notification processing or delivery.

The script generated credentials in process memory, passed RabbitMQ credentials by environment variable names to the container runtime, and did not print event payloads, environment values, reset content, or broker URLs. It stopped and removed only its uniquely named container; cleanup was confirmed afterward. Database disposal is the fixture owner's responsibility; the parent removed the disposable PostgreSQL verification container after the final checks.

## Repeat

After building the current shared and Auth workspaces, run the smoke with `TEST_DATABASE_URL` set to the isolated `_test` database and `CONTAINER_CLI=podman` (or Docker). The script refuses database names without a `_test` suffix and validates the published envelope against the checked-in event schema.
