const test = require("node:test");
const assert = require("node:assert/strict");

let capacity;
let runner;
test.before(async () => {
  capacity = await import("../loadtest/discovery-capacity.mjs");
  runner = await import("../loadtest/run-discovery.mjs");
});

function passingReport() {
  const categories = Object.fromEntries(
    ["broad", "selective", "availability"].map((name) => [
      name,
      {
        latency: { p95: 240 },
        transportFailureRate: 0,
        semanticFailureRate: 0,
        combinedFailureRate: 0,
        requests: 10,
      },
    ]),
  );
  return {
    categories,
    overall: { combinedFailureRate: 0 },
    scheduleComplete: true,
    assessment: { complete: true, pass: true },
  };
}

function hostValidity(replicas = 1, extra = {}) {
  return {
    replicas,
    telemetryError: null,
    containersStable: true,
    generatorPossiblyLimited: false,
    routingDistribution: {},
    boundedStop: false,
    ...extra,
  };
}

test("assessment requires complete passing results, host validity, and category samples", async () => {
  assert.equal(
    capacity.assessResult({
      report: passingReport(),
      exitCode: 0,
      hostValidity: hostValidity(),
    }).pass,
    true,
  );
  assert.equal(
    capacity.assessResult({
      report: passingReport(),
      exitCode: 99,
      hostValidity: hostValidity(),
    }).pass,
    false,
  );
  assert.equal(
    capacity.assessResult({
      report: passingReport(),
      exitCode: 0,
      hostValidity: hostValidity(1, { containersStable: false }),
    }).pass,
    false,
  );
  const sparse = passingReport();
  sparse.categories.availability.requests = 2;
  assert.equal(
    capacity.assessResult({ report: sparse, exitCode: 0 }).pass,
    false,
  );
  assert.equal(
    capacity.assessResult({
      report: passingReport(),
      exitCode: 101,
      hostValidity: hostValidity(),
    }).complete,
    false,
  );
  assert.equal(
    capacity.assessResult({
      report: passingReport(),
      hostValidity: hostValidity(),
    }).complete,
    false,
  );
  assert.equal(
    capacity.assessResult({ report: passingReport(), exitCode: 0 }).complete,
    false,
  );
  const stopped = capacity.assessResult({
    report: passingReport(),
    exitCode: 137,
    hostValidity: hostValidity(1, {
      containersStable: false,
      boundedStop: true,
    }),
  });
  assert.equal(stopped.boundedStop, true);
  assert.equal(stopped.pass, false);
});

test("baseline selection returns highest verified passing rate and upper failed bracket", async () => {
  assert.deepEqual(capacity.chooseBaselineRate([5, 10, 7.5], [20, 15]), {
    rate: 10,
    failedUpperBound: 15,
    isLowerBound: false,
  });
  assert.deepEqual(capacity.chooseBaselineRate([], [5]), {
    rate: null,
    failedUpperBound: 5,
  });
  assert.equal(capacity.chooseBaselineRate([2560], [1280]).isLowerBound, true);
});

test("rate rounding and environment overrides identify diagnostic runs", async () => {
  assert.equal(capacity.roundRate(7.26), 7.3);
  assert.deepEqual(capacity.getRunSettings({}), {
    durationSeconds: 300,
    repeats: 3,
    canonical: true,
  });
  assert.deepEqual(
    capacity.getRunSettings({
      DISCOVERY_DURATION_SECONDS: "30",
      DISCOVERY_REPEATS: "1",
    }),
    {
      durationSeconds: 30,
      repeats: 1,
      canonical: false,
    },
  );
  assert.throws(
    () => capacity.getRunSettings({ DISCOVERY_DURATION_SECONDS: "0" }),
    /positive integer/,
  );
});

function fakeRuntime({ pass = true, resultFor } = {}) {
  const calls = [];
  let replicas = 1;
  const runtime = {
    directory: "/tmp/discovery-test",
    metadata: { fixture: true },
    calls,
    async start() {},
    async prepare() {},
    async scale(count) {
      replicas = count;
      calls.push({ type: "scale", replicas: count });
    },
    async sample(label) {
      return { label };
    },
    written: new Map(),
    async write(name, data) {
      this.written.set(name, data);
    },
    async cleanup() {
      calls.push({ type: "cleanup" });
    },
    async runK6(args) {
      calls.push({ type: "run", ...args });
      if (resultFor) return resultFor(args, replicas);
      const report = passingReport();
      if (!pass) report.assessment.pass = false;
      return {
        report,
        raw: {},
        exitCode: 0,
        hostValidity: hostValidity(replicas),
      };
    },
  };
  return runtime;
}

test("runner stops and records unavailable baseline when the minimum probe fails", async () => {
  const runtime = fakeRuntime({ pass: false });
  const ledger = await runner.runDiscovery({
    logger: { log() {} },
    runtime,
    env: { DISCOVERY_DURATION_SECONDS: "1", DISCOVERY_REPEATS: "1" },
  });
  assert.equal(ledger.baseline.status, "unavailable");
  assert.deepEqual(ledger.baseline.failedRates, [5, 2.5, 1.3, 0.7, 0.5]);
  assert.equal(
    runtime.calls.filter(
      (call) => call.type === "run" && call.name.endsWith("warmup"),
    ).length,
    5,
  );
  assert.equal(runtime.calls.at(-1).type, "cleanup");
});

test("dropped-only probe censors capacity and preserves the prior passing rate", async () => {
  const runtime = fakeRuntime({
    resultFor(args, replicas) {
      const report = passingReport();
      const droppedOnly = args.ratePerSecond === 10;
      report.overall = {
        combinedFailureRate: 0,
        droppedFraction: droppedOnly ? 0.05 : 0,
      };
      if (droppedOnly) report.assessment.pass = false;
      return {
        report,
        exitCode: droppedOnly ? 99 : 0,
        hostValidity: hostValidity(replicas),
      };
    },
  });
  await assert.rejects(
    runner.runDiscovery({
      runtime,
      env: { DISCOVERY_DURATION_SECONDS: "1", DISCOVERY_REPEATS: "1" },
      logger: { log() {} },
    }),
    /dropped without a discovery latency or error breach/,
  );
  const ledger = JSON.parse(runtime.written.get("ledger.json"));
  assert.equal(ledger.baseline.status, "censored");
  assert.equal(ledger.baseline.ratePerSecond, 5);
  assert.deepEqual(ledger.baseline.passingRates, [5]);
  assert.deepEqual(ledger.baseline.failedRates, []);
  assert.deepEqual(
    ledger.baseline.censoredRates.map((item) => item.ratePerSecond),
    [10],
  );
});

test("invalid baseline exit is reported as an invalid measurement, not a capacity failure", async () => {
  const runtime = fakeRuntime({
    resultFor() {
      return {
        report: passingReport(),
        exitCode: 107,
        hostValidity: hostValidity(),
      };
    },
  });
  await assert.rejects(
    runner.runDiscovery({
      runtime,
      env: { DISCOVERY_DURATION_SECONDS: "1", DISCOVERY_REPEATS: "1" },
      logger: { log() {} },
    }),
    /Incomplete load measurement/,
  );
  const ledger = JSON.parse(runtime.written.get("ledger.json"));
  assert.equal(ledger.baseline.status, "invalid_measurement");
  assert.deepEqual(ledger.baseline.failedRates, []);
});

test("runner ramps to cap, confirms and alternates paired topology order", async () => {
  const runtime = fakeRuntime();
  const ledger = await runner.runDiscovery({
    logger: { log() {} },
    runtime,
    env: { DISCOVERY_DURATION_SECONDS: "1", DISCOVERY_REPEATS: "3" },
  });
  assert.equal(ledger.baseline.status, "verified");
  assert.equal(ledger.baseline.ratePerSecond, 2560);
  assert.equal(ledger.baseline.isLowerBound, true);
  const pairs = ledger.comparisons.filter((entry) => entry.outcomes);
  assert.deepEqual(
    pairs.slice(0, 3).map((entry) => entry.order),
    [
      [1, 3],
      [3, 1],
      [1, 3],
    ],
  );
  assert.equal(pairs.length, 9);
  assert.equal(ledger.qualified, false);
  assert.equal(runtime.calls.at(-1).type, "cleanup");
});

test("Q-03 gains compare paired repeats and use unrounded values for pass/fail", async () => {
  const runs = [
    {
      replicas: 1,
      repeat: 1,
      report: { overall: { successfulRequestsPerSecond: 100 } },
    },
    {
      replicas: 3,
      repeat: 1,
      report: { overall: { successfulRequestsPerSecond: 100.0001 } },
    },
    {
      replicas: 1,
      repeat: 2,
      report: { overall: { successfulRequestsPerSecond: 110 } },
    },
    {
      replicas: 3,
      repeat: 2,
      report: { overall: { successfulRequestsPerSecond: 105 } },
    },
    {
      replicas: 1,
      repeat: 3,
      report: { overall: { successfulRequestsPerSecond: 100 } },
    },
    {
      replicas: 3,
      repeat: 3,
      report: { overall: { successfulRequestsPerSecond: 120 } },
    },
  ];
  const result = runner.calculateQ03Gains(runs);
  assert.equal(result.consistent, false);
  assert.deepEqual(result.ratios, [1.000001, 0.954545, 1.2]);
});

test("canonical run stays complete after the 150% point fails or triggers a bounded stop", async () => {
  const runtime = fakeRuntime({
    resultFor(args, replicas) {
      const report = passingReport();
      report.overall = {
        combinedFailureRate: 0,
        successfulRequestsPerSecond:
          args.mode === "concurrency" ? (replicas === 3 ? 120 : 100) : 100,
        droppedFraction: 0,
        latency: { p95: 240 },
      };
      const overloaded =
        args.mode === "arrival" &&
        args.name.includes("compare-") &&
        args.ratePerSecond > 2560;
      const boundedStop =
        overloaded &&
        args.name.includes("compare-3-replica") &&
        args.name.includes("repeat-1");
      if (overloaded) report.assessment.pass = false;
      if (boundedStop) report.scheduleComplete = false;
      return {
        report,
        raw: {},
        exitCode: boundedStop ? 137 : overloaded ? 99 : 0,
        hostValidity: {
          replicas,
          telemetryError: null,
          containersStable: !boundedStop,
          generatorPossiblyLimited: false,
          boundedStop,
          routingDistribution: Object.fromEntries(
            Array.from({ length: replicas }, (_, index) => [
              `10.0.0.${index + 1}`,
              10,
            ]),
          ),
        },
      };
    },
  });
  const ledger = await runner.runDiscovery({
    runtime,
    env: {},
    logger: { log() {} },
  });
  const overloadRows = ledger.comparisons.filter(
    (entry) => entry.outcomes && entry.multiplier === 1.5,
  );
  assert.equal(ledger.experimentComplete, true);
  assert.equal(ledger.allSchedulesComplete, false);
  assert.equal(ledger.boundedStopCount, 1);
  assert.equal(ledger.qualified, false);
  assert.equal(overloadRows.length, 3);
  assert.ok(
    overloadRows.every((entry) => entry.outcomes.every((run) => !run.pass)),
  );
  assert.ok(
    overloadRows
      .flatMap((entry) => entry.outcomes)
      .some((run) => run.boundedStop),
  );
});
