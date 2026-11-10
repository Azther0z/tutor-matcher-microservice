# Discovery capacity experiment analysis

Receipt: main ledger completed.
Experiment started: 2026-11-10T21:18:09.797Z; completed: 2026-11-10T23:37:33.368Z.
Measured revision: c9cd30ec5606996217209aa6755ea5d4725f5da5.
Baseline: 80 RPS; 3/3 confirmation runs passed their recorded assessments.
Comparison receipt: 18/18 expected rate × replica × repeat cases found; 15 full scheduled, 3 bounded-stop partial, 0 missing. Threshold failures with complete measurement data are recorded observations, not missing cases.

## Scope and fixture

The planned comparison covers 18 arrival-rate measurements: 64, 80, 120 offered RPS × 1 or 3 Tutor replicas × three repeats, with a 300-second target per repeat. It also includes six Q-03 measurements at a fixed 50 virtual users (VUs) × 30 seconds and six 80% recovery measurements after the 150% overload points. Q-03 uses a concurrency executor and has no offered-RPS target; the arrival tests' preallocated VUs are capacity for the generator, not 50 simultaneous users.
Fixture: 24 tutors, 48 subjects, 1 Review record(s); 12 available and 12 unavailable tutors when fixture counts are present. One review is submitted through the real Review API against a Booking-owned synthetic completed-lesson fixture. Future availability is created through Booking APIs. Real unrated, rated, and availability query categories are represented.
Dataset sweep: not run; one fixed 24-tutor/48-subject dataset.

## Receipt by offered rate and replica count

| Offered RPS | Tutor replicas | Repeat 1                       | Repeat 2                       | Repeat 3                       | 300s complete | Guarded partial | Completed threshold failures |
| ----------: | -------------: | ------------------------------ | ------------------------------ | ------------------------------ | ------------: | --------------: | ---------------------------: |
|          64 |              1 | pass                           | pass                           | pass                           |             3 |               0 |                            0 |
|          64 |              3 | pass                           | pass                           | pass                           |             3 |               0 |                            0 |
|          80 |              1 | pass                           | pass                           | pass                           |             3 |               0 |                            0 |
|          80 |              3 | pass                           | pass                           | pass                           |             3 |               0 |                            0 |
|         120 |              1 | bounded service stop (partial) | bounded service stop (partial) | bounded service stop (partial) |             0 |               3 |                            0 |
|         120 |              3 | pass                           | pass                           | pass                           |             3 |               0 |                            0 |

## Aggregate workload summaries

Worst p95 means the maximum of per-run p95 values; percentiles are not pooled or averaged. These aggregate metrics include only full scheduled runs, including completed threshold failures. Guarded partial runs remain in the receipt and CSV with observed duration, but their p95/error percentages may include canceled in-flight requests and are excluded from full-duration steady-state aggregates.

| Offered RPS | Replicas | Median successful RPS | Worst full-run overall p95 ms | Worst broad p95 | Worst selective p95 | Worst availability p95 | Max full-run error | Max full-run dropped fraction | 300s complete | Guarded partial | Completed threshold failures |
| ----------: | -------: | --------------------: | ----------------------------: | --------------: | ------------------: | ---------------------: | -----------------: | ----------------------------: | ------------: | --------------: | ---------------------------: |
|          64 |        1 |                 63.98 |                            35 |              47 |                  24 |                     22 |                  0 |                             0 |           3/3 |             0/3 |                          0/3 |
|          64 |        3 |                 63.98 |                            25 |              30 |                  12 |                     10 |                  0 |                             0 |           3/3 |             0/3 |                          0/3 |
|          80 |        1 |                 79.98 |                            57 |              69 |                  47 |                     44 |                  0 |                             0 |           3/3 |             0/3 |                          0/3 |
|          80 |        3 |                 79.97 |                            28 |              35 |                  13 |                     11 |                  0 |                             0 |           3/3 |             0/3 |                          0/3 |
|         120 |        1 |                   n/a |                           n/a |             n/a |                 n/a |                    n/a |                n/a |                           n/a |           0/3 |             3/3 |                          0/3 |
|         120 |        3 |                119.95 |                            42 |              57 |                  30 |                     26 |                  0 |                             0 |           3/3 |             0/3 |                          0/3 |

At 120 RPS with one Tutor replica, 0/3 runs completed the full scheduled measurement and 3/3 ended at the configured service guard. Guard-stopped samples are partial; their latency/error metrics are not treated as five-minute measurements.

## Recovery after each 150% overload run

| Replicas | Repeat | Recovery rate | Status | Overall p95 | Broad p95 | Selective p95 | Availability p95 | Error rate | Dropped fraction |
| -------: | -----: | ------------: | ------ | ----------: | --------: | ------------: | ---------------: | ---------: | ---------------: |
|        1 |      1 |        64 RPS | pass   |          88 |     104.4 |            75 |            71.95 |          0 |                0 |
|        3 |      1 |        64 RPS | pass   |          28 |      37.2 |            16 |               12 |          0 |                0 |
|        3 |      2 |        64 RPS | pass   |          27 |        36 |            14 |               12 |          0 |                0 |
|        1 |      2 |        64 RPS | pass   |          73 |      87.2 |            69 |               63 |          0 |                0 |
|        1 |      3 |        64 RPS | pass   |          65 |      79.2 |         52.25 |            43.95 |          0 |                0 |
|        3 |      3 |        64 RPS | pass   |          25 |        31 |            12 |               10 |          0 |                0 |

## Q-03 concurrency: 50 VUs for 30 seconds

This workload holds 50 concurrent virtual users. It is separate from the 64/80/120 offered-RPS arrival workloads; its `ratePerSecond` metadata field is not an offered request rate.

| Tutor replicas | Runs | Median successful RPS | Median overall p95 ms | Worst overall p95 ms | Worst broad p95 | Worst selective p95 | Worst availability p95 | Worst error rate | Acceptance passes |
| -------------: | ---: | --------------------: | --------------------: | -------------------: | --------------: | ------------------: | ---------------------: | ---------------: | ----------------: |
|              1 |    3 |                106.54 |                 599.4 |                  615 |           656.5 |              614.25 |                  604.9 |           0.1903 |               0/3 |
|              3 |    3 |                189.05 |                   592 |                  600 |             638 |               255.6 |                  242.1 |                0 |               0/3 |

For mode-aware context, Q-03 50-VU concurrency has median overall p95 599.4 ms (1 replica) and 592 ms (3 replicas); the separate 120 offered-RPS/3-replica arrival workload has worst full-run overall p95 42 ms. These are different executors and populations, not equivalent request rates.

Paired three-replica / one-replica successful-throughput ratios: repeat 1 1.742×; repeat 2 1.792×; repeat 3 1.748×. Median gain is 1.748× (range 1.742–1.792×) from 3/3 paired repeats.
The configured Tutor CPU limit is 0.5 CPU per replica: 0.5 CPU at one replica and 1.5 CPU at three. Paired throughput-per-configured-Tutor-CPU ratio (throughput gain divided by three) has median 0.583× and range 0.581–0.597×. These are CPU limits/ceilings, not reservations or dedicated cores; this Tutor-only comparison is not whole-deployment efficiency. Fixed other service limits make the whole-app configured CPU ceiling 5.6→6.6 CPU (+18%) excluding the load generator, or 6.6→7.6 CPU including it; recorded peak budget is 7.6 CPU.
The Q-03 p95 target is 500 ms and error target is below 1%. Results above those thresholds remain measured outcomes; replica throughput gains do not imply latency acceptance.

## Baseline discovery and confirmation

Short probes passed at: 5, 10, 20, 40, 80 RPS. Failed or bounded probes: 160, 120, 100, 90 RPS.
Confirmed sustained baseline: 80 RPS; failed upper bound: 90 RPS. This is an observed sustainable rate/bracket, not a proven theoretical maximum.

| Repeat | Rate | Complete | Pass | Overall p95 | Broad p95 | Selective p95 | Availability p95 | Error rate | Dropped fraction |
| -----: | ---: | :------: | :--: | ----------: | --------: | ------------: | ---------------: | ---------: | ---------------: |
|      1 |   80 |   yes    | yes  |          64 |        77 |            53 |               51 |          0 |                0 |
|      2 |   80 |   yes    | yes  |         116 |     142.7 |           100 |               95 |          0 |           0.0007 |
|      3 |   80 |   yes    | yes  |          97 |    112.05 |         83.05 |               81 |          0 |                0 |

Short-probe boundary observations:

| Rate | Status            | Overall p95 | Broad p95 | Selective p95 | Availability p95 | Error rate | Dropped fraction |
| ---: | ----------------- | ----------: | --------: | ------------: | ---------------: | ---------: | ---------------: |
|    5 | pass              |          60 |       128 |         30.95 |            26.55 |          0 |                0 |
|   10 | pass              |       75.05 |      82.5 |          38.3 |            63.45 |          0 |                0 |
|   20 | pass              |          50 |        60 |            28 |            33.85 |          0 |                0 |
|   40 | pass              |         112 |       138 |         98.05 |             88.2 |          0 |                0 |
|   80 | pass              |         297 |       325 |         280.1 |            260.6 |          0 |                0 |
|  160 | bounded stop      |        5001 |      5000 |          5001 |             5001 |     0.3117 |           0.2234 |
|  120 | bounded stop      |     3404.85 |    3551.5 |        3316.6 |           3366.3 |     0.1699 |           0.2312 |
|  100 | threshold failure |     1706.45 |   1721.95 |        1679.7 |           1680.3 |     0.1041 |           0.0487 |
|   90 | threshold failure |       632.7 |     648.5 |        606.75 |           620.65 |     0.0323 |           0.0137 |

## API service resource use and cap checks

Ledger resource limits match the resource values recorded in environment metadata: yes. Snapshots confirm expected replica counts and limits for the five measured API services (Auth, Gateway, Tutor, Booking, Review) across sampled workload windows: yes. MongoDB, RabbitMQ, Traefik, and other host processes are not included in the API-service CPU/memory aggregate.
CPU mean-of-limit is summarized from sampled Docker `CPUPerc` divided by each container's declared CPU limit; memory is Docker stats working-set usage. Resource sampling includes startup/drain where labels overlap the measurement; it is observational, not a precise per-request attribution.

| Offered RPS | Replicas | Repeat | Mean API-service CPU of limit | Mean API-service memory MiB | Peak API-service memory MiB | Cap/snapshot valid |
| ----------: | -------: | -----: | ----------------------------: | --------------------------: | --------------------------: | :----------------: |
|          64 |        1 |      1 |                        28.14% |                      106.82 |                       143.6 |        yes         |
|          64 |        1 |      2 |                        27.55% |                      113.79 |                       161.9 |        yes         |
|          64 |        1 |      3 |                         27.9% |                      113.76 |                       173.3 |        yes         |
|          64 |        3 |      1 |                        23.76% |                      103.13 |                       157.4 |        yes         |
|          64 |        3 |      2 |                        23.39% |                      107.03 |                       161.9 |        yes         |
|          64 |        3 |      3 |                        23.67% |                       106.1 |                       162.6 |        yes         |
|          80 |        1 |      1 |                        34.27% |                      113.23 |                       161.6 |        yes         |
|          80 |        1 |      2 |                         33.2% |                      115.01 |                       164.9 |        yes         |
|          80 |        1 |      3 |                        33.29% |                      114.01 |                       159.9 |        yes         |
|          80 |        3 |      1 |                        28.16% |                      106.79 |                       161.5 |        yes         |
|          80 |        3 |      2 |                        28.61% |                       107.5 |                       165.7 |        yes         |
|          80 |        3 |      3 |                        28.62% |                      106.83 |                       165.7 |        yes         |
|         120 |        1 |      1 |                        39.87% |                      165.18 |                       511.9 |        yes         |
|         120 |        1 |      2 |                        43.48% |                       132.2 |                       470.5 |        yes         |
|         120 |        1 |      3 |                        44.59% |                      124.39 |                       511.9 |        yes         |
|         120 |        3 |      1 |                        41.06% |                      105.81 |                       164.5 |        yes         |
|         120 |        3 |      2 |                        40.75% |                      107.93 |                       164.9 |        yes         |
|         120 |        3 |      3 |                        42.11% |                      103.91 |                       152.9 |        yes         |

Tutor replicas observed per resource sample are checked against the requested topology; Auth, Gateway, Booking, and Review are each expected at one replica. Declared core limits: api-gateway 0.5 CPU / 512 MiB; auth-service 0.5 CPU / 384 MiB; booking-service 0.5 CPU / 384 MiB; review-service 0.5 CPU / 384 MiB; tutor-service 0.5 CPU / 384 MiB.

## Supplemental gateway status evidence

Supplemental gateway status samples within resource-sampling windows; parent topology samples share the run label, so these windows include warm-up, process startup and drain. They are not exact k6 measurement totals.

- q03-1-replica-repeat-1: statuses {"200":4644,"503":1234}; origins {"0":1234,"200":4644}; retry attempts {"0":5878}.
- q03-3-replica-repeat-1: statuses {"200":8572}; origins {"200":8572}; retry attempts {"0":8572}.
- q03-3-replica-repeat-2: statuses {"200":8638}; origins {"200":8638}; retry attempts {"0":8638}.
- q03-1-replica-repeat-2: statuses {"200":4635,"503":1586}; origins {"0":1586,"200":4635}; retry attempts {"0":6221}.
- q03-1-replica-repeat-3: statuses {"200":4780,"503":1368}; origins {"0":1368,"200":4780}; retry attempts {"0":6148}.
- q03-3-replica-repeat-3: statuses {"200":8753}; origins {"200":8753}; retry attempts {"0":8753}.
  The supplemental gateway log review found the 503 responses had origin status 0, no `ServiceAddr`, and retry count 0; the exact ingress cause remains unproven because Traefik active-health state was not sampled. This supplemental window includes warm-up, process startup, and drain; it is not an exact k6 request total.

## Provenance, limitations, and scope

- Tested source revision: c9cd30ec5606996217209aa6755ea5d4725f5da5.
- Fixture: 24 tutors / 48 subjects; 1 real Review row(s), plus a Booking-owned synthetic completed-lesson fixture.
- Prior interrupted sibling retained: discovery-2026-11-11-interrupted. Earlier gateway budget was 256 MiB; canonical run budget is 512 MiB.
- The fixed dataset does not establish a capacity curve across larger catalogue sizes.
- Per-run p95 values are summarized as worst-run p95; they are not pooled across runs.
- This analysis is a measurement report only. It proposes no application changes.

## Bottleneck evidence and follow-up

Booking's [`batchGetAvailability`](../../../services/booking-service/src/domain/slots.ts#L201) executes one awaited aggregate SELECT per candidate, sequentially within the RPC. Broad searches contain 48 candidates, selective searches four, and availability queries one. The 40/40/20 mix therefore implies 21 availability SELECTs per search. This is RPC batching with per-candidate database work.

For the first three-replica Q-03 measurement, all 5,620 responses succeeded. Its category counts imply 118,020 availability SELECTs; Booking database transaction commits increased by 118,121 across the surrounding counter window. Setup, drain, background workers and asynchronous PostgreSQL statistics make that supporting correlation, not an isolated query profile. See `booking-query-work.json` in the raw archive for all six observations.

The shared PostgreSQL container averaged about 80–81% of its one-CPU ceiling in the three-replica Q-03 samples. This identifies the Booking/database path as a useful profiling candidate; it does not prove the cause of the latency tail. Gateway 503s without an origin need separate backend-health/routing telemetry to distinguish their cause. Application performance changes are outside this measurement PR.

The independent `resource-budget-verification.json` checks all 1,089 resource snapshots against the declared limits for all ten persistent services and the generator whenever present. Quotas and requested replica counts match, including Booking and Review staying at one replica.

Recovery means readiness and warm-up followed by a passing 60-second measurement at 64 RPS. A separate time-to-recovery SLA was not measured.
