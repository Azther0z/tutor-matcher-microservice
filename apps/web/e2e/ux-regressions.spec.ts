import { expect, test, type Page, type Route } from "@playwright/test";

const account = {
  id: "00000000-0000-4000-8000-000000000101",
  firstName: "Jamie",
  lastName: "Learner",
  email: "jamie@example.test",
  capabilities: ["STUDENT"],
  status: "ACTIVE",
  revision: "0",
};

const apiError = (
  route: Route,
  status: number,
  code: string,
  message: string,
) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "X-Request-Id": "00000000-0000-4000-8000-000000000999" },
    body: JSON.stringify({
      code,
      message,
      requestId: "00000000-0000-4000-8000-000000000999",
      retryable: false,
      fields: [],
    }),
  });

async function signIn(page: Page, capabilities = ["STUDENT"]) {
  await page.addInitScript(() =>
    sessionStorage.setItem("tm.session.token", "synthetic-session-token"),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...account, capabilities }),
    }),
  );
}

test("promised booking, messaging, availability, legal, support, and not-found pages exist", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/api/bookings?**", (route) =>
    apiError(
      route,
      503,
      "SERVICE_UNAVAILABLE",
      "Bookings are temporarily unavailable.",
    ),
  );
  await page.route("**/api/messages/inbox?**", (route) =>
    apiError(
      route,
      503,
      "SERVICE_UNAVAILABLE",
      "Messages are temporarily unavailable.",
    ),
  );

  await page.goto("/bookings");
  await expect(
    page.getByRole("heading", { name: "Your bookings" }),
  ).toBeVisible();
  await page.goto("/messages");
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
  await page.goto("/teach/availability");
  await expect(
    page.getByRole("heading", { name: "Tutor access required" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Apply to become a tutor" }),
  ).toBeVisible();
  await page.goto("/terms");
  await expect(
    page.getByRole("heading", { name: "Terms of Service" }),
  ).toBeVisible();
  await page.goto("/privacy");
  await expect(
    page.getByRole("heading", { name: "Privacy notice" }),
  ).toBeVisible();
  await page.goto("/support");
  await expect(
    page.getByRole("heading", { name: "Support", exact: true }),
  ).toBeVisible();
  const response = await page.goto("/does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "We couldn’t find that page" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Find tutors" }).last()).toBeVisible();
});

test("navigation follows session state and role, including at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const header = page.getByRole("banner");
  const nav = header.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: "Home" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Find tutors" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Bookings" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Messages" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Login" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Sign-up" })).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "Open account menu" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Skip to main content" }),
  ).toBeAttached();

  await signIn(page);
  await page.reload();
  await expect(nav.getByRole("link", { name: "Login" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Sign-up" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Bookings" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Messages" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Find tutors" })).toBeVisible();
  await nav.getByRole("button", { name: "Open account menu" }).click();
  await expect(nav.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Logout" })).toBeVisible();
});

test("an incorrect current password stays on account and scopes the field error", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/api/profiles/me/account", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        headers: { ETag: '"0"' },
        contentType: "application/json",
        body: JSON.stringify(account),
      });
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        code: "INVALID_CREDENTIALS",
        message: "Current password is incorrect.",
        requestId: "00000000-0000-4000-8000-000000000998",
        retryable: false,
        fields: [],
      }),
    });
  });
  await page.route("**/api/profiles/me/student", (route) =>
    route.fulfill({
      status: 200,
      headers: { ETag: '"0"' },
      contentType: "application/json",
      body: JSON.stringify({
        userId: account.id,
        learningAreas: [],
        level: "",
        goals: "",
        preferredPeriods: [],
        revision: "0",
      }),
    }),
  );
  await page.goto("/account");
  await page.getByLabel("Email address").fill("new@example.test");
  await page
    .getByLabel("Current password (required to change email)")
    .fill("wrong password");
  await page.getByRole("button", { name: "Save details" }).click();

  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByLabel("Current password (required to change email)"),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByLabel("Current password", { exact: true }),
  ).toHaveAttribute("aria-invalid", "false");
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("tm.session.token")))
    .toBe("synthetic-session-token");
});

test("auth forms validate accessibly and show notices and retry timing", async ({
  page,
}) => {
  await page.goto("/signup");
  const referralCode = page.getByLabel("Referral code (optional)");
  await expect(referralCode).toBeVisible();
  await expect(referralCode).toHaveJSProperty("required", false);
  await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
  await expect(page.getByRole("link", { name: "Privacy notice" })).toHaveAttribute("href", "/privacy");
  await expect(
    page.getByRole("checkbox", { name: /Terms of Service/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /Privacy notice/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("#firstName")).toBeFocused();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "maxlength",
    "100",
  );
  await expect(page.locator("#password-hint")).toHaveText(
    "Use 8 to 100 characters.",
  );

  await page.goto("/login?notice=password-changed");
  await expect(
    page.getByText(
      "Your password was changed and every session was signed out. Log in with your new password.",
    ),
  ).toBeVisible();
  await page.route("**/api/auth/login", (route) => {
    void route.fulfill({
      status: 429,
      headers: { "Retry-After": "125" },
      contentType: "application/json",
      body: JSON.stringify({
        code: "RATE_LIMITED",
        message: "Too many attempts. Try again later.",
        requestId: "00000000-0000-4000-8000-000000000997",
        retryable: true,
        fields: [],
      }),
    });
  });
  await page.getByLabel("Email address").fill("jamie@example.test");
  await page.getByLabel("Password").fill("secret password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText(/Try again in about 3 minutes/)).toBeVisible();
  await expect(
    page.getByText(/Reference: 00000000-0000-4000-8000-000000000997/),
  ).toBeVisible();
});

test("plain gateway outages become specific, recoverable service errors", async ({
  page,
}) => {
  await page.route("**/api/discovery/**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "text/plain",
      body: "no available server\n",
    }),
  );
  await page.goto("/discover");
  await expect(
    page.getByText("Tutor search is unavailable right now."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Search" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("titles, notification copy, and malformed ids are user-facing", async ({
  page,
}) => {
  await page.goto("/discover");
  await expect(page).toHaveTitle("Find tutors · Tutor Matcher");

  await signIn(page);
  await page.route("**/api/notifications/preferences", (route) =>
    apiError(
      route,
      503,
      "SERVICE_UNAVAILABLE",
      "Notifications are temporarily unavailable.",
    ),
  );
  await page.route("**/api/notifications?**", (route) =>
    apiError(
      route,
      503,
      "SERVICE_UNAVAILABLE",
      "Notifications are temporarily unavailable.",
    ),
  );
  await page.goto("/notifications");
  await expect(
    page.getByText(
      "Demonstration only. Notifications here are simulated and nothing is sent outside this app.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/No real money moves/)).toHaveCount(0);

  let transactionCalls = 0;
  await page.route("**/api/wallet/transactions/abc", (route) => {
    transactionCalls += 1;
    return apiError(
      route,
      400,
      "VALIDATION_FAILED",
      "Request parameters are invalid.",
    );
  });
  await page.goto("/wallet/transactions/abc");
  await expect(
    page.getByText("We couldn’t find that record."),
  ).toBeVisible();
  await expect(
    page.locator("section.panel").getByRole("link", { name: "Back to history" }),
  ).toBeVisible();
  expect(transactionCalls).toBe(0);
});

test("opening a reset fragment in the current page validates it", async ({
  page,
}) => {
  let validationBody: unknown;
  await page.route("**/api/auth/password-reset/validate", (route) => {
    validationBody = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        valid: true,
        expiresAt: "2030-01-01T00:30:00.000Z",
      }),
    });
  });
  await page.goto("/password-reset");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("Enter your email address.")).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = "token=synthetic-reset-token";
  });
  await expect.poll(() => validationBody).toEqual({ token: "synthetic-reset-token" });
  await expect(
    page.getByRole("heading", { name: "Choose a new password" }),
  ).toBeVisible();
});
