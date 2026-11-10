# Discovery capacity experiment

- Status: diagnostic / incomplete
- Measured: 2026-11-10T21:09:18.857Z to 2026-11-10T21:16:36.811Z
- Duration/repeats: 300s x 3
- Baseline arrival rate: unavailable RPS

## Category acceptance (each must pass)

Broad, selective, and availability discovery each require p95 below 500 ms and combined transport plus semantic failures below 1%. Overall failures and dropped iterations must also remain below 1%.

## Q-03 concurrency

| Tutor replicas | Repeat | Pass | Broad p95 ms | Selective p95 ms | Availability p95 ms | Combined failure |
|---:|---:|:---:|---:|---:|---:|---:|

Q-03 successful-throughput gain versus the paired one-replica run: inconclusive (missing throughput data).

## Arrival-rate comparisons

| Offered rate | Repeat | Order | Replicas | Pass | Overall p95 | Broad p95 | Selective p95 | Availability p95 | Successful RPS | Dropped fraction | Failure rate |
|---:|---:|:---:|---:|:---:|---:|---:|---:|---:|---:|---:|---:|

Each comparison is an arrival-rate run at the offered rate shown. The 150% point is an overload observation; its threshold failure is a measured outcome and does not by itself make the experiment incomplete.

## Recovery after overload

| Replicas | Repeat | Recovery pass | Broad p95 | Selective p95 | Availability p95 | Rate |
|---:|---:|:---:|---:|---:|---:|---:|

Three-replica routing evidence: not verified (0 observed).

## Interpretation

The baseline is a verified sustainable rate, not a claim of the service's true maximum. A failed higher probe or confirmation establishes an observed bound; reaching the configured probe cap reports a lower bound. Diagnostic overrides, incomplete runs, invalid host samples, or failed recovery prevent qualification. Three-replica throughput scaling is called consistent only when all three paired Q-03 throughput comparisons exceed their one-replica repeat at the same repeat number.
