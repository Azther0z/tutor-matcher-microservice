---
status: accepted
recorded: 2026-11-06
---

# Define versioned contracts before parallel implementation

Four members must implement separate service owners against one reviewed interface. The [step-3 contracts](../../contracts/README.md) keep OpenAPI as the REST authority, shared JSON Schema for data, versioned private-domain protobuf contracts, and typed notification events. Derived route inventories, bundles and Postman requests do not become independent definitions. Existing demo contracts remain historical until the coordinated step-4 migration.

Use UUID domain identities, decimal-string THB amounts, UTC timestamps, conditional revisions, stable operation identities and explicit pending results. Gateway-signed actor admission plus allowlisted workload identity separates new authorized actions from durable recovery after session expiry. Closing an absent charge saves a tombstone rather than treating a read's absence as proof; Wallet serializes charge/close and dispute/clearing decisions. See the [recovery rules](../../contracts/recovery.md).

This retains REST, gRPC, RabbitMQ and service ownership. [ADR-0028](0028-private-domain-grpc.md) amends the original step-2 protocol split: private domain calls now use gRPC, with public and Gateway infrastructure REST retained. The alternative was implementing each owner against inferred monolith payloads and reconciling incompatible money, retries and identity rules at integration time. Breaking changes now require a contract review before consumers change. Contract validation does not replace runtime acceptance.

The user confirmed five configurable notification groups with mandatory SYSTEM email for security and decision messages. [ADR-0024](0024-recoverable-notifications.md) still governs recovery; the [event contract](../../contracts/events.md) defines concrete recipients, routing and effect identities.
