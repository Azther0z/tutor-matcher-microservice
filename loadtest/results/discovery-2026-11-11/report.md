# Discovery capacity experiment

- Status: complete with 5 bounded service stop(s); qualification withheld
- Measured: 2026-11-10T21:18:09.797Z to 2026-11-10T23:37:33.368Z
- Duration/repeats: 300s x 3
- Baseline arrival rate: 80 RPS; failed bound 90 RPS

## Category acceptance (each must pass)

Broad, selective, and availability discovery each require p95 below 500 ms and combined transport plus semantic failures below 1%. Overall failures and dropped iterations must also remain below 1%.

## Q-03 concurrency

| Tutor replicas | Repeat | Pass | Broad p95 ms | Selective p95 ms | Availability p95 ms | Combined failure |
|---:|---:|:---:|---:|---:|---:|---:|
- Failed boundary 160 RPS: bounded service instability/pressure stop.
- Failed boundary 120 RPS: bounded service instability/pressure stop.
- Failed boundary 100 RPS: completed measurement failed acceptance.
- Failed boundary 90 RPS: completed measurement failed acceptance.
| 1 | 1 | no | 597 | 588.9499999999999 | 588.5 | 0.13977635782747605 |
| 3 | 1 | no | 638 | 222 | 242.0999999999997 | 0 |
| 3 | 2 | no | 617 | 255.5999999999998 | 225.69999999999996 | 0 |
| 1 | 2 | no | 600 | 597 | 598.3499999999999 | 0.19028441983387867 |
| 1 | 3 | no | 656.4999999999999 | 614.2499999999997 | 604.9 | 0.17522432701894317 |
| 3 | 3 | no | 615.3999999999999 | 175 | 140.74999999999986 | 0 |

Q-03 successful-throughput gain versus the paired one-replica run: consistent across all three repeats.
- Throughput ratios: repeat 1: 1.742297; repeat 2: 1.792087; repeat 3: 1.747688

## Arrival-rate comparisons

| Offered rate | Repeat | Order | Replicas | Pass | Overall p95 | Broad p95 | Selective p95 | Availability p95 | Successful RPS | Dropped fraction | Failure rate |
|---:|---:|:---:|---:|:---:|---:|---:|---:|---:|---:|---:|---:|
| 64 (80%) | 1 | 1→3 | 1 | yes | 35 | 47 | 24 | 22 | 63.96883723141787 | 0 | 0 |
| 64 (80%) | 1 | 1→3 | 3 | yes | 25 | 30 | 12 | 10 | 63.98087051173226 | 0 | 0 |
| 64 (80%) | 2 | 3→1 | 3 | yes | 25 | 29 | 11 | 10 | 63.98529003245753 | 0 | 0 |
| 64 (80%) | 2 | 3→1 | 1 | yes | 30 | 42 | 20 | 16 | 63.98601524295467 | 0 | 0 |
| 64 (80%) | 3 | 1→3 | 1 | yes | 33 | 45 | 24 | 21 | 63.983982373028816 | 0 | 0 |
| 64 (80%) | 3 | 1→3 | 3 | yes | 25 | 28 | 11 | 10 | 63.982616064249676 | 0 | 0 |
| 80 (100%) | 1 | 1→3 | 1 | yes | 51 | 63 | 41 | 39 | 79.9794481043276 | 0 | 0 |
| 80 (100%) | 1 | 1→3 | 3 | yes | 26 | 30 | 11 | 10 | 79.96758918707968 | 0 | 0 |
| 80 (100%) | 2 | 3→1 | 3 | yes | 27 | 33.04999999999957 | 12 | 10 | 79.97812996942952 | 0 | 0 |
| 80 (100%) | 2 | 3→1 | 1 | yes | 57 | 69 | 47 | 44 | 79.97590249823875 | 0 | 0 |
| 80 (100%) | 3 | 1→3 | 1 | yes | 51 | 63 | 41.04999999999957 | 36.049999999999784 | 79.97888215615602 | 0 | 0 |
| 80 (100%) | 3 | 1→3 | 3 | yes | 28 | 35 | 13 | 11 | 79.96944166206126 | 0 | 0 |
| 120 (150%) | 1 | 1→3 | 1 | bounded stop | 4650.999999999999 | 4629.749999999999 | 4658.25 | 4638 | 75.92755247479043 | 0.12248803827751197 | 0.1668484187568157 |
| 120 (150%) | 1 | 1→3 | 3 | yes | 38 | 52 | 26 | 23 | 119.94773837056614 | 0 | 0 |
| 120 (150%) | 2 | 3→1 | 3 | yes | 38 | 51 | 25 | 22 | 119.953291202516 | 0 | 0 |
| 120 (150%) | 2 | 3→1 | 1 | bounded stop | 538 | 550 | 532 | 531.05 | 118.36455413116653 | 0.004507465489717344 | 0 |
| 120 (150%) | 3 | 1→3 | 1 | bounded stop | 449 | 467.3999999999994 | 431.49999999999943 | 437 | 119.2639873855918 | 0.0022357471121599803 | 0 |
| 120 (150%) | 3 | 1→3 | 3 | yes | 42 | 57 | 30 | 26 | 119.96484694412193 | 0 | 0 |

Each comparison is an arrival-rate run at the offered rate shown. The 150% point is an overload observation; its threshold failure is a measured outcome and does not by itself make the experiment incomplete.

## Recovery after overload

| Replicas | Repeat | Recovery pass | Broad p95 | Selective p95 | Availability p95 | Rate |
|---:|---:|:---:|---:|---:|---:|---:|
| 1 | 1 | yes | 104.39999999999986 | 75 | 71.9499999999999 | 64 RPS |
| 3 | 1 | yes | 37.19999999999993 | 16 | 12 | 64 RPS |
| 3 | 2 | yes | 36 | 14 | 12 | 64 RPS |
| 1 | 2 | yes | 87.19999999999993 | 69 | 63 | 64 RPS |
| 1 | 3 | yes | 79.19999999999993 | 52.24999999999993 | 43.949999999999896 | 64 RPS |
| 3 | 3 | yes | 31 | 12 | 10 | 64 RPS |

Three-replica routing evidence: observed 3 targets.

## Interpretation

The baseline is a verified sustainable rate, not a claim of the service's true maximum. A failed higher probe or confirmation establishes an observed bound; reaching the configured probe cap reports a lower bound. Diagnostic overrides, incomplete runs, invalid host samples, or failed recovery prevent qualification. Three-replica throughput scaling is called consistent only when all three paired Q-03 throughput comparisons exceed their one-replica repeat at the same repeat number.
