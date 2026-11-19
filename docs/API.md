# DayPact HTTP API

The PWA and API use the same origin. Except for `GET /api/health`, every route requires `Authorization: Bearer <Firebase ID token>`. The server verifies the token and performs a live Firebase account lookup to reject disabled, deleted, unverified or revoked accounts. Actor IDs come from this verified identity. No HTTP or environment variable can bypass authentication.

Requests and responses use JSON. POST, PUT and PATCH require `Content-Type: application/json`; bodies are limited to 16 KiB. Unknown write fields are rejected. API responses use `Cache-Control: no-store`. Errors have the shape `{error:{code,message,requestId}}`. Clients should translate `code`; messages are not a localization contract.

Shared types are in `src/shared/contracts.ts`; server validation is in `src/api/domain/schemas.ts`. Dates are real calendar dates in `YYYY-MM-DD` format, times are `HH:mm`, timestamps are UTC ISO 8601 strings, and amounts are integer tenge. Plans have their own IANA time zone. Supported calendar years are 2000–2100.

## Account and settings

| Method and path       | Request                           | Response                      |
| --------------------- | --------------------------------- | ----------------------------- |
| `GET /api/health`     | None                              | `{ok:true,service:"daypact"}` |
| `GET /api/me`         | None                              | `{profile:Profile}`           |
| `PUT /api/me`         | `{displayName,username,bio,city}` | `{profile:Profile}`           |
| `PATCH /api/settings` | Partial `Settings`                | `{settings:Settings}`         |
| `DELETE /api/me`      | None                              | `{ok:true}`                   |

The first authenticated visit initializes the profile. Display names have at most 70 characters; usernames are normalized to lowercase, unique, and contain 3–24 ASCII letters, digits or underscores. Biography and city limits are 300 and 80 characters. Settings support Kazakh/Russian, system/dark/light appearance, notification preferences, quiet hours and time zone. Equal quiet-hour endpoints disable the quiet window.

Deletion requires Firebase reauthentication within five minutes. The server records a tombstone and deletes application data, then deletes the Firebase account. A provider failure returns `503 AUTH_DELETE_PENDING`: application data is already removed, and the user must retry `DELETE /api/me` after fresh authentication. Other routes return `ACCOUNT_DELETED` for a tombstoned identity and cannot recreate its profile. Deletion removes plans owned by that account; other owners' plans remain. This is a two-service operation, not a distributed transaction.

## Friends

| Method and path                 | Request   | Response                        |
| ------------------------------- | --------- | ------------------------------- |
| `GET /api/friends`              | None      | `{friends:Friend[]}`            |
| `POST /api/friends/invitations` | `{}`      | `{token,expiresAt}`; status 201 |
| `POST /api/friends/accept`      | `{token}` | `{friend:Friend}`               |
| `DELETE /api/friends/:uid`      | None      | `{ok:true}`                     |

Share invitations as `/?invite=TOKEN`. Tokens contain 32 cryptographically random bytes encoded as 64 hexadecimal characters; only SHA-256 hashes are stored. Invitations expire after seven days, are single use, and cannot be accepted by their creator. Concurrent acceptance allows one winner. Limits are 200 friends and 20 unexpired, unused invitations per account.

Removing a friendship removes each former friend from plans owned by the other. Membership in a third person's plan is separate and is not automatically removed. A friend's public view contains only UID, display name, username and city.

## Plans and progress

| Method and path                  | Request                                                   | Response                                             |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `GET /api/plans?date=YYYY-MM-DD` | Optional date; defaults to today in the account time zone | `{plans:Plan[]}`                                     |
| `POST /api/plans`                | `PlanInput`; optional `Idempotency-Key` header            | `{plan:Plan}`; status 201 on creation, 200 on replay |
| `PATCH /api/plans/:id`           | Partial `PlanInput` plus required `{version:number}`      | `{plan:Plan}`                                        |
| `DELETE /api/plans/:id`          | None                                                      | `{ok:true}`                                          |
| `POST /api/plans/:id/checkins`   | `{date,completed,contribution?,operationId}`              | `{ok:true}`                                          |
| `POST /api/plans/:id/rsvp`       | `{date,status:"accepted"                                  | "declined"}`                                         | `{ok:true}` |
| `POST /api/plans/:id/nudges`     | `{toUserId,date}`                                         | `{ok:true}`                                          |

Only members can read a plan or submit their own progress/RSVP; only the owner can change or delete it. Additional members must be current friends of the owner. The owner always remains a member. A plan accepts at most 20 supplied member IDs in addition to its owner; an account can belong to at most 200 plans. The database also enforces these limits and membership relationships.

Kinds are `habit`, `event`, `savings`; recurrence is `once`, `daily`, `weekly`, `monthly`. Monthly plans starting on the 31st use the last available day in shorter months. Titles have 1–120 characters; descriptions at most 1,000. Savings targets must be positive and no greater than 1,000,000,000 tenge. A place contains latitude, longitude and a label of at most 200 characters. It is a selected location, not proof of attendance.

`remindMinutes` is `-1` to disable, `0` at the scheduled time, or a positive number up to 10,080 minutes before it. Editing recalculates the next reminder. PATCH uses optimistic concurrency: a stale `version` returns `409 VERSION_CONFLICT` without changing the plan or membership. Refresh and resolve the conflict.

For offline creation, generate a UUID once and send it in `Idempotency-Key` on every retry of that draft. Keys are scoped to the authenticated user. Normalized request fields are fingerprinted; concurrent identical requests create only one plan. Reuse with changed fields returns `409 OPERATION_CONFLICT`. A replay returns the current original plan without rewriting it or restoring removed friends. If that plan was deleted, replay returns `404 PLAN_NOT_FOUND` and never recreates it. A failed transaction does not consume the key. Changing the account's default time zone after the original request does not invalidate an otherwise identical replay. Requests without the header create a new plan each time.

Check-ins must match an occurrence and cannot be in the future in the plan's time zone. `operationId` is a UUID identifying that user's intended action. Replaying the same ID/payload succeeds without reapplying it; changed payloads return `409 OPERATION_CONFLICT`. An old replay cannot overwrite a newer action. `contribution` replaces the actor's total for that occurrence; it is not an increment. Non-savings plans cannot receive a nonzero contribution. Progress is self-reported; the app does not hold or transfer money.

Nudges require current friendship and shared membership, today's occurrence, an incomplete recipient, enabled friend reminders and time outside quiet hours. Cooldown is 24 hours per sender, recipient, plan and occurrence. Success means queued, not guaranteed device delivery.

## Notifications

| Method and path                | Request                       | Response                                        |
| ------------------------------ | ----------------------------- | ----------------------------------------------- |
| `GET /api/notifications`       | None                          | `{notifications:AppNotification[]}`; latest 100 |
| `POST /api/notifications/read` | `{ids:string[]}`; at most 100 | `{ok:true}`                                     |
| `POST /api/push/tokens`        | `{token,deviceId}`            | `{ok:true}`                                     |
| `DELETE /api/push/tokens`      | `{deviceId}`                  | `{ok:true}`                                     |

Device IDs are UUIDs. At most three devices can register per account; an existing device can update its token. The same token cannot be silently transferred between accounts. Registration/deletion are scoped to the caller.

Push text is generic and excludes plan titles, locations, savings amounts, biographies and religious activities. Routing data includes recipient UID, notification ID and plan ID. The service worker checks the active account before displaying/opening a notification. Platform support, permission, connectivity and provider availability determine delivery.

Each scheduler invocation queues at most five due plans and processes at most three notifications, with at most three devices each. Delivery claims check current preferences, use a two-minute lease, retry transient failures with bounded backoff, delete unregistered tokens and skip reminders older than 24 hours. Delivery is at least once; stable browser tags reduce duplicates. Partial success can cause a previously successful device to receive a retry. Quiet-hour reminders are skipped, not postponed.

## Paginated export

`GET /api/export?limit=1000&cursor=OPAQUE` exports the caller's data. `limit` must be 1–1,000 and defaults to 1,000. Omit `cursor` initially and pass returned cursors unchanged.

First page: `{exportedAt,profile,plans,friendships,checkins,nextCursor,limits:{pageSize}}`.

Later pages: `{exportedAt,checkins,nextCursor,limits:{pageSize}}`.

Continue until `nextCursor` is `null`; concatenate check-ins and keep first-page metadata. Check-ins contain only the caller's progress, ordered by `occurrence_date DESC, plan_id ASC`. The compound cursor preserves records sharing a date. Plans include those owned by or shared with the caller. Other users' private profiles, emails and device tokens are excluded.

Cursors are bounded, validated base64url date/plan-ID tuples. They confer no authority: every page applies the caller's UID filter. Pages are live reads, not a frozen snapshot; concurrent edits can affect export consistency. The frontend must show an explicit error if its memory/page guard is reached instead of downloading silently truncated data.

## Errors, quotas and verification

Production limits are 180 requests per minute per hashed edge IP and 90 per minute per verified UID. `429` responses include `Retry-After: 60`. These do not replace provider quotas or upstream abuse controls.

Common codes include `AUTH_REQUIRED`, `AUTH_INVALID`, `AUTH_REVOKED`, `EMAIL_NOT_VERIFIED`, `AUTH_UNAVAILABLE`, `ACCOUNT_DELETED`, `AUTH_DELETE_PENDING`, `RECENT_LOGIN_REQUIRED`, `INVALID_INPUT`, `INVALID_CURSOR`, `BODY_TOO_LARGE`, `PLAN_NOT_FOUND`, `OWNER_REQUIRED`, `VERSION_CONFLICT`, `OPERATION_CONFLICT`, `INVITE_EXPIRED`, `MEMBER_NOT_FRIEND`, `PLAN_LIMIT`, `FRIEND_LIMIT`, `INVITATION_LIMIT`, `DEVICE_LIMIT`, `TOKEN_CONFLICT`, `NUDGE_COOLDOWN`, `QUIET_HOURS`, `ALREADY_COMPLETED`. Unknown errors must remain visible and must not silently discard offline changes.

Local tests cover real D1 migrations, multi-user permissions, concurrent mutations, recurrence, invitation consumption, export pagination, device limits and delivery failures. Live Firebase/FCM, deployed D1, real-device PWA behavior and Cloudflare CPU profiling still require verification using configured production accounts. Exact notification timing and unlimited free capacity are not guaranteed.
