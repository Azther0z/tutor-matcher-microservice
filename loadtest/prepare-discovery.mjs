import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const base = (process.env.BASE_URL || "http://127.0.0.1:8080").replace(
  /\/$/,
  "",
);
const baseUrl = new URL(base);
assert.ok(
  ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname),
  "BASE_URL must point to an isolated local environment.",
);
assert.equal(
  process.env.SYNTHETIC_LOADTEST,
  "true",
  "Set SYNTHETIC_LOADTEST=true only for an isolated synthetic environment.",
);
const admin = process.env.LOADTEST_ADMIN_TOKEN;
assert.ok(
  admin,
  "Supply the current synthetic Admin token through LOADTEST_ADMIN_TOKEN.",
);
assert.ok(
  process.env.FIXTURE_OUTPUT,
  "Set FIXTURE_OUTPUT to a new manifest path.",
);

const tutorCount = 24;
const runId = randomUUID();
const marker = `SyntheticDiscovery-${runId.slice(0, 8)}`;
const areas = [
  "mathematics",
  "english",
  "science",
  "physics",
  "chemistry",
  "biology",
];
const items = [];
const date = new Date(Date.now() + 3 * 86400000).toLocaleDateString("en-CA", {
  timeZone: "Asia/Bangkok",
});

async function request(
  path,
  { token, body, method = "GET", revision, ifNoneMatch } = {},
) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      "X-Request-Id": randomUUID(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(revision === undefined ? {} : { "If-Match": `"${revision}"` }),
      ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json();
  assert.ok(
    response.ok,
    `${method} ${path} failed with HTTP ${response.status} (${data?.code || "unknown"}).`,
  );
  return data;
}

for (let index = 0; index < tutorCount; index += 1) {
  const password = randomBytes(24).toString("base64url");
  const account = await request("/auth/signup", {
    method: "POST",
    body: {
      firstName: `Fixture${String(index).padStart(2, "0")}`,
      lastName: "DiscoveryTutor",
      email: `${runId}-${index}@load.invalid`,
      password,
      passwordConfirmation: password,
      termsAccepted: true,
      privacyAccepted: true,
    },
  });
  const token = account.token;
  assert.ok(
    token && account.user?.id,
    "Synthetic signup did not return a session and user identity.",
  );

  const draft = await request("/profiles/me/tutor/drafts", {
    token,
    method: "POST",
    body: {
      bio: "Synthetic discovery load-test tutor, not a real person.",
      headline: marker,
      identificationDocumentUrl: "https://documents.invalid/synthetic-id",
      introVideoUrl: "https://video.invalid/synthetic-introduction",
    },
  });
  const submitted = await request(
    `/profiles/me/tutor/drafts/${draft.id}/submit`,
    {
      token,
      method: "POST",
      revision: draft.revision,
      body: { consentAccepted: true },
    },
  );
  await request(`/admin/tutor-requests/${submitted.id}/review`, {
    token: admin,
    method: "POST",
    revision: submitted.revision,
    body: { decision: "APPROVE" },
  });

  let workspace;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    workspace = await request("/profiles/me/tutor", { token });
    if (workspace.activation === "ACTIVE") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(
    workspace.activation,
    "ACTIVE",
    "Auth activation did not complete.",
  );

  for (let subjectIndex = 0; subjectIndex < 2; subjectIndex += 1) {
    const area = areas[(index * 2 + subjectIndex) % areas.length];
    const tutorName = `Fixture${String(index).padStart(2, "0")} DiscoveryTutor`;
    const name = `${marker} Tutor${String(index).padStart(2, "0")} Subject${subjectIndex}`;
    const description = `Synthetic ${marker} discovery offering in ${area}.`;
    const hourlyRate = `${300 + index * 5 + subjectIndex * 20}.00`;
    const subject = await request("/profiles/me/tutor/subjects", {
      token,
      method: "POST",
      body: {
        name,
        description,
        hourlyRate,
        format: "ONLINE",
        learningAreas: [area],
      },
    });
    items.push({
      userId: account.user.id,
      tutorId: workspace.tutorId,
      subjectId: subject.id,
      subjectName: name,
      description,
      tutorDisplayName: tutorName,
      hourlyRate,
      learningArea: area,
      reviewCount: 0,
      average: null,
      available: index % 2 === 0 && subjectIndex === 0,
      date: index % 2 === 0 && subjectIndex === 0 ? date : null,
      nextAvailableAt:
        index % 2 === 0 && subjectIndex === 0 ? `${date}T02:00:00.000Z` : null,
    });
  }

  workspace = await request("/profiles/me/tutor", { token });
  await request("/profiles/me/tutor/publication", {
    token,
    method: "PATCH",
    revision: workspace.revision,
    body: { published: true },
  });
  for (const fixture of items.slice(-2)) {
    if (!fixture.available) continue;
    await request(`/profiles/me/tutor/availability/${date}/09:00`, {
      token,
      method: "PUT",
      ifNoneMatch: "*",
      body: { state: "OPEN", subjectIds: [fixture.subjectId] },
    });
  }
}

function params(values) {
  const search = new URLSearchParams({
    page: "1",
    pageSize: "100",
    sort: "PRICE_ASC",
    ...values,
  });
  return `/discovery/tutors?${search}`;
}

const selections = [
  {
    name: "broad-all-fixture-subjects",
    category: "broad",
    path: params({ q: marker }),
    fixtureItems: [...items].sort(
      (a, b) => Number(a.hourlyRate) - Number(b.hourlyRate),
    ),
  },
  {
    name: "selective-mathematics-over-350",
    category: "selective",
    path: params({ q: marker, learningArea: "mathematics", minRate: "350.00" }),
    fixtureItems: [...items]
      .filter(
        (item) =>
          item.learningArea === "mathematics" && Number(item.hourlyRate) >= 350,
      )
      .sort((a, b) => Number(a.hourlyRate) - Number(b.hourlyRate)),
  },
  {
    name: "availability-open-fixture-subject",
    category: "availability",
    path: params({ q: `${marker} Tutor00 Subject0` }),
    fixtureItems: [items[0]],
  },
  {
    name: "availability-no-open-fixture-subject",
    category: "availability",
    path: params({ q: `${marker} Tutor01 Subject0` }),
    fixtureItems: [items[2]],
  },
];

const queries = [];
for (const selection of selections) {
  const data = await request(selection.path);
  assert.equal(
    data.pagination.totalItems,
    selection.fixtureItems.length,
    `${selection.name}: total mismatch`,
  );
  assert.equal(
    data.items.length,
    selection.fixtureItems.length,
    `${selection.name}: page item count mismatch`,
  );
  const actualById = new Map(data.items.map((item) => [item.subject.id, item]));
  const expected = selection.fixtureItems.map((fixture) => {
    const actual = actualById.get(fixture.subjectId);
    assert.ok(
      actual,
      `${selection.name}: expected fixture subject ${fixture.subjectId} missing`,
    );
    assert.equal(actual.subject.tutorId, fixture.tutorId);
    assert.equal(actual.rating.reviewCount, fixture.reviewCount);
    assert.equal(actual.rating.average, fixture.average);
    assert.equal(actual.nextAvailableAt, fixture.nextAvailableAt);
    return {
      subjectId: fixture.subjectId,
      tutorId: fixture.tutorId,
      subjectName: fixture.subjectName,
      hourlyRate: fixture.hourlyRate,
      tutorDisplayName: fixture.tutorDisplayName,
      reviewCount: fixture.reviewCount,
      average: fixture.average,
      nextAvailableAt: fixture.nextAvailableAt,
    };
  });
  assert.equal(
    actualById.size,
    expected.length,
    `${selection.name}: unexpected subjects returned`,
  );
  queries.push({
    name: selection.name,
    category: selection.category,
    path: `/api${selection.path}`,
    expected: { total: expected.length, items: expected },
  });
}

const result = {
  runId,
  searchMarker: marker,
  preparedAt: new Date().toISOString(),
  fixture: {
    tutorCount,
    subjectsPerTutor: 2,
    subjectCount: items.length,
    availableTutorCount: tutorCount / 2,
    unavailableTutorCount: tutorCount / 2,
    reviewCount: 0,
    availabilityDate: date,
  },
  availabilitySemantics: {
    discoveryFilterSupported: false,
    note: "The discovery API has no availability filter; availability-category paths select known open and unavailable fixture subjects and assert their real availability summary.",
  },
  ratingSemantics: {
    note: "Generated tutor subjects have zero reviews; review creation requires an eligible completed booking.",
  },
  queries,
  items,
};
await writeFile(
  process.env.FIXTURE_OUTPUT,
  `${JSON.stringify(result, null, 2)}\n`,
  { flag: "wx" },
);
console.log(JSON.stringify(result, null, 2));
