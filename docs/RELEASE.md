# DayPact release verification

## 20 November 2026 — push registration and device diagnostics

- Device readiness checks the actual browser subscription. Consented registrations refresh on app open/resume without prompting; reconnect explicitly renews the current device registration. Strict recipient-context persistence and revision guards prevent late refresh work from undoing logout, privacy lock, or deletion. Coalesced resume checks retry after overlapping work, including a temporary network failure.
- Settings now include localized connection state, iPhone permission/install guidance, reconnect, and an explicit test push. Tests target only the caller's current device, are limited to three per five minutes, and return provider acceptance rather than claiming phone display. Reminder quiet hours remain unchanged; explicit tests bypass them.
- TypeScript and **170 tests across 11 files passed**, including subscription/permission/storage failures, device ownership, rate limiting, provider rejection, and refreshed-token cleanup races. The existing eight-flow local browser smoke check passed. No dependencies or migrations were added.
- Production investigation found one registered device for the reported account and one earlier notification accepted by FCM. This does not identify which device showed it or prove iPhone display. Physical iPhone receipt must still be confirmed using the new test button.

## 20 November 2026 — coordination expansion

- Added series-wide time availability polls, minimum attendance, own travel states, self-claimed supplies, recurring meetings with separate occurrence data, and equal integer-tenge expense records with own payment marks. These are recordkeeping features, not payment processing.
- Applied additive D1 migration `0003_coordination.sql`. Final Worker version: `088607f4-2c0e-485a-be8a-50cc5b77a463`. Previous migrations remain unchanged. Kazakh/Russian and light/dark appearance retain the existing design, with three sections inside a meeting.
- TypeScript, production build and **139 tests across 11 files passed**, including **61 real D1 API tests** and **6 notification queue tests**. All 43 packaged map resources pass integrity verification. No dependencies were added or changed.
- Local browser verification passed **14 meeting scenarios** and **8 existing UI scenarios**. Covered all six additions, future/recurring occurrence separation, delayed map readiness, lost-response retries, stale versions and paginated coordination export. The legacy map focus effect fails the delayed-readiness regression; the fixed effect passes.
- **98 live API checks passed** with four real Firebase identities: time options/availability/confirmation, recurrence, threshold counts, actor-bound travel, concurrent supply claim protection, exact expense splits, stale payment rejection, membership removal and occurrence isolation. Fixture notifications were disabled. All four identities and application data were removed with no pending cleanup.
- Final live browser verification on `088607f4-2c0e-485a-be8a-50cc5b77a463` passed **14 checks** with two real Firebase users, no identity/API mocks, and fixture notifications disabled. Covered all six features, the exact 18,001-tenge split, only the responding member's paid mark, recurring isolation, time-confirmation resets, Kazakh dark/Russian light appearance, and historical cleanup after re-anchoring. Old-date claim/payment requests remained rejected while authorized cleanup succeeded. No browser exceptions, CSP violations, unexpected API errors or horizontal mobile overflow were recorded. Both accounts and application data were erased with no pending cleanup.
- Historical item deletion and clearing an existing expense to zero remain possible after a series is re-anchored to another date. Current membership, creator/organizer ownership, exact stored date and record version still apply; creating, claiming or paying on an invalid occurrence remains prohibited. Dedicated regressions cover both cleanup access and rejected mutations.
- Threshold and travel alerts use generic text and durable anti-repeat receipts. Queue tests verify current membership/state, mute preferences, quiet hours, occurrence bounds and concurrent requests. These tests do not prove delivery on a physical phone.

## 20 November 2026 — shared meetings

Published to the same Cloudflare origin with additive D1 migration `0002_meetings.sql`. Worker version: `6c5cc619-3dcd-452d-87d7-a7d86581d920`.

- Named one-time meetings support several friends, a date/time, a separate map-place label and an upcoming list. Members propose places and cast one movable/withdrawable vote; the organizer confirms a place. Each person controls their own attendance response.
- Material changes to a meeting reset attendance. Version checks reject replies to obsolete details, including requests from older clients that omit the version. Proposal retries retain their operation ID and cannot recreate removed proposals.
- A stalled browser push unsubscribe no longer blocks sign-out indefinitely. Its five-second deadline retains account/subscription guards while allowing sign-out to finish.
- Live browser verification exposed a delayed-map-load race that could replace a member's newly selected point and typed label with the meeting's original place. External focus now initializes independently of map readiness, preserving later user edits.
- TypeScript, production build and **118 tests across 10 files passed**, including **46 D1 API tests**. Dependency audit reported zero vulnerabilities. All **43 map resources** still pass their recorded integrity checks.
- Local browser checks: **8 meeting scenarios** and **8 existing UI scenarios passed**. Covered multi-friend creation, preservation of title/time/members through map selection, future meetings, lost-response proposal retry, vote changes, organizer confirmation, stale RSVP refresh/retry, and Russian/light appearance on a narrow viewport. A delayed-readiness regression reproduces the original focus overwrite and passes with the fix, checking both the edited label and coordinates through the proposal request. No browser exceptions were recorded.
- Live API verification: **51 checks passed** against the deployed Worker with four separate real Firebase identities. Covered private access, named group meetings, map proposals, retry/payload conflicts, vote movement/withdrawal, actor-spoof denial, organizer-only confirmation, attendance resets after place/time changes, stale responses, friendship revocation and deletion cascades. All four temporary accounts and their application data were deleted; no cleanup remained pending.
- Live browser verification: **8 checks passed** with two isolated real Firebase users and no identity/API mocks. Covered normal sign-in, creating a future meeting with a map point and a friend, the friend's alternative-place proposal/vote, organizer confirmation, and attendance visible to both accounts. Server state matched the UI. No CSP violations, browser exceptions, API errors or horizontal overflow at 430×932 were recorded. Both accounts and their application data were erased; fixtures from the earlier map-race and selector-only runs were also fully cleaned.

The original release record and outstanding physical-device/operational checks follow below. Automated security checks are not a guarantee against every vulnerability.

## 19 November 2026 — initial release

Date: 19 November 2026. App: https://daypact.vertex-blip.workers.dev. Source: https://github.com/Vertex-blip/DayPact.

## Deployment

- Cloudflare Worker and Static Assets deployed with D1 binding and a one-minute reminder schedule. D1 migration `0001_initial.sql` is applied.
- Firebase Spark project `daypact-8dd4b` supplies real password authentication and FCM. Production hostname is authorized; 12–128-character password policy and email-enumeration protection are enabled.
- The public web key is restricted to the four required identity/token/messaging-registration services. The public VAPID key is included in the frontend configuration.
- FCM uses a dedicated service account whose custom role contains only `cloudmessaging.messages.create`. Its credentials are Worker secrets; the temporary local secret file was removed after upload verification.
- Language and dark/light/system appearance are selected in Settings. The map uses ready Protomaps/OpenStreetMap data and official light/dark palettes, with 2D by default and optional 3D.

## Automated checks

- TypeScript, production build and **95 tests across 10 files passed**.
- Map integrity: **43 resources passed**; package **12,865,003 bytes**, including the **9,775,568-byte** Astana PMTiles archive and **5,673** indexed places.
- Dependency audit: zero reported vulnerabilities at release preparation.
- Local browser regression: 21 checks passed, including account-isolated offline state, session expiry, modal handling and first offline map opening after a download from Settings. Local fixture tests do not substitute for live identity/API checks.
- Map layout regression: eight combinations of two phone sizes and offline/sync/no banners passed; the bottom action remains clickable above navigation, and other pages retain scrolling.

## Live API verification

**58 checks passed** against the production origin using three newly created disposable Firebase identities and real ID tokens. No production authentication bypass or mocked API was used.

Verified: health, anonymous/unverified access rejection, separate profiles, identity-spoof rejection, single-use friend invitations, shared plans with place data, outsider read/write denial, owner-only edits, member-specific completion and RSVP, idempotent retries and payload conflicts, concurrent creation without duplicates, friendship revocation, delayed retries without restoring access, deletion without recreation, account deletion cascades and rejection of deleted-account tokens.

All three accounts and their application data were removed by the application's deletion flow. Test harness setup failures were separately cleaned using exact test identities only.

Live static/API response headers include CSP, HSTS, frame restrictions and private API `no-store` caching. FCM accepted OAuth credentials and a validation-only send; that proves configuration, not notification delivery to a phone.

## Live browser verification

An isolated Chrome browser used the real production UI, Firebase authentication and API without intercepting responses. It passed normal sign-in, creating/completing a personal plan, downloading the map from Settings before its first opening, opening that map offline, creating a plan at a clicked map coordinate, confirming server persistence, and switching to Russian/light appearance from Settings. No browser exceptions or CSP violations were recorded. The temporary account and its D1 data were deleted successfully.

Client push registration did not complete within the 20-second headless-browser check. A separate native `PushManager.subscribe` probe, with permission granted and the service worker active, failed with `AbortError` before Firebase integration. The browser transport therefore could not be used to prove delivery. Actual delivery still needs a supported regular browser/device; a successful FCM validation-only send does not replace that check. The application now bounds post-permission setup to 30 seconds and offers a localized retry instead of remaining busy indefinitely.

A deterministic concurrency regression also exposed and fixed delayed sending when a new plan/check-in was enqueued during an active synchronization pass. Explicit writes now perform at most one follow-up pass, preserving account/session guards; background calls still share a single active pass.

One deployed scheduled invocation completed successfully with messaging configured: **3 ms CPU, 352 ms elapsed, zero deliveries**. This was an idle sample and does not establish loaded performance.

## Remaining device and operational checks

- Real email verification and password-reset mailbox delivery have not been tested; no messages were sent by the release harness.
- Actual Android and installed iPhone PWA notification delivery, lock-screen rendering and background behavior need physical-device checks.
- Sustained load, Cloudflare CPU budgets, reminder backlogs and backup restoration have not been exercised. Free tiers have quotas and can interrupt service when exceeded.
- Offline changes synchronize while the application is open with connectivity. Push requires internet and permission. Browser storage may be evicted and is not end-to-end encrypted.

These checks do not constitute an independent penetration test or a guarantee of fault-free operation.
