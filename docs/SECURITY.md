# DayPact security and privacy

This document records implemented controls and remaining production checks. It is not a penetration-test certificate or a guarantee that software cannot be compromised. DayPact may contain private routines, locations, religious activities and savings goals; access must remain scoped to the owner and included plan members.

## Authentication and trust boundaries

- Firebase tokens are verified against Google's signing keys, RS256, the configured audience/issuer, required claims, expiry and bounded integer issue/authentication timestamps.
- Every authenticated request also performs a live Firebase account lookup. Disabled, deleted, unverified and revoked accounts are rejected. Revocation is compared against `auth_time`; malformed metadata and provider outages fail closed. Account email comes from the verified lookup.
- Firebase handles passwords; D1 does not store them. There is no request-controlled UID override, development-login endpoint or environment authentication bypass. Test authentication is explicit in-process dependency injection.
- Account deletion requires reauthentication within five minutes. A tombstone prevents a partially deleted identity from recreating application data while Firebase deletion is retried.

The Firebase web API key/public configuration are client configuration, not administrator credentials. Restrict API usage and authorized domains in the provider console. The FCM service-account private key is a server secret and must never enter frontend builds, browser storage, repository files or logs.

## Data authorization and integrity

- SQL values use bound parameters. Strict schemas reject unknown write fields and validate types, calendar dates, time zones, coordinates and size/range bounds.
- The verified identity determines the actor. Plan reads require membership; editing/deletion requires ownership. Check-ins, RSVP, profile, settings, devices and notification-read changes apply to the caller only.
- Shared members must be current friends of the owner. Database triggers enforce this and resource limits in addition to application checks. Foreign keys cascade removed memberships into dependent records.
- Removing a friendship revokes reciprocal membership in plans owned by those two users. A third owner's shared plan is a separate relationship.
- Plan updates combine a version check and transaction-scoped mutation marker. Losing concurrent updates cannot alter members. Check-in IDs bind to payload fingerprints and cannot replay over newer progress.
- Offline plan creation uses actor-scoped UUID receipts and an atomic receipt/plan/member transaction. Different payloads cannot reuse a key. Receipts survive plan deletion, preventing delayed retries from recreating removed plans or re-adding revoked members.
- Invitation tokens have 256 bits of cryptographic randomness, are stored hashed, expire after seven days and are consumed atomically. Friends see limited public profiles; exports exclude other users' private profiles, emails and push tokens.

Revocation controls subsequent authorized access; it cannot erase information a member already saw, copied or cached. Progress and savings are self-reported, not financial transactions or proof of physical attendance.

## HTTP and browser controls

- The worker applies CSP, frame restrictions, MIME sniffing protection, referrer policy and HTTPS transport policy. CSP excludes inline scripts and `eval`; external connections are restricted to services required by the app.
- APIs use bearer authorization, not ambient login cookies. Origin checks reject unapproved browser origins; wildcard cross-origin access is not configured.
- Bodies are capped at 16 KiB while reading and in the API. D1-backed rate limits allow 180 requests/minute per hashed edge IP and 90 per verified UID. The edge address is used rather than client-supplied `X-Forwarded-For`.
- Errors exclude SQL, tokens and stack traces. Logging records request identifiers/categories rather than request bodies or private plans.
- API responses are `no-store`. The service worker caches public shell assets rather than authenticated responses. React renders user text as text, not interpreted HTML.

Rate limits do not guarantee availability during a large attack or remove provider quotas. Shared IPs can hit a limit. Deployed CSP, origin handling and browser behavior are included in the [release verification record](RELEASE.md); repeat those checks after changes to hosting or browser integration.

## Offline data and account switching

Private IndexedDB snapshots and queued changes are scoped by account UID. Logout/deletion clear private local records; public map files are separate. Queued mutations retain their original operation keys and terminal failures remain visible for user review.

UID-scoped storage alone is insufficient: asynchronous API requests, push registration and local writes must verify that their initiating account/session is still active before updating UI or persisting results. Switching accounts must clear private dialogs and invalidate old work. These boundaries require regression tests and real shared-device verification. Offline clients cannot learn of access revocation until they reconnect.

Browser storage is **not end-to-end encrypted**. An unlocked browser profile, developer tools or invasive extension may expose cached data. Device locking and separate browser profiles remain relevant. Offline installations cannot receive remote erasure instructions while disconnected.

## Push privacy and reliability

FCM credentials are worker-only secrets. Use a dedicated service account with minimum messaging permissions and store its key through Cloudflare secrets. Rotate exposed credentials.

Push text is generic and excludes plan content, locations, religion, amounts and profile information. Routing metadata includes recipient UID, notification ID and plan ID. The service worker checks the active account before showing/opening notifications; these identifiers do not authorize plan access.

A two-minute delivery lease prevents overlapping workers from normally sending the same row. Claims read current preferences; disabled notifications/nudges, quiet hours, missing devices and records older than 24 hours are skipped. Transient failures retry with bounded backoff; unregistered tokens are removed. All-invalid tokens do not count as successful delivery. D1 atomically limits each user to three devices.

Delivery is best effort and at least once, not exactly once or guaranteed at an exact minute. Crashes and partial multi-device success can repeat sends; stable browser tags reduce visible duplicates. A preference change after a claim cannot retract an already in-flight send. Push requires connectivity and permission; offline plans do not provide offline push delivery.

## Work bounds and operational limits

Each invocation queues at most five indexed due plans and delivers at most three notifications to three devices each. The examined worst-case branch uses approximately 46 external/D1 subrequests, including OAuth, invalid-device cleanup and hourly rate-limit cleanup. This is a code-path estimate, not a deployed measurement; changes to these bounds require another quota review.

Live Cloudflare CPU profiling has **not** been completed. A subrequest count does not prove the free plan's CPU or daily quotas are sufficient. Membership counts, cryptographic work, provider latency and backlogs need measurement. Bounded batches can delay burst traffic. Storage growth, retention and backups need monitoring; bounded rate-limit cleanup is not a general retention policy.

Exports paginate check-ins instead of silently cutting off history. Clients follow `nextCursor` to completion or show a memory-limit failure. Pages are live reads, not a frozen snapshot.

## Deletion and recovery

Deletion checks recent authentication before erasing data, writes a tombstone, cascades private records/owned plans, then requests Firebase deletion. `AUTH_DELETE_PENDING` communicates an unfinished provider step. The tombstoned identity can retry deletion after authentication but cannot recreate a profile. Monitor persistent failures rather than treating this as an atomic two-service operation.

Provider backup retention and externally copied/exported records are outside immediate application-data erasure. Configure and document operational retention before promising deletion guarantees.

## Production verification and remaining work

The intended Firebase project, password policy, authorized production domain, restricted public API key, exact app origin and server secrets are configured. D1 migrations are applied. Live checks with three separate Firebase accounts passed for private/shared access, invitation reuse, revocation, idempotent creation, deletion cascades and rejection of a deleted account's token. Test accounts were removed. The packaged map's 43 resource hashes pass verification.

Still required before a wider public launch:

1. Verify real verification/reset email delivery to a mailbox; automated live verification used temporary administrator-verified test identities and sent no email.
2. Verify permission prompts, generic lock-screen text, account isolation, quiet hours and real FCM delivery on supported iOS/Android browsers. Test installed-PWA and offline behavior on physical devices.
3. Profile deployed CPU/subrequests and reminder backlog under realistic load. Monitor free quotas and establish a recovery contact.
4. Exercise backup restoration into a separate non-production database and document retention. Never restore over production simply to test recovery.
5. Repeat repository checks and security review after substantial changes. Automated checks and a clean dependency audit do not replace an independent penetration test.

Report suspected vulnerabilities privately to the repository owner with a minimal reproduction. Never post tokens, passwords, private keys or another user's records in public issues.
