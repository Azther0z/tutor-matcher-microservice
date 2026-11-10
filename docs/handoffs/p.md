# P handoff: Wallet, Notification and financial recovery

Own Wallet and Notification, including their UI, tests, durable work and simulated providers.
Deliver top-ups, payments, refunds, earnings, payout accounts/payouts, disputes and notification preferences/receipts.
Booking owns lesson lifecycle. Wallet owns every financial decision and completed money movement.

## Baseline and owned paths

Start with the [shared handoff](README.md), [requirements](../requirements.md), [system design](../system-design.md) and [contracts](../../contracts/README.md).
Read the [recovery rules](../../contracts/recovery.md) and [event guide](../../contracts/events.md) before extending current code.
Use the [pinned monolith](https://github.com/Azther0z/tutor-matcher/tree/ce3ec82672d7dac5da8b846ecdb6725dcc7e5ca1) and UC-04, UC-07, UC-09 and SUP-02–SUP-03 evidence links.
UC05-05 and UC-06 govern your earnings/refund collaboration with Santa.
The [source index](../sources/README.md) links both original PDFs.
Use the shared reviewed baseline commit containing the requirements, design, contracts and handoffs.

Existing code starts in `services/wallet-service/src/` and `services/notification-service/src/`.
The existing direct top-up confirmation, one-refund shortcut and notification delivery log need the target rules below.

| Area | Your implementation ownership |
| --- | --- |
| Backend | `services/wallet-service/**`, `services/notification-service/**` |
| Frontend features | `apps/web/features/wallet/**`, `apps/web/features/notification/**` |
| Frontend routes | `apps/web/app/wallet/**`, `apps/web/app/disputes/**`, `apps/web/app/admin/disputes/**`, `apps/web/app/notifications/**`, `apps/web/app/demo/finance/**` |
| Browser tests | `apps/web/e2e/finance/**` |
| Broker definitions | Planned `services/notification-service/deploy/**`. Saint integrates them into shared manifests |
| Evidence | Planned `docs/evidence/p/**`, including financial recovery, receipts and risk-matrix draft |

Treat frontend routes above as paths under `apps/web/app/`. Use Saint's shell, API/session adapter and common UI components.
Santa owns payment/cancellation buttons in booking pages. You provide their financial endpoints and wallet/top-up destinations.

## First deliverable

1. Add Wallet financial-operation and booking-record migrations with transaction tests.
2. Expose charge, query, resolve-or-close, refund and refund-query RPCs to Santa.
3. Expose completion-recording and financial-record RPCs with immutable original timestamps.
4. Boot the versioned Notification queue, durable acceptance and one simulated delivery fixture.
5. Publish topology requirements and service runtime needs to Saint.
6. Build wallet, dispute and preference components while the shared shell is prepared.

Deliver the charge/close path and Notification acceptance early.
Do not wait for every payout/admin page before other producers can integrate.
Use separate PostgreSQL `wallet_db` and MongoDB `notification_db` storage.

## Money, providers and UI

Implement UC-04, UC-07, UC-09 and Wallet's parts of UC-03, UC-05 and UC-06.
Use exact satang or exact decimal arithmetic and the shared rounding rules.
Maintain one wallet per account. Keep posted funds, payout reservations and pending earnings distinct.
Only completed movements belong in read-only transaction history.

Top-ups are positive THB amounts up to 100,000 with at most two decimal places.
Show a clearly non-payable simulated representation and preserve the return booking destination.
Ordinary users cannot assert successful payment. Only the authorized synthetic provider control resolves the outcome.
A successful outcome credits once. A failed or unknown outcome cannot credit funds.

Payout accounts and payouts require current Tutor capability.
Support five active owned accounts, one default, normalized/masked numbers and duplicate rejection.
Preserve accepted payout destination snapshots and historical references after account removal.
Reserve available funds before submitting a payout. Pending earnings cannot fund it.
Success completes one movement, definitive failure releases the reservation, and UNKNOWN keeps it reserved.
Bind provider references and reject contradictory terminal outcomes.

Implement the shared owner-operation status contract and meaningful pending/error states in the UI.
Protect finance demo controls with current Admin capability, DEMO_MODE and synthetic-resource checks.
Keep them available under explicit demo configuration in the production-built course deployment.

## Charge, refund, clearing and dispute rules

Serialize charge and close on the same financial record.
`resolveOrCloseLessonCharge` must create a durable closed record even when the charge operation was absent.
That record prevents a late charge from applying. A GetLessonCharge RPC returning NOT_FOUND alone cannot provide this guarantee.
Verify immutable command input and preserve the same outcome across retries.
Permit at most one applied lesson payment across different attempts for the same booking.

Cancellation refunds use separate operation identities and the actual paid amount.
Verify the actor/policy amount and cumulative refund cap.
Support a 70% cancellation refund followed by a distinct approved refund of the remaining 30%.
Do not preserve the old assumption that one refund row completes every possible remedy.

Tutor confirmation records the first original confirmation time from Booking.
Calculate the 15% platform fee and keep the net earning pending.
Clear only after 24 hours and while no dispute hold exists.
Dispute opening, refund, rejection and clearing use the same Wallet financial-record lock.
A valid open dispute must block earning release even if completion delivery arrives later.

Use Booking's GetBookingEvidence RPC for the permitted dispute window and participants.
Apply the separate cancelled-booking residual-payment window from the requirements.
An authorized Admin can reject or refund the full remaining amount, with reason and audit.
Provide the private admin detail DTO with Booking evidence, financial state and relevant booking ledger entries.
An approved remedy removes the refunded pending earning and applies once.
Keep partial awards and post-settlement claims outside the delivery.

Use injected time in automated tests. For the live demo, label historical clearing fixtures and show new completions remaining pending.
Keep the real 24-hour policy unchanged.

## Notification behavior and UI

Implement all five Email/Push preference groups and inspectable simulated receipts.
SYSTEM security/administrative decision email is mandatory and has no sixth preference toggle.
Check current preferences at dispatch and before retrying an undelivered attempt.
Keep delivered/skipped results terminal.

Own the versioned RabbitMQ topology, Notification consumer, audience resolution, jobs and simulated effects.
Use `tutor-matcher.events`, `notification.events.v1`, `v1.#` and the specified dead-letter topology.
Validate schema, routing/type and authenticated publisher identity.
Persist accepted events and durable work before acknowledging them.
Resolve active admins through Auth and preserve the resolved recipients for job retries.

Make simulated effects unique per event, recipient and channel.
Retain failed jobs for safe retry. Quarantine invalid events and conflicting payloads using an existing event ID.
Fetch sensitive reset content only through Saint's allowlisted Auth GetResetNotificationContent RPC.
Keep reset tokens, private messages, document URLs and bank numbers out of event bodies and ordinary receipts.
Call Booking GetReminderEligibility through gRPC before dispatch. A dependency outage leaves that work pending.

Wallet owns its own outbox and publisher worker.
Auth, Tutor, Review, Booking and Messaging owners implement their producer transactions and retries.
Provide acceptance fixtures and topology instructions so each producer can prove its own recovery.

Serve the seven Wallet RPCs on private port 50054.
Wallet calls Booking/Auth/Tutor through gRPC. Notification calls Auth/Booking through gRPC and needs no gRPC server.
Apply the registry's deadlines, metadata, field-presence checks and typed error mapping.
A gRPC deadline or cancelled call leaves a possibly committed mutation pending for reconciliation.

## Interfaces and parallel work

| Peer | You provide | You consume |
| --- | --- | --- |
| Saint | Finance/Notification endpoints, topology definitions and service runtime needs | Identity adapters, account/admin lookup and sensitive reset-content fetch |
| Ideal | Durable acceptance and receipts for application/moderation events | Tutor eligibility and Tutor/Review versioned events |
| Santa | Charge/query/close, refund/query, completion recording and finance status | Booking evidence, original completion time, reminder eligibility and producer events |

Start Wallet tests with real local PostgreSQL and typed Booking/Auth/Tutor doubles.
Start Notification tests against real MongoDB transactions and RabbitMQ with schema-valid synthetic events.
Replace internal doubles with real owners at the first integration checkpoint.
Pair with Santa before both implementations assume different operation IDs or refund finalization rules.

## Acceptance and evidence

- Prove top-up success, failure, unknown state and repeated provider outcomes through the UI.
- Prove tutor-only payout accounts, masking, default behavior and cross-user rejection.
- Prove reservations prevent simultaneous spending and survive unknown payout outcomes.
- Prove lost charge response and late charge after close with Santa's actual Booking implementation.
- Prove partial cancellation plus full remaining dispute refund never exceeds payment.
- Prove dispute opening races clearing safely and completion delivery preserves the original deadline.
- Prove an Admin can inspect evidence, decide a case and observe the remedy/audit through the UI.
- Prove all five preferences, mandatory SYSTEM email and one effect per event/recipient/channel.
- Prove producer outage recovery, consumer crash/redelivery, failed-job retry and stale reminder suppression.
- Prove restored financial records and pending operations resume without duplicate movements.

Save commands, revision, environment, state observations and unresolved failures in your evidence directory.
Draft C-06's risk matrix with likelihood, impact, mitigation and remaining risk for at least three issues.
Include money inconsistency, access violations, deployment/dependency failure and unconfirmed instructor acceptance of simulated providers.
Collect the relevant owner observations rather than claiming tests that did not run.
Give Saint your slide/demo section, operational notes and risk draft.
Your handoff is complete when finance and delivery work through the UI with real peers and pass the paired recovery cases.

## Owned interface inventory

This index is derived from the combined REST/gRPC inventory. OpenAPI owns REST wire contracts.
Protobuf and its method registry own gRPC wire contracts, callers and value-validation references.
Implement every listed operation. Coordinate producer/consumer changes before updating this index.

| Owner | Protocol | Surface | Operation ID | Method and path |
| --- | --- | --- | --- | --- |
| wallet | GRPC | INTERNAL | `applyCancellationRefund` | `UNARY /tutor_matcher.wallet.v1.WalletFinanceService/ApplyCancellationRefund` |
| wallet | GRPC | INTERNAL | `applyLessonCharge` | `UNARY /tutor_matcher.wallet.v1.WalletFinanceService/ApplyLessonCharge` |
| wallet | REST | PUBLIC | `createPayout` | `POST /api/payouts` |
| wallet | REST | PUBLIC | `createPayoutAccount` | `POST /api/payout-accounts` |
| wallet | REST | PUBLIC | `createTopup` | `POST /api/wallet/topups` |
| wallet | REST | PUBLIC | `decideDispute` | `POST /api/admin/disputes/{disputeId}/decision` |
| wallet | REST | PUBLIC | `decideTopup` | `POST /api/admin/topups/{topupId}/decision` |
| wallet | REST | PUBLIC | `deletePayoutAccount` | `DELETE /api/payout-accounts/{accountId}` |
| wallet | REST | PUBLIC | `getAdminDispute` | `GET /api/admin/disputes/{disputeId}` |
| wallet | GRPC | INTERNAL | `getBookingFinancialRecord` | `UNARY /tutor_matcher.wallet.v1.WalletFinanceService/GetBookingFinancialRecord` |
| wallet | GRPC | INTERNAL | `getLessonCharge` | `UNARY /tutor_matcher.wallet.v1.WalletFinanceService/GetLessonCharge` |
| notification | REST | INTERNAL | `getNotificationOperation` | `GET /internal/v1/notification/operations/{operationId}` |
| notification | REST | PUBLIC | `getNotificationPreferences` | `GET /api/notifications/preferences` |
| wallet | REST | PUBLIC | `getOwnDispute` | `GET /api/disputes/{disputeId}` |
| wallet | REST | PUBLIC | `getPayout` | `GET /api/payouts/{payoutId}` |
| wallet | REST | PUBLIC | `getPayoutBanks` | `GET /api/payout-accounts/banks` |
| wallet | GRPC | INTERNAL | `getRefundOutcome` | `UNARY /tutor_matcher.wallet.v1.WalletFinanceService/GetRefundOutcome` |
| wallet | REST | PUBLIC | `getTopup` | `GET /api/wallet/topups/{topupId}` |
| wallet | REST | PUBLIC | `getTopupSlip` | `GET /api/admin/topups/{topupId}/slip` |
| wallet | REST | PUBLIC | `getWallet` | `GET /api/wallet` |
| wallet | REST | INTERNAL | `getWalletOperation` | `GET /internal/v1/wallet/operations/{operationId}` |
| wallet | REST | PUBLIC | `getWalletTransaction` | `GET /api/wallet/transactions/{transactionId}` |
| wallet | REST | PUBLIC | `listAdminDisputes` | `GET /api/admin/disputes` |
| wallet | REST | PUBLIC | `listAdminTopups` | `GET /api/admin/topups` |
| wallet | REST | PUBLIC | `listOwnDisputes` | `GET /api/disputes` |
| notification | REST | PUBLIC | `listOwnNotifications` | `GET /api/notifications` |
| wallet | REST | PUBLIC | `listPayoutAccounts` | `GET /api/payout-accounts` |
| wallet | REST | PUBLIC | `listPayouts` | `GET /api/payouts` |
| wallet | REST | PUBLIC | `listTopups` | `GET /api/wallet/topups` |
| wallet | REST | PUBLIC | `listWalletTransactions` | `GET /api/wallet/transactions` |
| wallet | REST | PUBLIC | `openDispute` | `POST /api/disputes` |
| notification | REST | PUBLIC | `putNotificationPreferences` | `PUT /api/notifications/preferences` |
| wallet | GRPC | INTERNAL | `recordLessonCompletion` | `UNARY /tutor_matcher.wallet.v1.WalletFinanceService/RecordLessonCompletion` |
| wallet | GRPC | INTERNAL | `resolveOrCloseLessonCharge` | `UNARY /tutor_matcher.wallet.v1.WalletFinanceService/ResolveOrCloseLessonCharge` |
| wallet | REST | PUBLIC | `setDefaultPayoutAccount` | `PATCH /api/payout-accounts/{accountId}/default` |
| wallet | REST | PUBLIC | `setDemoPayoutsOutcome` | `POST /api/demo/payouts/{payoutId}/outcome` |
| wallet | REST | PUBLIC | `setDemoTopupsOutcome` | `POST /api/demo/topups/{topupId}/outcome` |
