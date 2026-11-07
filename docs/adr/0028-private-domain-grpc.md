---
status: accepted
recorded: 2026-11-06
---

# Use gRPC for private domain collaborations

After reviewing the protocol split, the user selected all 18 private domain operations for gRPC. Keep the two availability methods, for 20 unary RPCs across Auth, Tutor, Booking, Wallet and Review. [The gRPC contracts](../../contracts/grpc/README.md) define the typed messages, exact callers, private ports, deadlines, value validation and error mapping.

Public REST stays unchanged. Gateway-to-Auth introspection and Gateway-to-owner status polling remain eight private REST operations. RabbitMQ continues to deliver versioned events. Messaging and Notification use domain RPCs as clients without adding their own gRPC servers. Do not keep competing REST aliases for the converted domain methods.

This explicitly amends the initial REST catalogue and financial collaborations in step 2 and the first step-3 contract set. Service/data ownership and business rules stay unchanged. The alternative was adding only seven Booking-to-Wallet RPCs. The user selected a consistent private domain split instead. The course requires REST and gRPC, but it does not mandate this larger RPC count.

Use explicit protobuf scalar presence, caller allowlists and immutable operation identities. A gRPC deadline, cancellation or NOT_FOUND read does not prove that a charge failed. Preserve the [financial recovery contract](../../contracts/recovery.md), durable outboxes, refund caps and dispute/clearing locks. The registry and fixtures distinguish the selected target from unimplemented runtime behavior.
