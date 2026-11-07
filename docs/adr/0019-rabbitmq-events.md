---
status: accepted
recorded: 2026-11-06
---

# RabbitMQ for asynchronous events

Retain RabbitMQ, durable queues, persistent messages, acknowledgements, and topic routing. Consumers must tolerate repeated delivery. Persist broker data across supported deployment changes.

RabbitMQ buffers published events during consumer outages. It cannot recover an event that a producer never successfully published. [ADR-0024](0024-recoverable-notifications.md) governs that separate boundary. Consumed-event replay also needs retained source data.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 17, original ADR-019. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
