---
status: accepted
recorded: 2026-11-06
---

# Encrypt deployment secrets with SOPS and age

Retain SOPS with age for encrypted deployment configuration. Doco-CD decrypts required files at deployment time. Plaintext production secrets must not enter Git or demonstration output.

Document key ownership, recovery, and hosted configuration without recording secret values. Provider simulation does not remove the need to protect account, database, and deployment secrets.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 13, original ADR-008. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
