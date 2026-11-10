# Discovery Load and Stress evidence, 11 November 2026

[Analysis and scope receipt](analysis.md) | [Measurements CSV](measurements.csv) | [Runner report](report.md)

- Baseline: 80 offered requests/second passed three five-minute confirmations. A 90 RPS short probe failed; this is an observed bracket, not a proven maximum.
- At 64 and 80 RPS, both replica configurations passed every five-minute repeat.
- At 120 RPS, three Tutors passed all three five-minute runs, with worst overall p95 42 ms and no errors or dropped iterations. One Tutor reached the memory-pressure guard in all three attempts; those are partial observations, not five-minute latency/error estimates.
- All six recovery measurements at 64 RPS passed.
- At 50 continuous VUs for 30 seconds, three Tutors delivered 1.742–1.792 times the successful throughput with zero errors, but p95 585–600 ms missed the 500 ms target. Q-03 remains unmet.

## Scope and provenance

Measured source: `c9cd30ec5606996217209aa6755ea5d4725f5da5`. The later console-label correction distinguishes VUs from offered RPS; it does not change the measured workload, application, resource limits or criteria.

The canonical comparison uses one fixed catalogue of 24 tutors and 48 subjects, with real Auth, Booking and Review collaborators, PostgreSQL, MongoDB, RabbitMQ, and public/internal Traefik. One Review API submission uses Booking's historical synthetic completed-lesson fixture. Availability is created through Booking APIs. Authenticated personalization, large review histories and a catalogue-size sweep are outside this experiment.

The API has no availability filter. Availability-category queries select known available/unavailable subjects and validate their returned availability. Data and resource limits stay identical across the one- and three-Tutor configurations. `resource-budget-verification.json` independently checks 1,089 snapshots for all persistent services and the generator whenever present.

All 18 planned arrival-rate comparison cases were observed: 15 completed the full 300 seconds and three stopped at the configured service guard. The full protocol has 42 measured runs: 29 passes, eight complete threshold failures and five guarded partial observations (including two baseline probes). Warm-up runs are retained separately. A passing tooling CI is not a passing performance requirement.

The experiment ran from 2026-11-10 21:18:09 UTC to 23:37:33 UTC, corresponding to 11 November in Asia/Bangkok. This is local single-host evidence. The initial 256 MiB gateway attempt is retained in the sibling interrupted bundle; the canonical comparison uses 512 MiB for both configurations.

## Raw archive and verification

`raw-results.tar.gz` contains every raw k6 summary/text log, runner wrapper, the complete ledger, resource/database samples, passive gateway status buckets, initialization/cleanup logs, and a snapshot of the analysis method. Readable summaries and key metadata are also kept beside the archive. The archive's `RAW_SHA256SUMS` lists every payload file.

```bash
shasum -a 256 -c SHA256SUMS
mkdir raw
tar -xzf raw-results.tar.gz -C raw
(cd raw && shasum -a 256 -c RAW_SHA256SUMS)
node raw/analysis-method.mjs "$PWD/raw"
```

The method regenerates numerical tables and CSV from the archived ledger and samples. The interpretation and SQL-work discussion in the published analysis also use the inspected Booking source and supporting database counters. Error fractions in CSV are proportions, not percentages. Guarded-run metrics can include canceled in-flight requests and are excluded from full-duration aggregates.

Gateway status samples include warm-up, startup and drain and are supplemental, not exact k6 phase totals. They show gateway 503s with no recorded origin in the one-Tutor concurrency windows; the exact routing/health cause was not captured. Recovery checks verify readiness and warm-up followed by 60 seconds at 64 RPS; a separate time-to-recovery SLA was not measured.

All owned containers, networks and database volumes were removed. Existing local projects and hosted environments were not changed.
