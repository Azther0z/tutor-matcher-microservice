import type { Page, Route } from "@playwright/test";

export const IDS = {
  user: "00000000-0000-4000-8000-000000000101",
  booking: "00000000-0000-4000-8000-000000000201",
  topup: "00000000-0000-4000-8000-000000000301",
  provider: "00000000-0000-4000-8000-000000000401",
  operation: "00000000-0000-4000-8000-000000000501",
  account: "00000000-0000-4000-8000-000000000601",
  account2: "00000000-0000-4000-8000-000000000602",
  payout: "00000000-0000-4000-8000-000000000701",
  dispute: "00000000-0000-4000-8000-000000000801",
};

export const thb = (amount: string) => ({ currency: "THB", amount });
export const TS = "2026-11-10T03:00:00.000Z";

/** Signs in with a synthetic session; the shell reads the token from tab storage and confirms it with /api/auth/me. */
export async function signIn(page: Page, capabilities: string[] = ["STUDENT"]) {
  await page.addInitScript(() => window.sessionStorage.setItem("tm.session.token", "synthetic-session-token"));
  await page.route(/\/api\/auth\/me$/, (route) => json(route, 200, {
    id: IDS.user, firstName: "Jamie", lastName: "Learner", email: "jamie@example.test", capabilities, status: "ACTIVE", revision: "0",
  }));
}

export function json(route: Route, status: number, body: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
}

export type Seen = { method: string; url: string; headers: Record<string, string>; body?: unknown };

/** Records every request that matches, so a test can assert on what the browser actually sent. */
export async function record(page: Page, pattern: RegExp, respond: (route: Route, seen: Seen) => Promise<void> | void) {
  const calls: Seen[] = [];
  await page.route(pattern, async (route) => {
    const request = route.request();
    const seen: Seen = { method: request.method(), url: request.url(), headers: request.headers(), body: request.postData() ? request.postDataJSON() : undefined };
    calls.push(seen);
    await respond(route, seen);
  });
  return calls;
}

export const wallet = (overrides: Record<string, unknown> = {}) => ({
  userId: IDS.user,
  postedBalance: thb("1500.00"), reservedPayouts: thb("200.00"), availableBalance: thb("1300.00"),
  pendingEarnings: thb("350.00"), earningsThisMonth: thb("900.00"), totalPaidOut: thb("2400.00"),
  paymentDueBookings: [],
  ...overrides,
});

export const topup = (status: string, overrides: Record<string, unknown> = {}) => ({
  id: IDS.topup, userId: IDS.user, amount: thb("250.50"), status, demo: true, providerReference: IDS.provider,
  paymentRepresentation: "DEMO-NOT-PAYABLE-0001",
  operation: { id: IDS.operation, owner: "wallet", status: status === "PENDING" ? "PENDING" : "SUCCEEDED", statusUrl: `/api/operations/wallet/${IDS.operation}`, resource: null },
  createdAt: TS, confirmedAt: status === "SUCCEEDED" ? TS : null,
  ...overrides,
});

export const account = (id: string, isDefault: boolean, revision = "0") => ({
  id, bankCode: "KBANK", accountHolderName: "Taylor Tutor", maskedAccountNumber: `••••${id.slice(-4)}`, isDefault, revision,
});

export const page1 = (items: unknown[]) => ({ items, pagination: { page: 1, pageSize: 20, totalItems: items.length, totalPages: 1 } });

export const dispute = (overrides: Record<string, unknown> = {}) => ({
  id: IDS.dispute, bookingId: IDS.booking, studentUserId: IDS.user, status: "OPEN", reason: "The tutor never joined.",
  decisionReason: null, refundedAmount: thb("0.00"), earningsHeld: true, revision: "0", createdAt: TS, resolvedAt: null, audit: [],
  ...overrides,
});
