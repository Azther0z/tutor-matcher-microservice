import { expect, test, type Page } from "@playwright/test";
import { IDS, json, page1, record, signIn as baseSignIn, topup, wallet } from "../finance/support";

/** Signs in and answers the header's own wallet and inbox calls, so a signed-in page never reaches a real backend. Later routes in a test take precedence. */
async function signIn(page: Page, capabilities: string[] = ["STUDENT"]) {
  await baseSignIn(page, capabilities);
  await page.route(/\/api\/wallet$/, (route) => json(route, 200, wallet()));
  await page.route(/\/api\/messages\/inbox\?/, (route) => json(route, 200, page1([])));
  await page.route(/\/api\/wallet\/transactions\?/, (route) => json(route, 200, page1([])));
}

const me = {
  id: IDS.user,
  firstName: "Jamie",
  lastName: "Learner",
  email: "jamie@example.test",
  capabilities: ["STUDENT"],
  status: "ACTIVE",
  revision: "0",
};
const studentProfile = { userId: IDS.user, learningAreas: [], level: "", goals: "", preferredPeriods: [], revision: "0" };

async function mockAccountPage(page: Page, onWrite: (route: import("@playwright/test").Route) => Promise<void>) {
  await page.route(/\/api\/profiles\/me\/student$/, (route) => json(route, 200, studentProfile, { ETag: '"0"' }));
  await page.route(/\/api\/profiles\/me\/account$/, async (route) => {
    if (route.request().method() === "GET") return json(route, 200, me, { ETag: '"0"' });
    return onWrite(route);
  });
}

const wrongPassword = { code: "INVALID_CREDENTIALS", message: "Current password is incorrect.", requestId: "00000000-0000-4000-8000-0000000000aa", retryable: false, fields: [] };

test.describe("account forms keep the session on a wrong current password (UX-05, UX-12)", () => {
  test("email change shows an inline error and stays signed in", async ({ page }) => {
    await signIn(page);
    await mockAccountPage(page, (route) => json(route, 401, wrongPassword));
    await page.goto("/account");
    await page.getByLabel("Email address").fill("new@example.test");
    await page.getByLabel("Current password (required to change email)").fill("wrong password");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByText("Current password is incorrect.")).toBeVisible();
    await expect(page).toHaveURL(/\/account$/);
    expect(await page.evaluate(() => sessionStorage.getItem("tm.session.token"))).toBe("synthetic-session-token");
    // the other two forms are untouched
    await expect(page.locator("#passwordCurrentPassword")).not.toHaveAttribute("aria-invalid", "true");
  });

  test("password change with a wrong current password stays signed in", async ({ page }) => {
    await signIn(page);
    await mockAccountPage(page, (route) => json(route, 401, wrongPassword));
    await page.goto("/account");
    await page.getByLabel("Current password", { exact: true }).fill("wrong password");
    await page.getByLabel("New password", { exact: true }).fill("new password 123");
    await page.getByLabel("Confirm new password").fill("new password 123");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Current password is incorrect.")).toBeVisible();
    await expect(page).toHaveURL(/\/account$/);
  });

  test("a missing current password is reported under the email form only", async ({ page }) => {
    await signIn(page);
    await mockAccountPage(page, (route) => json(route, 422, { code: "CURRENT_PASSWORD_REQUIRED", message: "Current password is required for this change.", requestId: "00000000-0000-4000-8000-0000000000ab", retryable: false, fields: [{ path: "/currentPassword", code: "REQUIRED", message: "Required." }] }));
    await page.goto("/account");
    await page.getByLabel("Email address").fill("new@example.test");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#emailCurrentPassword")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#passwordCurrentPassword")).not.toHaveAttribute("aria-invalid", "true");
  });

  test("a rejected session token still ends the session", async ({ page }) => {
    await signIn(page);
    await page.route(/\/api\/wallet$/, (route) => json(route, 401, { code: "TOKEN_INVALID", message: "The session token is invalid or expired.", requestId: "00000000-0000-4000-8000-0000000000ac", retryable: false, fields: [] }));
    await page.goto("/wallet");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fwallet$/);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("tm.session.token"))).toBeNull();
  });
});

test.describe("header navigation follows auth state (UX-08, UX-04, UX-06)", () => {
  test("logged out sees the inline links and direct Login and Sign-up links", async ({ page }) => {
    await page.goto("/login");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    for (const [label, href] of [["Home", "/"], ["Find tutors", "/discover"], ["Bookings", "/bookings"], ["Messages", "/messages"]]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href);
    }
    await expect(nav.getByRole("link", { name: "Login", exact: true })).toHaveAttribute("href", "/login");
    await expect(nav.getByRole("link", { name: "Sign-up", exact: true })).toHaveAttribute("href", "/signup");
    await expect(nav.getByRole("button", { name: "Open account menu" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Wallet balance" })).toHaveCount(0);
  });

  test("a student sees inline links and account controls, but no admin destinations", async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    for (const shown of ["Home", "Find tutors", "Bookings", "Messages"]) await expect(nav.getByRole("link", { name: shown, exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Wallet balance" })).toBeVisible();
    await nav.getByRole("button", { name: "Open account menu" }).click();
    await expect(nav.getByRole("menuitem", { name: "Settings", exact: true })).toHaveAttribute("href", "/account");
    await expect(nav.getByRole("menuitem", { name: "Notifications", exact: true })).toHaveAttribute("href", "/notifications");
    await expect(nav.getByRole("menuitem", { name: "Log out", exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Admin" })).toHaveCount(0);
    for (const hidden of ["Accounts", "Tutor requests", "Top-up requests"]) await expect(nav.getByRole("menuitem", { name: hidden, exact: true })).toHaveCount(0);
  });

  test("admin account controls include admin destinations", async ({ page }) => {
    await signIn(page, ["STUDENT", "ADMIN"]);
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await nav.getByRole("button", { name: "Admin" }).click();
    for (const [label, href] of [["Accounts", "/admin/users"], ["Tutor requests", "/admin/tutor-requests"], ["Top-up requests", "/admin/topups"]]) {
      await expect(nav.getByRole("menuitem", { name: label, exact: true })).toHaveAttribute("href", href);
    }
  });

  test("the inline navigation and account menu stay reachable at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Login", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Sign-up", exact: true })).toBeVisible();
    await signIn(page);
    await page.reload();
    const mobileNav = page.getByRole("navigation", { name: "Main navigation" });
    for (const link of ["Home", "Find tutors", "Bookings", "Messages"]) await expect(mobileNav.getByRole("link", { name: link, exact: true })).toBeVisible();
    const menu = mobileNav.getByRole("button", { name: "Open account menu" });
    await expect(menu).toBeVisible();
    expect((await menu.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
    await menu.click();
    await expect(mobileNav.getByRole("menuitem", { name: "Log out", exact: true })).toBeVisible();
  });

  test("the landing page and Account point to discovery", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Find tutors" }).last()).toHaveAttribute("href", "/discover");
    await signIn(page);
    await mockAccountPage(page, (route) => json(route, 200, me));
    await page.goto("/account");
    await expect(page.getByRole("link", { name: "Find tutors" }).last()).toHaveAttribute("href", "/discover");
  });
});

test.describe("login and signup around the session (UX-14, UX-33, UX-34)", () => {
  test("login explains why the user was sent back", async ({ page }) => {
    await page.goto("/login?notice=password-changed");
    await expect(page.getByText(/Your password was changed/)).toBeVisible();
    await page.goto("/login?notice=deactivated");
    await expect(page.getByText(/Your account was deactivated/)).toBeVisible();
    await page.goto("/login?notice=something-else");
    await expect(page.getByRole("status").filter({ hasText: "was" })).toHaveCount(0);
  });

  test("a deactivated account no longer says to contact support", async ({ page }) => {
    await page.route(/\/api\/auth\/login$/, (route) => json(route, 403, { code: "ACCOUNT_RESTRICTED", message: "restricted", requestId: "00000000-0000-4000-8000-0000000000ad", retryable: false, fields: [] }));
    await page.goto("/login");
    await page.getByLabel("Email address").fill("jamie@example.test");
    await page.getByLabel("Password").fill("correct horse 123");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.locator(".notice-error")).toContainText("deactivated or restricted");
    await expect(page.locator(".notice-error")).not.toContainText(/support/i);
    await expect(page.locator(".notice-error")).toContainText("00000000-0000-4000-8000-0000000000ad");
  });

  // A signed-in student leaves Login for tutor search and leaves Sign-up for Account.
  for (const [path, destination] of [["/login", /\/discover$/], ["/signup", /\/account$/]] as const) {
    test(`signed-in users are sent away from ${path}`, async ({ page }) => {
      await signIn(page);
      await mockAccountPage(page, (route) => json(route, 200, me));
      await page.route(/\/api\/discovery\//, (route) => json(route, 200, { items: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 } }));
      await page.goto(path);
      await expect(page).toHaveURL(destination);
    });
  }

  test("a signed-in user visiting /login keeps a safe returnTo", async ({ page }) => {
    await signIn(page);
    await page.route(/\/api\/wallet$/, (route) => json(route, 200, wallet()));
    await page.goto("/login?returnTo=%2Fwallet");
    await expect(page).toHaveURL(/\/wallet$/);
  });

  test("header logout lands on / without retaining the session", async ({ page }) => {
    await signIn(page);
    await mockAccountPage(page, (route) => json(route, 200, me));
    await page.route(/\/api\/auth\/logout$/, (route) => route.fulfill({ status: 204, body: "" }));
    await page.goto("/account");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await nav.getByRole("button", { name: "Open account menu" }).click();
    await nav.getByRole("menuitem", { name: "Log out", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("tm.session.token"))).toBeNull();
  });

  test("the Account sign-out button also leaves no returnTo", async ({ page }) => {
    await signIn(page);
    await mockAccountPage(page, (route) => json(route, 200, me));
    await page.route(/\/api\/auth\/logout$/, (route) => route.fulfill({ status: 204, body: "" }));
    await page.goto("/account");
    await page.getByRole("button", { name: "Sign out of this session" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.waitForTimeout(300);
    expect(new URL(page.url()).search).toBe("");
  });
});

test.describe("email checks and friendly validation (UX-11, UX-29, UX-31, UX-32)", () => {
  test("signup checks the email format before calling the API and focuses the first invalid field", async ({ page }) => {
    const calls = await record(page, /\/api\/auth\/signup$/, (route) => json(route, 201, {}));
    await page.goto("/signup");
    await page.getByLabel("First name").fill("Jamie");
    await page.getByLabel("Last name").fill("Learner");
    await page.getByLabel("Email address").fill("not-an-email");
    await page.getByLabel("Password", { exact: true }).fill("correct horse 123");
    await page.getByLabel("Confirm password").fill("correct horse 123");
    await page.getByRole("checkbox", { name: /Terms of Service/ }).check();
    await page.getByRole("checkbox", { name: /Privacy notice/ }).check();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(page.locator("#email")).toBeFocused();
    expect(calls).toHaveLength(0);
  });

  test("signup states and enforces the 100 character password limit", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByText("Use 8 to 100 characters.")).toBeVisible();
    await expect(page.locator("#password")).toHaveAttribute("maxlength", "100");
    await expect(page.getByLabel("Referral code (optional)")).toBeVisible();
  });

  test("backend validation wording becomes a friendly message, and a duplicate email shows once", async ({ page }) => {
    await page.route(/\/api\/auth\/signup$/, (route) => json(route, 409, { code: "EMAIL_ALREADY_REGISTERED", message: "An account already uses this email address.", requestId: "00000000-0000-4000-8000-0000000000ae", retryable: false, fields: [{ path: "/email", code: "DUPLICATE", message: "An account already uses this email address." }] }));
    await page.goto("/signup");
    await page.getByLabel("First name").fill("Jamie");
    await page.getByLabel("Last name").fill("Learner");
    await page.getByLabel("Email address").fill("jamie@example.test");
    await page.getByLabel("Password", { exact: true }).fill("correct horse 123");
    await page.getByLabel("Confirm password").fill("correct horse 123");
    await page.getByRole("checkbox", { name: /Terms of Service/ }).check();
    await page.getByRole("checkbox", { name: /Privacy notice/ }).check();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("An account already uses this email address.")).toHaveCount(1);
  });

  test("server schema wording is translated on signup", async ({ page }) => {
    await page.route(/\/api\/auth\/signup$/, (route) => json(route, 422, { code: "VALIDATION_FAILED", message: "Request validation failed.", requestId: "00000000-0000-4000-8000-0000000000af", retryable: false, fields: [{ path: "/email", code: "format", message: 'must match format "email"' }] }));
    await page.goto("/signup");
    // jamie@x passes the client check (it has a dot-less domain only on the server), so use a value the client accepts
    await page.getByLabel("First name").fill("Jamie");
    await page.getByLabel("Last name").fill("Learner");
    await page.getByLabel("Email address").fill("jamie@example.test");
    await page.getByLabel("Password", { exact: true }).fill("correct horse 123");
    await page.getByLabel("Confirm password").fill("correct horse 123");
    await page.getByRole("checkbox", { name: /Terms of Service/ }).check();
    await page.getByRole("checkbox", { name: /Privacy notice/ }).check();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(page.getByText("Request validation failed.")).toHaveCount(0);
    await expect(page.getByText('must match format "email"')).toHaveCount(0);
  });

  test("login and password reset show a field error for a bad email", async ({ page }) => {
    const calls = await record(page, /\/api\/auth\/(login|password-reset\/request)$/, (route) => json(route, 200, {}));
    await page.goto("/login");
    await page.getByLabel("Email address").fill("not-an-email");
    await page.getByLabel("Password").fill("correct horse 123");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(page.locator("#email")).toBeFocused();
    await page.goto("/password-reset");
    await page.getByLabel("Email address").fill("not-an-email");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  test("an emailed reset link opened in the same tab is picked up (hashchange)", async ({ page }) => {
    await page.route(/\/api\/auth\/password-reset\/validate$/, (route) => json(route, 200, { valid: true, expiresAt: "2030-01-01T00:30:00.000Z" }));
    await page.goto("/password-reset");
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    await page.evaluate(() => { window.location.hash = "token=synthetic-reset-token"; });
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  });
});

test.describe("wallet top-up (UX-17, UX-45)", () => {
  test("the form is off when the wallet failed to load", async ({ page }) => {
    await signIn(page);
    await page.route(/\/api\/wallet$/, (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "no available server\n" }));
    await page.route(/\/api\/wallet\/topups\?/, (route) => json(route, 200, page1([])));
    await page.route(/\/api\/messages\/inbox\?/, (route) => json(route, 200, page1([])));
    await page.goto("/wallet");
    await expect(page.getByText("This area is temporarily unavailable")).toBeVisible();
    // Without a wallet there is no balance card, so there is no Top up button and no form to open.
    await expect(page.getByRole("button", { name: /Top up/ })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Adding funds is unavailable until your wallet loads.")).toBeVisible();
  });

  test("a double click sends one top-up request", async ({ page }) => {
    await signIn(page);
    await page.route(/\/api\/wallet$/, (route) => json(route, 200, wallet()));
    await page.route(/\/api\/wallet\/topups\?/, (route) => json(route, 200, page1([])));
    await page.route(/\/api\/messages\/inbox\?/, (route) => json(route, 200, page1([])));
    await page.route(/https:\/\/promptpay\.io\/.*/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=", "base64") }));
    const calls = await record(page, /\/api\/wallet\/topups$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await json(route, 201, { ...topup("PENDING"), manual: true });
    });
    await page.goto("/wallet");
    await page.getByRole("button", { name: /Top up/ }).click();
    const dialog = page.getByRole("dialog", { name: "Add funds" });
    await dialog.getByLabel("How much do you want to add? (THB)").fill("100");
    await dialog.getByRole("button", { name: "Confirm amount" }).click();
    const sendDialog = page.getByRole("dialog", { name: "Transfer and attach slip" });
    await sendDialog.getByLabel("Transfer slip").setInputFiles({ name: "slip.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=", "base64") });
    await sendDialog.getByRole("button", { name: "Send request" }).dblclick();
    await expect(sendDialog.getByRole("button", { name: "Sending…" })).toBeDisabled();
    // The dialog closes once the request is sent, and the request shows as waiting for review.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Top-up request/ })).toBeVisible();
    expect(calls).toHaveLength(1);
  });
});

test.describe("dead ends and outage states", () => {
  test("the tutor navigation links Availability and Lessons and marks the current page", async ({ page }) => {
    await signIn(page);
    await page.route(/\/api\/profiles\/me\/tutor\/subjects/, (route) => json(route, 200, { items: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 } }));
    await page.route(/\/api\/discovery\/learning-areas$/, (route) => json(route, 200, { items: [] }));
    await page.goto("/teach/subjects");
    const nav = page.getByRole("navigation", { name: "Tutor workspace" });
    await expect(nav.getByRole("link", { name: "Availability" })).toHaveAttribute("href", "/teach/availability");
    await expect(nav.getByRole("link", { name: "Lessons" })).toHaveAttribute("href", "/teach/lessons");
    await expect(nav.getByRole("link", { name: "Subjects" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText(/in Availability/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Apply to become a tutor" })).toHaveAttribute("href", "/teach/application");
  });

  test("a student on tutor-only wallet pages is offered the application", async ({ page }) => {
    await signIn(page);
    await page.goto("/wallet/payouts");
    await expect(page.getByRole("heading", { name: "Tutor access required" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Apply to become a tutor" })).toHaveAttribute("href", "/teach/application");
  });

  test("unknown pages get a branded not-found page", async ({ page }) => {
    await page.goto("/does-not-exist");
    await expect(page.getByRole("heading", { name: "We couldn’t find that page" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
    await expect(page.getByRole("link", { name: "Find tutors" }).last()).toHaveAttribute("href", "/discover");
  });

  test("a malformed id is reported as not found, with a way back and no retry", async ({ page }) => {
    await signIn(page);
    await page.route(/\/api\/wallet\/transactions\/abc$/, (route) => json(route, 400, { code: "VALIDATION_FAILED", message: "Request parameters are invalid.", requestId: "00000000-0000-4000-8000-0000000000b1", retryable: false, fields: [] }));
    await page.goto("/wallet/transactions/abc");
    await expect(page.getByText("We couldn’t find that record.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Transaction", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Home", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  });

  test("failed lists share one error with a retry button and a reference", async ({ page }) => {
    await signIn(page);
    let calls = 0;
    await page.route(/\/api\/disputes\?/, (route) => {
      calls += 1;
      return json(route, 500, { code: "INTERNAL", message: "Something broke.", requestId: "00000000-0000-4000-8000-0000000000b2", retryable: true, fields: [] });
    });
    await page.goto("/disputes");
    await expect(page.getByText("Something broke.")).toBeVisible();
    await expect(page.getByText("00000000-0000-4000-8000-0000000000b2")).toBeVisible();
    const before = calls;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => calls).toBeGreaterThan(before);
  });

  test("the tutor page keeps a heading in its error state", async ({ page }) => {
    await page.route(/\/api\/discovery\/tutors\/abc\/profile$/, (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "no available server\n" }));
    await page.goto("/tutors/abc");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByText("This area is temporarily unavailable")).toBeVisible();
  });

  test("Discover shows one outage state and turns the form off", async ({ page }) => {
    for (const path of ["learning-areas", "price-range", "tutors"]) await page.route(new RegExp(`/api/discovery/${path}`), (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "no available server\n" }));
    await page.goto("/discover");
    await expect(page.locator(".notice-error")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Search" })).toBeDisabled();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".notice-error")).toHaveCount(1);
  });

  test("Discover checks the price range, labels ratings and shows the single format as text", async ({ page }) => {
    await page.route(/\/api\/discovery\/learning-areas/, (route) => json(route, 200, { items: [{ id: "algebra", label: "Algebra" }] }));
    await page.route(/\/api\/discovery\/price-range/, (route) => json(route, 200, { minimum: { amount: "100.00" }, maximum: { amount: "900.00" } }));
    const searches = await record(page, /\/api\/discovery\/tutors\?/, (route) => json(route, 200, { items: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 } }));
    await page.goto("/discover");
    const rating = page.getByRole("group", { name: "Minimum rating" });
    // Half steps from 1 to 5: the first star is one whole button, the other four have a left and a right half.
    await expect(rating.getByRole("button")).toHaveCount(9);
    await expect(rating.getByRole("button", { name: "4 stars and up", exact: true })).toBeVisible();
    await expect(rating.getByRole("button", { name: "4.5 stars and up", exact: true })).toBeVisible();
    await expect(rating.getByRole("button", { name: "1 stars and up", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Learning area" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Sort" })).toBeVisible();
    await expect(page.locator("select#format")).toHaveCount(0);
    await expect(page.getByText(/Lessons are online/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Search" })).toBeEnabled();
    const before = searches.length;
    const price = page.getByRole("group", { name: "Price per hour (THB)" });
    await price.getByLabel("Min", { exact: true }).fill("900");
    await price.getByLabel("Max", { exact: true }).fill("100");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("The maximum rate must be at least the minimum rate.")).toBeVisible();
    await price.getByLabel("Min", { exact: true }).fill("-5");
    await price.getByLabel("Max", { exact: true }).fill("");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("Enter a rate of 0 or more.")).toBeVisible();
    expect(searches.length).toBe(before);
    await expect(page).toHaveURL(/\/discover$/);
  });
});

test.describe("accessibility basics (UX-24, UX-26, UX-27, UX-28)", () => {
  test("pages have their own titles, a skip link and a main target", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveTitle("Log in | Tutor Matcher");
    await page.goto("/signup");
    await expect(page).toHaveTitle("Create account | Tutor Matcher");
    await page.goto("/");
    await expect(page).toHaveTitle("Tutor Matcher");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute("href", "#main");
    await expect(page.locator("main#main")).toHaveCount(1);
  });

  test("a favicon is declared", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /icon/);
  });

  test("muted text meets 4.5:1 on the page background", async ({ page }) => {
    await page.goto("/login");
    const ratio = await page.evaluate(() => {
      const parse = (value: string) => value.match(/\d+/g)!.slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => { const c = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
      const fg = lum(parse(getComputedStyle(document.querySelector(".site-footer")!).color));
      const bg = lum(parse(getComputedStyle(document.body).backgroundColor));
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("notifications show a notification-specific notice, not the money banner", async ({ page }) => {
    await signIn(page);
    await page.route(/\/api\/notifications\/preferences$/, (route) => json(route, 200, {
      bookingUpdates: { email: true, push: true }, lessonReminders: { email: true, push: true }, newMessages: { email: true, push: false },
      walletPayments: { email: true, push: true }, productNews: { email: false, push: false }, revision: "0",
    }, { ETag: '"0"' }));
    await page.route(/\/api\/notifications\?/, (route) => json(route, 200, { items: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 } }));
    await page.goto("/notifications");
    await expect(page.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
    await expect(page.getByText(/No real money moves/)).toHaveCount(0);
    await expect(page.getByText(/Notifications here are simulated/)).toBeVisible();
  });
});
