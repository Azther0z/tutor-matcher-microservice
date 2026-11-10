# Sequence diagrams per use case

Mermaid source (`.mmd`) is the editable version; the PNG is a rendered copy for slides.
Each diagram was checked against the service code and `contracts/public.openapi.json` on origin/main (222f377, 2026-11-11). Where the code differs from the use case document, the diagram follows the code.

| Use case | Source | Image | Code differs from the use case document |
| --- | --- | --- | --- |
| UC-01 Apply to become a tutor | [mmd](uc01-apply-tutor.mmd) | [PNG](uc01-apply-tutor.png) | Needs bio, ID document URL and intro video URL plus consent; no certification field. Approval returns 202 and Tutor grants the capability in Auth by gRPC afterwards |
| UC-02 Publish subjects and availability | [mmd](uc02-publish-subjects-availability.mmd) | [PNG](uc02-publish-subjects-availability.png) | Only profile revisions go through admin review; subjects are edited directly. Slots are owned by Booking |
| UC-03 Discover and pay for a booking | [mmd](uc03-book-and-pay.mmd) | [PNG](uc03-book-and-pay.png) | Event is published after the 200 response, by an outbox worker |
| UC-04 Top up the wallet | [mmd](uc04-topup.mmd) | [PNG](uc04-topup.png) | Manual PromptPay: student uploads a slip, an admin approves or rejects. No payment provider callback |
| UC-05 Deliver and complete a lesson | [mmd](uc05-complete-lesson.mmd) | [PNG](uc05-complete-lesson.png) | No attendance evidence from the meeting provider; the tutor confirms completion after the lesson ends |
| UC-06 Cancel a booking | [mmd](uc06-cancel-refund.mmd) | [PNG](uc06-cancel-refund.png) | A server-issued quote (5 minute expiry) is required before cancelling |
| UC-07 Request a payout | [mmd](uc07-payout.mmd) | [PNG](uc07-payout.png) | Tutor only. No provider call: an admin demo control sets the outcome |
| UC-08 Review a completed booking | [mmd](uc08-review.mmd) | [PNG](uc08-review.png) | Review is public immediately; the tutor can reply exactly once |
| UC-09 Resolve a payment dispute | [mmd](uc09-dispute.mmd) | [PNG](uc09-dispute.png) | Admin can only approve the full remainder or reject; no partial refund |

Render a PNG (needs Google Chrome on macOS): `python3 render.py uc03-book-and-pay.mmd`. Or paste the `.mmd` into https://mermaid.live.
