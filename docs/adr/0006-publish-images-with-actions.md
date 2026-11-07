---
status: accepted
recorded: 2026-11-06
---

# Build and publish images with GitHub Actions

Build application images in GitHub Actions and publish images traceable to their source commit. Hosted deployment pulls those images rather than building on the server.

Required validation must pass before release. Image names, revision references, and the release process must be inspectable. Accepted tooling does not imply that this checkout already has a publishing workflow.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 12, original ADR-006. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
