# Tutor Matcher architectural decisions

These records preserve the numbering of ADR-001 through ADR-022 in the [Tutor Matcher PDF](../sources/tutor-matcher.pdf). The filenames use four digits.
They were first recorded as Markdown in this checkout on 6 November 2026. That date does not claim to be the original decision date.
The original PDF remains unchanged as historical evidence. ADR-0023–ADR-0028 record reconciliation, system-design and interface decisions.

Use the [requirements](../requirements.md) for delivery scope, policies, and acceptance criteria. Use the [glossary](../../GLOSSARY.md) for domain terms.
Accepted means that a decision governs the target. It does not mean that its implementation or operational evidence is complete.
[ARCHITECTURE.md](../../ARCHITECTURE.md) remains the current implementation snapshot.

| Record | Status | Source |
| --- | --- | --- |
| [ADR-0001 Next.js for presentation and routing](0001-nextjs-presentation.md) | Accepted | Tutor Matcher PDF pp. 10 |
| [ADR-0002 Express services in TypeScript](0002-express-typescript-backend.md) | Accepted | Tutor Matcher PDF pp. 10 |
| [ADR-0003 Prisma and PostgreSQL in the original backend](0003-original-prisma-postgresql.md) | Historical single-backend scope | Tutor Matcher PDF pp. 10 |
| [ADR-0004 Monorepo with npm workspaces](0004-npm-workspace-monorepo.md) | Accepted | Tutor Matcher PDF pp. 11 |
| [ADR-0005 Separate local and hosted deployment manifests](0005-local-and-hosted-compose.md) | Accepted | Tutor Matcher PDF pp. 12 |
| [ADR-0006 Build and publish images with GitHub Actions](0006-publish-images-with-actions.md) | Accepted | Tutor Matcher PDF pp. 12 |
| [ADR-0007 Hosted Swarm deployment with Doco-CD](0007-swarm-doco-cd-deployment.md) | Accepted | Tutor Matcher PDF pp. 12 |
| [ADR-0008 Encrypt deployment secrets with SOPS and age](0008-sops-age-secrets.md) | Accepted | Tutor Matcher PDF pp. 13 |
| [ADR-0009 Evidence and safeguards for service extraction](0009-service-extraction-principles.md) | Accepted | Tutor Matcher PDF pp. 13 |
| [ADR-0010 Extract the Tutor service](0010-tutor-service.md) | Accepted | Tutor Matcher PDF pp. 14 |
| [ADR-0011 Extract Booking with payment recovery](0011-booking-service.md) | Accepted | Tutor Matcher PDF pp. 14 |
| [ADR-0012 Extract asynchronous Notification processing](0012-notification-service.md) | Accepted | Tutor Matcher PDF pp. 15 |
| [ADR-0013 Extract Auth and issue signed identity](0013-auth-service.md) | Accepted | Tutor Matcher PDF pp. 15 |
| [ADR-0014 Extract Wallet as the financial owner](0014-wallet-service.md) | Accepted | Tutor Matcher PDF pp. 15 |
| [ADR-0015 Separate database ownership for every service](0015-database-per-service.md) | Accepted | Tutor Matcher PDF pp. 16 |
| [ADR-0016 PostgreSQL for Auth and Wallet](0016-postgresql-auth-wallet.md) | Accepted | Tutor Matcher PDF pp. 16 |
| [ADR-0017 MongoDB for document-oriented services](0017-mongodb-document-services.md) | Accepted; Booking selection superseded by ADR-0026 | Tutor Matcher PDF pp. 16; step-2 reconciliation |
| [ADR-0018 API gateway with centralized authentication](0018-gateway-authentication.md) | Accepted | Tutor Matcher PDF pp. 17 |
| [ADR-0019 RabbitMQ for asynchronous events](0019-rabbitmq-events.md) | Accepted | Tutor Matcher PDF pp. 17 |
| [ADR-0020 Synchronous money decisions and asynchronous side effects](0020-payment-calls-and-side-effects.md) | Accepted | Tutor Matcher PDF pp. 18 |
| [ADR-0021 Consul discovery and health-aware gateway routing](0021-consul-discovery.md) | Accepted | Tutor Matcher PDF pp. 18 |
| [ADR-0022 Measure tutor search scalability with k6](0022-measure-scalability.md) | Accepted | Tutor Matcher PDF pp. 18–19 |
| [ADR-0023 Course delivery scope and behavioral baseline](0023-course-delivery-baseline.md) | Accepted | User-confirmed reconciliation |
| [ADR-0024 Recover notifications after committed business actions](0024-recoverable-notifications.md) | Accepted | User-confirmed reconciliation |
| [ADR-0025 Give private conversations a Messaging service](0025-messaging-ownership.md) | Accepted | User-confirmed step 2 |
| [ADR-0026 Use PostgreSQL for Booking consistency](0026-booking-postgresql.md) | Accepted | User-confirmed step 2 |

| [ADR-0027 Define versioned contracts before parallel implementation](0027-versioned-interface-contracts.md) | Accepted | Step-3 interface design; user-confirmed SYSTEM policy |

| [ADR-0028 Use gRPC for private domain collaborations](0028-private-domain-grpc.md) | Accepted | User-confirmed step-3 protocol expansion |

## Reading historical decisions

ADR-0003 applies to the original single-backend version. ADR-0015–ADR-0017 govern extracted service persistence.
ADR-0009–ADR-0014 retain extraction rationale and safeguards. Their historical sequence does not require recombining the services or pretending the safeguards are complete.
ADR-0024 replaces ADR-0020's accepted event-loss limitation with required notification recovery.
ADR-0026 changes Booking alone to PostgreSQL. The other service-owned database choices remain as described in the [system design](../system-design.md).

The [course syllabus](../sources/swarch-syllabus-2026-11-04.pdf) requires microservice communication, discovery, relational and NoSQL storage, load testing, risk analysis, quality measurement, and final presentation evidence.
It does not mandate Kubernetes. Hosted Swarm/Doco-CD and local Compose remain the selected deployment shapes.
The [source index](../sources/README.md) links both PDFs and the pinned [monolith repository](https://github.com/Azther0z/tutor-matcher/tree/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1).
