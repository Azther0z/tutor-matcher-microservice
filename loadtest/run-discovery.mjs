import { createRuntime } from "./discovery-runtime.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assessResult,
  chooseBaselineRate,
  getRunSettings,
  Q03_DURATION_SECONDS,
  roundRate,
} from "./discovery-capacity.mjs";

const WARMUP_SECONDS = 15;
const PROBE_SECONDS = 30;
const MAX_RATE = 2560;
const MAX_VUS = 1000;
const RECOVERY_SECONDS = 60;

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export async function runDiscovery({
  runtime: suppliedRuntime,
  env = process.env,
  logger = console,
} = {}) {
  const settings = getRunSettings(env);
  const runtime = suppliedRuntime || (await createRuntime());
  const ledger = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    metadata: runtime.metadata,
    settings,
    runs: [],
    samples: [],
    baseline: {
      status: "pending",
      passingRates: [],
      failedRates: [],
      failedRateReasons: [],
      censoredRates: [],
      confirmation: [],
    },
    comparisons: [],
    q03: [],
    qualified: false,
  };

  const saveLedger = async () =>
    runtime.write("ledger.json", `${JSON.stringify(ledger, null, 2)}\n`);
  const sample = async (label) => {
    const value = await runtime.sample(label);
    ledger.samples.push({ label, value });
    await saveLedger();
    return value;
  };
  const measure = async ({
    name,
    mode = "arrival",
    ratePerSecond,
    durationSeconds,
    vus = 50,
    allowBoundedStop = false,
  }) => {
    const params = {
      name: slug(name),
      mode,
      ratePerSecond,
      durationSeconds,
      vus,
      maxVUs: MAX_VUS,
    };
    const warmName = `${params.name}-warmup`;
    let warmup;
    try {
      warmup = await runtime.runK6({
        ...params,
        name: warmName,
        durationSeconds: WARMUP_SECONDS,
      });
    } catch (error) {
      warmup = { error: String(error), exitCode: 1 };
    }
    const warmAssessment = assessResult(warmup, params);
    ledger.runs.push({
      ...params,
      phase: "warmup",
      result: warmup,
      assessment: warmAssessment,
    });
    await runtime.write(
      `runner-${warmName}.json`,
      `${JSON.stringify(ledger.runs.at(-1), null, 2)}\n`,
    );
    await saveLedger();
    logger.log(`Warmup complete: ${warmName} (${mode}, ${WARMUP_SECONDS}s).`);

    let result;
    try {
      result = await runtime.runK6(params);
    } catch (error) {
      result = { error: String(error), exitCode: 1 };
    }
    const assessment = assessResult(result, params);
    const entry = { ...params, phase: "measurement", result, assessment };
    ledger.runs.push(entry);
    await runtime.write(
      `runner-${params.name}.json`,
      `${JSON.stringify(entry, null, 2)}\n`,
    );
    await saveLedger();
    const runStatus = assessment.boundedStop
      ? "bounded service stop"
      : !assessment.complete
        ? "incomplete"
        : assessment.pass
          ? "pass"
          : "acceptance failed";
    const workload =
      mode === "concurrency" ? `${vus} VUs` : `${ratePerSecond} RPS`;
    logger.log(
      `Measurement complete: ${params.name} (${workload}, ${durationSeconds}s): ${runStatus}.`,
    );
    if (!assessment.hostValid) {
      if (assessment.censoredByGenerator) {
        ledger.baseline.censoredRates.push({
          ratePerSecond: params.ratePerSecond,
          name: params.name,
          reasons: assessment.reasons,
        });
      }
      const error = new Error(
        `Host telemetry invalid during ${params.name}; stopping to avoid treating a censored run as capacity evidence.`,
      );
      error.hostInvalid = Boolean(result?.hostValidity);
      error.invalidMeasurement = !result?.hostValidity;
      error.censoredByGenerator = assessment.censoredByGenerator;
      throw error;
    }
    if (assessment.boundedStop && allowBoundedStop)
      return { result, assessment };
    if (
      !assessment.exitValid ||
      !assessment.summaryComplete ||
      !assessment.scheduleComplete ||
      !assessment.categoriesPresent
    ) {
      const error = new Error(
        `Incomplete load measurement ${params.name}; no capacity conclusion is inferred.`,
      );
      error.invalidMeasurement = true;
      throw error;
    }
    return { result, assessment };
  };

  try {
    logger.log(`Discovery experiment artifacts: ${runtime.directory}`);
    await runtime.start();
    await runtime.prepare();
    await runtime.scale(1);
    await sample("baseline-1-replica");

    // Locate a short-run boundary first. The passing and failing endpoints are
    // retained as evidence; three bisection probes refine the interval.
    let rate = 5;
    let lower = null;
    let upper = null;
    const probe = async (candidate, label) => {
      const rounded = roundRate(candidate);
      const { assessment } = await measure({
        name: `baseline-probe-${label}-${rounded}rps`,
        ratePerSecond: rounded,
        durationSeconds: PROBE_SECONDS,
        allowBoundedStop: true,
      });
      if (assessment.droppedOnlyCensored) {
        ledger.baseline.censoredRates.push({
          ratePerSecond: rounded,
          reasons: assessment.reasons,
        });
        const lastPass = Math.max(...ledger.baseline.passingRates, 0);
        if (lastPass > 0) ledger.baseline.ratePerSecond = lastPass;
        ledger.baseline.status = "censored";
        ledger.baseline.reason =
          "Offered load was dropped without a discovery latency or error breach; this does not establish service capacity.";
        const error = new Error(ledger.baseline.reason);
        error.censored = true;
        throw error;
      }
      if (assessment.pass) ledger.baseline.passingRates.push(rounded);
      else {
        ledger.baseline.failedRates.push(rounded);
        ledger.baseline.failedRateReasons.push({
          ratePerSecond: rounded,
          reason: assessment.boundedStop
            ? "bounded service instability/pressure stop"
            : "completed measurement failed acceptance",
        });
      }
      await saveLedger();
      return assessment.pass;
    };

    while (rate <= MAX_RATE) {
      if (await probe(rate, "ramp")) {
        lower = rate;
        if (rate === MAX_RATE) break;
        rate = Math.min(MAX_RATE, rate * 2);
        continue;
      }
      upper = rate;
      break;
    }
    if (lower === null) {
      // The first geometric probe failed: step down to the documented 0.5 RPS floor.
      let candidate = 2.5;
      while (candidate >= 0.5) {
        if (await probe(candidate, "descent")) {
          lower = candidate;
          break;
        }
        upper = candidate;
        if (candidate === 0.5) break;
        candidate = Math.max(0.5, roundRate(candidate / 2));
      }
    } else if (upper !== null) {
      for (let step = 1; step <= 3; step += 1) {
        const middle = roundRate((lower + upper) / 2);
        if (middle <= lower || middle >= upper) break;
        if (await probe(middle, `bisect-${step}`)) lower = middle;
        else upper = middle;
      }
    }

    if (lower === null) {
      ledger.baseline.status = "unavailable";
      ledger.baseline.reason =
        "No 30-second rate at or above 0.5 RPS met the acceptance criteria.";
      ledger.completedAt = new Date().toISOString();
      await saveLedger();
      await runtime.write("report.md", renderReport(ledger));
      return ledger;
    }

    // Confirmation uses the full requested duration and three independent passes.
    let confirmRate = roundRate(lower);
    let confirmed = false;
    for (let fallback = 0; fallback < 5 && confirmRate >= 0.5; fallback += 1) {
      const batch = [];
      for (let repeat = 1; repeat <= settings.repeats; repeat += 1) {
        const measured = await measure({
          name: `baseline-confirm-${confirmRate}rps-repeat-${repeat}`,
          ratePerSecond: confirmRate,
          durationSeconds: settings.durationSeconds,
          allowBoundedStop: true,
        });
        batch.push(measured.assessment.pass);
        ledger.baseline.confirmation.push({
          ratePerSecond: confirmRate,
          repeat,
          ...measured.assessment,
        });
        await saveLedger();
        if (!measured.assessment.pass) break;
      }
      if (batch.length === settings.repeats && batch.every(Boolean)) {
        lower = confirmRate;
        confirmed = true;
        logger.log(
          `Baseline confirmed at ${confirmRate} RPS for ${settings.repeats} full-duration repeats.`,
        );
        break;
      }
      ledger.baseline.failedRates.push(confirmRate);
      ledger.baseline.failedRateReasons.push({
        ratePerSecond: confirmRate,
        reason: "full-duration confirmation did not pass all repeats",
      });
      upper = upper === null ? confirmRate : Math.min(upper, confirmRate);
      confirmRate = roundRate(confirmRate * 0.8);
      if (confirmRate >= lower) confirmRate = roundRate(lower - 0.1);
      lower = confirmRate;
    }

    if (!confirmed) {
      ledger.baseline.status = "unavailable";
      ledger.baseline.reason =
        "No rate completed all requested full-duration confirmation repeats.";
      ledger.baseline.failedUpperBound = upper;
      ledger.completedAt = new Date().toISOString();
      await saveLedger();
      await runtime.write("report.md", renderReport(ledger));
      return ledger;
    }

    const baseline = chooseBaselineRate(
      [confirmRate],
      [...ledger.baseline.failedRates, ...(upper === null ? [] : [upper])],
    );
    ledger.baseline = {
      ...ledger.baseline,
      status: "verified",
      ratePerSecond: confirmRate,
      failedUpperBound: baseline.failedUpperBound,
      isLowerBound: baseline.isLowerBound,
    };
    await saveLedger();

    // Pair Q-03 observations by repeat and alternate topology order.
    for (let repeat = 1; repeat <= settings.repeats; repeat += 1) {
      const order = repeat % 2 === 1 ? [1, 3] : [3, 1];
      for (const replicas of order) {
        await runtime.scale(replicas);
        await sample(`q03-${replicas}-replica-repeat-${repeat}`);
        const q03 = await measure({
          name: `q03-${replicas}-replica-repeat-${repeat}`,
          mode: "concurrency",
          ratePerSecond: confirmRate,
          durationSeconds: Q03_DURATION_SECONDS,
          vus: 50,
        });
        ledger.q03.push({ replicas, repeat, ...q03.assessment });
      }
    }

    // Pair each arrival-rate point across topologies, reversing the order on
    // alternating repeats to reduce systematic warm/cache-order bias.
    for (const multiplier of [0.8, 1, 1.5]) {
      for (let repeat = 1; repeat <= settings.repeats; repeat += 1) {
        const order = repeat % 2 === 1 ? [1, 3] : [3, 1];
        const outcomes = [];
        for (const replicas of order) {
          await runtime.scale(replicas);
          const config = {
            name: `compare-${replicas}-replica-${Math.round(multiplier * 100)}pct-repeat-${repeat}`,
            ratePerSecond: roundRate(confirmRate * multiplier),
            durationSeconds: settings.durationSeconds,
          };
          const measured = await measure({
            ...config,
            allowBoundedStop: multiplier === 1.5,
          });
          outcomes.push({ replicas, ...measured.assessment });
          if (multiplier === 1.5) {
            const recovery = await measure({
              name: `recovery-${replicas}-replica-repeat-${repeat}`,
              ratePerSecond: roundRate(confirmRate * 0.8),
              durationSeconds: RECOVERY_SECONDS,
            });
            ledger.comparisons.push({
              replicas,
              multiplier,
              repeat,
              recovery: recovery.assessment,
              after: config.name,
            });
            await saveLedger();
            if (!recovery.assessment.pass) {
              const error = new Error(
                `Recovery acceptance failed after ${config.name}; stopping before the next overload run.`,
              );
              error.recoveryFailed = true;
              throw error;
            }
          }
        }
        ledger.comparisons.push({
          multiplier,
          repeat,
          order,
          ratePerSecond: roundRate(confirmRate * multiplier),
          outcomes,
        });
        await saveLedger();
      }
    }

    const measuredRuns = ledger.runs.filter(
      (run) => run.phase === "measurement",
    );
    ledger.experimentComplete =
      measuredRuns.length > 0 &&
      measuredRuns.every(
        (run) =>
          (run.assessment.complete || run.assessment.boundedStop) &&
          run.assessment.hostValid,
      );
    ledger.allSchedulesComplete =
      measuredRuns.length > 0 &&
      measuredRuns.every((run) => run.assessment.complete);
    ledger.boundedStopCount = measuredRuns.filter(
      (run) => run.assessment.boundedStop,
    ).length;
    ledger.routingVerified3 = measuredRuns.some(
      (run) =>
        run.result?.hostValidity?.replicas === 3 &&
        Object.keys(run.result.hostValidity.routingDistribution || {}).length >=
          3,
    );
    const pairs = ledger.comparisons.filter((entry) =>
      Array.isArray(entry.outcomes),
    );
    const recoveries = ledger.comparisons.filter((entry) => entry.recovery);
    ledger.q03ThroughputGain = calculateQ03Gains(ledger.q03);
    ledger.qualified =
      settings.canonical &&
      ledger.experimentComplete &&
      ledger.allSchedulesComplete &&
      ledger.baseline.status === "verified" &&
      ledger.q03.length === 6 &&
      ledger.q03.every((run) => run.pass) &&
      pairs
        .filter((entry) => entry.multiplier < 1.5)
        .every((entry) => entry.outcomes.every((run) => run.pass)) &&
      recoveries.length === 6 &&
      recoveries.every((entry) => entry.recovery.pass) &&
      ledger.q03ThroughputGain.consistent === true &&
      ledger.routingVerified3;
    ledger.qualificationNote = settings.canonical
      ? null
      : "Diagnostic duration/repeat override used; results are not fully qualified.";
    ledger.completedAt = new Date().toISOString();
    await saveLedger();
    await runtime.write("report.md", renderReport(ledger));
    return ledger;
  } catch (error) {
    ledger.error = String(error);
    if (ledger.baseline.status === "pending") {
      ledger.baseline.status = error.censoredByGenerator
        ? "censored"
        : error.hostInvalid
          ? "invalid_environment"
          : error.invalidMeasurement
            ? "invalid_measurement"
            : "aborted";
      if (error.hostInvalid)
        ledger.baseline.reason =
          "Host telemetry was invalid or the load generator was resource-limited; no service-capacity boundary is inferred.";
      if (error.invalidMeasurement)
        ledger.baseline.reason =
          "The load run did not produce a complete, valid scheduled measurement; no capacity boundary is inferred.";
      if (error.censoredByGenerator) {
        ledger.baseline.status = "censored";
        const lastPass = Math.max(...ledger.baseline.passingRates, 0);
        if (lastPass > 0) ledger.baseline.ratePerSecond = lastPass;
      }
    }
    ledger.completedAt = new Date().toISOString();
    await saveLedger();
    await runtime.write("report.md", renderReport(ledger));
    throw error;
  } finally {
    await runtime.cleanup();
  }
}

export function renderReport(ledger) {
  const lines = [
    "# Discovery capacity experiment",
    "",
    `- Status: ${ledger.qualified ? "qualified" : ledger.baseline?.status === "unavailable" ? "baseline unavailable" : ledger.baseline?.status === "censored" ? "censored; no service limit inferred" : ledger.baseline?.status === "invalid_measurement" ? "invalid measurement; no service limit inferred" : ledger.experimentComplete && ledger.boundedStopCount ? `complete with ${ledger.boundedStopCount} bounded service stop(s); qualification withheld` : ledger.experimentComplete ? "complete; acceptance not met" : "diagnostic / incomplete"}`,
    `- Measured: ${ledger.startedAt || "unknown"} to ${ledger.completedAt || "incomplete"}`,
    `- Duration/repeats: ${ledger.settings?.durationSeconds ?? "?"}s x ${ledger.settings?.repeats ?? "?"}`,
    `- Baseline arrival rate: ${ledger.baseline?.ratePerSecond ?? "unavailable"} RPS${ledger.baseline?.failedUpperBound ? `; failed bound ${ledger.baseline.failedUpperBound} RPS` : ""}${ledger.baseline?.isLowerBound ? " (lower bound; configured probe cap reached)" : ""}`,
    "",
    "## Category acceptance (each must pass)",
    "",
    "Broad, selective, and availability discovery each require p95 below 500 ms and combined transport plus semantic failures below 1%. Overall failures and dropped iterations must also remain below 1%.",
    "",
    "## Q-03 concurrency",
    "",
    "| Tutor replicas | Repeat | Pass | Broad p95 ms | Selective p95 ms | Availability p95 ms | Combined failure |",
    "|---:|---:|:---:|---:|---:|---:|---:|",
  ];
  for (const boundary of ledger.baseline?.failedRateReasons || []) {
    lines.push(
      `- Failed boundary ${boundary.ratePerSecond} RPS: ${boundary.reason}.`,
    );
  }
  for (const run of ledger.q03 || []) {
    const c = run.report?.categories || {};
    lines.push(
      `| ${run.replicas} | ${run.repeat} | ${run.pass ? "yes" : "no"} | ${c.broad?.latency?.p95 ?? "n/a"} | ${c.selective?.latency?.p95 ?? "n/a"} | ${c.availability?.latency?.p95 ?? "n/a"} | ${run.report?.overall?.combinedFailureRate ?? "n/a"} |`,
    );
  }
  lines.push(
    "",
    `Q-03 successful-throughput gain versus the paired one-replica run: ${ledger.q03ThroughputGain?.consistent === true ? "consistent across all three repeats" : ledger.q03ThroughputGain?.consistent === false ? "not consistent across all three repeats" : "inconclusive (missing throughput data)"}.`,
  );
  if (ledger.q03ThroughputGain?.ratios?.length)
    lines.push(
      `- Throughput ratios: ${ledger.q03ThroughputGain.ratios.map((ratio, index) => `repeat ${index + 1}: ${ratio}`).join("; ")}`,
    );
  lines.push(
    "",
    "## Arrival-rate comparisons",
    "",
    "| Offered rate | Repeat | Order | Replicas | Pass | Overall p95 | Broad p95 | Selective p95 | Availability p95 | Successful RPS | Dropped fraction | Failure rate |",
    "|---:|---:|:---:|---:|:---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const pair of ledger.comparisons || []) {
    if (!Array.isArray(pair.outcomes)) continue;
    for (const result of pair.outcomes) {
      const report = result.report;
      const categories = report?.categories || {};
      lines.push(
        `| ${pair.ratePerSecond} (${Math.round(pair.multiplier * 100)}%) | ${pair.repeat} | ${pair.order.join("→")} | ${result.replicas} | ${result.boundedStop ? "bounded stop" : result.pass ? "yes" : "no"} | ${report?.overall?.latency?.p95 ?? "n/a"} | ${categories.broad?.latency?.p95 ?? "n/a"} | ${categories.selective?.latency?.p95 ?? "n/a"} | ${categories.availability?.latency?.p95 ?? "n/a"} | ${report?.overall?.successfulRequestsPerSecond ?? "n/a"} | ${report?.overall?.droppedFraction ?? "n/a"} | ${report?.overall?.combinedFailureRate ?? "n/a"} |`,
      );
    }
  }
  lines.push(
    "",
    "Each comparison is an arrival-rate run at the offered rate shown. The 150% point is an overload observation; its threshold failure is a measured outcome and does not by itself make the experiment incomplete.",
    "",
    "## Recovery after overload",
    "",
    "| Replicas | Repeat | Recovery pass | Broad p95 | Selective p95 | Availability p95 | Rate |",
    "|---:|---:|:---:|---:|---:|---:|---:|",
  );
  for (const run of ledger.comparisons || [])
    if (run.recovery) {
      const categories = run.recovery.report?.categories || {};
      lines.push(
        `| ${run.replicas} | ${run.repeat} | ${run.recovery.pass ? "yes" : "no"} | ${categories.broad?.latency?.p95 ?? "n/a"} | ${categories.selective?.latency?.p95 ?? "n/a"} | ${categories.availability?.latency?.p95 ?? "n/a"} | ${roundRate((ledger.baseline.ratePerSecond || 0) * 0.8)} RPS |`,
      );
    }
  const threeReplicaTargetKeys = new Set(
    ledger.runs
      .filter(
        (run) =>
          run.phase === "measurement" &&
          run.result?.hostValidity?.replicas === 3,
      )
      .flatMap((run) =>
        Object.keys(run.result.hostValidity.routingDistribution || {}),
      ),
  );
  lines.push(
    "",
    `Three-replica routing evidence: ${threeReplicaTargetKeys.size >= 3 ? `observed ${threeReplicaTargetKeys.size} targets` : `not verified (${threeReplicaTargetKeys.size} observed)`}.`,
  );
  lines.push(
    "",
    "## Interpretation",
    "",
    "The baseline is a verified sustainable rate, not a claim of the service's true maximum. A failed higher probe or confirmation establishes an observed bound; reaching the configured probe cap reports a lower bound. Diagnostic overrides, incomplete runs, invalid host samples, or failed recovery prevent qualification. Three-replica throughput scaling is called consistent only when all three paired Q-03 throughput comparisons exceed their one-replica repeat at the same repeat number.",
    "",
  );
  return lines.join("\n");
}

export function calculateQ03Gains(runs) {
  const actualRatios = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    const baseline = runs.find(
      (run) => run.replicas === 1 && run.repeat === repeat,
    )?.report?.overall?.successfulRequestsPerSecond;
    const scaled = runs.find(
      (run) => run.replicas === 3 && run.repeat === repeat,
    )?.report?.overall?.successfulRequestsPerSecond;
    if (!(baseline > 0) || !(scaled > 0))
      return { consistent: null, ratios: [] };
    actualRatios.push(scaled / baseline);
  }
  return {
    consistent: actualRatios.every((ratio) => ratio > 1),
    ratios: actualRatios.map((ratio) => Number(ratio.toFixed(6))),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runDiscovery().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
