import http from "k6/http";
import { check, fail } from "k6";

const base = (__ENV.BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const mode = __ENV.TEST_TYPE || "steady";
if (!["steady", "stress"].includes(mode))
  throw new Error("TEST_TYPE must be steady or stress");
const query = __ENV.SEARCH_QUERY || "IdealLoad";
const minimum = Number(__ENV.MIN_RESULTS || 20);
const url = `${base}/api/discovery/tutors?q=${encodeURIComponent(query)}&pageSize=100&sort=RECOMMENDED`;

export const options = {
  scenarios:
    mode === "steady"
      ? {
          search: {
            executor: "constant-vus",
            vus: Number(__ENV.VUS || 50),
            duration: __ENV.DURATION || "30s",
          },
        }
      : {
          search: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
              { duration: "10s", target: 10 },
              { duration: "20s", target: 25 },
              { duration: "20s", target: 50 },
              { duration: "20s", target: 100 },
              { duration: "10s", target: 0 },
            ],
            gracefulRampDown: "5s",
          },
        },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
    checks: ["rate>0.99"],
  },
  tags: {
    test_type: mode,
    tutor_replicas: __ENV.TUTOR_REPLICAS || "unspecified",
    tested_revision: __ENV.TESTED_REVISION || "working-tree",
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "max"],
};

function valid(response) {
  if (response.status !== 200) return false;
  let data;
  try {
    data = response.json();
  } catch {
    return false;
  }
  return (
    Array.isArray(data.items) &&
    data.items.length >= minimum &&
    data.items.every(
      (item) =>
        item.rating &&
        typeof item.rating.reviewCount === "number" &&
        Object.keys(item.rating.distribution || {}).length === 5,
    ) &&
    !/identificationDocumentUrl|passwordHash/.test(response.body)
  );
}

export function setup() {
  const response = http.get(url, { tags: { phase: "preflight" } });
  if (!valid(response))
    fail(
      "Prepare the approved synthetic catalogue and real Booking/Review collaborators first. No measured run started.",
    );
}

export default function () {
  const response = http.get(url, {
    tags: { phase: "measurement", operation: "searchTutorSubjects" },
  });
  check(response, { "target search returns complete public DTOs": valid });
}
