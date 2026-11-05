---
status: accepted
recorded: 2026-11-06
---

# Course delivery scope and behavioral baseline

The four-person team must deliver all nine business use cases by 10 November 2026. Use the [requirements](../requirements.md) as the single authority for scope, behavior, quality acceptance, and course evidence.

The user retained most original technical decisions, including Next.js, TypeScript, npm workspaces, owned databases, image publishing, Swarm/Doco-CD, and SOPS/age. Hosted deployment and a local fallback both remain required.

Use the [pinned monolith](https://github.com/Azther0z/tutor-matcher/tree/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1) for established journeys, with source conflicts resolved in the requirements. Retain chat and defer Google sign-in. Simulate external providers without simulating away internal authorization or financial correctness.

Accepted changes cover application document URLs, tutor-only payouts, tutor-confirmed completion, earnings clearing, disputes, and moderation. Their exact policies belong in the requirements, rather than competing specifications.

The [PDFs](../sources/README.md) remain unchanged. Open issues and unmerged PRs establish proposals, not completed implementation. Accepted scope does not mean the current repository meets it.

Alternatives were a three-use-case delivery, deferring hosted deployment, and real-provider integration. The user selected all nine, hosted Swarm/Doco-CD, and simulated providers. Instructor acceptance of simulation remains unconfirmed.

Source: user decisions confirmed during requirements reconciliation on 6 November 2026.
