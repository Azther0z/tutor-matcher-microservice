# Demo and slide section (P): finance and notifications

Status: the **UI is not built**, so this describes what can be shown today at API level and what the live demo needs once the web shell exists. Do not present the API walkthrough as the UI journey.

## What can be shown now (API level, 5 minutes)

Use Postman or curl through a Gateway, or the test harness, with `DEMO_MODE=true`.

1. **Top-up lifecycle.** Student creates THB 250.00 (response says `NOT PAYABLE`, balance unchanged). Admin sets UNKNOWN (still no credit, operation still pending). Admin sets SUCCEEDED (credited once). Repeat SUCCEEDED (no second credit). Try FAILED afterwards (409, cannot reverse).
2. **Payout reservation.** Tutor saves an account (response shows `******3210` only), requests a payout, shows available balance drop while posted balance stays. UNKNOWN keeps the reservation; FAILED releases it; SUCCEEDED posts one payout.
3. **70% then 30%.** Cancel inside 24 h (70% refunded), student opens a dispute inside the cancelled-booking window, admin reads the evidence and approves; only the remaining 30% moves and the total equals the payment.
4. **Race at the deadline.** Dispute versus clearing at exactly `tutorConfirmedAt + 24 h`: either a held dispute or a cleared earning, never both.
5. **Notification receipts.** Turn off Push for wallet/payments, trigger a top-up, and show one DELIVERED Email and one SKIPPED Push. Show a password-reset email delivered with every toggle off (mandatory SYSTEM). Cancel a booking before a reminder and show it suppressed.

## Needed for the live UI demo

Wallet overview and top-up page with the labelled simulated representation and return-to-booking; transaction history; payout accounts and payout; dispute filing and admin decision with evidence; preferences and receipts; the admin finance demo control page. Label historical clearing fixtures and show new completions staying pending.

## Operational notes for the slides

- Money is exact satang with ROUND_HALF_UP; fee 15%, clearing 24 h after the tutor's original confirmation, 70% refund inside 24 h.
- Recovery model: decision and event commit together (outbox); broker and peer outages leave durable work pending; nothing releases money on a timeout.
- Be explicit that RabbitMQ and hosted behaviour were not yet exercised (see README).
