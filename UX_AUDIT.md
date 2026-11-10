# Tutor Matcher UX/UI and error audit — organised by symptom

Every problem found, grouped by what the user actually sees. Finding IDs (UX-01 … UX-51) are stable, so each one can be traced from the symptom list to the flat table and its details.

## 1. Summary

**51 findings** from walking every route reachable in the web app, logged out, as a student, and at 375px.

| Severity | Count |
| --- | --- |
| Blocker | 2 |
| High | 4 |
| Medium | 18 |
| Low | 27 |

| Category | Count |
| --- | --- |
| UX | 28 |
| UI visual | 9 |
| Copy | 6 |
| Accessibility | 6 |
| Backend error | 2 |

| Classification | Count |
| --- | --- |
| n/a (frontend) | 31 |
| frontend handling | 11 |
| real bug | 5 |
| missing service + frontend handling | 2 |
| missing service | 2 |

No finding is an App crash: no uncaught exception, blank screen or console `pageerror` occurred anywhere. Most outage findings show a generic message rather than failing silently.

### Symptoms at a glance

| Group | What the user sees | Findings | Worst severity |
| --- | --- | --- | --- |
| A | A "404 This page could not be found" for something the app promises or links to | UX-01, 02, 03, 30 | Blocker |
| B | A dead end, or navigation that doesn't match who they are or where they are | UX-04, 08, 19, 22, 33, 47, 48 | High |
| C | Signed out or locked out without warning | UX-05, 07, 34 | High |
| D | A backend outage shown as one vague, unhelpful message | UX-15, 16, 17, 18, 20, 21, 25, 46, 50 | Medium |
| E | Form validation that is technical, unclear or in the wrong place | UX-11, 12, 29, 31, 32, 37, 39, 49 | Medium |
| F | Signup form surprises | UX-09, 10 | Medium |
| G | An action with no feedback, or stale feedback | UX-14, 35, 38, 44, 45 | Medium |
| H | Visual and layout defects | UX-06, 13, 27, 36, 40, 42, 43, 51 | High |
| I | Accessibility barriers | UX-23, 24, 26, 28 | Medium |
| J | Copy that doesn't fit its page | UX-41 | Low |

### Top 5 issues to fix first

1. **UX-01 / UX-03 Booking and Availability pages do not exist (group A).** `/bookings`, `/teach/availability` and every booking link target return the stock Next.js 404. This is not caused by the Booking service being down; the web app has no such routes. The central student journey (choose slots, hold, pay, view booking) and the tutor Availability step cannot be reached.
2. **UX-02 Messaging has no pages (group A).** `/messages` is a 404 and nothing links to it, although student–tutor messaging is in scope (SUP-01).
3. **UX-05 A wrong "current password" signs the user out (group C).** Changing email or deactivating with a mistyped password returns 401 `INVALID_CREDENTIALS`, and the client treats it as an expired session. It wipes the token and drops the user on a blank login page with no message, while the server session is still valid.
4. **UX-04 Tutor discovery cannot be reached from the landing page or the header (group B).** There is no "Find tutors" link. The Account page's "Browse Tutor Matcher" link goes back to the landing page.
5. **UX-06 On mobile (375px) the header hides "Log in" and "Sign out" (group H).** Both are `display:none`, so a signed-in mobile user can only sign out through a button deep in Account settings.

Close behind: UX-07 (login lockout appears to count successful logins and gives no duration), UX-15/UX-18 (gateway 503s are plain text, so every outage shows the same generic message and several lists have no retry), and UX-08 (the header nav ignores login state and role).

## 2. Environment

| Item | Value |
| --- | --- |
| Date | 10 November 2026 (Asia/Bangkok) |
| Web app | http://localhost:3000 (Next.js 16.4.5, production `next start`) |
| Gateway | http://127.0.0.1:8080 (Traefik) |
| Browser | Headless Chromium (Playwright 1.65, cached chrome-headless-shell build 1248), driven from scripts in `/tmp/ux` outside the repo |
| Viewports | Desktop 1440×1000, mobile 375×812 |
| Compose project | `tutor-demo-3` |
| Services up | postgres, rabbitmq, api-gateway (Traefik), auth-service, web, docker-api |
| Services down (not deployed) | tutor, booking, wallet, review, messaging, notification. Traefik answers their routes with 503 from `*-unavailable@file` fallback routers. |
| Test accounts | Synthetic only: `qa+student1`, `qa+probe`, `qa+student3`, `qa+student4` at `@example.test`. `qa+student4` was deactivated during the audit. |
| Not tested | Any ADMIN-only content (section 5) |

Source code, config, compose files, tests and containers were not modified by the audit. `.ux-audit/screenshots/` also holds screenshots from an earlier pass that this report does not cite. The `M infra/docker/postgres-owned-databases.sh` entry in `git status` pre-dates the audit (a mode-only change).

Classification legend: **missing service** = backend not deployed (expected). **real bug** = the running component misbehaves, or the web app lacks a route it links to. **frontend handling** = how the UI reacts to an error or an outage. **n/a (frontend)** = pure copy, visual or accessibility issue with no backend involved.

An earlier pass of this audit suggested a request loop on `/teach/application`. Re-measured here over 10 seconds, there is none (request counts stay constant).

## 3. Findings table

| ID | Group | Severity | Category | Page/flow | Classification | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| UX-01 | A | Blocker | UX | Booking (all pages) | real bug | No booking pages exist; `/bookings` is a 404 and nothing lets a student book, pay for or view a booking |
| UX-02 | A | Blocker | UX | Messaging | real bug | No messaging pages exist; `/messages` is a 404 and nothing links to it |
| UX-03 | A | High | UX | Tutor → Availability | real bug | The "Availability" tab on every `/teach/*` page links to a 404 |
| UX-04 | B | High | UX | Landing, header, Account | real bug | No link to tutor discovery from the landing page or header; "Browse Tutor Matcher" loops back to the landing page |
| UX-05 | C | High | UX | Account settings | frontend handling | Wrong current password (email change, deactivate) is treated as an expired session: token wiped, silent redirect to a blank login |
| UX-06 | H | High | UI visual | Header, mobile | n/a (frontend) | At 375px "Log in" and "Sign out" are `display:none` |
| UX-07 | C | Medium | Backend error | Login | real bug | Account lockout (429) appears to count successful logins, blocks the correct password, and the UI gives no wait time |
| UX-08 | B | Medium | UX | Header nav | n/a (frontend) | Nav ignores login state and role: signed-in users see "Log in / Create account"; logged-out users and students see Account, Wallet, Notifications, Admin |
| UX-09 | F | Medium | UX | Signup | n/a (frontend) | "Terms of Service" and "Privacy notice" are plain text with no link and no page |
| UX-10 | F | Medium | UX | Signup | n/a (frontend) | Public "Admin signup key" field; a wrong key is silently ignored and a normal account is created |
| UX-11 | E | Medium | Copy | Signup, login, password reset | frontend handling | Raw validation text (`must match format "email"`) and a bare "Request validation failed." banner; login and reset show no field error |
| UX-12 | E | Medium | UI visual | Account settings | n/a (frontend) | One error key is shared by three forms: "Required." appears under unrelated password fields |
| UX-13 | H | Medium | UI visual | Account → learning profile | n/a (frontend) | "Preferred lesson periods" fieldset is mis-laid-out (centred checkboxes, right-aligned labels, default border) |
| UX-14 | G | Medium | UX | Login after password change or deactivation | n/a (frontend) | `/login?notice=password-changed` and `?notice=deactivated` are never read, so the user sees no confirmation |
| UX-15 | D | Medium | Backend error | All pages when a service is down | frontend handling | Gateway 503/404 bodies are plain text, not the JSON error envelope, so the UI falls back to "This information is unavailable. Please retry." |
| UX-16 | D | Medium | UX | Discover | missing service + frontend handling | Tutor service down: two stacked error banners plus a third "Try again", search still enabled |
| UX-17 | D | Medium | UX | Wallet | missing service + frontend handling | Wallet down: no balance, but "Add funds" stays live and fails only after submit |
| UX-18 | D | Medium | UX | Transactions, Disputes, Notification preferences | frontend handling | Inconsistent recovery: these error states have no retry button, while Wallet and Delivery receipts do |
| UX-19 | B | Medium | UX | `/teach/subjects`, `/wallet/payouts*` as a student | n/a (frontend) | A student without Tutor capability gets "Tutor access required" with no link to apply; the application page is not in the nav |
| UX-20 | D | Medium | UX | `/teach/application`, `/teach/profile` | missing service | Tutor service down: generic error only, no guidance |
| UX-21 | D | Medium | UX | Password reset | missing service | Reset request reports "queued", but the Notification service is down, so no link can ever arrive |
| UX-22 | B | Medium | UX | Disputes | n/a (frontend) | The user must paste a raw Booking ID; there is no booking list to choose from |
| UX-23 | I | Medium | Accessibility | Whole app, mobile | n/a (frontend) | Tap targets far below 44px (nav links 17px high, checkboxes 13px) |
| UX-24 | I | Medium | Accessibility | Whole app | n/a (frontend) | Muted text fails WCAG AA contrast (3.58:1 footer, 4.38:1 secondary text) |
| UX-25 | D | Low | Copy | `/wallet/transactions/{id}`, `/disputes/{id}`, `/wallet/topups/{id}` | frontend handling | A malformed id shows "Request parameters are invalid." (400) with a pointless "Try again" |
| UX-26 | I | Low | Accessibility | All pages | n/a (frontend) | Every page has the same `<title>` ("Tutor Matcher") |
| UX-27 | H | Low | UI visual | All pages | n/a (frontend) | `/favicon.ico` is a 404 |
| UX-28 | I | Low | Accessibility | All pages | n/a (frontend) | No skip link; 7 header stops precede page content |
| UX-29 | E | Low | Accessibility | Signup, login | n/a (frontend) | No focus move or error summary after a failed submit; focus stays on the button |
| UX-30 | A | Low | UI visual | 404 page | n/a (frontend) | Default unstyled Next.js 404 (white background, black text) inside the branded shell |
| UX-31 | E | Low | UX | Signup | n/a (frontend) | The 100-character password limit is never stated and not enforced client-side |
| UX-32 | E | Low | UX | Signup | n/a (frontend) | Duplicate-email error is shown twice, and it reveals whether an email is registered |
| UX-33 | B | Low | UX | Login, signup | n/a (frontend) | Signed-in users can open `/login` and `/signup` and see the empty forms |
| UX-34 | C | Low | UX | Logout from Account | frontend handling | Logout lands on `/login?returnTo=%2Faccount`, so the next login (possibly another user) returns to Account |
| UX-35 | G | Low | UX | Account settings | n/a (frontend) | The "details saved" banner persists while other forms on the page are used |
| UX-36 | H | Low | UI visual | Account settings | n/a (frontend) | "Sign out of this session" looks like a stray link; the danger zone sits above the learning profile; header "Sign out" is bigger than other nav items |
| UX-37 | E | Low | UX | Account → learning profile | n/a (frontend) | Learning areas must be typed as comma-separated lowercase slugs |
| UX-38 | G | Low | UX | Password reset | frontend handling | Opening a reset link when the tab is already on `/password-reset` does nothing (hash change ignored) |
| UX-39 | E | Low | UX | Discover | frontend handling | Negative or inverted price ranges (min 900, max 100) are sent to the backend with no client check |
| UX-40 | H | Low | UI visual | Discover | n/a (frontend) | "Clear filters" sits off-centre beside the Search button; the error banner touches the button |
| UX-41 | J | Low | Copy | Notifications | n/a (frontend) | The Notifications page shows the "No real money moves…" banner, which has nothing to do with notifications |
| UX-42 | H | Low | UI visual | `/teach/*` | n/a (frontend) | The tutor sub-navigation has no active-page indicator and reads as a list of underlined links |
| UX-43 | H | Low | Copy | Landing | n/a (frontend) | "More learning features are coming soon" contradicts the built features; large empty area under the hero; mobile "Get started →" wraps |
| UX-44 | G | Low | Copy | Login (deactivated account) | n/a (frontend) | "Contact support" with no support contact anywhere; "restricted" does not say the user deactivated the account |
| UX-45 | G | Low | UX | Wallet top-up | frontend handling | A double click sends two POSTs; no visible pending state (safe: same Idempotency-Key) |
| UX-46 | D | Low | Accessibility | `/tutors/{id}` error state | frontend handling | The error state has no `<h1>`, so the page has no heading |
| UX-47 | B | Low | UX | `/reviews` | n/a (frontend) | The page is a dead-end explainer whose only action is "Find a tutor" |
| UX-48 | B | Low | UX | Discover | n/a (frontend) | "Lesson format" is a dropdown with a single option ("Online") |
| UX-49 | E | Low | Copy | Discover | n/a (frontend) | "Minimum rating" options are bare numbers (1, 1.5 … 5) with no "stars" or "& up" |
| UX-50 | D | Low | UX | Every error state | frontend handling | Error responses carry a `requestId`, but no page shows it to the user, so there is nothing to quote to support |
| UX-51 | H | Low | UI visual | Wallet | n/a (frontend) | "Transaction history" and "Disputes" sit in an otherwise empty card as bare links with no heading |

## 4. Finding details, by symptom

Shared evidence for outage findings (UX-15 to UX-21, UX-46, UX-50): the gateway log has one entry per failing route, for example `DownstreamStatus 503, RouterName get-wallet-unavailable@file, OriginStatus 0`, with the same pattern for `search-tutor-subjects-unavailable`, `list-own-notifications-unavailable`, `get-tutor-workspace-unavailable` and `list-own-disputes-unavailable`. The web and auth-service containers logged nothing for these requests.

---

### Group A — "404 This page could not be found"

The user follows a link or journey the app itself suggests and reaches the framework's default 404. Cause: routes that were never built (not a service outage).

#### UX-01 Booking pages do not exist (Blocker, UX, real bug)
- **Steps:** Open `/bookings` (logged out or signed in). Look in the header, Account, Wallet, Discover, `/reviews/new` and `/disputes` for any way to book, pay for or open a booking.
- **Expected:** UC-03: a student chooses a subject and slots, creates a held booking, pays from the wallet, and views the booking. The review and dispute pages tell the user to "open a completed booking", so a booking list or detail page should exist.
- **Actual:** `/bookings` returns the stock 404. `apps/web/app` has no booking routes. Only `/reviews/bookings/{id}` and the dispute form refer to bookings, and the dispute form wants a pasted ID. This is independent of the Booking service being down.
- **Evidence:** `.ux-audit/screenshots/a1-out-_bookings.png`; `.ux-audit/screenshots/c8-d-_reviews_new.png`; console `404 GET /bookings`.
- **Fix direction:** Add the booking creation, payment and list/detail pages, linked from tutor/subject pages and the header. Until the Booking service is deployed, show an explicit "bookings are unavailable" state rather than a 404.

#### UX-02 Messaging pages do not exist (Blocker, UX, real bug)
- **Steps:** Open `/messages`; look for any "Message tutor" action on a tutor profile or an inbox link in the header.
- **Expected:** SUP-01: inbox, thread, unread indicator, and a way to start a conversation with a tutor.
- **Actual:** `/messages` is a 404 and no page links to it.
- **Evidence:** `.ux-audit/screenshots/a1-out-_messages.png`; console `404 GET /messages`.
- **Fix direction:** Add inbox and thread routes plus entry points from the tutor profile and header. Show a clear unavailable state while the Messaging service is down.

#### UX-03 "Availability" tab links to a 404 (High, UX, real bug)
- **Steps:** Sign in, open `/teach/application`, click "Availability" (or open `/teach/availability`).
- **Expected:** A page for opening half-hour slots (UC-02). `/teach/subjects` even says "open their half-hour slots in Availability".
- **Actual:** 404. Every `/teach/*` page also logs a failed prefetch, `404 GET /teach/availability?_rsc=…`, in the console.
- **Evidence:** `.ux-audit/screenshots/c8-d-_teach_application.png`; `.ux-audit/screenshots/c8-d-_teach_subjects.png`.
- **Fix direction:** Build the Availability page or remove the link until it exists.

#### UX-30 Unstyled 404 page (Low, UI visual, n/a (frontend))
- **Steps:** Open `/does-not-exist`, `/bookings`, `/messages` or `/tutors`.
- **Expected:** A branded not-found page with a way back to search or home.
- **Actual:** The default Next.js "404 | This page could not be found." in black on a white background, inside the cream branded shell, with no link home or to search.
- **Evidence:** `.ux-audit/screenshots/a1-out-_bookings.png`.
- **Fix direction:** Add a branded `not-found` page.

---

### Group B — Dead ends and navigation that doesn't match the user

The user can't find the next step, or sees controls that don't apply to them.

#### UX-04 No path to tutor discovery (High, UX, real bug)
- **Steps:** From `/`, read the header and hero. Sign in and use "Browse Tutor Matcher" on `/account`.
- **Expected:** A prominent "Find tutors" entry on the landing page and in the header, since search is the core student journey.
- **Actual:** The landing page offers only "Get started" and "I already have an account". The header has no discovery link. "Browse Tutor Matcher" on Account links to `/`, which has no browse action. `/discover` is reachable only by typing the URL or via "Find a tutor" on `/reviews` and `/teach/*`.
- **Evidence:** `.ux-audit/screenshots/a1-out-_.png`; `.ux-audit/screenshots/c8-d-_wallet.png`.
- **Fix direction:** Add "Find tutors" to the header and landing hero, and point the Account link at `/discover`.

#### UX-08 Header nav ignores login state and role (Medium, UX, n/a (frontend))
- **Steps:** Compare the header logged out, signed in as a student, and on mobile.
- **Expected:** Logged out: Log in / Create account. Signed in: Account, Wallet, Notifications, Sign out. Admin only for admins.
- **Actual:** The same links always render: "Log in", the highlighted "Create account", Account, Wallet, Notifications, Admin. Signed-in users still see "Log in / Create account". Logged-out users and students see "Admin" and "Wallet" and are sent to login or "Admin access required".
- **Evidence:** `.ux-audit/screenshots/b3-account-after-signup.png`; `.ux-audit/screenshots/c8-d-_admin_users.png`.
- **Fix direction:** Render nav items from auth state and capabilities.

#### UX-19 Students hit a dead end on tutor pages (Medium, UX, n/a (frontend))
- **Steps:** As a student open `/teach/subjects`, `/wallet/payouts`, `/wallet/payout-accounts`.
- **Expected:** "Become a tutor" with a link to `/teach/application`.
- **Actual:** "Approved and activated Tutor access is required to manage subjects." / "Tutor access required. Your current account does not have the TUTOR capability." with no action. The application page is not linked from the header or Account.
- **Evidence:** `.ux-audit/screenshots/c8-d-_teach_subjects.png`; `.ux-audit/screenshots/c8-d-_wallet_payouts.png`.
- **Fix direction:** Add an apply call-to-action to these states and to the nav.

#### UX-22 Dispute form needs a pasted Booking ID (Medium, UX, n/a (frontend))
- **Steps:** `/disputes` → "Open a dispute".
- **Expected:** Q-09: no manual ID copying; choose from the user's bookings.
- **Actual:** A free-text "Booking ID" field with "Enter the booking ID from your booking page", which does not exist (UX-01). An empty submit shows good field errors; a valid-looking submit with the service down shows "We couldn't open the dispute."
- **Evidence:** `.ux-audit/screenshots/f14-dispute-empty.png`.
- **Fix direction:** Start disputes from a booking detail page or offer a booking picker.

#### UX-33 Auth pages while signed in (Low, UX, n/a (frontend))
- **Steps:** Sign in, then open `/login` or `/signup`.
- **Expected:** Redirect to `/account`.
- **Actual:** The empty forms render with no redirect or notice.
- **Evidence:** `.ux-audit/screenshots/b3-login-while-authed.png`.
- **Fix direction:** Redirect signed-in users away from these pages.

#### UX-47 `/reviews` dead end (Low, UX, n/a (frontend))
- **Steps:** Open `/reviews`.
- **Actual:** "Choose a tutor or subject to read its verified lesson reviews." with one action, "Find a tutor", which leads to `/discover`.
- **Evidence:** `.ux-audit/screenshots/c8-d-_reviews_new.png` (sibling page); text captured on `/reviews`.
- **Fix direction:** Link into discovery results, or fold reviews into the tutor profile.

#### UX-48 Single-option "Lesson format" dropdown (Low, UX, n/a (frontend))
- **Steps:** Open `/discover`, open "Lesson format".
- **Actual:** The select contains one option, "Online". It looks like a filter but filters nothing. ("Learning area" has only "All learning areas" because its options failed to load.)
- **Evidence:** `.ux-audit/screenshots/a1-out-_discover.png`.
- **Fix direction:** Show it as static text until more formats exist.

---

### Group C — Signed out or locked out without warning

#### UX-05 Wrong current password signs the user out (High, UX, frontend handling)
- **Steps:** Sign in, open `/account`. In "Personal details" enter a new email and a wrong "Current password", then Save. Repeat with a wrong password in "Deactivate account" and accept the confirm dialog.
- **Expected:** An inline "Current password is incorrect" error. The session stays active (the server session is still valid).
- **Actual:** `PUT /api/profiles/me/account` returns 401 `INVALID_CREDENTIALS`. `api()` treats every 401 on an authenticated call as session expiry: it clears the token, fires `tm:session-expired`, and `RequireAuth` redirects to `/login?returnTo=%2Faccount` with no message. Entering the password again requires a full login. Reproduced for both forms; the "change password" form with a wrong current password was not re-verified separately.
- **Evidence:** `.ux-audit/screenshots/b4-acct-email-wrong-pw.png` (blank login); `.ux-audit/screenshots/g16-deactivate-wrong-pw.png`; network `401 PUT /api/profiles/me/account {"code":"INVALID_CREDENTIALS","message":"Current password is incorrect."}`.
- **Fix direction:** Only treat 401 `TOKEN_INVALID` as session expiry; show `INVALID_CREDENTIALS` as a field error.

#### UX-07 Login lockout counts successful logins and gives no duration (Medium, Backend error, real bug)
- **Steps:** Log in successfully about 10 times in roughly 15 minutes with `qa+probe` (no failed attempts), then try again with the correct password. Separately, make about 9 wrong attempts on `qa+student1`.
- **Expected:** Lockout after repeated failures only, with a visible wait time. Valid sign-ins by the owner are not penalised.
- **Actual:** Both accounts return 429 `RATE_LIMITED` with `Retry-After` (714 s and 485 s) even for the correct password. The UI says only "Too many attempts. Try again later." and ignores `Retry-After`. The lock is per account (other accounts from the same IP still log in). The success-counting conclusion is inferred from the probe account having zero failures; the exact threshold was not determined. Anyone who can guess an email can also lock that user out.
- **Evidence:** `.ux-audit/screenshots/b9-login-rate-limited.png`; `429 POST /api/auth/login {"code":"RATE_LIMITED",…}`; `.ux-audit/screenshots/b3-login-bruteforce.png` (the earlier failed attempts showed only "Email or password is incorrect." with no warning that a lock was approaching).
- **Fix direction:** Count only failures, or use per-IP plus per-account limits that do not hard-lock the owner. Show the retry time from `Retry-After`.

#### UX-34 Logout keeps `returnTo` (Low, UX, frontend handling)
- **Steps:** On `/account` click the header "Sign out".
- **Expected:** `/login` with no destination.
- **Actual:** Lands on `/login?returnTo=%2Faccount`, most likely because the page's auth guard and the sign-out handler both redirect (inferred from the code, not instrumented). The next login, possibly by a different person, goes straight to Account.
- **Evidence:** `.ux-audit/screenshots/b3-after-logout.png`.
- **Fix direction:** Skip the guard redirect after an intentional sign-out.

---

### Group D — Backend outage shown as one vague message

Cause: the gateway's fallback routes answer with plain text, and each page handles failure differently.

#### UX-15 Gateway errors are plain text, so the UI says nothing useful (Medium, Backend error, frontend handling)
- **Steps:** With services down, load `/discover`, `/tutors/{id}`, `/wallet`, `/teach/*`. Also `GET /api/tutors`.
- **Expected:** The JSON error envelope the other APIs use (`code`, `message`, `requestId`, `retryable`), so the UI can say which area is unavailable.
- **Actual:** The 503 body is `no available server\n` and the unknown route returns `404 page not found`. The client cannot parse them, so pages show the same sentence, "This information is unavailable. Please retry." (or "We couldn't load …"), regardless of cause. Retrying cannot succeed while the service is absent.
- **Evidence:** `503 GET /api/discovery/tutors/abc/profile :: no available server`; `.ux-audit/screenshots/a1-out-_tutors_abc.png`; gateway log entries with `OriginStatus 0` and `*-unavailable@file` routers.
- **Fix direction:** Have the fallback routers return the standard JSON envelope with a service-unavailable code, and let the UI show a specific, calmer message.

#### UX-16 Discover when the Tutor service is down (Medium, UX, missing service + frontend handling)
- **Steps:** Open `/discover`.
- **Expected:** One clear "Search is unavailable right now" state.
- **Actual:** Three failures stack: a red "Learning-area options could not load. Retry learning areas" banner, a grey "catalogue price range is temporarily unavailable" line, and a third red "This information is unavailable. Please retry." with a large "Try again" button. The filter form stays fully usable, and Search can only fail.
- **Evidence:** `.ux-audit/screenshots/a1-out-_discover.png`; `503 GET /api/discovery/learning-areas|price-range|tutors`.
- **Fix direction:** Collapse into one error state and disable the form until the catalogue loads.

#### UX-17 Wallet when the Wallet service is down (Medium, UX, missing service + frontend handling)
- **Steps:** Sign in, open `/wallet`, enter 500, press "Start top-up".
- **Expected:** An unavailable state that hides or disables money actions.
- **Actual:** "We couldn't load your wallet. Try again" appears, yet "Add funds" is live. Submitting fails with "We couldn't start the top-up. Your balance has not changed." Client-side amount validation is good: one clear message for 0, negative, text, over 100,000, and more than two decimals.
- **Evidence:** `.ux-audit/screenshots/f14-topup-last.png`; `503 POST /api/wallet/topups`.
- **Fix direction:** Disable the form while the wallet fails to load.

#### UX-18 Inconsistent retry on error states (Medium, UX, frontend handling)
- **Steps:** With services down, open `/wallet/transactions`, `/disputes`, `/notifications`.
- **Expected:** Each failed region offers "Try again".
- **Actual:** "Delivery receipts" and Wallet have a retry control; "We couldn't load your transactions.", "We couldn't load your disputes." and "We couldn't load your preferences." have none, so only a full reload recovers.
- **Evidence:** `.ux-audit/screenshots/c8-d-_wallet_transactions.png`; `.ux-audit/screenshots/c8-d-_disputes.png`; `.ux-audit/screenshots/c8-d-_notifications.png`.
- **Fix direction:** Use one shared error component with retry.

#### UX-20 Teach pages when the Tutor service is down (Medium, UX, missing service)
- **Steps:** Open `/teach/application` and `/teach/profile`.
- **Expected:** An explicit "Tutor tools are unavailable" state.
- **Actual:** Only "This information is unavailable. Please retry." and a Try again button under the tab row. `/teach/subjects` also logs `503 /api/discovery/learning-areas`.
- **Evidence:** `.ux-audit/screenshots/c8-d-_teach_application.png`; `503 GET /api/profiles/me/tutor`.
- **Fix direction:** As UX-15.

#### UX-21 Password reset cannot complete without the Notification service (Medium, UX, missing service)
- **Steps:** `/password-reset`, enter `qa+student1@example.test` or an unknown address, submit.
- **Expected:** The same neutral confirmation for both (AUTH-03), and a delivered link.
- **Actual:** Both show "If an account matches, reset instructions are queued for simulated delivery." (neutral, as required). With the Notification service down the link is never delivered; the admin demo page (`/demo/password-resets`) is the only in-app way I found to read it. Invalid or expired tokens are handled well ("This reset link is invalid, expired, or already used.").
- **Evidence:** `.ux-audit/screenshots/b6-pr-sent-unknown.png`; `.ux-audit/screenshots/b7-pr-bogus.png`.
- **Fix direction:** Nothing needed in the UI beyond deploying the service; mention the demo delivery page in the demo script.

#### UX-25 Malformed ids look like retryable errors (Low, Copy, frontend handling)
- **Steps:** Open `/wallet/transactions/abc`, `/disputes/abc`, `/wallet/topups/abc`, `/reviews/bookings/abc`.
- **Actual:** "Request parameters are invalid." (400 `VALIDATION_FAILED`); the topup and review pages add a "Try again" that can never work. A real id for a missing record was not testable because the services are down.
- **Evidence:** `.ux-audit/screenshots/c8-d-_wallet_transactions_abc.png`; `400 GET /api/wallet/transactions/abc`.
- **Fix direction:** Show "We couldn't find that record" with a link back to the list.

#### UX-46 Tutor profile error has no heading (Low, Accessibility, frontend handling)
- **Steps:** Open `/tutors/abc` with the Tutor service down.
- **Actual:** No `<h1>`; the page shows only "Back to discovery" and the error.
- **Evidence:** `.ux-audit/screenshots/a1-out-_tutors_abc.png`.
- **Fix direction:** Keep a page heading in every state.

#### UX-50 Request id never shown (Low, UX, frontend handling)
- **Steps:** Trigger any API error (422, 409, 429, 400).
- **Actual:** The JSON body always contains a `requestId` (it matches the gateway log), but no page displays it, so a user cannot quote a reference when asking for help.
- **Evidence:** network bodies on `/api/auth/signup` (422/409), `/api/auth/login` (429), `/api/wallet/transactions/abc` (400).
- **Fix direction:** Show the request id in error notices, in small text.

---

### Group E — Form validation that is technical, unclear or misplaced

#### UX-11 Raw validation messages (Medium, Copy, frontend handling)
- **Steps:** Signup with `not-an-email` (otherwise valid); login with `not-an-email`; password reset with `not-an-email`.
- **Expected:** "Enter a valid email address" under the field.
- **Actual:** Signup shows the banner "Request validation failed." plus the schema text `must match format "email"` under the field. Login and password reset show only the banner "Request validation failed." with no field highlighted (they do not map `fields`). The client only checks for empty values.
- **Evidence:** `.ux-audit/screenshots/b2-signup-bad-email-server.png`; `.ux-audit/screenshots/b3-login-bad-email.png`; `.ux-audit/screenshots/b6-pr-bad-email.png`; `422 POST /api/auth/signup|login|password-reset/request`.
- **Fix direction:** Validate email format client-side and map backend codes to friendly field messages.

#### UX-12 Error key shared across account forms (Medium, UI visual, n/a (frontend))
- **Steps:** `/account` → change email, leave "Current password" empty, Save.
- **Expected:** The error shows under that form's password field only.
- **Actual:** The 422 `CURRENT_PASSWORD_REQUIRED` banner appears at the top, and "Required." also appears under the unrelated "Current password" of Change password and "Current password to deactivate". Those fields turn red though the user never touched them.
- **Evidence:** `.ux-audit/screenshots/b4-acct-email-no-pw.png`.
- **Fix direction:** Scope errors per form.

#### UX-29 No focus management after a failed submit (Low, Accessibility, n/a (frontend))
- **Steps:** Submit the empty signup form.
- **Actual:** Six errors appear but focus stays on the submit button and the errors are not summarised.
- **Evidence:** `.ux-audit/screenshots/b2-signup-empty.png`.
- **Fix direction:** Focus the first invalid field.

#### UX-31 Password length limit unstated (Low, UX, n/a (frontend))
- **Steps:** Sign up with a 320-character password.
- **Actual:** 422 with "must NOT have more than 100 characters" under both password fields; the form only mentions the 8-character minimum.
- **Evidence:** `.ux-audit/screenshots/b2-signup-long-password.png`.
- **Fix direction:** State the range and set `maxLength`.

#### UX-32 Duplicate email message (Low, UX, n/a (frontend))
- **Steps:** Sign up with `QA+STUDENT1@EXAMPLE.TEST` (same address, upper case).
- **Actual:** "An account already uses this email address." in the banner and again under the field. This also confirms the address is registered, in tension with the neutral reset message.
- **Evidence:** `.ux-audit/screenshots/b3-signup-duplicate.png`; `409 POST /api/auth/signup`.
- **Fix direction:** Show it once; decide on an enumeration policy.

#### UX-37 Learning areas are typed as slugs (Low, UX, n/a (frontend))
- **Steps:** `/account` → learning profile → enter `Algebra Math, Web Dev!` → Save.
- **Actual:** "Use up to 30 learning area tags with lowercase letters, numbers, and hyphens." Discover offers learning areas as a dropdown instead.
- **Evidence:** `.ux-audit/screenshots/b5-lp-invalid.png`.
- **Fix direction:** Use the same picker as Discover.

#### UX-39 No client validation of price filters (Low, UX, frontend handling)
- **Steps:** On `/discover` search with min -5, then min 900 and max 100.
- **Actual:** `?minRate=-5&maxRate=100` and `?minRate=900&maxRate=100` are submitted unchanged. Backend behaviour could not be seen because the Tutor service is down.
- **Evidence:** `.ux-audit/screenshots/f14-discover-min-gt-max.png`.
- **Fix direction:** Validate before searching.

#### UX-49 Rating filter options are bare numbers (Low, Copy, n/a (frontend))
- **Steps:** Open `/discover`, open "Minimum rating".
- **Actual:** Options are "Any rating, 1, 1.5, 2 … 5" with no unit or "& up".
- **Evidence:** `.ux-audit/screenshots/a1-out-_discover.png`.
- **Fix direction:** Label them "4★ & up" or similar.

---

### Group F — Signup form surprises

#### UX-09 Terms and Privacy are not links (Medium, UX, n/a (frontend))
- **Steps:** Open `/signup`.
- **Expected:** AUTH-01 requires agreement to the Terms and Privacy Policy; the labels should link to them.
- **Actual:** "I agree to the Terms of Service." and "I have read the Privacy notice." are plain text. No such pages exist.
- **Evidence:** `.ux-audit/screenshots/b2-signup-empty.png`.
- **Fix direction:** Add the documents and link them (new tab).

#### UX-10 Public "Admin signup key" field (Medium, UX, n/a (frontend))
- **Steps:** Open `/signup`; submit with a made-up admin key.
- **Expected:** Ordinary users never see an admin-provisioning field; a wrong key gets feedback.
- **Actual:** The field is shown to everyone. With `wrong-key-123`, signup succeeded and a STUDENT account was created (verified by login: capabilities `["STUDENT"]`), with no hint that the key was ignored.
- **Evidence:** `.ux-audit/screenshots/b3-signup-bad-admin-key.png`.
- **Fix direction:** Hide the field outside provisioning flows, or reject an invalid key explicitly.

---

### Group G — No feedback, or stale feedback

#### UX-14 Login notices are never displayed (Medium, UX, n/a (frontend))
- **Steps:** Change password on `/account`, or deactivate an account.
- **Expected:** The login page shows "Your password was changed. Log in again" or "Your account was deactivated."
- **Actual:** The app redirects to `/login?notice=password-changed` or `?notice=deactivated`, but the login page only reads `returnTo`. The user lands on a bare login form.
- **Evidence:** `.ux-audit/screenshots/b5-after-pw-change.png`; `.ux-audit/screenshots/g17-after-deactivate.png`.
- **Fix direction:** Read `notice` and show the matching message.

#### UX-35 Stale success banner (Low, UX, n/a (frontend))
- **Steps:** Save "Personal details", then use the learning-profile form.
- **Actual:** "Your account details have been saved." stays at the top while the learning-profile form shows its own error or success further down the page.
- **Evidence:** `.ux-audit/screenshots/b5-lp-invalid.png`.
- **Fix direction:** Clear notices when another form submits.

#### UX-38 Reset link ignored on the same page (Low, UX, frontend handling)
- **Steps:** With the tab already on `/password-reset`, change the URL hash to `#token=…` (for example by pasting the emailed link into the same tab).
- **Actual:** Nothing happens; the token is read only on first load. A fresh load works (invalid token shows the correct error).
- **Evidence:** `.ux-audit/screenshots/b7-pr-bogus.png` (fresh-load case).
- **Fix direction:** Listen for `hashchange`.

#### UX-44 "Contact support" with no support (Low, Copy, n/a (frontend))
- **Steps:** Deactivate an account, then try to log in with it.
- **Actual:** "This account is currently restricted. Contact support if you need help." (403 `ACCOUNT_RESTRICTED`). No contact route exists anywhere in the app, and "restricted" does not say the user deactivated it themselves.
- **Evidence:** `.ux-audit/screenshots/g17-login-deactivated.png`.
- **Fix direction:** Add a contact route and distinguish deactivated from restricted.

#### UX-45 Top-up double-click (Low, UX, frontend handling)
- **Steps:** Click "Start top-up" twice quickly.
- **Actual:** Two POSTs to `/api/wallet/topups` with the same `Idempotency-Key`, so the server can deduplicate. No pending label appeared on the button. Outcome with a live service was not testable.
- **Evidence:** captured request headers; `.ux-audit/screenshots/f14-topup-last.png`.
- **Fix direction:** Disable the button while pending.

---

### Group H — Visual and layout defects

#### UX-06 Mobile header hides Log in and Sign out (High, UI visual, n/a (frontend))
- **Steps:** At 375×812 open `/` (logged out) and `/account` (signed in); inspect the header.
- **Expected:** A way to log in or sign out from the header, or a menu containing them.
- **Actual:** "Log in" and "Sign out" measure 0×0 (hidden). The header shows only Create account, Account, Wallet, Notifications, Admin. A signed-in mobile user can sign out only through the Account page; a logged-out visitor sees no "Log in" in the header.
- **Evidence:** `.ux-audit/screenshots/d11-m-account.png`; `.ux-audit/screenshots/e12-mobile-header-authed.png`; `.ux-audit/screenshots/d11-m-home.png`.
- **Fix direction:** Keep both controls visible at small widths or add a menu.

#### UX-13 Learning-profile fieldset layout (Medium, UI visual, n/a (frontend))
- **Steps:** `/account`, scroll to "Preferred lesson periods" (desktop and mobile).
- **Expected:** Checkboxes aligned with their labels, like the signup checkboxes.
- **Actual:** Checkboxes are centred, labels are right-aligned in small bold text, and a default grey fieldset border shows.
- **Evidence:** `.ux-audit/screenshots/b3-account-after-signup.png`; `.ux-audit/screenshots/d11-m-account.png`.
- **Fix direction:** Apply the `check-row` styling used elsewhere and reset the fieldset styling.

#### UX-27 Favicon missing (Low, UI visual, n/a (frontend))
`GET /favicon.ico` returns 404. **Fix direction:** add an icon.

#### UX-36 Account page layout inconsistencies (Low, UI visual, n/a (frontend))
"Sign out of this session" is a quiet button that looks like a stray link and is indented oddly; the Deactivate (danger) section sits above the learning profile rather than last; the header "Sign out" renders larger than the 14px nav links. Evidence: `.ux-audit/screenshots/b3-account-after-signup.png`. **Fix direction:** normalise button styles and section order.

#### UX-40 Discover form alignment (Low, UI visual, n/a (frontend))
"Clear filters" is vertically offset from the Search button, and the error banner starts directly under the button with no gap. Evidence: `.ux-audit/screenshots/a1-out-_discover.png`.

#### UX-42 Tutor sub-nav has no active state (Low, UI visual, n/a (frontend))
"Application and history / Profile and publication / Subjects / Availability / Find a tutor" are all underlined links with no current-page marker. Evidence: `.ux-audit/screenshots/c8-d-_teach_application.png`.

#### UX-43 Landing page copy and layout (Low, Copy, n/a (frontend))
"More learning features are coming soon" sits beside already-built features. The hero leaves about 300px of empty space before the footer on desktop, and on mobile "Get started →" wraps to two lines with the arrow detached. The hero card text ("Build a learning habit", "Weekly momentum") is decorative and implies progress tracking that does not exist. Evidence: `.ux-audit/screenshots/a1-out-_.png`; `.ux-audit/screenshots/d11-m-home.png`.

#### UX-51 Wallet link card (Low, UI visual, n/a (frontend))
Below "Add funds", "Transaction history" and "Disputes" appear as two bare links in a wide card with no heading, so they read as stray text rather than navigation. Evidence: `.ux-audit/screenshots/f14-topup-last.png`. **Fix direction:** give the card a heading or style the links as buttons.

---

### Group I — Accessibility barriers

#### UX-23 Tap targets too small (Medium, Accessibility, n/a (frontend))
- **Steps:** At 375px measure interactive elements.
- **Expected:** About 44×44px (WCAG 2.5.8 minimum 24px).
- **Actual:** Header links are 17px high with 9px gaps; checkboxes are 13×13px; inline links ("Forgot your password?", "Log in", "Browse Tutor Matcher") are 16px high; `/teach/*` tab links are 22px.
- **Evidence:** `.ux-audit/screenshots/d11-m-login.png`; `.ux-audit/screenshots/d11-m-teach.png`.
- **Fix direction:** Increase padding on links and checkboxes at small widths.

#### UX-24 Contrast below AA (Medium, Accessibility, n/a (frontend))
- **Steps:** Measure computed colours.
- **Actual:** Footer text `rgb(119,136,129)` on `rgb(251,250,246)` at 12px is 3.58:1. Secondary text, nav links and eyebrows `rgb(101,122,116)` are 4.38:1 on the page background (4.58:1 on white cards), below 4.5:1 for small text.
- **Evidence:** Computed styles via Playwright on `/login`.
- **Fix direction:** Darken the muted colour token.

#### UX-26 Identical page titles (Low, Accessibility, n/a (frontend))
Every route returns the title "Tutor Matcher"; only the Next 404 differs ("404: This page could not be found."). Evidence: `document.title` on `/`, `/login`, `/signup`, `/discover`, `/password-reset`. **Fix direction:** per-page titles.

#### UX-28 No skip link; long tab run (Low, Accessibility, n/a (frontend))
On `/login`, Tab visits the brand and 6 nav links before the email field; there is no skip link and `<main>` has no id. Focus outlines are present and visible (3px). Evidence: `.ux-audit/screenshots/e13-focus-email.png`. **Fix direction:** add a skip-to-content link.

---

### Group J — Copy that doesn't fit its page

#### UX-41 Wrong banner on Notifications (Low, Copy, n/a (frontend))
"Demonstration only. No real money moves and nothing here can be paid with a real banking app." appears on `/notifications`. Evidence: `.ux-audit/screenshots/c8-d-_notifications.png`. **Fix direction:** use a notification-specific simulation notice.

## 5. Flows that could not be tested

| Flow | Why |
| --- | --- |
| Tutor search results, tutor profile, subject detail, availability calendar | Tutor service not running (503 on every discovery route). Only the error and empty-filter states were seen. |
| Booking, slot hold, payment, cancellation, meeting link, completion | No booking pages exist (UX-01) and the Booking service is not running. |
| Wallet balance, top-up confirmation (success/fail/unresolved), transaction details, payouts, payout accounts | Wallet service not running. Payout pages need the TUTOR capability. Only client-side amount validation was exercised. |
| Writing, replying to, flagging and moderating reviews | Review and Booking services not running; no completed booking could exist. |
| Messaging inbox and threads | No pages (UX-02) and no Messaging service. |
| Notification preferences and delivery receipts | Notification service not running. |
| Tutor application, profile revision, publish, subject management | Tutor service not running, and no account could obtain TUTOR. |
| Disputes (student and admin) | Wallet service not running; no booking to reference. |
| All ADMIN pages (`/admin/users`, `/admin/tutor-requests`, `/admin/disputes`, `/admin/review-flags`, `/demo/finance`, `/demo/password-resets`) | No admin credentials were available and the admin signup key was not read or guessed. As a student these pages show "Admin access required". Their real content, tables, forms and moderation actions are unreviewed. |
| Delivered password-reset email and a full reset-confirm cycle | Notification service not running, so no reset token could be obtained. Only invalid-token handling was tested. |
| Deactivation restore, suspension, ban | Admin-only. |
| Thai/English mixing | The app is English only (`lang="en"`, no Thai strings in `apps/web`); nothing to compare. |
| Cross-browser, screen-reader and zoom/reflow testing | Only headless Chromium at two widths, with measured contrast, focus and tab order but no screen reader. |
