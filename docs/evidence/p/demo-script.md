# Demo and slide section (P): finance and notifications

Status: the finance and notification UI is built and passes browser tests against mocked responses (`apps/web/e2e/finance`). It has **not** been shown against the running backend, so rehearse the live path before presenting. The API walkthrough below is the fallback.

## What can be shown now (API level, 5 minutes)

Use Postman or curl through a Gateway, or the test harness, with `DEMO_MODE=true`.

1. **Top-up lifecycle.** Student creates THB 250.00 (response says `NOT PAYABLE`, balance unchanged). Admin sets UNKNOWN (still no credit, operation still pending). Admin sets SUCCEEDED (credited once). Repeat SUCCEEDED (no second credit). Try FAILED afterwards (409, cannot reverse).
2. **Payout reservation.** Tutor saves an account (response shows `******3210` only), requests a payout, shows available balance drop while posted balance stays. UNKNOWN keeps the reservation; FAILED releases it; SUCCEEDED posts one payout.
3. **70% then 30%.** Cancel inside 24 h (70% refunded), student opens a dispute inside the cancelled-booking window, admin reads the evidence and approves; only the remaining 30% moves and the total equals the payment.
4. **Race at the deadline.** Dispute versus clearing at exactly `tutorConfirmedAt + 24 h`: either a held dispute or a cleared earning, never both.
5. **Notification receipts.** Turn off Push for wallet/payments, trigger a top-up, and show one DELIVERED Email and one SKIPPED Push. Show a password-reset email delivered with every toggle off (mandatory SYSTEM). Cancel a booking before a reminder and show it suppressed.

## Live UI path (rehearse before presenting)

Sign in as a student: **Wallet** (`/wallet`) shows available, posted and reserved balances. Start a top-up (the page labels the code *Not payable*; keep `?returnToBookingId=` to come back to a booking). As an admin open **Demo provider controls** (`/demo/finance`), paste the top-up ID and provider reference, and record SUCCEEDED, then watch the top-up page update. Tutor: **Payout accounts** then **Payouts**; show an UNKNOWN payout staying reserved. Student: **Disputes** to file; admin: **Admin disputes** to read the evidence, give a reason and decide. **Notifications** shows the five preference groups and simulated receipts. Label historical clearing fixtures and show new completions staying pending.

## Operational notes for the slides

- Money is exact satang with ROUND_HALF_UP; fee 15%, clearing 24 h after the tutor's original confirmation, 70% refund inside 24 h.
- Recovery model: decision and event commit together (outbox); broker and peer outages leave durable work pending; nothing releases money on a timeout.
- Be explicit that RabbitMQ and hosted behaviour were not yet exercised (see README).
