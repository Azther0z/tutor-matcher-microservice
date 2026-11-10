import http from "k6/http";
import exec from "k6/execution";
import { check, fail } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import {
  queryForIteration,
  validateResponse,
  normalizeSummary,
} from "./discovery-model.mjs";

const base = (__ENV.BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const allowedHosts = ["localhost", "127.0.0.1", "::1", "[::1]", "api-gateway"];
const baseMatch = base.match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)(?::\d+)?$/i);
const baseHost = baseMatch?.[1]?.toLowerCase();
if (!baseHost || !allowedHosts.includes(baseHost))
  throw new Error(
    "BASE_URL must be an HTTP(S) origin using loopback or api-gateway in the isolated Docker network",
  );
const fixtureFile = __ENV.FIXTURE_FILE;
if (!fixtureFile) throw new Error("FIXTURE_FILE is required");
const fixture = JSON.parse(open(fixtureFile));
if (!Array.isArray(fixture.queries) || fixture.queries.length === 0)
  throw new Error("fixture must contain queries");
for (const query of fixture.queries) {
  if (
    !query ||
    !["broad", "selective", "availability"].includes(query.category) ||
    typeof query.path !== "string" ||
    !query.path.startsWith("/api/discovery/tutors") ||
    !query.expected ||
    !Number.isFinite(query.expected.total) ||
    !Array.isArray(query.expected.items)
  )
    throw new Error(
      "fixture query is missing category, discovery path, or expected results",
    );
}
const fixtureCategories = new Set(
  fixture.queries.map((query) => query.category),
);
if (
  ["broad", "selective", "availability"].some(
    (category) => !fixtureCategories.has(category),
  )
)
  throw new Error("fixture needs at least one query for each search category");
const mode = __ENV.MODE || "arrival";
const duration = __ENV.DURATION || "300s";
const ratePerSecond = Number(__ENV.RATE_PER_SECOND || 10);
const vus = Number(__ENV.VUS || 50);
const preAllocatedVUs = Number(__ENV.PREALLOCATED_VUS || 50);
const maxVUs = Number(__ENV.MAX_VUS || 200);
if (!["arrival", "concurrency"].includes(mode))
  throw new Error("MODE must be arrival or concurrency");
if (!(ratePerSecond > 0) || !Number.isFinite(ratePerSecond))
  throw new Error("RATE_PER_SECOND must be positive");
if (!Number.isInteger(vus) || vus < 1)
  throw new Error("VUS must be a positive integer");
if (
  !Number.isInteger(preAllocatedVUs) ||
  preAllocatedVUs < 1 ||
  !Number.isInteger(maxVUs) ||
  maxVUs < preAllocatedVUs
)
  throw new Error(
    "PREALLOCATED_VUS and MAX_VUS must be positive integers with MAX_VUS >= PREALLOCATED_VUS",
  );

const latency = new Trend("discovery_latency", true);
const requests = new Counter("discovery_requests");
const transportFailed = new Rate("discovery_transport_failed");
const semanticFailed = new Rate("discovery_semantic_failed");
const combinedFailed = new Rate("discovery_failed");

const thresholds = {
  discovery_latency: ["p(95)<500"],
  discovery_failed: ["rate<0.01"],
  "discovery_latency{category:broad}": ["p(95)<500"],
  "discovery_latency{category:selective}": ["p(95)<500"],
  "discovery_latency{category:availability}": ["p(95)<500"],
  "discovery_failed{category:broad}": ["rate<0.01"],
  "discovery_failed{category:selective}": ["rate<0.01"],
  "discovery_failed{category:availability}": ["rate<0.01"],
  "discovery_transport_failed{category:broad}": ["rate<0.01"],
  "discovery_transport_failed{category:selective}": ["rate<0.01"],
  "discovery_transport_failed{category:availability}": ["rate<0.01"],
  "discovery_semantic_failed{category:broad}": ["rate<0.01"],
  "discovery_semantic_failed{category:selective}": ["rate<0.01"],
  "discovery_semantic_failed{category:availability}": ["rate<0.01"],
  "discovery_requests{category:broad}": ["count>0"],
  "discovery_requests{category:selective}": ["count>0"],
  "discovery_requests{category:availability}": ["count>0"],
};

export const options = {
  scenarios: {
    discovery:
      mode === "arrival"
        ? {
            executor: "constant-arrival-rate",
            rate: Math.max(1, Math.round(ratePerSecond * 10)),
            timeUnit: "10s",
            duration,
            preAllocatedVUs,
            maxVUs,
          }
        : { executor: "constant-vus", vus, duration },
  },
  thresholds,
  summaryTrendStats: ["min", "avg", "med", "max", "p(95)", "p(99)"],
};

export function setup() {
  for (const query of fixture.queries) {
    const response = http.get(`${base}${query.path}`, {
      timeout: "5s",
      tags: { phase: "preflight", category: query.category },
    });
    const result = validateResponse(response.status, response.body, query);
    if (!result.ok)
      fail(
        `Fixture preflight failed for ${query.name || query.path}: ${result.reason}`,
      );
  }
}

export default function () {
  const query = queryForIteration(
    fixture.queries,
    exec.scenario.iterationInTest,
  );
  const tags = { category: query.category };
  const started = Date.now();
  const response = http.get(`${base}${query.path}`, {
    timeout: "5s",
    tags: { operation: "discovery_search", ...tags },
  });
  const elapsed = Date.now() - started;
  const transportBad = response.status !== 200;
  const result = validateResponse(response.status, response.body, query);
  const semanticBad = !transportBad && !result.ok;
  const failed = transportBad || semanticBad;
  latency.add(elapsed, tags);
  requests.add(1, tags);
  transportFailed.add(transportBad, tags);
  semanticFailed.add(semanticBad, tags);
  combinedFailed.add(failed, tags);
  check(response, { "discovery response matches fixture": () => !failed });
}

export function handleSummary(data) {
  const config = { mode, duration, ratePerSecond, vus, baseUrl: base };
  const report = normalizeSummary(data, config);
  const path = __ENV.SUMMARY_PATH || "discovery-summary.json";
  return { [path]: JSON.stringify({ report, raw: data }, null, 2) };
}
