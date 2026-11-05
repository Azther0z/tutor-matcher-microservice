---
status: accepted
recorded: 2026-11-06
---

# Express services in TypeScript

Keep Express business services separate from Next.js and write the submitted backend in TypeScript. The backend owns booking, wallet, access, and lifecycle rules for every client.

The original single-backend deployment is historical. Extraction changes deployment boundaries without moving rules into Next.js. Current JavaScript services require work to meet this retained constraint.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 10, original ADR-002. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
