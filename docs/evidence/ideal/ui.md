# Tutor and Review UI

Date: 10 November 2026. Tested against the working tree based on Saint's `8dff5c3` identity and web shell, with the Ideal marketplace changes.

## Implemented routes

| Route | Journey |
| --- | --- |
| `/teach/application` | Create, edit, delete and submit incomplete application drafts; consent; withdraw pending work; immutable submission history; rejection reason and copy into a new draft |
| `/teach/profile` | Current approved content, profile revisions, activation-pending status, account-access refresh, publish and unpublish |
| `/teach/subjects` | Owned Online subjects, positive two-decimal THB rate, one to three learning areas, pagination and revision-protected edits |
| `/discover` | Keyword, tutor name, learning area, price, rating and Online filters; sorting, pagination, saved learning preferences, explicit dependency errors and genuine unrated state |
| `/tutors/[tutorId]` | Approved public profile, subjects and visible lesson reviews |
| `/tutors/[tutorId]/subjects/[subjectId]` | Subject details, rating distribution, Bangkok day availability, consecutive slot selection and booking destination |
| `/reviews` | Tutor or subject review lists |
| `/reviews/new?bookingId=...` and `/reviews/bookings/[bookingId]` | Completed-booking review form for its student |
| `/admin/tutor-requests` and `/admin/tutor-requests/[submissionId]` | Private application queue, document inspection, approval/rejection and accepted-operation polling |
| `/admin/review-flags` | Private reporter and complete review/reply, KEEP/HIDE/REMOVE with reason and review revision |

Public review lists expose a one-time tutor reply and report controls for signed-in users. The API remains responsible for current capabilities, ownership, duplicate prevention and immutable booking eligibility.

All requests use the shared session/API adapter. Revision writes send quoted `If-Match` values. Mutations retain the original payload and idempotency key after a network or server failure; Retry original action resends that command, even if a visible field was edited afterwards. Accepted processing work uses its returned status URL. Stale edits keep the unsaved form visible.

Saved Student learning areas are passed as the `preferredLearningAreas` search hint. When that profile lookup fails, the page says recommendations are using ratings and availability instead. This hint never grants access. Classes-taught counts are not displayed while Booking has no agreed count interface.

## Peer UI integration

The exact proposed booking link is `/bookings/new?tutorId=<uuid>&subjectId=<uuid>&slotIds=<comma-separated-uuids>`. Slot IDs are ordered by their start times. The selection is limited to 1-8 consecutive future half-hour slots. Signed-out users keep this complete destination through the login `returnTo` parameter. Slot selection does not create a hold.

The availability editor link is `/teach/availability`. Santa owns these destination routes. No Santa implementation was available in the checkout when these components were added, so reaching a working booking/availability screen through these links remains an integration check. The review form also consumes Santa's participant-only `GET /api/bookings/{bookingId}` and its `canReview` field.

## Verification

Commands run from the repository root unless stated otherwise:

```sh
npm run typecheck -w @tutor-matcher/web
npm run build -w @tutor-matcher/web
npx eslint apps/web/features/tutor apps/web/features/review apps/web/e2e/marketplace
cd web
CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npx playwright test e2e/marketplace/marketplace.spec.ts --workers=2
```

Type checking, the production build and ESLint passed. The browser suite first passed all 15 cases. A final added subject-creation case and the revised stale-edit case both passed in a targeted run, covering 16 distinct cases in total. Browser tests use synthetic intercepted API responses. They verify UI behavior and request contracts, not live cross-service transactions or a hosted deployment.

The cases cover application consent/withdrawal/copying, immutable original retries, approval activation-pending/polling, denied unapproved subject access, discovery filters/preferences/unrated state, visible collaborator failures, consecutive slot selection, review ownership and submission, tutor reply and reporting, private moderation payloads, stale-edit form retention, subject creation, private document non-rendering, and mobile/desktop layouts.

The installed Chrome executable was used because the default Playwright-managed browser was absent. The local server required execution outside the sandbox's listen restriction.

Visual checks: [mobile discovery](visual/discovery-mobile.png) and [desktop application](visual/application-desktop.png). Both use synthetic data. Both were opened and inspected. Controls and text fit their viewport, with no horizontal overflow. No private identification URL is rendered by the public profile component.

## Live walkthrough

1. Sign in as a Student, open Tutor application, create and save a draft with synthetic HTTPS document/video links. Check consent and submit.
2. In the Admin account, inspect the submitted private document and approve. If activation is pending, check its operation and refresh the applicant's Tutor status/access.
3. As the activated Tutor, create an Online subject, publish the listing and open Availability to add slots through Santa's editor.
4. Discover the subject, inspect the public tutor page, select consecutive Bangkok slots and continue to Santa's booking screen.
5. After a completed lesson, open its review destination as the student, publish a review, reply once as the assigned tutor and report it from an eligible account.
6. As Admin, inspect the full reported review and reporter, record HIDE or REMOVE with a reason, and confirm its review/reply/rating disappears publicly through the real services.

These walkthrough steps still need the integrated peer services and synthetic seed accounts. Do not present the browser fixtures as evidence that those live journeys have already passed.

## Combined service browser smoke

`apps/web/e2e/marketplace/live-smoke.mjs` exports `runLiveSmoke({gatewayUrl,password,tutorId,subjectId,bookingId})` for the isolated `loadtest/marketplace-integration.mjs` runner. It starts Next on an ephemeral loopback port, uses real gateway HTTP responses without browser interception, and creates separate candidate, admin and public browser contexts. It covers real login, published profile, subject creation/editing, revision submission and rejection, preservation of approved public content, future Bangkok slot selection and hidden-review moderation details. Browser and web-server processes are cleaned up on failure too. Credentials never appear in its printed diagnostics.

The module passed static syntax, lint and type checking when added. Runtime results belong to the combined runner's evidence. Its Booking and Swarm discovery fixtures remain explicit limitations even when its browser checks pass.
