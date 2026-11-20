# DayPact HTTP API

The PWA and API use the same origin. Except for `GET /api/health`, every route requires `Authorization: Bearer <Firebase ID token>`. The server verifies the token and performs a live Firebase account lookup to reject disabled, deleted, unverified or revoked accounts. Actor IDs come from this verified identity. No HTTP or environment variable can bypass authentication.

Requests and responses use JSON. Mutating requests, including DELETE, require `Content-Type: application/json`; bodies are limited to 16 KiB. Unknown write fields are rejected. API responses use `Cache-Control: no-store`. Errors have the shape `{error:{code,message,requestId}}`. Clients should translate `code`; messages are not a localization contract.

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

| Method and path                  | Request                                                     | Response                                             |
| -------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| `GET /api/plans?date=YYYY-MM-DD` | Optional date; defaults to today in the account time zone   | `{plans:Plan[]}`                                     |
| `POST /api/plans`                | `PlanInput`; optional `Idempotency-Key` header              | `{plan:Plan}`; status 201 on creation, 200 on replay |
| `PATCH /api/plans/:id`           | Partial `PlanInput` plus required `{version:number}`        | `{plan:Plan}`                                        |
| `DELETE /api/plans/:id`          | None                                                        | `{ok:true}`                                          |
| `POST /api/plans/:id/checkins`   | `{date,completed,contribution?,operationId}`                | `{ok:true}`                                          |
| `POST /api/plans/:id/rsvp`       | `{date,status,version}`; status is `accepted` or `declined` | `{ok:true}`                                          |
| `POST /api/plans/:id/nudges`     | `{toUserId,date}`                                           | `{ok:true}`                                          |

Only members can read a plan or submit their own progress/RSVP; only the owner can change or delete it. Additional members must be current friends of the owner. The owner always remains a member. A plan accepts at most 20 supplied member IDs in addition to its owner; an account can belong to at most 200 plans. The database also enforces these limits and membership relationships.

Kinds are `habit`, `event`, `savings`; recurrence is `once`, `daily`, `weekly`, `monthly`. Monthly plans starting on the 31st use the last available day in shorter months. Titles have 1–120 characters; descriptions at most 1,000. Savings targets must be positive and no greater than 1,000,000,000 tenge. A place contains latitude, longitude and a label of at most 200 characters. It is a selected location, not proof of attendance.

`remindMinutes` is `-1` to disable, `0` at the scheduled time, or a positive number up to 10,080 minutes before it. Editing recalculates the next reminder. PATCH uses optimistic concurrency: a stale `version` returns `409 VERSION_CONFLICT` without changing the plan or membership. Refresh and resolve the conflict.

RSVP applies only to events and only to the authenticated member's own attendance. It requires the current plan `version`; an obsolete or omitted version returns `409 VERSION_CONFLICT` without writing a response. Omitted versions from older clients therefore prompt a refresh instead of accepting attendance for unreviewed details. Changing an event's place, date, time, time zone or recurrence clears applicable current/future responses so participants can decide again. Changes to a title alone do not reset responses. A stale failed edit cannot clear attendance.

For offline creation, generate a UUID once and send it in `Idempotency-Key` on every retry of that draft. Keys are scoped to the authenticated user. Normalized request fields are fingerprinted; concurrent identical requests create only one plan. Reuse with changed fields returns `409 OPERATION_CONFLICT`. A replay returns the current original plan without rewriting it or restoring removed friends. If that plan was deleted, replay returns `404 PLAN_NOT_FOUND` and never recreates it. A failed transaction does not consume the key. Changing the account's default time zone after the original request does not invalidate an otherwise identical replay. Requests without the header create a new plan each time.

Check-ins must match an occurrence and cannot be in the future in the plan's time zone. `operationId` is a UUID identifying that user's intended action. Replaying the same ID/payload succeeds without reapplying it; changed payloads return `409 OPERATION_CONFLICT`. An old replay cannot overwrite a newer action. `contribution` replaces the actor's total for that occurrence; it is not an increment. Non-savings plans cannot receive a nonzero contribution. Progress is self-reported; the app does not hold or transfer money.

Nudges require current friendship and shared membership, today's occurrence, an incomplete recipient, enabled friend reminders and time outside quiet hours. Cooldown is 24 hours per sender, recipient, plan and occurrence. Success means queued, not guaranteed device delivery.

## Meetings and proposed places

Named meetings use the existing plan model with `kind: "event"` and cadence `once`, `daily`, `weekly` or `monthly`. They retain the same membership, friend-invitation, offline creation and authorization rules. `minAttendees` is an integer from 2 to 21, defaulting to 2. The title (for example, Football) and the place label (for example, School football field) are separate fields.

| Method and path                     | Request                                               | Response                                                              |
| ----------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /api/meetings?from=YYYY-MM-DD` | Optional date, default today in the account time zone | `{meetings:Plan[]}`; at most 50 meetings, each at its next occurrence |
| `GET /api/plans/:id/places`         | None                                                  | `MeetingPlaces`                                                       |
| `POST /api/plans/:id/places`        | `{operationId:UUID,place:Place}`                      | `MeetingPlaces`; 201 first creation, 200 identical retry              |
| `PUT /api/plans/:id/place-vote`     | `{optionId:UUID}` or `{optionId:null}` to withdraw    | `{ok:true}`                                                           |
| `POST /api/plans/:id/place-confirm` | `{optionId:UUID,version:number}`                      | `{plan:Plan}`                                                         |

`MeetingPlaces` contains `planVersion` and `options`. Each option contains `id`, `planId`, `proposedBy`, `proposerName`, `place`, `voterIds` and `createdAt`. Only current members can see proposals and voters. The upcoming list uses each meeting's actual occurrence date for attendance, rather than today's date, and orders by date, time and ID. Recurring events also appear in the daily plan view. Place and time polls apply to the whole series; the interface explains this before an organizer changes its schedule or location.

Each member may propose at most three places, with a maximum of 24 per meeting. Keep the same `operationId` when retrying a proposal: changed content under an existing ID is rejected. Each member has one vote per meeting, which can be moved or withdrawn. A vote cannot target another meeting's option or impersonate another participant. Removing membership cascades its proposals and votes.

The organizer chooses a proposed location using the current version; votes inform that decision and do not automatically finalize it. Adopting a different place updates the meeting and resets attendance for reconfirmation. Someone else's vote or response cannot be edited by the organizer. Proposals, voting and finalization require a connection; a new meeting can use the existing offline creation queue. A place initially picked by the organizer is valid without creating a poll option.

## Meeting coordination

`GET /api/plans/:id/coordination?date=YYYY-MM-DD` returns `MeetingCoordination` from `src/shared/meetingCoordination.ts`. It includes the current plan version, occurrence date, minimum/accepted participant counts, derived confirmation state, series-wide time options, and this occurrence's travel, supplies and expense split. Every read requires current membership. Separate occurrences never inherit each other's attendance, claims, travel or paid marks.

| Method and path                          | Request                                   | Purpose                                                                    |
| ---------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| `PUT /api/plans/:id/time-options`        | `{version,options:[{id:UUID,date,time}]}` | Organizer replaces 2–6 distinct schedule options.                          |
| `PUT /api/plans/:id/time-vote`           | `{version,optionIds:UUID[]}`              | Member marks all suitable options; an empty list withdraws availability.   |
| `POST /api/plans/:id/time-confirm`       | `{version,optionId:UUID}`                 | Organizer adopts an option for the series and returns `{plan:Plan}`.       |
| `PUT /api/plans/:id/travel`              | `{date,version,status,lateMinutes?}`      | Own `on_way`, `late` or `arrived` state; late minutes are 1–240.           |
| `POST /api/plans/:id/items`              | `{date,version,operationId:UUID,title}`   | Member creates a supply/task with a stable retry ID.                       |
| `PATCH /api/plans/:id/items/:itemId`     | `{date,version,title}`                    | Creator or organizer edits an item.                                        |
| `DELETE /api/plans/:id/items/:itemId`    | `{date,version}`                          | Creator or organizer removes an item.                                      |
| `PUT /api/plans/:id/items/:itemId/claim` | `{date,version,claimed:boolean}`          | Member claims an unclaimed item or releases their own claim.               |
| `PUT /api/plans/:id/expense`             | `{date,version,total}`                    | Organizer sets an integer-tenge total; version 0 creates the first budget. |
| `PUT /api/plans/:id/expense/paid`        | `{date,version,paid:boolean}`             | Accepted member changes only their own payment mark.                       |

Time writes, travel and item creation use the plan version. Existing item mutations use the item's version; expense mutations use the expense version. Strict schemas reject actor overrides and unknown fields. Conflicting writes return `409 VERSION_CONFLICT`; refresh before deciding again. Ordinary occurrence writes are limited to yesterday through 366 days ahead. Travel specifically requires today's occurrence and an accepted RSVP.

Each participant may select several suitable time options. Confirming one changes the series anchor date/time, recalculates reminders and clears applicable attendance. An occurrence is confirmed while accepted attendance is at least `minAttendees`; it becomes unconfirmed again if attendance falls below that threshold.

Item claims use an atomic version/claimant condition: even an organizer cannot assign or release another participant's claim. Changing a claimed item's title clears its claim so the new obligation must be accepted again. Titles are limited to 80 characters. A meeting occurrence allows at most 30 items and a series at most 300 stored items. Creators/organizers may delete historical items with the same authorization and version checks to reclaim capacity.

Expenses split among accepted participants using integer tenge. Remainders are assigned deterministically by sorted participant UID so shares sum exactly to the total. Changes to the total or accepted roster advance the expense version and clear paid marks; old requests cannot mark a new share as paid. The total is 0–1,000,000,000 tenge. A series permits 366 nonzero budgets; the organizer may clear an existing historical budget to zero with its current version. Zero headers retain a monotonic version so an old payment request cannot become valid after clearing/reusing a budget. These are self-reported records, not payment processing or proof of a bank transfer.

Threshold notification receipts permit one alert per occurrence; travel alerts permit one per actor/status/occurrence. Changing late minutes does not send another alert for the same status. Notifications contain generic text, respect quiet hours and enabled preferences, and use the existing bounded delivery queue. Muted events are not replayed later. Delivery is best effort; the meeting view remains the current source of participation status.

## Notifications

| Method and path                | Request                       | Response                                        |
| ------------------------------ | ----------------------------- | ----------------------------------------------- |
| `GET /api/notifications`       | None                          | `{notifications:AppNotification[]}`; latest 100 |
| `POST /api/notifications/read` | `{ids:string[]}`; at most 100 | `{ok:true}`                                     |
| `POST /api/push/tokens`        | `{token,deviceId}`            | `{ok:true}`                                     |
| `DELETE /api/push/tokens`      | `{deviceId}`                  | `{ok:true}`                                     |
| `POST /api/push/test`          | `{deviceId}`                  | `{accepted:true}` after provider acceptance     |

The test-push endpoint sends only to the authenticated user's matching registered device, uses the saved language, and permits three attempts per five-minute window per user. An explicitly requested test bypasses quiet hours and reminder preferences. It never broadcasts or includes plan details. `accepted` means FCM accepted the request, not that the phone displayed it. Errors include `PUSH_NOT_REGISTERED` (409), `PUSH_SETUP` or `PUSH_DELIVERY_FAILED` (503), and `RATE_LIMITED` (429).

Device IDs are UUIDs. At most three devices can register per account; an existing device can update its token. The same token cannot be silently transferred between accounts. Registration/deletion are scoped to the caller.

Push text is generic and excludes plan titles, locations, savings amounts, biographies and religious activities. Routing data includes recipient UID, notification ID and plan ID. The service worker checks the active account before displaying/opening a notification. Platform support, permission, connectivity and provider availability determine delivery.

Each scheduler invocation queues at most five due plans and processes at most three notifications, with at most three devices each. Delivery claims check current preferences, use a two-minute lease, retry transient failures with bounded backoff, delete unregistered tokens and skip reminders older than 24 hours. Delivery is at least once; stable browser tags reduce duplicates. Partial success can cause a previously successful device to receive a retry. Quiet-hour reminders are skipped, not postponed.

## Paginated export

`GET /api/export?limit=1000&cursor=OPAQUE` exports the caller's data. `limit` must be 1–1,000 and defaults to 1,000. Omit `cursor` initially and pass returned cursors unchanged.

First page: `{exportedAt,profile,plans,friendships,meetingPlaces,meetingVotes,meetingResponses,checkins,nextCursor,limits:{pageSize}}`.

Later pages: `{exportedAt,checkins,nextCursor,limits:{pageSize}}`.

Continue until `nextCursor` is `null`; concatenate check-ins and keep first-page metadata. Check-ins contain only the caller's progress, ordered by `occurrence_date DESC, plan_id ASC`. The compound cursor preserves records sharing a date. Plans include those owned by or shared with the caller. Other users' private profiles, emails and device tokens are excluded.

Meeting arrays appear only on the first page and contain the caller's own contributions:

- `meetingPlaces`: `{id,plan_id,place_json,created_at}` for places proposed by the caller. `place_json` is serialized `Place` JSON, consistent with exported plan rows.
- `meetingVotes`: `{plan_id,option_id,updated_at}` for the caller's current votes.
- `meetingResponses`: `{plan_id,occurrence_date,status,updated_at}` for the caller's responses to the current occurrence of one-time events. This is not a recurring-event attendance history export.

The active-plan and proposal limits bound these arrays to 600 places, 200 votes and 200 responses. Other participants' proposals, votes and attendance records are not included in these arrays.

Cursors are bounded, validated base64url date/plan-ID tuples. They confer no authority: every page applies the caller's UID filter. Pages are live reads, not a frozen snapshot; concurrent edits can affect export consistency. The frontend must show an explicit error if its memory/page guard is reached instead of downloading silently truncated data.

`GET /api/export/coordination?limit=1000&cursor=OPAQUE` separately paginates coordination records as `{records:[{kind,key,data}],nextCursor}`. It includes the caller's attendance across recurrences, travel states, time votes and paid marks; items created or claimed by them; and expense totals/time options only for series they organize. It excludes other members' attendance, travel and paid records. Continue until `nextCursor` is null. The frontend merges these pages into `meetingCoordinationRecords` in the downloaded export, with the same account and memory guards as the original export.

## Errors, quotas and verification

Production limits are 180 requests per minute per hashed edge IP and 90 per minute per verified UID. `429` responses include `Retry-After: 60`. These do not replace provider quotas or upstream abuse controls.

Common codes include `AUTH_REQUIRED`, `AUTH_INVALID`, `AUTH_REVOKED`, `EMAIL_NOT_VERIFIED`, `AUTH_UNAVAILABLE`, `ACCOUNT_DELETED`, `AUTH_DELETE_PENDING`, `RECENT_LOGIN_REQUIRED`, `INVALID_INPUT`, `INVALID_CURSOR`, `BODY_TOO_LARGE`, `PLAN_NOT_FOUND`, `OWNER_REQUIRED`, `VERSION_CONFLICT`, `OPERATION_CONFLICT`, `INVITE_EXPIRED`, `MEMBER_NOT_FRIEND`, `PLAN_LIMIT`, `FRIEND_LIMIT`, `INVITATION_LIMIT`, `DEVICE_LIMIT`, `TOKEN_CONFLICT`, `NUDGE_COOLDOWN`, `QUIET_HOURS`, `ALREADY_COMPLETED`. Unknown errors must remain visible and must not silently discard offline changes.

Local tests cover real D1 migrations, multi-user permissions, concurrent mutations, recurrence, invitation consumption, export pagination, device limits and delivery failures. The [release verification record](RELEASE.md) documents live identity/API/browser checks and outstanding physical-device notification and operational checks. Exact notification timing and unlimited free capacity are not guaranteed.
