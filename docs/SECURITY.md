# DayPact security and privacy

This document records implemented controls and remaining production checks. It is not a penetration-test certificate or a guarantee that software cannot be compromised. DayPact may contain private routines, locations, religious activities and savings goals; access must remain scoped to the owner and included plan members.

## Authentication and trust boundaries

- Firebase tokens are verified against Google's signing keys, RS256, the configured audience/issuer, required claims, expiry and bounded integer issue/authentication timestamps.
- Every authenticated request also performs a live Firebase account lookup. Disabled, deleted, unverified and revoked accounts are rejected. Revocation is compared against `auth_time`; malformed metadata and provider outages fail closed. Account email comes from the verified lookup.
- Firebase handles passwords; D1 does not store them. There is no request-controlled UID override, development-login endpoint or environment authentication bypass. Test authentication is explicit in-process dependency injection.
- Account deletion requires reauthentication within five minutes. A tombstone prevents a partially deleted identity from recreating application data while Firebase deletion is retried.

The Firebase web API key/public configuration are client configuration, not administrator credentials. Restrict API usage and authorized domains in the provider console. Messaging and administrative service-account private keys are separate worker secrets and must never enter frontend builds, browser storage, repository files or logs.

## Administration and moderation

Administrative authorization is an exact comparison between the verified Firebase UID and the worker-only `ADMIN_OWNER_UID`. The administrator is not selected by email, profile flags, client storage or a hidden route. Eligibility may be queried by any authenticated user, but every administrative read and mutation is independently gated. Knowing the route or inspecting frontend source does not authorize access; browser-delivered code cannot meaningfully be hidden or made inaccessible through obfuscation.

The owner enrolls a standard authenticator on their first administrative visit. The application uses RFC 6238 SHA-1 TOTP, six digits and a 30-second period, accepting at most one neighboring period in either direction. Enrollment/confirmation/unlock require Firebase authentication within five minutes. Pending enrollment expires after ten minutes and cannot replace an enrolled secret. A shared rolling attempt table permits at most five code submissions per ten minutes. Accepted counters advance atomically to reject replay, including concurrent requests with the same code.

TOTP secrets are encrypted in D1 with AES-256-GCM, a fresh random IV, and authenticated data binding ciphertext to the owner UID and format version. The 32-byte encryption key is `ADMIN_TOTP_KEY`, stored as a worker secret. The setup secret and `otpauth` URI are returned only to the freshly authenticated owner and are not persisted by the browser or sent to an external QR renderer. Deployment does not enroll MFA on the owner's behalf. Loss of the authenticator requires a controlled infrastructure-owner recovery; there is no public reset endpoint or recovery bypass. Back up the encryption key through approved secret management; rotating it without re-encrypting existing records makes those secrets unreadable.

A successful code creates a random 256-bit session whose SHA-256 hash, UID, Firebase `auth_time` and expiry are stored in D1. The raw token is delivered only in a host-scoped `HttpOnly`, `Secure`, `SameSite=Strict` cookie at `/api/admin`. Sessions expire after 15 minutes, are bounded to five per owner and remain dependent on a valid bearer token with matching authentication time. Locking revokes the current session. Administrative mutations additionally require the exact configured `Origin` and JSON. Session tokens, authenticator secrets and codes never belong in logs or local storage.

Account management uses a dedicated service account with only `firebaseauth.users.get`, `firebaseauth.users.update` and `firebaseauth.users.delete` permissions. Its private key is separate from the messaging service account; it does not grant account creation, arbitrary project administration or password-hash access. Provider responses are explicitly reduced to account metadata before reaching the browser. The account list includes unverified Firebase registrations. Operational views expose aggregate counts and delivery metadata, not private plan contents, stored locations or savings amounts.

Suspension and restoration fail closed. D1 blocks the affected UID before the provider operation, and normal APIs check moderation before and after profile initialization. Profile insertion also includes the moderation condition. Suspension removes device tokens and marks pending push deliveries skipped before contacting Firebase. Firebase is disabled and previous authentication is revoked; restoration removes the D1 block only after a successful provider update. Previously downloaded offline data cannot be remotely erased while the device is disconnected.

Permanent deletion records a UID tombstone before deleting application records and the Firebase identity. Tombstones and moderation/audit records survive account deletion, while support requests and owned application data cascade. The account's email is never an access-ban key, so a new registration with the same email and a new UID remains valid. The original owner account is protected from both self-deletion and administrator suspend/delete operations. Account actions require typed email confirmation, a bounded operation lease, and an unlocked owner session. Concurrent actions cannot clear another operation's claim; a pending permanent deletion cannot be restored. Provider failures retain a visible, retryable pending action instead of silently reporting completion.

Support requests are scoped to their verified author and the administrator; replies and status updates require the administrative session. Creation has rate and open-ticket bounds. User content remains plain text. Successful account finalization and support edits write their audit records in the same D1 batch as the state update. Audit events record actor/target UIDs, action, outcome and time, with no passwords, codes, message bodies or private plans. Audit history is an operational record, not a tamper-proof archive against an infrastructure administrator with direct database access.

## Data authorization and integrity

- SQL values use bound parameters. Strict schemas reject unknown write fields and validate types, calendar dates, time zones, coordinates and size/range bounds.
- The verified identity determines the actor. Plan reads require membership; editing/deletion requires ownership. Check-ins, RSVP, profile, settings, devices and notification-read changes apply to the caller only.
- Shared members must be current friends of the owner. Database triggers enforce this and resource limits in addition to application checks. Foreign keys cascade removed memberships into dependent records.
- Removing a friendship revokes reciprocal membership in plans owned by those two users. A third owner's shared plan is a separate relationship.
- Plan updates combine a version check and transaction-scoped mutation marker. Losing concurrent updates cannot alter members. Check-in IDs bind to payload fingerprints and cannot replay over newer progress.
- Offline plan creation uses actor-scoped UUID receipts and an atomic receipt/plan/member transaction. Different payloads cannot reuse a key. Receipts survive plan deletion, preventing delayed retries from recreating removed plans or re-adding revoked members.
- Meeting proposals and votes require current membership. Upcoming lists and proposal reads include the viewer's membership in the same SQL statement as private rows. A vote belongs to its authenticated actor and cannot target an option in another meeting.
- Proposal receipts bind the actor, meeting and place to one operation ID. Receipts survive proposal removal, so a delayed replay cannot restore a removed proposal after re-invitation. Membership foreign keys cascade proposals and votes; database triggers enforce three proposals per member and 24 per meeting even during concurrent requests.
- Only the organizer can adopt a proposed place, using a version-checked update. RSVP writes also check the current version and membership atomically. Missing versions from older clients are rejected with a refresh conflict. A successful change to event details clears applicable responses; losing concurrent edits cannot clear them. Neither the organizer nor another member can submit attendance for someone else.
- Time options are organizer-controlled and series-wide; members can select only their own availability among that meeting's current options. Schedule confirmation is version-checked and resets applicable attendance. Travel, supplies, expenses and paid marks are occurrence-scoped; ordinary writes use a bounded calendar window.
- Travel updates require today's occurrence and the actor's accepted RSVP. Supply claims are atomic and cannot take over another participant's claim. Item creation receipts prevent a delayed retry from recreating a deleted item. Historical deletion retains creator/organizer authorization and item versions.
- Expense totals are organizer-only; accepted participants can change only their own paid mark using the current expense version. Changes to the total or accepted roster invalidate paid marks. The split assigns integer remainders deterministically and never holds/transfers money. Clearing an old budget retains its version history to prevent stale writes from matching a recreated version.
- Invitation tokens have 256 bits of cryptographic randomness, are stored hashed, expire after seven days and are consumed atomically. Friends see limited public profiles; exports exclude other users' private profiles, emails and push tokens.

Revocation controls subsequent authorized access; it cannot erase information a member already saw, copied or cached. Progress and savings are self-reported, not financial transactions or proof of physical attendance.

## HTTP and browser controls

- The worker applies CSP, frame restrictions, MIME sniffing protection, referrer policy and HTTPS transport policy. CSP excludes inline scripts and `eval`; external connections are restricted to services required by the app.
- Every protected API uses bearer authorization. Ordinary application requests omit cookies; administration additionally requires its short-lived, owner-bound session cookie and exact mutation Origin. The administrative cookie alone cannot authenticate a request. Wildcard cross-origin access is not configured.
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

Browser SDK push-subscription cleanup has a five-second deadline and is best effort, so that cleanup cannot indefinitely block sign-out or completed account deletion. Sign-out starts private-storage cleanup and clears the active push recipient before subscription cleanup, then awaits the private-storage cleanup before finishing. This deadline does not guarantee provider-side token deletion while offline or during an outage.

Meeting threshold alerts use durable once-per-occurrence receipts; travel alerts are limited to one per actor/status/occurrence. Receipt creation and recipient insertion share a transaction and mutation marker. Current membership, persisted travel state, accepted attendance and preferences are checked before enqueue. Quiet/muted events consume the receipt and are not replayed later. Generic text avoids disclosing details or asserting that a previously reached threshold still holds when a delayed push arrives.

Delivery is best effort and at least once, not exactly once or guaranteed at an exact minute. Crashes and partial multi-device success can repeat sends; stable browser tags reduce visible duplicates. A preference change after a claim cannot retract an already in-flight send. Push requires connectivity and permission; offline plans do not provide offline push delivery.

## Work bounds and operational limits

Each invocation queues at most five indexed due plans and delivers at most three notifications to three devices each. The examined worst-case branch uses approximately 46 external/D1 subrequests, including OAuth, invalid-device cleanup and hourly rate-limit cleanup. This is a code-path estimate, not a deployed measurement; changes to these bounds require another quota review.

Live Cloudflare CPU profiling has **not** been completed. A subrequest count does not prove the free plan's CPU or daily quotas are sufficient. Membership counts, cryptographic work, provider latency and backlogs need measurement. Bounded batches can delay burst traffic. Storage growth, retention and backups need monitoring; bounded rate-limit cleanup is not a general retention policy.

Exports paginate check-ins instead of silently cutting off history. Clients follow `nextCursor` to completion or show a memory-limit failure. Pages are live reads, not a frozen snapshot.

Upcoming meetings are limited to the nearest 50 next occurrences from the user's bounded plan set. Coordination reads are membership-bound and batched. A time poll has at most six options; a series has at most 300 supplies (30 per occurrence) and 366 nonzero budgets. Owners/creators can clear authorized historical records to regain active capacity. Zero budget headers and operation/notification receipts retain safety history; storage still needs monitoring and an operational retention policy.

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
