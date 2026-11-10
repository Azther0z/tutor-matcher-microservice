# Discovery Load and Stress experiment

This experiment measures search through the public Traefik gateway, real Tutor,
Booking and Review services, the internal Traefik proxy, Auth, PostgreSQL,
MongoDB and RabbitMQ. It compares Tutor/Booking/Review replica counts `1/1/1`
and `3/1/1` on one local machine.

## Run

```bash
npm ci
npm run test:loadtest
npm run loadtest:discovery
```

Docker Compose with `!override` support, eight Docker CPUs and at least 7 GiB of
Docker memory are required. The runner uses a fresh project, disposable volumes,
generated process-only credentials and loopback gateway port 18080. It removes
only that project's containers, networks and volumes when it exits. Existing
demo projects and their credentials are not used. The four service images are
built locally and k6 runs in a capped container. No cloud deployment or Grafana
Cloud submission is performed.

Results default to a new `.runtime/discovery/<run-id>/` directory. To preserve a
public evidence bundle directly, set `DISCOVERY_OUTPUT` to a new directory under
`loadtest/results/`. The directory must not exist. `DISCOVERY_PORT` can select a
different unprivileged gateway port.

For a short implementation diagnostic, set `DISCOVERY_DURATION_SECONDS` and
`DISCOVERY_REPEATS`. Any override differing from 300 seconds and three repeats
is labelled diagnostic and cannot qualify the full experiment. Baseline probes,
Q-03 checks, warm-up and recovery retain their own explicit durations.

## Workload and correctness

The dataset stays fixed across runs. Preparation creates 24 synthetic tutors
with two published subjects each through the actual signup, application,
approval and publication APIs. Prices and learning areas vary. Half the tutors
have a future Booking slot for one subject; the others have none.

Booking's existing owner seed supplies one historical synthetic completed lesson.
A synthetic student submits its review through the real Review API, which checks
eligibility with Booking. One subject is rated and the remaining subjects are
unrated. This fixture does not qualify payment or lesson-completion workflows,
large review histories, or a large production catalogue.

Measured searches are anonymous public discovery requests. Authenticated
personalization is outside this experiment. Requests follow a deterministic
40% broad / 40% selective / 20% availability mix. The discovery API has no availability filter. The availability category
selects known subjects with and without open slots and validates their returned
availability. It does not pretend to apply an unsupported filter.

Expected result membership, counts, ratings and next availability come from the
prepared fixture. Every response must contain the exact expected page, valid
rating buckets and no private identification/password fields. HTTP failures and
incorrect HTTP 200 responses are recorded separately and together. Preflight
checks run before each invocation and are excluded from custom measured metrics.

## Experiment

1. With `1/1/1`, probe increasing request rates geometrically, then narrow the
   first passing/failing interval. Confirm a sustainable candidate with three
   five-minute runs. If long confirmation fails, reduce the candidate and retry
   within a bounded number of attempts. Preserve every failed result.
2. Compare `1/1/1` and `3/1/1` at 80% and 100% of the confirmed rate (Load).
3. Compare both at 150% of the same confirmed rate (Stress), followed by a
   recovery check at 80%. Failure under stress is a result, not a harness error.
4. Keep the Q-03 check separate: 50 concurrent users for 30 seconds, three
   repetitions for each configuration.

Each fixed-rate comparison lasts five minutes and repeats three times. Paired
topology order alternates across repeats. Warm-up runs are separate invocations,
so their timings never enter the measured summaries. The 18 fixed-rate runs
alone take 90 minutes; baseline confirmation, warm-up, Q-03 and recovery add time.

Usable capacity requires p95 below 500 ms and combined failures below 1% in
every search category and every repeat, with fewer than 1% dropped iterations.
The baseline is an observed sustainable bound for this environment and fixture.
A configured probe ceiling without a failed upper bound does not establish the
maximum. A load-generator limit cannot be attributed to the application.

Each Tutor replica receives 0.5 CPU and 384 MiB. Booking and Review each remain
at one replica with 0.5 CPU and 384 MiB. Gateway, internal proxy, databases,
broker, Auth and load-generator limits stay fixed in
`compose.performance.yaml`. More Tutor replicas add resources; report throughput
per total Tutor CPU alongside absolute gains.

## Evidence and interpretation

The bundle contains fixture expectations, tested revision and source fingerprint,
actual container/image identities and limits, raw k6 summaries, normalized
assessments, a run ledger, resource samples, database counters and a report.
Raw threshold objects use `handleSummary()`'s `ok` values, rather than assuming
legacy exported threshold booleans have the same meaning.

At a common offered rate, equal successful throughput can be the correct result.
Use latency, errors, dropped requests and resource pressure to explain headroom.
Use the separate 50-user runs for a throughput comparison. A repeatable gain
requires all three paired runs to improve; inconsistent results are inconclusive.
Per-replica gateway request counts establish whether the extra Tutor replicas
actually receive traffic. CPU, memory, restarts and database activity support
bottleneck interpretation; they do not by themselves prove causation.

Container instability or excessive memory pressure stops new load. The report
retains invalid or interrupted runs and verifies recovery when possible. Results
apply to the recorded single-host Docker environment, not production capacity.

## Documentation

- [k6 constant arrival rate](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/)
- [k6 dropped iterations](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/dropped-iterations/)
- [k6 custom summary](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/)
- [Docker Compose overrides](https://docs.docker.com/reference/compose-file/merge/)
