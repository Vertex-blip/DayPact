# DayPact release verification

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
