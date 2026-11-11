import { expect, test } from "@playwright/test";

const account = {
  id: "00000000-0000-4000-8000-000000000101",
  firstName: "Jamie",
  lastName: "Learner",
  email: "jamie@example.test",
  capabilities: ["STUDENT"],
  status: "ACTIVE",
  revision: "0",
};
const session = { user: account, token: "synthetic-session-token", expiresAt: "2030-01-01T00:00:00.000Z" };

test.beforeEach(async ({ page }) => {
  // The signed-in navigation also loads the wallet chip and unread-message dot; answer them so they never touch the session.
  await page.route("**/api/wallet", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ availableBalance: { currency: "THB", amount: "0.00" } }) }));
  await page.route("**/api/messages/inbox?**", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }));
  await page.route("**/api/profiles/me/student", async (route) => route.fulfill({
    status: 200,
    headers: { ETag: '"0"' },
    contentType: "application/json",
    body: JSON.stringify({ userId: account.id, learningAreas: [], level: "", goals: "", preferredPeriods: [], revision: "0" }),
  }));
});

test("signup submits required agreements and starts with student access", async ({ page }) => {
  let posted: Record<string, unknown> | undefined;
  let key = "";
  await page.route("**/api/auth/signup", async (route) => {
    posted = route.request().postDataJSON();
    key = route.request().headers()["idempotency-key"];
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(session) });
  });
  await page.route("**/api/profiles/me/account", async (route) => {
    await route.fulfill({ status: 200, headers: { ETag: '"0"' }, contentType: "application/json", body: JSON.stringify(account) });
  });
  await page.goto("/signup");
  await page.getByLabel("First name").fill("Jamie");
  await page.getByLabel("Last name").fill("Learner");
  await page.getByLabel("Email address").fill("jamie@example.test");
  await page.getByLabel("Password", { exact: true }).fill("correct horse 123");
  await page.getByLabel("Confirm password").fill("correct horse 123");
  await page.getByRole("checkbox", { name: "I agree to the Terms of Service" }).check();
  await page.getByRole("checkbox", { name: "I have read the Privacy notice" }).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/account$/);
  expect(posted).toMatchObject({ firstName: "Jamie", lastName: "Learner", termsAccepted: true, privacyAccepted: true });
  expect(posted).not.toHaveProperty("capabilities");
  expect(key).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByText("STUDENT", { exact: true })).toBeVisible();
});

test("signup maps JSON Pointer validation paths to visible field errors", async ({ page }) => {
  await page.route("**/api/auth/signup", async (route) => route.fulfill({
    status: 422,
    contentType: "application/json",
    body: JSON.stringify({ code: "VALIDATION_ERROR", message: "Check the highlighted fields.", requestId: "00000000-0000-4000-8000-000000000001", retryable: false, fields: [
      { path: "/firstName", code: "REQUIRED", message: "Use your given name." },
      { path: "/passwordConfirmation", code: "MISMATCH", message: "These passwords do not match." },
    ] }),
  }));
  await page.goto("/signup");
  await page.getByLabel("First name").fill("Jamie");
  await page.getByLabel("Last name").fill("Learner");
  await page.getByLabel("Email address").fill("jamie@example.test");
  await page.getByLabel("Password", { exact: true }).fill("correct horse 123");
  await page.getByLabel("Confirm password").fill("correct horse 123");
  await page.getByRole("checkbox", { name: "I agree to the Terms of Service" }).check();
  await page.getByRole("checkbox", { name: "I have read the Privacy notice" }).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Use your given name.")).toBeVisible();
  await expect(page.getByText("These passwords do not match.")).toBeVisible();
  await expect(page.locator("#firstName")).toHaveAttribute("aria-invalid", "true");
});

test("login keeps only a same-origin return path and stores session in this tab", async ({ page }) => {
  let posted: Record<string, unknown> | undefined;
  await page.route("**/api/auth/login", async (route) => {
    posted = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) });
  });
  await page.route("**/api/profiles/me/account", async (route) => route.fulfill({ status: 200, headers: { ETag: '"0"' }, contentType: "application/json", body: JSON.stringify(account) }));
  await page.route("**/api/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(account) }));
  await page.goto("/login?returnTo=%2Faccount%3Ftab%3Dsecurity");
  await page.getByLabel("Email address").fill("jamie@example.test");
  await page.getByLabel("Password").fill("correct horse 123");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/account\?tab=security$/);
  expect(posted).toEqual({ email: "jamie@example.test", password: "correct horse 123" });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("tm.session.token"))).toBe("synthetic-session-token");
});

test("login rejects an external return destination", async ({ page }) => {
  await page.route("**/api/auth/login", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));
  await page.route("**/api/profiles/me/account", async (route) => route.fulfill({ status: 200, headers: { ETag: '"0"' }, contentType: "application/json", body: JSON.stringify(account) }));
  await page.goto("/login?returnTo=https%3A%2F%2Fevil.example%2Fcollect");
  await page.getByLabel("Email address").fill("jamie@example.test");
  await page.getByLabel("Password").fill("correct horse 123");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/discover$/);
});

test("login with no return destination sends an admin to the tutor request queue", async ({ page }) => {
  const adminSession = { ...session, user: { ...account, capabilities: ["STUDENT", "ADMIN"] } };
  await page.route("**/api/auth/login", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(adminSession) }));
  await page.route("**/api/profiles/me/account", async (route) => route.fulfill({ status: 200, headers: { ETag: '"0"' }, contentType: "application/json", body: JSON.stringify(adminSession.user) }));
  await page.goto("/login");
  await page.getByLabel("Email address").fill("jamie@example.test");
  await page.getByLabel("Password").fill("correct horse 123");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/admin\/tutor-requests$/);
});

test("signed-out navigation does not show a sign-out action", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("reset token is read from the fragment, removed from the address, and never stored", async ({ page }) => {
  let tokenInValidation = "";
  let tokenInConfirmation = "";
  await page.route("**/api/auth/password-reset/validate", async (route) => {
    tokenInValidation = route.request().postDataJSON().token;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ valid: true, expiresAt: "2030-01-01T00:30:00.000Z" }) });
  });
  await page.route("**/api/auth/password-reset/confirm", async (route) => {
    tokenInConfirmation = route.request().postDataJSON().token;
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/password-reset#token=synthetic-reset-token");
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect(page).toHaveURL(/\/password-reset$/);
  await page.getByLabel("New password", { exact: true }).fill("new safe pass 123");
  await page.getByLabel("Confirm new password").fill("new safe pass 123");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByRole("heading", { name: "You’re all set" })).toBeVisible();
  expect(tokenInValidation).toBe("synthetic-reset-token");
  expect(tokenInConfirmation).toBe("synthetic-reset-token");
  expect(await page.evaluate(() => sessionStorage.getItem("tm.session.token"))).toBeNull();
  expect(page.url()).not.toContain("synthetic-reset-token");
});

test("successful reset clears an existing local session without trying to reuse it", async ({ page }) => {
  let logoutCalls = 0;
  await page.addInitScript((token) => { if (window.location.pathname === "/password-reset") sessionStorage.setItem("tm.session.token", token); }, "synthetic-old-session");
  await page.route("**/api/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(account) }));
  await page.route("**/api/auth/logout", async (route) => { logoutCalls += 1; await route.fulfill({ status: 204, body: "" }); });
  await page.route("**/api/auth/password-reset/validate", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ valid: true, expiresAt: "2030-01-01T00:30:00.000Z" }) }));
  await page.route("**/api/auth/password-reset/confirm", async (route) => route.fulfill({ status: 204, body: "" }));
  await page.goto("/password-reset#token=synthetic-reset-token");
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill("new safe pass 123");
  await page.getByLabel("Confirm new password").fill("new safe pass 123");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByRole("heading", { name: "You’re all set" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("tm.session.token"))).toBeNull();
  expect(logoutCalls).toBe(0);
});

test("unknown reset address receives the same generic acknowledgement", async ({ page }) => {
  await page.route("**/api/auth/password-reset/request", async (route) => route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ message: "If an account exists for that address, a reset link has been sent." }) }));
  await page.goto("/password-reset");
  await page.getByLabel("Email address").fill("unknown@example.test");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(/same message appears whether or not an account matches/)).toBeVisible();
  await expect(page.getByText(/queued for simulated delivery/)).toBeVisible();
});

test("non-admin session cannot open admin account search", async ({ page }) => {
  await page.addInitScript((token) => { if (window.location.pathname.startsWith("/admin/users")) sessionStorage.setItem("tm.session.token", token); }, "synthetic-session-token");
  await page.route("**/api/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(account) }));
  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "Admin access required" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account access" })).toHaveCount(0);
});

test("temporary auth introspection failure keeps the tab token and offers retry", async ({ page }) => {
  let attempts = 0;
  await page.addInitScript((token) => { if (window.location.pathname === "/account") sessionStorage.setItem("tm.session.token", token); }, "synthetic-session-token");
  await page.route("**/api/auth/me", async (route) => {
    attempts += 1;
    if (attempts < 3) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "AUTH_UNAVAILABLE", message: "Authorization is temporarily unavailable.", requestId: "00000000-0000-4000-8000-000000000002", retryable: true, fields: [] }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(account) });
  });
  await page.route("**/api/profiles/me/account", async (route) => route.fulfill({ status: 200, headers: { ETag: '"0"' }, contentType: "application/json", body: JSON.stringify(account) }));
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "We couldn’t check your session" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("tm.session.token"))).toBe("synthetic-session-token");
  await page.getByRole("button", { name: "Retry session check" }).click();
  await expect(page.getByRole("heading", { name: "Account settings" })).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => sessionStorage.getItem("tm.session.token"))).toBe("synthetic-session-token");
});

test("restricted account response clears the old tab session", async ({ page }) => {
  await page.addInitScript((token) => { if (window.location.pathname === "/account") sessionStorage.setItem("tm.session.token", token); }, "synthetic-session-token");
  await page.route("**/api/auth/me", async (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "ACCOUNT_RESTRICTED", message: "This account cannot be used.", requestId: "00000000-0000-4000-8000-000000000003", retryable: false, fields: [] }) }));
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("tm.session.token"))).toBeNull();
});

test("student profile update carries current revision and a retry key", async ({ page }) => {
  const profile = { userId: account.id, learningAreas: ["algebra"], level: "Beginner", goals: "Build confidence", preferredPeriods: ["EVENING"], revision: "3" };
  let write: Record<string, unknown> | undefined;
  let writeHeaders: Record<string, string> | undefined;
  await page.addInitScript((token) => { if (window.location.pathname === "/account") sessionStorage.setItem("tm.session.token", token); }, "synthetic-session-token");
  await page.route("**/api/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(account) }));
  await page.route("**/api/profiles/me/account", async (route) => route.fulfill({ status: 200, headers: { ETag: '"0"' }, contentType: "application/json", body: JSON.stringify(account) }));
  await page.route("**/api/profiles/me/student", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, headers: { ETag: '"3"' }, contentType: "application/json", body: JSON.stringify(profile) });
    write = route.request().postDataJSON(); writeHeaders = route.request().headers();
    return route.fulfill({ status: 200, headers: { ETag: '"4"' }, contentType: "application/json", body: JSON.stringify({ ...profile, ...write, revision: "4" }) });
  });
  await page.goto("/account");
  await page.getByLabel("Learning areas (comma-separated)").fill("algebra, web-development");
  await page.getByLabel("Current level").fill("Intermediate");
  await page.getByLabel("Learning goals").fill("Ship a small app");
  await page.getByLabel("Evening").uncheck();
  await page.getByLabel("Morning").check();
  await page.getByRole("button", { name: "Save learning profile" }).click();
  await expect(page.getByText("Your learning profile has been saved.")).toBeVisible();
  expect(write).toEqual({ learningAreas: ["algebra", "web-development"], level: "Intermediate", goals: "Ship a small app", preferredPeriods: ["MORNING"] });
  expect(writeHeaders?.["if-match"]).toBe('"3"');
  expect(writeHeaders?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
});

test("password change clears the tab session and sends revision precondition", async ({ page }) => {
  let write: Record<string, unknown> | undefined;
  let headers: Record<string, string> | undefined;
  await page.addInitScript((token) => { if (window.location.pathname === "/account") sessionStorage.setItem("tm.session.token", token); }, "synthetic-session-token");
  await page.route("**/api/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(account) }));
  await page.route("**/api/profiles/me/account", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, headers: { ETag: '"0"' }, contentType: "application/json", body: JSON.stringify(account) });
    write = route.request().postDataJSON(); headers = route.request().headers();
    return route.fulfill({ status: 200, headers: { ETag: '"1"' }, contentType: "application/json", body: JSON.stringify({ ...account, revision: "1" }) });
  });
  await page.route("**/api/auth/logout", async (route) => route.fulfill({ status: 204, body: "" }));
  await page.goto("/account");
  await page.getByLabel("Current password", { exact: true }).fill("old password 123");
  await page.getByLabel("New password", { exact: true }).fill("new password 123");
  await page.getByLabel("Confirm new password").fill("new password 123");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page).toHaveURL(/\/login\?notice=password-changed$/);
  expect(write).toEqual({ currentPassword: "old password 123", newPassword: "new password 123" });
  expect(headers?.["if-match"]).toBe('"0"');
  expect(await page.evaluate(() => sessionStorage.getItem("tm.session.token"))).toBeNull();
});

test("admin can restore a suspended account with reason and revision", async ({ page }) => {
  const admin = { ...account, id: "00000000-0000-4000-8000-000000000199", capabilities: ["STUDENT", "ADMIN"] };
  const user = { ...account, status: "SUSPENDED", revision: "7" };
  const detail = { user, audit: [], revision: "7" };
  let submitted: Record<string, unknown> | undefined;
  let submittedHeaders: Record<string, string> | undefined;
  await page.addInitScript((token) => { if (window.location.pathname.startsWith("/admin/users/")) sessionStorage.setItem("tm.session.token", token); }, "synthetic-admin-session");
  await page.route("**/api/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(admin) }));
  await page.route("**/api/admin/users/**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, headers: { ETag: '"7"' }, contentType: "application/json", body: JSON.stringify(detail) });
    submitted = route.request().postDataJSON(); submittedHeaders = route.request().headers();
    return route.fulfill({ status: 200, headers: { ETag: '"8"' }, contentType: "application/json", body: JSON.stringify({ ...detail, user: { ...user, status: "ACTIVE", revision: "8" }, revision: "8" }) });
  });
  await page.goto(`/admin/users/${user.id}`);
  await page.getByRole("button", { name: "Change access" }).click();
  const dialog = page.getByRole("dialog", { name: "Change access" });
  const restore = dialog.getByRole("button", { name: "Restore access" });
  await expect(restore).toHaveAttribute("aria-pressed", "false");
  await restore.click();
  await expect(restore).toHaveAttribute("aria-pressed", "true");
  await dialog.getByLabel("Reason (required)").fill("Access review completed");
  await dialog.getByRole("button", { name: "Record action" }).click();
  await expect(page.getByText(/Restored accounts must log in again/)).toBeVisible();
  expect(submitted).toEqual({ action: "RESTORE", reason: "Access review completed" });
  expect(submittedHeaders?.["if-match"]).toBe('"7"');
  expect(submittedHeaders?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
});
