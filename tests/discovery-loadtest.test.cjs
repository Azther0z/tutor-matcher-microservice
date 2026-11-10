const test = require("node:test");
const assert = require("node:assert/strict");
const modelPromise = import("../loadtest/discovery-model.mjs");

const query = {
  name: "broad-1",
  category: "broad",
  path: "/api/discovery/tutors",
  expected: {
    total: 1,
    items: [
      {
        subjectId: "subject-1",
        tutorId: "tutor-1",
        reviewCount: 2,
        average: 4.5,
        nextAvailableAt: "2026-11-12T03:00:00.000Z",
      },
    ],
  },
};
const body = {
  items: [
    {
      subject: { id: "subject-1", tutorId: "tutor-1" },
      rating: {
        reviewCount: 2,
        average: 4.5,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 },
      },
      nextAvailableAt: "2026-11-12T03:00:00.000Z",
    },
  ],
  pagination: { totalItems: 1 },
};

test("iteration assignment uses deterministic 40/40/20 mix and varies within categories", async () => {
  const { queryForIteration } = await modelPromise;
  const queries = ["broad", "selective", "availability"].flatMap((category) =>
    [0, 1].map((i) => ({ category, name: `${category}-${i}` })),
  );
  const categories = Array.from(
    { length: 10 },
    (_, i) => queryForIteration(queries, i).category,
  );
  assert.deepEqual(categories, [
    "broad",
    "broad",
    "selective",
    "selective",
    "availability",
    "broad",
    "broad",
    "selective",
    "selective",
    "availability",
  ]);
  assert.notEqual(
    queryForIteration(queries, 0).name,
    queryForIteration(queries, 5).name,
  );
});

test("fixture validation accepts exact DTO and rejects wrong status, identifiers, ratings, and availability", async () => {
  const { validateResponse } = await modelPromise;
  assert.deepEqual(validateResponse(200, body, query), {
    ok: true,
    reason: "ok",
  });
  assert.equal(validateResponse(503, body, query).reason, "non_200");
  const withPrice = {
    ...query,
    expected: {
      ...query.expected,
      items: [{ ...query.expected.items[0], hourlyRate: "300.00" }],
    },
  };
  assert.equal(
    validateResponse(200, body, withPrice).reason,
    "incorrect_public_details",
  );
  assert.equal(
    validateResponse(
      200,
      {
        ...body,
        items: [
          {
            ...body.items[0],
            subject: { ...body.items[0].subject, hourlyRate: "300.00" },
          },
        ],
      },
      withPrice,
    ).ok,
    true,
  );

  assert.equal(
    validateResponse(
      200,
      {
        ...body,
        items: [
          { ...body.items[0], subject: { id: "other", tutorId: "tutor-1" } },
        ],
      },
      query,
    ).reason,
    "missing_expected_item",
  );
  assert.equal(
    validateResponse(
      200,
      { ...body, items: [{ ...body.items[0], rating: undefined }] },
      query,
    ).reason,
    "incorrect_rating",
  );
  assert.equal(
    validateResponse(
      200,
      { ...body, items: [{ ...body.items[0], nextAvailableAt: null }] },
      query,
    ).reason,
    "incorrect_availability",
  );
  assert.equal(
    validateResponse(200, { ...body, pagination: { totalItems: 2 } }, query)
      .reason,
    "incorrect_total",
  );
  assert.equal(
    validateResponse(
      200,
      { ...body, items: [...body.items, body.items[0]] },
      query,
    ).reason,
    "incorrect_page_size",
  );
  assert.equal(
    validateResponse(
      200,
      {
        ...body,
        items: [{ ...body.items[0], rating: { reviewCount: 2, average: 4.5 } }],
      },
      query,
    ).reason,
    "incorrect_rating",
  );
  assert.equal(
    validateResponse(
      200,
      {
        ...body,
        items: [
          {
            ...body.items[0],
            rating: {
              ...body.items[0].rating,
              distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 2 },
            },
          },
        ],
      },
      query,
    ).reason,
    "incorrect_rating",
  );
  assert.equal(
    validateResponse(
      200,
      {
        ...body,
        items: [
          { ...body.items[0], rating: { ...body.items[0].rating, average: 3 } },
        ],
      },
      query,
    ).reason,
    "incorrect_rating",
  );
  assert.equal(
    validateResponse(
      200,
      JSON.stringify({
        ...body,
        items: [{ ...body.items[0], userId: "private" }],
      }),
      query,
    ).reason,
    "private_field_leak",
  );
});

function summary({
  p95 = 240,
  combined = 0,
  dropped = 0,
  iterations = 60,
  durationMs = 30_000,
  includeCategory = true,
  thresholdOk = true,
} = {}) {
  const metrics = {};
  const set = (name, values, threshold = false) => {
    metrics[name] = {
      values,
      ...(threshold ? { thresholds: { threshold: { ok: thresholdOk } } } : {}),
    };
  };
  for (const category of ["broad", "selective", "availability"]) {
    if (!includeCategory && category === "availability") continue;
    set(
      `discovery_latency{category:${category}}`,
      { med: 150, "p(95)": p95, "p(99)": 400 },
      true,
    );
    set(`discovery_transport_failed{category:${category}}`, { rate: 0 }, true);
    set(`discovery_semantic_failed{category:${category}}`, { rate: 0 }, true);
    set(`discovery_requests{category:${category}}`, { count: 20 });
    set(`discovery_failed{category:${category}}`, { rate: 0 }, true);
  }
  set("discovery_latency", { med: 150, "p(95)": p95, "p(99)": 400 }, true);
  set("discovery_transport_failed", { rate: 0 });
  set("discovery_semantic_failed", { rate: 0 });
  set("discovery_failed", { rate: combined }, true);
  set("discovery_requests", { rate: 10, count: 60 });
  if (dropped > 0) set("dropped_iterations", { count: dropped });
  set("iterations", { count: iterations });
  return { state: { testRunDurationMs: durationMs }, metrics };
}

test("summary normalization passes only complete samples within latency, failure, and dropped limits", async () => {
  const { normalizeSummary } = await modelPromise;
  const normalize = (options = {}) =>
    normalizeSummary(summary(options), {
      mode: "arrival",
      duration: "30s",
      ratePerSecond: 2,
    });
  assert.equal(normalize().assessment.pass, true);
  assert.deepEqual(normalize().overall.latency, {
    p50: 150,
    p95: 240,
    p99: 400,
  });
  assert.equal(
    normalize({ combined: 0.05 }).overall.successfulRequestsPerSecond,
    9.5,
  );
  assert.equal(normalize({ combined: 0.05 }).scheduleComplete, true);
  assert.equal(normalize({ p95: 500 }).assessment.pass, false);
  assert.equal(normalize({ combined: 0.01 }).assessment.pass, false);
  assert.equal(
    normalize({ dropped: 1, iterations: 59 }).assessment.pass,
    false,
  );
  assert.equal(normalize().assessment.pass, true);
  assert.equal(
    normalize({ includeCategory: false }).assessment.complete,
    false,
  );
  assert.equal(normalize({ thresholdOk: false }).assessment.pass, false);
  assert.equal(normalize({ thresholdOk: false }).assessment.complete, true);
  assert.equal(normalize({ durationMs: 29_000 }).assessment.complete, false);
  assert.equal(normalize({ durationMs: 29_000 }).scheduleComplete, false);
  assert.equal(normalize({ iterations: 40 }).assessment.complete, false);
  assert.equal(normalize({ iterations: 65 }).assessment.complete, false);
  assert.equal(normalize({ durationMs: 29_000 }).observedDurationMs, 29_000);
  const concurrency = normalizeSummary(summary({ iterations: 8 }), {
    mode: "concurrency",
    duration: "30s",
    vus: 50,
  });
  assert.equal(concurrency.assessment.complete, true);
  assert.equal(concurrency.schedule.expectedArrivals, null);
});
