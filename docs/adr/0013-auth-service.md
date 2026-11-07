---
status: accepted
recorded: 2026-11-06
---

# Extract Auth and issue signed identity

Keep credentials and password verification in Auth. Auth issues JWTs, and the gateway passes authenticated identity to downstream services. No other service reads credential data directly.

Stateless token verification does not replace ownership or current account restrictions. The submitted system must enforce Student, Tutor, and Admin capabilities and reject protected actions by restricted accounts.

The [system design](../system-design.md#identity-permissions-and-tutor-activation) keeps approval decisions in Tutor and account capability grants in Auth.
Activation is a durable, idempotent workflow. Protected new actions check current Auth state, rather than waiting for an old token to expire after a ban.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 15, original ADR-013. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
