# Deployment and operations

This document describes the deployment configuration and repeatable setup process. The existing DayPact accounts have been authorized and configured; see the current resource identifiers below and the release verification record for the latest live checks.

## Accounts and scope

Use the existing Cloudflare account `fd0552315586fdcf384c51efec740e8e` and **only** Firebase project `daypact-8dd4b`. Keep Cloudflare Free and Firebase Spark. The project does not require Blaze, a payment card, Firestore, Firebase Functions or paid map services. Do not change unrelated projects.

Cloudflare hosts both the app and its D1 database. Firebase supplies identity and push delivery. Sign in through each provider's official authorization flow; never paste passwords, OAuth codes, private keys or service-account JSON into chat or GitHub.

## 1. Firebase identity

1. In the [DayPact console](https://console.firebase.google.com/project/daypact-8dd4b/settings/general), register a **Web app** named DayPact. Analytics is not needed.
2. Enable Authentication → Email/Password. Require a password policy with minimum 12 characters and keep email-enumeration protection enabled. The client also validates the project's policy. Use a recovery-capable email for the project owner.
3. Keep email verification and password reset templates branded DayPact. Verify the sender and action links using a test account. The API refuses unverified users.
4. Add the final `daypact.<subdomain>.workers.dev` hostname to Auth's authorized domains. Add local hostnames only for development; remove unused domains before launch.
5. Copy the web app's public configuration into `.env.local`, following `.env.example`. Set the same project ID and API key in `wrangler.jsonc` vars. These web configuration identifiers are not admin credentials.

The public API key must permit the Firebase Authentication/Token and Messaging Registration APIs required by the SDK. The server also calls Auth's account lookup using this key; a browser-referrer restriction that excludes server calls will break it. API keys identify the project; server authorization relies on verified Firebase identity and database permissions. Test any restriction change against both sign-in and authenticated API calls.

Official guidance: [password authentication and policy](https://firebase.google.com/docs/auth/web/password-auth), [Firebase API keys](https://firebase.google.com/docs/projects/api-keys), [security checklist](https://firebase.google.com/support/guides/security-checklist).

## 2. Firebase push

1. Enable Firebase Cloud Messaging HTTP v1 in the same project.
2. In Project settings → Cloud Messaging → Web Push certificates, generate the web key pair. Put the **public** key in `VITE_FIREBASE_VAPID_KEY`.
3. Create a dedicated `daypact-push` service account. Grant a custom role containing only `cloudmessaging.messages.create` where possible; otherwise use `roles/firebasecloudmessaging.admin`. Do not use Owner, Editor or a broadly privileged Firebase Admin SDK account.
4. Store its client email and private key as Worker secrets `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`. Do not prefix these with `VITE_`. Load them through the secret UI/CLI secure input; never commit or print the private key. Rotate the key if exposed and revoke superseded keys.

The Worker exchanges the private key for short-lived OAuth tokens and sends generic lock-screen notifications. No plan titles, prayer activity, savings amounts or location are included. Users explicitly enable notifications; the service worker checks the recipient against the current account.

For an iPhone delivery check, open the installed Home Screen app on iOS 16.4 or newer, then Profile → Settings → Notifications. Enable or reconnect this device and send a test push. The test targets this device only, including during quiet hours. Check iOS Settings → Notifications → DayPact, lock-screen/banner permissions, and Focus settings if the provider accepts the test but no banner appears. Production acceptance and physical-device display must be recorded separately. See [Apple's Home Screen Web Push guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

The client checks the real browser subscription instead of trusting its local registration marker. With existing permission and a matching account marker, it refreshes the provider token and server registration on opening/resuming the app (successful refreshes are limited to once per 15 minutes within that session). It never prompts for notification permission in the background. Recipient-context storage must succeed before registration reports success; logout, privacy lock and deletion invalidate outstanding registration work.

Official references: [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [FCM IAM roles](https://firebase.google.com/docs/projects/iam/roles-predefined-product#fcm).

## 3. Cloudflare database and app

Use the locked Wrangler CLI and its normal OAuth flow. Supported encrypted OS credential storage requires the Wrangler keyring dependency installed as described by its CLI. Typical limited scopes for this project are account/user read, Worker scripts write, D1 write and Worker tail read; no zone or billing administration is needed.

```sh
npx wrangler login --scopes account:read user:read workers_scripts:write workers_tail:read d1:write --use-keyring
npx wrangler whoami
npx wrangler d1 create daypact
```

Replace the all-zero `database_id` in `wrangler.jsonc` with the returned D1 ID. Confirm the database belongs to the intended account, then apply migrations:

```sh
npm run db:migrate:remote
```

Register the free Workers subdomain if this account does not yet have one. Set `APP_ORIGIN` to the exact HTTPS origin without a trailing slash, for example `https://daypact.<your-subdomain>.workers.dev`. Never use `*` as an allowed origin.

Use Wrangler's `secret put` secure input (or Cloudflare dashboard → Worker → Settings → Variables and Secrets) to add the two FCM secrets. On an initial empty account Wrangler may ask to create the named Worker to store secrets. Confirm it is `daypact`. List secret **names**, not values, to verify both exist.

```sh
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
npx wrangler secret list
npm run deploy
```

`deploy` runs preflight, type checks, tests, a production build and map integrity checks before publishing. `npm run build` alone intentionally works without cloud configuration for CI; that output displays an honest setup screen and must not be advertised as a live app.

## 4. Release verification

Do these against the real production origin using separate test accounts, then delete test data:

- `/api/health` responds; unauthenticated private requests are rejected; security headers/CSP allow the real UI and map worker.
- Register two accounts, receive/complete email verification, sign in, recover a password, and confirm revoked sessions lose API access.
- Invite/accept a friend, create a shared recurring plan with a location, update each person's own completion and verify the other account sees the change. A third uninvited account must not read or mutate it.
- Create a named future meeting with several friends, propose and vote for places, confirm as the organizer and submit individual attendance. Verify that changed details require new responses, stale versions fail and removed members lose access to proposals/votes.
- Exercise recurring occurrences separately: time availability, threshold confirmation, own travel status, competing supply claims, exact expense splitting and payment-version resets. Keep fixture notifications disabled unless explicitly testing delivery on a device.
- Download Astana, install/open offline, search a place, save an offline change, reconnect and verify a single synchronized result. Log out/switch accounts; private snapshots and notifications must not leak.
- Enable push on actual Android and installed iPhone PWA devices. Test one scheduled reminder and one friend nudge, quiet hours, disabling notifications, expired tokens and logout. Check real Cloudflare CPU/subrequest metrics; local tests cannot establish the free-plan CPU budget.
- Export data across multiple pages and delete an account after recent sign-in. Confirm D1 data is removed and Firebase deletion is complete or visibly pending for retry.
- Test a database backup/restore into a separate non-production database. Keep actual production data and backups private.

Record the deployed URL, commit, date, device/browser versions, test result and any remaining limitation before calling the release ready.

## Quotas and reliability

Cloudflare Free currently allows 100,000 Worker requests/day, 10 ms CPU per invocation, 50 subrequests, 5 cron triggers and 25 MiB per static file. D1 Free has a 500 MB per-database limit and daily read/write limits. Inspect actual quotas in the account before launch: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Firebase plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans).

The minute cron takes at most two due plans, one due study document and three notification recipients per invocation, with at most three registered devices per user. Study version checks before each device send preserve the bounded Free-tier request budget. This bounds costs but can delay reminders during a backlog. General messages expire after 24 hours; study reminders are dropped when class starts. Retries are bounded; notifications are best effort, not an alarm service. Actual CPU and provider latency must be measured live.

Apply migration `0005_study.sql` before deploying the Study feature. It adds per-user documents, once-per-occurrence reminder receipts and nullable notification routing columns. Provision a private timetable only into its verified owner UID, with a non-overwriting insert; never commit that person's timetable into this public repository. The public test fixture uses synthetic subjects, teachers and rooms. Default push content remains generic; an explicit Study preference may include lesson time and room.

API requests check account revocation against Firebase on each call; Firebase outages therefore deny new API access while existing offline data remains device-local. Rate limits use D1 writes, which count toward its free quota. Monitor daily usage, errors, backlog and D1 size without logging bearer tokens, push tokens or plan contents. Exceeding a free quota may interrupt service; there is no promise of unlimited capacity.

Use D1 Time Travel/exports for recovery, retaining backups securely and testing restoration. Restore to a separate database first; restoring old data can revive deleted records, so account deletion tombstones and retention policies must be reconciled before a production cutover.

## Configured resources

- App origin: `https://daypact.vertex-blip.workers.dev`.
- Cloudflare D1: `daypact`, ID `222fd9fe-f67c-41ae-82c6-52d84f92c45e`, migrations `0001_initial.sql`, `0002_meetings.sql`, `0003_coordination.sql` and `0004_admin.sql` applied in EEUR.
- Firebase project: `daypact-8dd4b`, project number `621011622605`, Spark.
- Web app: `1:621011622605:web:4f309d5e7cddc1ed53a784`.
- Password policy: enforce 12–128 characters; email enumeration protection enabled; production hostname authorized.
- Web API key permits only Identity Toolkit, Secure Token, Firebase Installations and FCM Registration APIs. The public web configuration and public VAPID key are in `.env.example`; copy it to `.env.local` for builds. These identifiers are not administrator secrets.
- Dedicated push sender: `daypact-push@daypact-8dd4b.iam.gserviceaccount.com`, with a custom project role containing only `cloudmessaging.messages.create`. OAuth and an FCM validation-only request were accepted. This is not proof of delivery to a physical device.

Cloudflare OAuth credentials use the OS keyring. Firebase authorization uses the official Firebase connector/CLI session. Secrets and temporary operational helpers are excluded from Git. An operator must use their own authorized session for later deployment, not copy another person's browser cookies or authentication tokens.

## Owner administration

Apply `0004_admin.sql` before publishing the administration routes. It adds moderation, support tickets, the administrative audit log, encrypted TOTP enrollment, sessions and rolling code-attempt limits. It does not alter or erase existing users or plans.

Administration uses four **Worker secrets**, never frontend environment variables:

- `ADMIN_OWNER_UID`: the existing, verified owner's immutable Firebase UID. Changing a display name or email does not grant this role.
- `ADMIN_TOTP_KEY`: a cryptographically random 32-byte AES key encoded as unpadded base64url. Keep a protected operational backup; replacing it makes existing enrollment unreadable.
- `ADMIN_FIREBASE_CLIENT_EMAIL` and `ADMIN_FIREBASE_PRIVATE_KEY`: a dedicated service-account key used only by account management.

The configured account is `daypact-accounts@daypact-8dd4b.iam.gserviceaccount.com`. Its custom role, `projects/daypact-8dd4b/roles/daypactAccountManager`, contains only `firebaseauth.users.get`, `firebaseauth.users.update` and `firebaseauth.users.delete`. It cannot retrieve password hashes, create accounts, send email or change Firebase configuration. The existing push service account remains separate. Private keys must be supplied using protected stdin or a trusted secret manager, never committed or placed in browser code.

The owner opens **Profile → Admin panel** (also available in Settings), confirms the current account password, saves the displayed setup key in an authenticator, and enters its six-digit code. Setup is not complete until the code is accepted. Subsequent unlocks require the password and a fresh code; the administrative session lasts 15 minutes. Production enrollment belongs to the owner and must not be created by an automated test. Losing the authenticator does not unlock administration through ordinary password reset.

Recovery requires the authorized infrastructure operator to independently verify the owner, revoke administrative sessions and reset only that UID's TOTP enrollment through a controlled database operation. Record the recovery in the operational audit. There is no public MFA-reset endpoint or email-only bypass. Do not reset enrollment merely because a code has expired; check the device clock and retry with a fresh code first.

Before release, exercise suspension, restoration and permanent deletion on disposable identities. Verify that old tokens fail, private application data cascades on deletion, and registering the same email creates a different UID. Provider failures leave a visible pending action and keep access blocked until the owner retries. Protect the production owner's account from these tests.

The panel displays actual application counts, current D1 size, push queue states and configuration presence. It does not claim to measure Cloudflare/Firebase daily quotas or prove delivery to a phone. Consult provider dashboards for billing/usage and request-specific diagnostics. No paid tier is required by these administration features; normal free-tier limits still apply.
