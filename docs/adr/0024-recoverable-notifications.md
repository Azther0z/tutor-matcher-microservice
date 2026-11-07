---
status: accepted
recorded: 2026-11-06
---

# Recover notifications after committed business actions

[ADR-0020](0020-payment-calls-and-side-effects.md) originally acknowledged publishing failure after a database write. The user requires recovery instead of silent notification loss.

Preserve required notification work after the business action commits. Recover after producer, broker, or consumer failures, and retry without duplicate delivery effects. Notification outages must not reverse a successful business action.

This closes the publishing gap while preserving asynchronous delivery and [ADR-0009](0009-service-extraction-principles.md). RabbitMQ durability alone does not cover unpublished work.

The alternative was lost notifications as an explicit demo limitation. The user rejected it. Step 3 defines event identities and contracts in the [event guide](../../contracts/events.md) for the selected mechanism below. See SUP-03 and Q-06 in the [requirements](../requirements.md).

Step 2 selects transactional outboxes in each producer, publisher workers in their owning services, and durable Notification jobs. See the [event design](../system-design.md#recoverable-events-and-scheduled-work).
Preserve event identities across retries, establish required queue bindings, handle unroutable publications, and acknowledge only after durable acceptance.
The simulated delivery receipt is the effect, unique per event, recipient, and channel. This does not claim exactly-once real email delivery.

Source: user decisions confirmed during requirements reconciliation on 6 November 2026.


The user confirmed in step 3 that the five preference groups stay unchanged. Security and decision messages use mandatory SYSTEM email. The event guide specifies recipient selection and the unique per-event/recipient/channel effect.
