import { test, expect, type Page, type Route } from "@playwright/test";

const userId = "10000000-0000-4000-8000-000000000001";
const tutorId = "20000000-0000-4000-8000-000000000001";
const tutorUserId = "10000000-0000-4000-8000-000000000002";
const subjectId = "30000000-0000-4000-8000-000000000001";
const bookingId = "40000000-0000-4000-8000-000000000001";
const reviewId = "50000000-0000-4000-8000-000000000001";
const draftId = "60000000-0000-4000-8000-000000000001";
const pageMeta = { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
const account = {
  id: userId,
  firstName: "Jamie",
  lastName: "Lee",
  email: "jamie@example.test",
  capabilities: ["STUDENT"],
  status: "ACTIVE",
  revision: "1",
};
const subject = {
  id: subjectId,
  tutorId,
  tutorUserId,
  name: "Algebra",
  description: "Learn algebra step by step",
  hourlyRate: "400.00",
  format: "ONLINE",
  learningAreas: ["mathematics"],
  revision: "1",
};
const rating = {
  subjectId,
  average: null,
  reviewCount: 0,
  distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
};
const tutor = {
  id: tutorId,
  userId: tutorUserId,
  displayName: "Alex Tutor",
  headline: "Friendly maths lessons",
  bio: "I teach algebra.",
  avatarUrl: null,
  introVideoUrl: null,
  verified: true,
  subjects: [subject],
  recentReviews: [],
};
const review = {
  id: reviewId,
  bookingId,
  studentUserId: userId,
  tutorId,
  tutorUserId,
  subjectId,
  rating: 5,
  text: "Clear explanations and helpful practice.",
  headline: "Helpful lesson",
  reply: null as { id: string; text: string; createdAt: string } | null,
  visibility: "PUBLIC",
  revision: "1",
  createdAt: "2026-11-09T04:00:00.000Z",
  studentDisplayName: "Jamie Lee",
};
const submission = {
  id: draftId,
  userId,
  kind: "APPLICATION",
  state: "DRAFT",
  activation: "NOT_REQUIRED",
  bio: "",
  headline: "",
  identificationDocumentUrl: null as string | null,
  introVideoUrl: null as string | null,
  avatarUrl: null,
  rejectionReason: null,
  revision: "1",
  submittedAt: null as string | null,
  reviewedAt: null,
};
const workspace = {
  tutorId: null as string | null,
  published: false,
  activation: "NONE",
  currentSubmissionId: null as string | null,
  drafts: [] as (typeof submission)[],
  submissions: [] as (typeof submission)[],
  revision: "1",
};
function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}
async function signedIn(page: Page, capabilities = ["STUDENT"], id = userId) {
  await page.addInitScript(() =>
    sessionStorage.setItem("tm.session.token", "synthetic-marketplace-session"),
  );
  await page.route("**/api/auth/me", (route) =>
    json(route, { ...account, id, capabilities }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/discovery/learning-areas")
      return json(route, {
        items: [{ id: "mathematics", label: "Mathematics" }],
      });
    if (url.pathname === "/api/discovery/price-range")
      return json(route, {
        minimum: { currency: "THB", amount: "100.00" },
        maximum: { currency: "THB", amount: "800.00" },
      });
    if (url.pathname === "/api/profiles/me/student")
      return json(route, {
        learningAreas: ["mathematics"],
        level: "Beginner",
        goals: "",
        preferredPeriods: [],
        revision: "1",
      });
    if (url.pathname === "/api/reviews")
      return json(route, { items: [], pagination: pageMeta });
    return json(
      route,
      {
        code: "UNMODELED_TEST_REQUEST",
        message: `No fixture for ${url.pathname}`,
      },
      501,
    );
  });
});

test("application supports private draft, consent submission, withdrawal and copying immutable history", async ({
  page,
}) => {
  await signedIn(page);
  const state = structuredClone(workspace);
  let posted: Record<string, unknown> | null = null;
  await page.route("**/api/profiles/me/tutor**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET") return json(route, state);
    expect(route.request().headers()["idempotency-key"]).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    if (url.pathname.endsWith("/drafts") && method === "POST") {
      posted = route.request().postDataJSON();
      const draft = { ...submission, ...posted, revision: "1" };
      state.drafts = [draft];
      return json(route, draft, 201);
    }
    if (url.pathname.endsWith("/submit")) {
      expect(route.request().postDataJSON()).toEqual({ consentAccepted: true });
      expect(route.request().headers()["if-match"]).toBe('"1"');
      state.submissions = [
        {
          ...state.drafts[0],
          state: "PENDING",
          revision: "2",
          submittedAt: "2026-11-10T08:00:00Z",
        },
      ];
      state.drafts = [];
      return json(route, state.submissions[0]);
    }
    if (url.pathname.endsWith("/withdraw")) {
      state.submissions[0] = {
        ...state.submissions[0],
        state: "CANCELLED",
        revision: "3",
      };
      return json(route, state.submissions[0]);
    }
    if (url.pathname.endsWith("/copy")) {
      state.drafts = [
        {
          ...state.submissions[0],
          id: "60000000-0000-4000-8000-000000000002",
          state: "DRAFT",
          revision: "1",
          submittedAt: null,
        },
      ];
      return json(route, state.drafts[0], 201);
    }
    return json(route, { message: "Unexpected action" }, 500);
  });
  await page.goto("/teach/application");
  await page.getByRole("button", { name: "Create application draft" }).click();
  await page
    .getByLabel("Headline", { exact: true })
    .fill("Patient maths tutor");
  await page
    .getByLabel("Bio", { exact: true })
    .fill("I teach maths with clear examples.");
  await page
    .getByLabel("Identification document URL (private)")
    .fill("https://example.test/private-id");
  await page
    .getByLabel("Introduction video URL")
    .fill("https://example.test/intro");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const editor = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "Edit draft", exact: true }),
  });
  await expect(editor).toBeVisible();
  expect(posted).toMatchObject({
    bio: "I teach maths with clear examples.",
    identificationDocumentUrl: "https://example.test/private-id",
  });
  await expect(
    editor.getByRole("button", { name: "Submit saved draft" }),
  ).toBeDisabled();
  await editor.getByRole("checkbox").check();
  await editor.getByRole("button", { name: "Submit saved draft" }).click();
  await expect(
    page.getByRole("button", { name: "Withdraw submission" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Withdraw submission" }).click();
  await expect(
    page.getByRole("button", { name: "Copy into a new draft" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy into a new draft" }).click();
  await expect(editor).toBeVisible();
  expect(state.submissions[0].state).toBe("CANCELLED");
});

test("uncertain draft retry keeps original payload and idempotency key", async ({
  page,
}) => {
  await signedIn(page);
  await page.route("**/api/profiles/me/tutor", (route) =>
    json(route, workspace),
  );
  const commands: { key: string; body: unknown }[] = [];
  await page.route("**/api/profiles/me/tutor/drafts", async (route) => {
    commands.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    if (commands.length === 1)
      return json(
        route,
        { message: "Dependency is temporarily unavailable" },
        503,
      );
    return json(
      route,
      { ...submission, ...route.request().postDataJSON() },
      201,
    );
  });
  await page.goto("/teach/application");
  await page.getByRole("button", { name: "Create application draft" }).click();
  await page.getByLabel("Bio", { exact: true }).fill("Original draft content");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry original action" }),
  ).toBeVisible();
  await page.getByLabel("Bio", { exact: true }).fill("Changed browser field");
  await page.getByRole("button", { name: "Retry original action" }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual(commands[0]);
});

test("admin approval displays durable activation pending and checks its status", async ({
  page,
}) => {
  await signedIn(page, ["STUDENT", "ADMIN"]);
  let item = {
    ...submission,
    state: "PENDING",
    bio: "Tutor bio",
    identificationDocumentUrl: "https://example.test/private-id",
    introVideoUrl: "https://example.test/video",
    submittedAt: "2026-11-10T08:00:00Z",
  };
  const operation = {
    id: draftId,
    owner: "tutor",
    status: "PENDING",
    statusUrl: `/api/operations/tutor/${draftId}`,
    resource: null,
  };
  await page.route(`**/api/admin/tutor-requests/${draftId}`, (route) =>
    json(route, item),
  );
  await page.route(`**/api/admin/tutor-requests/${draftId}/review`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ decision: "APPROVE" });
    item = { ...item, state: "APPROVED", activation: "PENDING" };
    return json(route, operation, 202);
  });
  await page.route(`**/api/operations/tutor/${draftId}`, (route) =>
    json(route, { ...operation, status: "SUCCEEDED" }),
  );
  await page.goto(`/admin/tutor-requests/${draftId}`);
  await expect(
    page.getByRole("link", { name: "Open private identification document" }),
  ).toHaveAttribute("href", "https://example.test/private-id");
  await page.getByRole("button", { name: "Save review decision" }).click();
  await expect(
    page.getByText("Approval is saved. Auth activation is pending.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check processing status" }).click();
  await expect(page.getByText("Processing finished.")).toBeVisible();
});

test("unapproved students cannot access subject management controls", async ({
  page,
}) => {
  await signedIn(page);
  await page.goto("/teach/subjects");
  await expect(
    page.getByText("Approved and activated Tutor access is required").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create subject" }),
  ).toHaveCount(0);
});

test("discovery preserves filters, includes saved preferences and renders genuine unrated state", async ({
  page,
}) => {
  await signedIn(page);
  const searches: URL[] = [];
  await page.route("**/api/discovery/tutors?**", (route) => {
    searches.push(new URL(route.request().url()));
    return json(route, {
      items: [
        {
          subject,
          tutorDisplayName: tutor.displayName,
          rating,
          nextAvailableAt: null,
          classesTaught: null,
          classesTaughtAvailable: false,
        },
      ],
      pagination: { ...pageMeta, totalItems: 1, totalPages: 1 },
    });
  });
  await page.goto("/discover?q=algebra&sort=PRICE_ASC");
  await expect(page.getByLabel("Keyword")).toHaveValue("algebra");
  await expect(page.getByText("No ratings yet (0 reviews)")).toBeVisible();
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("preferredLearningAreas"))
    .toBe("mathematics");
  await page.getByLabel("Maximum hourly rate (THB)").fill("500.00");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/maxRate=500.00/);
  await expect(
    page.getByRole("link", { name: "View subject and availability" }),
  ).toHaveAttribute("href", `/tutors/${tutorId}/subjects/${subjectId}`);
  expect(searches.at(-1)?.searchParams.get("sort")).toBe("PRICE_ASC");
});

test("discovery dependency failures stay visible instead of empty search results", async ({
  page,
}) => {
  await page.route("**/api/discovery/tutors?**", (route) =>
    json(
      route,
      {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Rating service is unavailable",
      },
      503,
    ),
  );
  await page.goto("/discover");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Rating service is unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText("No subjects match these filters.", { exact: false }),
  ).toHaveCount(0);
});

test("subject selection rejects gaps and preserves consecutive slots in booking destination", async ({
  page,
}) => {
  await signedIn(page);
  const day = new Date(Date.now() + 48 * 3600 * 1000);
  day.setUTCHours(3, 0, 0, 0);
  const slots = [0, 1, 3].map((offset, index) => ({
    id: `70000000-0000-4000-8000-00000000000${index + 1}`,
    tutorId,
    subjectIds: [subjectId],
    startsAt: new Date(day.getTime() + offset * 1800000).toISOString(),
    endsAt: new Date(day.getTime() + (offset + 1) * 1800000).toISOString(),
    revision: "1",
  }));
  await page.route(
    `**/api/discovery/tutors/${tutorId}/subjects/${subjectId}?**`,
    (route) =>
      json(route, {
        tutor,
        subject,
        rating,
        selectedDate: "2026-11-12",
        slots,
        reviews: [],
      }),
  );
  await page.goto(`/tutors/${tutorId}/subjects/${subjectId}`);
  const choices = page.getByRole("checkbox");
  await choices.nth(0).check();
  await choices.nth(2).check();
  await expect(
    page.getByText("Choose consecutive future half-hour slots on this day."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue to booking" }),
  ).toHaveCount(0);
  await choices.nth(2).uncheck();
  await choices.nth(1).check();
  const destination = new URL(
    (await page
      .getByRole("link", { name: "Continue to booking" })
      .getAttribute("href")) ?? "",
    "http://example.test",
  );
  expect(destination.pathname).toBe("/bookings/new");
  expect(destination.searchParams.get("slotIds")).toBe(
    `${slots[0].id},${slots[1].id}`,
  );
  expect(destination.searchParams.get("subjectId")).toBe(subjectId);
  await expect(page.getByText("2 slots selected, 1 hours.")).toBeVisible();
});

test("completed booking owner can publish one review with a stable command", async ({
  page,
}) => {
  await signedIn(page);
  await page.route(`**/api/bookings/${bookingId}`, (route) =>
    json(route, {
      id: bookingId,
      status: "COMPLETED",
      studentUserId: userId,
      canReview: true,
      tutorId,
      tutorDisplayName: tutor.displayName,
      subject: { name: subject.name },
      completedAt: "2026-11-09T04:00:00Z",
    }),
  );
  let written: unknown;
  await page.route(`**/api/bookings/${bookingId}/review`, (route) => {
    written = route.request().postDataJSON();
    return json(route, review, 201);
  });
  await page.goto(`/reviews/new?bookingId=${bookingId}`);
  await page.getByLabel("Your review", { exact: true }).fill(review.text);
  await page.getByLabel("Headline (optional)").fill(review.headline);
  await page.getByRole("button", { name: "Publish review" }).click();
  await expect(page.getByText("Your review has been published.")).toBeVisible();
  expect(written).toEqual({
    rating: 5,
    text: review.text,
    headline: review.headline,
  });
  await expect(
    page.getByRole("button", { name: "Publish review" }),
  ).toHaveCount(0);
});

test("other students cannot open the review form for someone else's booking", async ({
  page,
}) => {
  await signedIn(page, ["STUDENT"], tutorUserId);
  await page.route(`**/api/bookings/${bookingId}`, (route) =>
    json(route, {
      id: bookingId,
      status: "COMPLETED",
      studentUserId: userId,
      canReview: false,
      tutorId,
      tutorDisplayName: tutor.displayName,
      subject: { name: subject.name },
      completedAt: "2026-11-09T04:00:00Z",
    }),
  );
  await page.goto(`/reviews/bookings/${bookingId}`);
  await expect(
    page.getByText("This booking is not eligible for a new review.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish review" }),
  ).toHaveCount(0);
});

test("assigned tutor replies once and signed-in users can flag with a reason", async ({
  page,
}) => {
  await signedIn(page, ["STUDENT", "TUTOR"], tutorUserId);
  let current = structuredClone(review);
  await page.route(`**/api/discovery/tutors/${tutorId}/profile`, (route) =>
    json(route, tutor),
  );
  await page.route("**/api/reviews?**", (route) =>
    json(route, {
      items: [current],
      pagination: { ...pageMeta, totalItems: 1, totalPages: 1 },
    }),
  );
  await page.route(`**/api/reviews/${reviewId}/reply`, (route) => {
    expect(route.request().headers()["if-match"]).toBe('"1"');
    current = {
      ...current,
      revision: "2",
      reply: {
        id: draftId,
        text: route.request().postDataJSON().text,
        createdAt: "2026-11-10T04:00:00Z",
      },
    };
    return json(route, current);
  });
  await page.route(`**/api/reviews/${reviewId}/flags`, (route) => {
    expect(route.request().postDataJSON()).toEqual({
      reason: "Please check this review",
    });
    return json(route, { id: draftId }, 201);
  });
  await page.goto(`/tutors/${tutorId}`);
  await page.getByLabel("Your reply").fill("Thank you for learning with me.");
  await page.getByRole("button", { name: "Post tutor reply" }).click();
  await expect(page.getByText("Thank you for learning with me.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Post tutor reply" }),
  ).toHaveCount(0);
  await page.getByText("Report this review", { exact: true }).click();
  await page.getByLabel("Report reason").fill("Please check this review");
  await page.getByRole("button", { name: "Submit report" }).click();
  await expect(
    page.getByText("Your report was submitted for moderation."),
  ).toBeVisible();
});

test("moderation shows private reporter and full review, then sends reason and review revision", async ({
  page,
}) => {
  await signedIn(page, ["STUDENT", "ADMIN"]);
  let items = [
    {
      flag: {
        id: draftId,
        reviewId,
        reporterUserId: userId,
        reason: "Abusive reply",
        state: "OPEN",
        revision: "1",
        createdAt: "2026-11-10T04:00:00Z",
      },
      review: {
        ...review,
        reply: {
          id: draftId,
          text: "Reported tutor reply",
          createdAt: "2026-11-10T04:00:00Z",
        },
      },
      reporterDisplayName: "Jamie Reporter",
    },
  ];
  await page.route("**/api/admin/review-flags?**", (route) =>
    json(route, {
      items,
      pagination: {
        ...pageMeta,
        totalItems: items.length,
        totalPages: items.length ? 1 : 0,
      },
    }),
  );
  let command: unknown;
  await page.route(`**/api/admin/reviews/${reviewId}/moderation`, (route) => {
    command = route.request().postDataJSON();
    expect(route.request().headers()["if-match"]).toBe('"1"');
    items = [];
    return json(route, { ...review, visibility: "HIDDEN", revision: "2" });
  });
  await page.goto("/admin/review-flags");
  await expect(page.getByText("Reported by Jamie Reporter")).toBeVisible();
  await expect(page.getByText("Reported tutor reply")).toBeVisible();
  await page.getByLabel("Moderation decision").selectOption("HIDE");
  await page
    .getByLabel("Moderation reason")
    .fill("The full review violates the content policy.");
  await page.getByRole("button", { name: "Save moderation decision" }).click();
  await expect(page.getByText("No review reports.")).toBeVisible();
  expect(command).toEqual({
    decision: "HIDE",
    reason: "The full review violates the content policy.",
  });
});

test("stale owned subject edit preserves unsaved form and sends the resource revision", async ({
  page,
}) => {
  await signedIn(page, ["STUDENT", "TUTOR"], tutorUserId);
  const items = [structuredClone(subject)];
  await page.route("**/api/profiles/me/tutor/subjects?**", (route) =>
    json(route, {
      items,
      pagination: { ...pageMeta, totalItems: items.length, totalPages: 1 },
    }),
  );
  let updateCount = 0;
  await page.route(
    `**/api/profiles/me/tutor/subjects/${subjectId}`,
    (route) => {
      expect(route.request().headers()["if-match"]).toBe('"1"');
      updateCount++;
      return json(
        route,
        {
          code: "REVISION_MISMATCH",
          message: "This subject changed. Your draft has not been saved.",
        },
        412,
      );
    },
  );
  await page.goto("/teach/subjects");
  const editor = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "Edit Algebra", exact: true }),
  });
  await editor
    .getByLabel("Description", { exact: true })
    .fill("My unsaved subject description");
  await editor
    .getByRole("button", { name: "Save subject", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText(
    "Your draft has not been saved",
  );
  await expect(editor.getByLabel("Description", { exact: true })).toHaveValue(
    "My unsaved subject description",
  );
  expect(updateCount).toBe(1);
  expect(items[0].hourlyRate).toBe("400.00");
  expect(items[0].format).toBe("ONLINE");
});

test("public tutor page renders approved fields without private document URLs", async ({
  page,
}) => {
  const privateUrl = "https://example.test/never-public-identity-document";
  await page.route(`**/api/discovery/tutors/${tutorId}/profile`, (route) =>
    json(route, { ...tutor, identificationDocumentUrl: privateUrl }),
  );
  await page.goto(`/tutors/${tutorId}`);
  await expect(
    page.getByRole("heading", { name: tutor.displayName }),
  ).toBeVisible();
  await expect(page.locator(`a[href="${privateUrl}"]`)).toHaveCount(0);
  await expect(page.getByText(privateUrl)).toHaveCount(0);
});

test("mobile discovery stays within viewport with usable search controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/discovery/tutors?**", (route) =>
    json(route, {
      items: [
        {
          subject,
          tutorDisplayName: tutor.displayName,
          rating,
          nextAvailableAt: null,
          classesTaught: null,
          classesTaughtAvailable: false,
        },
      ],
      pagination: { ...pageMeta, totalItems: 1, totalPages: 1 },
    }),
  );
  await page.goto("/discover");
  await expect(
    page.getByRole("link", { name: "View subject and availability" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../../docs/evidence/ideal/visual/discovery-mobile.png",
    fullPage: true,
  });
});

test("desktop application has usable private draft controls", async ({
  page,
}) => {
  await signedIn(page);
  await page.route("**/api/profiles/me/tutor", (route) =>
    json(route, {
      ...workspace,
      drafts: [
        {
          ...submission,
          headline: "My tutor application",
          bio: "I teach maths with clear examples.",
        },
      ],
    }),
  );
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.goto("/teach/application");
  await expect(page.getByRole("heading", { name: "Edit draft" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../../docs/evidence/ideal/visual/application-desktop.png",
    fullPage: true,
  });
});

test("approved tutor creates a positive-rate Online subject in one to three areas", async ({
  page,
}) => {
  await signedIn(page, ["STUDENT", "TUTOR"], tutorUserId);
  const items: (typeof subject)[] = [];
  await page.route("**/api/profiles/me/tutor/subjects?**", (route) =>
    json(route, {
      items,
      pagination: {
        ...pageMeta,
        totalItems: items.length,
        totalPages: items.length ? 1 : 0,
      },
    }),
  );
  let command: unknown;
  await page.route("**/api/profiles/me/tutor/subjects", (route) => {
    command = route.request().postDataJSON();
    items.push({ ...subject, ...route.request().postDataJSON() });
    return json(route, items[0], 201);
  });
  await page.goto("/teach/subjects");
  const editor = page
    .locator("section.panel")
    .filter({
      has: page.getByRole("heading", { name: "Create a subject", exact: true }),
    });
  await editor.getByLabel("Subject name").fill("Algebra");
  await editor.getByLabel("Description").fill(subject.description);
  await editor.getByLabel("Hourly rate (THB)").fill("400.00");
  await editor.getByLabel("Mathematics").check();
  await editor
    .getByRole("button", { name: "Create subject", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Edit Algebra", exact: true }),
  ).toBeVisible();
  expect(command).toEqual({
    name: "Algebra",
    description: subject.description,
    hourlyRate: "400.00",
    format: "ONLINE",
    learningAreas: ["mathematics"],
  });
});
