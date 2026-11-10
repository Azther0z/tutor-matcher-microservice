import { CATEGORIES, normalizeSummary } from "./discovery-model.mjs";

export const DEFAULT_DURATION_SECONDS = 300;
export const DEFAULT_REPEATS = 3;
export const Q03_VUS = 50;
export const Q03_DURATION_SECONDS = 30;
export const CATEGORY_MIN_SAMPLES = 3;

export function roundRate(rate) {
  return Math.round(rate * 10) / 10;
}

export function assessResult(result, config = {}) {
  let report = result?.report;
  if (!report && result?.raw) report = normalizeSummary(result.raw, config);
  if (!report && result?.metrics) report = normalizeSummary(result, config);
  const base = report?.assessment;
  const host = result?.hostValidity;
  const hasHostValidity = Boolean(
    host &&
    typeof host === "object" &&
    Object.hasOwn(host, "telemetryError") &&
    typeof host.containersStable === "boolean" &&
    typeof host.generatorPossiblyLimited === "boolean" &&
    typeof host.replicas === "number",
  );
  const boundedStop = host?.boundedStop === true;
  const hostValid =
    hasHostValidity &&
    result?.hostValid !== false &&
    host.telemetryError == null &&
    (host.containersStable === true || boundedStop) &&
    host.generatorPossiblyLimited === false;
  const exitValid =
    Number.isInteger(result?.exitCode) &&
    (result.exitCode === 0 || result.exitCode === 99 || boundedStop);
  const scheduleComplete =
    result?.scheduleComplete === true ||
    report?.scheduleComplete === true ||
    base?.scheduleComplete === true;
  const summaryComplete = Boolean(base?.complete);
  const censoredByGenerator = host?.generatorPossiblyLimited === true;
  const categoriesPresent = CATEGORIES.every((category) => {
    const entry = report?.categories?.[category];
    return entry?.requests >= CATEGORY_MIN_SAMPLES;
  });
  const serviceWithinThresholds =
    Boolean(report) &&
    CATEGORIES.every((category) => {
      const entry = report.categories?.[category];
      return (
        Number.isFinite(entry?.latency?.p95) &&
        entry.latency.p95 < 500 &&
        Number.isFinite(entry?.combinedFailureRate) &&
        entry.combinedFailureRate < 0.01
      );
    }) &&
    Number.isFinite(report.overall?.combinedFailureRate) &&
    report.overall.combinedFailureRate < 0.01;
  const droppedOnlyCensored =
    Number.isFinite(report?.overall?.droppedFraction) &&
    report.overall.droppedFraction >= 0.01 &&
    serviceWithinThresholds;
  const complete =
    summaryComplete &&
    scheduleComplete &&
    hostValid &&
    exitValid &&
    categoriesPresent;
  return {
    report: report || null,
    complete,
    pass: Boolean(
      base?.pass &&
      complete &&
      result?.exitCode === 0 &&
      !droppedOnlyCensored &&
      !boundedStop,
    ),
    hostValid,
    exitValid,
    boundedStop,
    scheduleComplete,
    summaryComplete,
    categoriesPresent,
    censoredByGenerator,
    droppedOnlyCensored,
    routingDistribution:
      host && typeof host === "object" ? host.routingDistribution || {} : {},
    reasons: [
      ...(!summaryComplete ? ["incomplete_summary"] : []),
      ...(!scheduleComplete ? ["incomplete_schedule"] : []),
      ...(!exitValid ? ["invalid_exit_code"] : []),
      ...(!hasHostValidity ? ["missing_host_validity"] : []),
      ...(complete && !base?.pass ? ["acceptance_threshold_failed"] : []),
      ...(droppedOnlyCensored
        ? ["dropped_iterations_without_service_breach"]
        : []),
      ...(!categoriesPresent ? ["insufficient_category_samples"] : []),
      ...(!hostValid ? ["host_invalid"] : []),
      ...(censoredByGenerator ? ["load_generator_limited"] : []),
      ...(boundedStop ? ["bounded_runtime_stop"] : []),
      ...(result?.error ? [String(result.error)] : []),
    ],
  };
}

export function chooseBaselineRate(passingRates, failedRates = []) {
  const pass = passingRates.filter((rate) => Number.isFinite(rate) && rate > 0);
  if (!pass.length) {
    const failed = failedRates.filter(Number.isFinite);
    return {
      rate: null,
      failedUpperBound: failed.length ? Math.min(...failed) : null,
    };
  }
  const rate = Math.max(...pass);
  const above =
    failedRates
      .filter((candidate) => candidate > rate)
      .sort((a, b) => a - b)[0] ?? null;
  return { rate, failedUpperBound: above, isLowerBound: above === null };
}

export function getRunSettings(env = process.env) {
  const durationSeconds = Number(
    env.DISCOVERY_DURATION_SECONDS || DEFAULT_DURATION_SECONDS,
  );
  const repeats = Number(env.DISCOVERY_REPEATS || DEFAULT_REPEATS);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1)
    throw new Error("DISCOVERY_DURATION_SECONDS must be a positive integer");
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error("DISCOVERY_REPEATS must be a positive integer");
  return {
    durationSeconds,
    repeats,
    canonical:
      durationSeconds === DEFAULT_DURATION_SECONDS &&
      repeats === DEFAULT_REPEATS,
  };
}
