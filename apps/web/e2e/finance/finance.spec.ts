import { expect, test } from "@playwright/test";
import { IDS, TS, account, dispute, json, page1, record, signIn, thb, topup, wallet } from "./support";

test.describe("wallet and top-up", () => {
  test("shows balances separately and keeps pending earnings out of tutor-only view for students", async ({ page }) => {
    await signIn(page, ["STUDENT"]);
    await page.route(/\/api\/wallet$/, (route) => json(route, 200, wallet()));
    await page.goto("/wallet");
    await expect(page.getByText("THB 1,300.00")).toBeVisible();
    await expect(page.getByText("RESERVED FOR PAYOUTS")).toBeVisible();
    await expect(page.getByText("PENDING EARNINGS", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Payouts" })).toHaveCount(0);
  });

  test("starts a simulated top-up with an exact decimal string and an idempotency key, and keeps the booking destination", async ({ page }) => {
    await signIn(page);
    await page.route(/\/api\/wallet$/, (route) => json(route, 200, wallet()));
    const created = await record(page, /\/api\/wallet\/topups$/, (route) => json(route, 201, topup("PENDING")));
    await page.route(new RegExp(`/api/wallet/topups/${IDS.topup}$`), (route) => json(route, 200, topup("PENDING")));
    await page.route(/\/api\/operations\/wallet\//, (route) => json(route, 200, { id: IDS.operation, owner: "wallet", status: "PENDING", statusUrl: "", resource: null }));
    await page.goto(`/wallet?returnToBookingId=${IDS.booking}`);
    await page.getByLabel("Amount (THB)").fill("250.5");
    await page.getByRole("button", { name: "Start top-up" }).click();
    await expect(page).toHaveURL(new RegExp(`/wallet/topups/${IDS.topup}\\?returnToBookingId=${IDS.booking}$`));
    expect(created[0].body).toEqual({ amount: "250.50", returnToBookingId: IDS.booking });
    expect(created[0].headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(page.getByText("Not payable.")).toBeVisible();
    await expect(page.getByText("DEMO-NOT-PAYABLE-0001")).toBeVisible();
    await expect(page.getByText(/Nothing has been credited yet/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to booking without paying" })).toHaveAttribute("href", `/bookings/${IDS.booking}`);
  });

  test("rejects an invalid amount before calling the API", async ({ page }) => {
    await signIn(page);
    await page.route(/\/api\/wallet$/, (route) => json(route, 200, wallet()));
    const created = await record(page, /\/api\/wallet\/topups$/, (route) => json(route, 201, topup("PENDING")));
    await page.goto("/wallet");
    for (const bad of ["0", "100000.01", "12.345", "abc", "-5"]) {
      await page.getByLabel("Amount (THB)").fill(bad);
      await page.getByRole("button", { name: "Start top-up" }).click();
      await expect(page.getByText(/from 0.01 to 100,000.00/)).toBeVisible();
    }
    expect(created).toHaveLength(0);
  });

  for (const [status, text] of [
    ["SUCCEEDED", /credited once/],
    ["FAILED", /Nothing was credited/],
    ["UNKNOWN", /outcome is unknown/],
  ] as const) {
    test(`explains a ${status} top-up and offers the booking only after success`, async ({ page }) => {
      await signIn(page);
      await page.route(new RegExp(`/api/wallet/topups/${IDS.topup}$`), (route) => json(route, 200, topup(status)));
      await page.goto(`/wallet/topups/${IDS.topup}?returnToBookingId=${IDS.booking}`);
      await expect(page.getByRole("status").filter({ hasText: text })).toBeVisible();
      await expect(page.getByRole("link", { name: "Return to your booking" })).toHaveCount(status === "SUCCEEDED" ? 1 : 0);
    });
  }

  test("follows a pending operation until the provider outcome arrives, then reloads the top-up", async ({ page }) => {
    await signIn(page);
    let loads = 0;
    await page.route(new RegExp(`/api/wallet/topups/${IDS.topup}$`), (route) => { loads += 1; return json(route, 200, topup(loads > 1 ? "SUCCEEDED" : "PENDING")); });
    await page.route(/\/api\/operations\/wallet\//, (route) => json(route, 200, { id: IDS.operation, owner: "wallet", status: "SUCCEEDED", statusUrl: "", resource: null }));
    await page.goto(`/wallet/topups/${IDS.topup}`);
    await expect(page.getByRole("status").filter({ hasText: /credited once/ })).toBeVisible({ timeout: 10_000 });
  });

  test("lists completed transactions with a type filter", async ({ page }) => {
    await signIn(page);
    const seen = await record(page, /\/api\/wallet\/transactions\?/, (route) => json(route, 200, page1([
      { id: IDS.topup, type: "TOP_UP", amount: thb("500.00"), direction: "IN", balanceAfter: thb("1500.00"), operationId: IDS.operation, bookingId: null, payoutAccountId: null, createdAt: TS },
    ])));
    await page.goto("/wallet/transactions");
    await expect(page.getByRole("cell", { name: "Top Up" })).toBeVisible();
    await page.getByLabel("Type").selectOption("REFUND");
    await expect.poll(() => seen.some((call) => call.url.includes("type=REFUND"))).toBe(true);
  });
});

test.describe("tutor payouts", () => {
  test("a student without the Tutor capability sees an access message, not the payout pages", async ({ page }) => {
    await signIn(page, ["STUDENT"]);
    await page.goto("/wallet/payouts");
    await expect(page.getByRole("heading", { name: "Tutor access required" })).toBeVisible();
  });

  test("adds, defaults and removes payout accounts using the current revision", async ({ page }) => {
    await signIn(page, ["STUDENT", "TUTOR"]);
    let accounts = [account(IDS.account, true, "3"), account(IDS.account2, false, "5")];
    await page.route(/\/api\/payout-accounts\?/, (route) => json(route, 200, page1(accounts)));
    await page.route(/\/api\/payout-accounts\/banks$/, (route) => json(route, 200, { items: [{ code: "KBANK", name: "Kasikornbank" }] }));
    const created = await record(page, /\/api\/payout-accounts$/, (route) => json(route, 201, account("00000000-0000-4000-8000-000000000603", false)));
    const patched = await record(page, new RegExp(`/api/payout-accounts/${IDS.account2}/default$`), (route) => { accounts = [account(IDS.account, false, "4"), account(IDS.account2, true, "6")]; return json(route, 200, accounts[1]); });
    const removed = await record(page, new RegExp(`/api/payout-accounts/${IDS.account}$`), (route) => { accounts = [accounts[1]]; return route.fulfill({ status: 204 }); });

    await page.goto("/wallet/payout-accounts");
    await expect(page.getByText("Default", { exact: true })).toBeVisible();

    await page.getByLabel("Bank").selectOption("KBANK");
    await page.getByLabel("Account holder name").fill("Taylor Tutor");
    await page.getByLabel("Account number").fill("123-4-56789-0");
    await page.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByText("Payout account added.")).toBeVisible();
    expect(created[0].body).toMatchObject({ bankCode: "KBANK", accountHolderName: "Taylor Tutor", accountNumber: "123-4-56789-0", makeDefault: false });
    expect(created[0].headers["idempotency-key"]).toBeTruthy();

    await page.getByRole("button", { name: "Make default" }).click();
    await expect(page.getByText("Default account updated.")).toBeVisible();
    expect(patched[0].headers["if-match"]).toBe('"5"');

    await page.getByRole("button", { name: "Remove" }).first().click();
    await expect(page.getByText(/Past payouts keep their original destination/)).toBeVisible();
    expect(removed[0].headers["if-match"]).toBe('"4"');
  });

  test("validates the account number client-side", async ({ page }) => {
    await signIn(page, ["STUDENT", "TUTOR"]);
    await page.route(/\/api\/payout-accounts\?/, (route) => json(route, 200, page1([])));
    await page.route(/\/api\/payout-accounts\/banks$/, (route) => json(route, 200, { items: [{ code: "KBANK", name: "Kasikornbank" }] }));
    const created = await record(page, /\/api\/payout-accounts$/, (route) => json(route, 201, account(IDS.account, true)));
    await page.goto("/wallet/payout-accounts");
    await page.getByLabel("Bank").selectOption("KBANK");
    await page.getByLabel("Account holder name").fill("Taylor Tutor");
    await page.getByLabel("Account number").fill("12345");
    await page.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByText(/10 to 15 digits/)).toBeVisible();
    expect(created).toHaveLength(0);
  });

  test("requests a payout, explaining that pending earnings cannot fund it", async ({ page }) => {
    await signIn(page, ["STUDENT", "TUTOR"]);
    await page.route(/\/api\/payouts\?/, (route) => json(route, 200, page1([])));
    await page.route(/\/api\/payout-accounts\?/, (route) => json(route, 200, page1([account(IDS.account, true)])));
    await page.route(/\/api\/wallet$/, (route) => json(route, 200, wallet()));
    let attempt = 0;
    const created = await record(page, /\/api\/payouts$/, (route) => {
      attempt += 1;
      if (attempt === 1) return json(route, 402, { code: "INSUFFICIENT_BALANCE", message: "Not enough available funds.", requestId: IDS.operation, retryable: false, fields: [] });
      return json(route, 202, { id: IDS.operation, owner: "wallet", status: "PENDING", statusUrl: `/api/operations/wallet/${IDS.operation}`, resource: null });
    });
    await page.goto("/wallet/payouts");
    await expect(page.getByText("THB 1300.00")).toBeVisible();
    await page.getByLabel("Amount (THB)").fill("5000");
    await page.getByRole("button", { name: "Request payout" }).click();
    await expect(page.getByText(/Pending earnings can’t fund a payout/)).toBeVisible();
    await page.getByLabel("Amount (THB)").fill("600");
    await page.getByRole("button", { name: "Request payout" }).click();
    await expect(page.getByText(/The amount is reserved until the provider reports an outcome/)).toBeVisible();
    expect(created[1].body).toEqual({ amount: "600.00", payoutAccountId: IDS.account });
    expect(created[0].headers["idempotency-key"]).not.toBe(created[1].headers["idempotency-key"]);
  });

  test("keeps an UNKNOWN payout reserved and says so", async ({ page }) => {
    await signIn(page, ["STUDENT", "TUTOR"]);
    await page.route(new RegExp(`/api/payouts/${IDS.payout}$`), (route) => json(route, 200, {
      id: IDS.payout, userId: IDS.user, amount: thb("600.00"), payoutAccount: account(IDS.account, true), status: "UNKNOWN", demo: true,
      providerReference: IDS.provider, createdAt: TS, resolvedAt: null,
      operation: { id: IDS.operation, owner: "wallet", status: "SUCCEEDED", statusUrl: "", resource: null },
    }));
    await page.goto(`/wallet/payouts/${IDS.payout}`);
    await expect(page.getByRole("status").filter({ hasText: /stays reserved/ })).toBeVisible();
  });
});

test.describe("disputes", () => {
  test("a student opens a dispute and sees it listed", async ({ page }) => {
    await signIn(page);
    let items: unknown[] = [];
    await page.route(/\/api\/disputes\?/, (route) => json(route, 200, page1(items)));
    const created = await record(page, /\/api\/disputes$/, (route) => { items = [dispute()]; return json(route, 201, dispute()); });
    await page.goto(`/disputes?bookingId=${IDS.booking}`);
    await page.getByRole("button", { name: "Open dispute" }).click();
    await expect(page.getByText("What went wrong?")).toBeVisible();
    await expect(page.getByText("Tell us what went wrong.")).toBeVisible();
    await page.getByLabel("What went wrong?").fill("The tutor never joined.");
    await page.getByRole("button", { name: "Open dispute" }).click();
    await expect(page.getByText("Your dispute was opened.")).toBeVisible();
    expect(created[0].body).toEqual({ bookingId: IDS.booking, reason: "The tutor never joined." });
    await expect(page.getByRole("link", { name: "View" })).toBeVisible();
  });

  test("an admin inspects evidence and must give a reason before deciding, using the current revision", async ({ page }) => {
    await signIn(page, ["STUDENT", "ADMIN"]);
    const detail = (status: string, revision: string) => ({
      dispute: dispute({ status, revision, refundedAmount: thb(status === "APPROVED" ? "140.00" : "0.00"), decisionReason: status === "OPEN" ? null : "Evidence supports the student.",
        audit: status === "OPEN" ? [] : [{ id: IDS.operation, actorUserId: IDS.user, action: "DISPUTE_APPROVED", reason: "Evidence supports the student.", occurredAt: TS }] }),
      booking: { bookingId: IDS.booking, status: "COMPLETED", studentUserId: IDS.user, tutorUserId: IDS.account, subjectId: IDS.account2, startsAt: TS, endsAt: TS, completedAt: TS, cancelledAt: null, revision: "1" },
      financial: { bookingId: IDS.booking, studentUserId: IDS.user, tutorUserId: IDS.account, paid: thb("200.00"), refunded: thb("60.00"), pendingEarning: thb("120.00"), fee: thb("20.00"),
        status: "COMPLETED", paymentGate: "CLOSED", tutorConfirmedAt: TS, clearingDueAt: TS, disputeId: IDS.dispute, disputeHeld: status === "OPEN", revision: "2" },
      transactions: [], studentDisplayName: "Jamie Learner", tutorDisplayName: "Taylor Tutor",
    });
    let current = detail("OPEN", "7");
    await page.route(/\/api\/admin\/disputes\?/, (route) => json(route, 200, page1([current.dispute])));
    await page.route(new RegExp(`/api/admin/disputes/${IDS.dispute}$`), (route) => json(route, 200, current, { ETag: `"${current.dispute.revision}"` }));
    const decided = await record(page, new RegExp(`/api/admin/disputes/${IDS.dispute}/decision$`), (route) => { current = detail("APPROVED", "8"); return json(route, 200, current.dispute); });

    await page.goto("/admin/disputes");
    await page.getByRole("link", { name: "Review" }).click();
    await expect(page.getByText("Jamie Learner")).toBeVisible();
    await expect(page.getByText("Pending tutor earning")).toBeVisible();
    await page.getByRole("button", { name: "Record decision" }).click();
    await expect(page.getByText(/Enter the reason for your decision/)).toBeVisible();
    expect(decided).toHaveLength(0);

    await page.getByLabel("Reason (kept in the audit trail)").fill("Evidence supports the student.");
    await page.getByRole("button", { name: "Record decision" }).click();
    await expect(page.getByText(/remaining paid amount was refunded/)).toBeVisible();
    expect(decided[0].body).toEqual({ decision: "APPROVE_FULL_REMAINDER", reason: "Evidence supports the student." });
    expect(decided[0].headers["if-match"]).toBe('"7"');
    await expect(page.getByRole("button", { name: "Record decision" })).toHaveCount(0);
    await expect(page.getByText("Dispute Approved", { exact: true })).toBeVisible();
  });

  test("a student cannot open the admin dispute pages", async ({ page }) => {
    await signIn(page, ["STUDENT"]);
    await page.goto("/admin/disputes");
    await expect(page.getByRole("heading", { name: "Admin access required" })).toBeVisible();
  });
});

test.describe("demonstration provider controls", () => {
  test("an admin records an outcome and sees the resulting status", async ({ page }) => {
    await signIn(page, ["STUDENT", "ADMIN"]);
    const posted = await record(page, new RegExp(`/api/demo/topups/${IDS.topup}/outcome$`), (route) => json(route, 200, topup("SUCCEEDED")));
    await page.goto("/demo/finance");
    await page.getByLabel("Top-up or payout ID").fill(IDS.topup);
    await page.getByLabel("Provider reference").fill(IDS.provider);
    await page.getByLabel("Outcome").selectOption("SUCCEEDED");
    await page.getByRole("button", { name: "Record outcome" }).click();
    await expect(page.getByText(/Recorded\./)).toBeVisible();
    expect(posted[0].body).toEqual({ outcome: "SUCCEEDED", providerReference: IDS.provider });
    expect(posted[0].headers["idempotency-key"]).toBeTruthy();
  });

  test("explains a refusal when demo controls are off", async ({ page }) => {
    await signIn(page, ["STUDENT", "ADMIN"]);
    await page.route(/\/api\/demo\/payouts\//, (route) => json(route, 403, { code: "DEMO_DISABLED", message: "Demo provider controls are disabled", requestId: IDS.operation, retryable: false, fields: [] }));
    await page.goto("/demo/finance");
    await page.getByLabel("Resource").selectOption("payouts");
    await page.getByLabel("Top-up or payout ID").fill(IDS.payout);
    await page.getByLabel("Provider reference").fill(IDS.provider);
    await page.getByRole("button", { name: "Record outcome" }).click();
    await expect(page.getByText(/Demo controls are turned off/)).toBeVisible();
  });

  test("a non-admin cannot reach the controls", async ({ page }) => {
    await signIn(page, ["STUDENT", "TUTOR"]);
    await page.goto("/demo/finance");
    await expect(page.getByRole("heading", { name: "Admin access required" })).toBeVisible();
  });
});

test.describe("notifications", () => {
  const prefs = (revision: string, productEmail = true) => ({
    bookingUpdates: { email: true, push: true }, lessonReminders: { email: true, push: true }, newMessages: { email: true, push: true },
    walletPayments: { email: true, push: true }, productNews: { email: productEmail, push: false }, revision,
  });

  test("saves the five preference groups with the current revision and lists simulated receipts", async ({ page }) => {
    await signIn(page);
    let current = prefs("4");
    await page.route(/\/api\/notifications\?/, (route) => json(route, 200, page1([
      { id: IDS.operation, eventId: IDS.booking, recipientUserId: IDS.user, channel: "EMAIL", category: "WALLET_PAYMENTS", status: "DELIVERED", demo: true, createdAt: TS, deliveredAt: TS },
      { id: IDS.topup, eventId: IDS.booking, recipientUserId: IDS.user, channel: "PUSH", category: "SYSTEM", status: "SKIPPED", demo: true, createdAt: TS, deliveredAt: null },
    ])));
    const saved = await record(page, /\/api\/notifications\/preferences$/, async (route) => {
      if (route.request().method() === "GET") return json(route, 200, current, { ETag: '"4"' });
      current = prefs("5", false);
      return json(route, 200, current, { ETag: '"5"' });
    });
    await page.goto("/notifications");
    for (const label of ["Booking updates", "Lesson reminders", "New messages", "Wallet and payments", "Product news"]) {
      await expect(page.getByRole("checkbox", { name: `${label}: email` })).toBeVisible();
    }
    await expect(page.getByText("Simulated").first()).toBeVisible();
    await page.getByRole("checkbox", { name: "Product news: email" }).uncheck();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByText("Your notification preferences were saved.")).toBeVisible();
    const put = saved.find((call) => call.method === "PUT")!;
    expect(put.headers["if-match"]).toBe('"4"');
    expect(put.body).toEqual({
      bookingUpdates: { email: true, push: true }, lessonReminders: { email: true, push: true }, newMessages: { email: true, push: true },
      walletPayments: { email: true, push: true }, productNews: { email: false, push: false },
    });
  });
});
