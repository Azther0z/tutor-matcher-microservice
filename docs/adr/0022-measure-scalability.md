---
status: accepted
recorded: 2026-11-06
---

# Measure tutor search scalability with k6

Retain an automated k6 tutor-search comparison through the gateway. With 50 concurrent users for 30 seconds, additional Tutor replicas must raise throughput while p95 latency stays below 500 ms and errors stay below 1%.

Use comparable datasets and fixed per-replica resource limits. Save results, report the environment, and explain bottlenecks. CPU limits improve comparison but do not make capacity independent of the host machine.

Existing results describe an earlier run. The course also requires a distinct second load-test type. The [requirements](../requirements.md#course-submission-requirements) select a stress test with increasing demand.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 18–19, original ADR-022. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.
