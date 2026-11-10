export const CATEGORIES = ["broad", "selective", "availability"];
const MIX = ["broad", "broad", "selective", "selective", "availability"];

export function queryForIteration(queries, iteration) {
  if (!Array.isArray(queries) || queries.length === 0)
    throw new Error("fixture queries must not be empty");
  const category = MIX[((iteration % MIX.length) + MIX.length) % MIX.length];
  const matches = queries.filter((query) => query.category === category);
  if (matches.length === 0)
    throw new Error(`fixture has no ${category} queries`);
  return {
    ...matches[Math.floor(iteration / MIX.length) % matches.length],
    category,
  };
}

export function validateResponse(status, body, query) {
  if (status !== 200) return { ok: false, reason: "non_200" };
  let data;
  try {
    data = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (
    !data ||
    !Array.isArray(data.items) ||
    !data.pagination ||
    !Number.isFinite(data.pagination.totalItems)
  )
    return { ok: false, reason: "invalid_search_shape" };
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  if (
    /"(?:identificationDocumentUrl|passwordHash|password|email|userId)"\s*:/.test(
      serialized,
    )
  )
    return { ok: false, reason: "private_field_leak" };
  if (data.pagination.totalItems !== query.expected.total)
    return { ok: false, reason: "incorrect_total" };
  const expectedItems = query.expected.items;
  if (
    !Array.isArray(expectedItems) ||
    data.items.length !== expectedItems.length
  )
    return { ok: false, reason: "incorrect_page_size" };
  const expectedIds = new Set();
  const actualIds = new Set();
  for (const expected of expectedItems) {
    const id = `${expected.subjectId}:${expected.tutorId}`;
    if (expectedIds.has(id))
      return { ok: false, reason: "duplicate_expected_item" };
    expectedIds.add(id);
  }
  for (const item of data.items) {
    const id = `${item?.subject?.id}:${item?.subject?.tutorId}`;
    if (!item?.subject?.id || !item?.subject?.tutorId || actualIds.has(id))
      return { ok: false, reason: "invalid_or_duplicate_item" };
    actualIds.add(id);
    const distribution = item.rating?.distribution;
    const distributionKeys = distribution && Object.keys(distribution).sort();
    if (
      !item.rating ||
      !Number.isInteger(item.rating.reviewCount) ||
      item.rating.reviewCount < 0 ||
      !(
        item.rating.average === null ||
        (typeof item.rating.average === "number" &&
          Number.isFinite(item.rating.average))
      ) ||
      !distribution ||
      distributionKeys.length !== 5 ||
      distributionKeys.some((key, index) => key !== String(index + 1)) ||
      ["1", "2", "3", "4", "5"].some(
        (key) => !Number.isInteger(distribution[key]) || distribution[key] < 0,
      ) ||
      ["1", "2", "3", "4", "5"].reduce(
        (sum, key) => sum + distribution[key],
        0,
      ) !== item.rating.reviewCount
    )
      return { ok: false, reason: "incorrect_rating" };
    const weighted = ["1", "2", "3", "4", "5"].reduce(
      (sum, key) => sum + Number(key) * distribution[key],
      0,
    );
    if (
      item.rating.reviewCount === 0
        ? item.rating.average !== null
        : item.rating.average === null ||
          Math.abs(item.rating.average - weighted / item.rating.reviewCount) >
            0.01
    )
      return { ok: false, reason: "incorrect_rating" };
  }
  for (const expected of expectedItems) {
    const item = data.items.find(
      (candidate) =>
        candidate.subject.id === expected.subjectId &&
        candidate.subject.tutorId === expected.tutorId,
    );
    if (!item) return { ok: false, reason: "missing_expected_item" };
    if (
      (expected.subjectName !== undefined &&
        item.subject.name !== expected.subjectName) ||
      (expected.hourlyRate !== undefined &&
        item.subject.hourlyRate !== expected.hourlyRate) ||
      (expected.tutorDisplayName !== undefined &&
        item.tutorDisplayName !== expected.tutorDisplayName)
    )
      return { ok: false, reason: "incorrect_public_details" };
    if (
      item.rating.reviewCount !== expected.reviewCount ||
      item.rating.average !== expected.average
    )
      return { ok: false, reason: "incorrect_rating" };
    if (item.nextAvailableAt !== expected.nextAvailableAt)
      return { ok: false, reason: "incorrect_availability" };
  }
  return { ok: true, reason: "ok" };
}

function metric(summary, name) {
  return summary?.metrics?.[name]?.values;
}
function rate(values) {
  return values && Number.isFinite(values.rate) ? values.rate : null;
}
function trend(values) {
  if (!values) return null;
  const p = (key) => (Number.isFinite(values[key]) ? values[key] : null);
  return { p50: p("med"), p95: p("p(95)"), p99: p("p(99)") };
}

function durationMs(config) {
  if (Number.isFinite(config?.durationSeconds) && config.durationSeconds > 0)
    return config.durationSeconds * 1000;
  const value = config?.duration;
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value * 1000;
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) return null;
  const multiplier = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]];
  return Number(match[1]) * multiplier;
}

export function normalizeSummary(summary, config = {}) {
  const metrics = summary?.metrics;
  const categories = {};
  let categoriesComplete = Boolean(metrics);
  for (const category of CATEGORIES) {
    const latency = trend(
      metric(summary, `discovery_latency{category:${category}}`),
    );
    const transportFailureRate = rate(
      metric(summary, `discovery_transport_failed{category:${category}}`),
    );
    const semanticFailureRate = rate(
      metric(summary, `discovery_semantic_failed{category:${category}}`),
    );
    const combined = rate(
      metric(summary, `discovery_failed{category:${category}}`),
    );
    const requests = metric(
      summary,
      `discovery_requests{category:${category}}`,
    );
    categories[category] = {
      latency,
      transportFailureRate,
      semanticFailureRate,
      combinedFailureRate: combined,
      requests: requests?.count ?? null,
    };
    if (
      !latency ||
      latency.p95 === null ||
      transportFailureRate === null ||
      semanticFailureRate === null ||
      combined === null ||
      categories[category].requests === null ||
      categories[category].requests === 0
    )
      categoriesComplete = false;
  }
  const transport = rate(metric(summary, "discovery_transport_failed"));
  const semantic = rate(metric(summary, "discovery_semantic_failed"));
  const combined = rate(metric(summary, "discovery_failed"));
  const iterations = metric(summary, "iterations")?.count ?? null;
  const dropped =
    metric(summary, "dropped_iterations")?.count ??
    (iterations !== null ? 0 : null);
  const observedArrivals =
    iterations !== null && dropped !== null ? iterations + dropped : null;
  const expectedDurationMs = durationMs(config);
  const observedDurationMs = Number.isFinite(summary?.state?.testRunDurationMs)
    ? summary.state.testRunDurationMs
    : null;
  const durationComplete =
    expectedDurationMs !== null &&
    observedDurationMs !== null &&
    observedDurationMs >= expectedDurationMs * 0.98;
  const mode = config.mode;
  let expectedArrivals = null;
  let arrivalCountComplete = false;
  if (
    mode === "arrival" &&
    Number.isFinite(config.ratePerSecond) &&
    config.ratePerSecond > 0 &&
    expectedDurationMs !== null
  ) {
    const actualRate = Math.max(1, Math.round(config.ratePerSecond * 10)) / 10;
    expectedArrivals = (actualRate * expectedDurationMs) / 1000;
    arrivalCountComplete =
      observedArrivals !== null &&
      observedArrivals >= Math.floor(expectedArrivals) - 1 &&
      observedArrivals <= Math.ceil(expectedArrivals) + 2;
  } else if (mode === "concurrency") {
    arrivalCountComplete = observedArrivals !== null && observedArrivals > 0;
  }
  const scheduleComplete = durationComplete && arrivalCountComplete;
  const droppedFraction =
    dropped !== null && iterations !== null && dropped + iterations > 0
      ? dropped / (dropped + iterations)
      : null;
  const thresholdResults = Object.values(metrics || {}).flatMap((m) =>
    Object.values(m.thresholds || {}),
  );
  const requiredThresholdsOk =
    thresholdResults.length > 0 && thresholdResults.every((t) => t.ok === true);
  const complete =
    categoriesComplete &&
    transport !== null &&
    semantic !== null &&
    combined !== null &&
    droppedFraction !== null &&
    thresholdResults.length > 0 &&
    scheduleComplete;
  const pass =
    complete &&
    requiredThresholdsOk &&
    CATEGORIES.every(
      (c) =>
        categories[c].latency.p95 < 500 &&
        categories[c].combinedFailureRate < 0.01,
    ) &&
    combined < 0.01 &&
    droppedFraction < 0.01;
  return {
    schemaVersion: 1,
    config,
    scheduleComplete,
    observedDurationMs,
    schedule: {
      expectedDurationMs,
      observedDurationMs,
      expectedArrivals,
      observedArrivals,
      scheduleComplete,
    },
    categories,
    overall: {
      latency: trend(metric(summary, "discovery_latency")),
      transportFailureRate: transport,
      semanticFailureRate: semantic,
      combinedFailureRate: combined,
      successfulRequestsPerSecond:
        metric(summary, "discovery_requests")?.rate !== undefined &&
        combined !== null
          ? metric(summary, "discovery_requests").rate * (1 - combined)
          : null,
      requests: metric(summary, "discovery_requests")?.count ?? null,
      droppedIterations: dropped,
      iterations,
      droppedFraction,
      thresholdChecksPassed: requiredThresholdsOk,
    },
    assessment: { complete, pass },
  };
}
