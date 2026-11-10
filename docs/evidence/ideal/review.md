# Review implementation evidence

Tested 10 November 2026 on the implementation worktree based on `8dff5c3`.
These results cover the uncommitted Review service changes on that base. The final assembled commit requires the root acceptance run.

## Checks actually run

| Check                                                                                          | Observed result                                    |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `npm run typecheck -w @tutor-matcher/review-service`                                           | Passed.                                            |
| `npm run build -w @tutor-matcher/review-service`                                               | Passed.                                            |
| `npx eslint services/review-service/src`                                                                | Zero errors. Nine warnings for dynamic gRPC types. |
| `REVIEW_TEST_MONGO_URI=<disposable replica-set URI> npm test -w @tutor-matcher/review-service` | 21 tests passed, zero failures and zero skips.     |

The transaction tests used a real local MongoDB replica set, a new isolated synthetic database and real MongoDB sessions.
The test removed its database afterward. HTTP and gRPC tests bound local ephemeral ports.
The broker transport tests used injected confirm-channel fixtures. They did not contact a RabbitMQ broker.
The peer wire tests used typed local Auth/Booking gRPC fixtures. They did not establish integration with Santa's actual Booking service.

## Demonstrated behavior

- Completed-booking eligibility and captured-student ownership. An unavailable Booking peer does not invent completion.
- Concurrent commands can create only one review per booking. Concurrent same-key retries return one result.
- Changed input or actor under an existing operation identity is rejected. Authorized replay works while peers are unavailable.
- Only the assigned tutor can reply, once, under the expected revision. A successful replay survives a stale revision.
- One report per reporter, duplicate rejection and a private moderation queue containing review and reporter details.
- Moderation revision races commit one decision. Keep/remove decisions preserve audit.
- Hidden review and reply disappear from public lists and the rating contribution disappears under the same local visibility update.
- Genuine empty rating summaries remain distinct from storage/dependency errors.
- Reporting rolls back if the required outbox write fails. Business records and required notification work commit together.
- Publication failure preserves the original event identity. Lease fences reject stale completion. Exhausted work remains inspectable.
- Moderation audiences over 100 are chunked without losing or duplicating the author or any reporter. Idempotent replay preserves the chunks.
- Real gRPC codecs preserve nullable average and explicit false eligibility, reject omitted required inputs and enforce workload credentials.
- Gateway paths after `/api` stripping accept the signed operation-specific assertion and reject spoofed identity, incorrect operations, repeated queries and unknown queries.
- Injected publisher confirms use persistent mandatory publication and authenticated `userId`. Both broker nacks and unroutable returns fail the attempt.

## Remaining evidence

A real RabbitMQ/Notification recovery and receipt run is still required. The injected channel tests establish publisher behavior, not broker permission configuration or consumer delivery.
Root integration must connect actual Auth, Tutor and Review and document the Booking fixture limitation until Santa's implementation is available.
The browser walkthrough, target load tests and hosted Swarm deployment belong to the assembled application checks.
No hosted rollout, real email delivery, real payment effect or final course submission was performed here.

## Live explanation

A review stores the tutor, subject and participants from Booking's completed-booking evidence. The browser cannot choose them.
Each public read checks visibility, so moderation changes the text, reply and rating contribution together without a stale cached summary.
Reporting and moderation put notification work in their own MongoDB transaction. RabbitMQ runs after commit, so an outage cannot erase the decision.
Retries preserve the event ID. A Notification receipt, rather than a publisher lease alone, is responsible for preventing duplicate delivery effects.
