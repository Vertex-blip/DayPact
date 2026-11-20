import { DEFAULT_SETTINGS, type Cadence, type Settings } from '../../shared/contracts';
import type { MeetingTravelStatus } from '../../shared/meetingCoordination';
import { addDays, isQuiet, localParts, occurs } from './dates';

interface MeetingRow {
  id: string;
  kind: string;
  cadence: Cadence;
  start_date: string;
  time_zone: string;
  version: number;
}

async function context(db: D1Database, planId: string, date: string, now: Date) {
  const plan = await db
    .prepare('SELECT id,kind,cadence,start_date,time_zone,version FROM plans WHERE id=?')
    .bind(planId)
    .first<MeetingRow>();
  if (
    !plan ||
    plan.kind !== 'event' ||
    !occurs(plan.start_date, plan.cadence, date) ||
    date < localParts(now, plan.time_zone).date ||
    date > addDays(localParts(now, plan.time_zone).date, 366)
  )
    return null;
  const members = await db
    .prepare(
      'SELECT u.uid,u.settings_json FROM plan_members m JOIN users u ON u.uid=m.user_id WHERE m.plan_id=? LIMIT 21',
    )
    .bind(planId)
    .all<{ uid: string; settings_json: string }>();
  const eligible = members.results
    .filter((member) => {
      const settings: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(member.settings_json) };
      return settings.notificationsEnabled && settings.friendNudges && !isQuiet(now, settings);
    })
    .map((member) => member.uid);
  return { plan, eligible };
}

/** Persist an event receipt even when every recipient has muted it, so retries
 * cannot produce a delayed alert after their preferences or quiet hours change. */
function notificationInsert(
  db: D1Database,
  planId: string,
  date: string,
  eventKey: string,
  requestId: string,
  eligible: string[],
  now: Date,
  kind: 'threshold' | 'travel',
): D1PreparedStatement {
  const body =
    kind === 'threshold'
      ? {
          kk: 'Кездесуге қатысу туралы жаңарту бар. Қолданбадан тексер.',
          ru: 'Для встречи обновился статус участия. Проверьте приложение.',
        }
      : {
          kk: 'Кездесуге қатысушының күйі өзгерді. Қолданбадан тексер.',
          ru: 'Участник встречи обновил свой статус. Проверьте приложение.',
        };
  const stamp = now.toISOString();
  return db
    .prepare(
      `
    INSERT OR IGNORE INTO notifications(id,user_id,plan_id,kind,title,body,created_at,next_attempt_at,dedupe_key)
    SELECT lower(hex(randomblob(16))),u.uid,p.id,'nudge','DayPact',
      CASE WHEN json_extract(u.settings_json,'$.locale')='ru' THEN ? ELSE ? END,?,?,
      'meeting:'||p.id||':'||?||':'||?||':'||u.uid
    FROM plans p JOIN plan_members m ON m.plan_id=p.id JOIN users u ON u.uid=m.user_id
    WHERE p.id=? AND p.kind='event' AND u.uid IN(SELECT value FROM json_each(?))
      AND json_extract(u.settings_json,'$.notificationsEnabled')=1
      AND json_extract(u.settings_json,'$.friendNudges')=1
      AND EXISTS(SELECT 1 FROM meeting_notification_receipts r
        WHERE r.plan_id=p.id AND r.occurrence_date=? AND r.event_key=? AND r.request_id=?)
    LIMIT 21
  `,
    )
    .bind(
      body.ru,
      body.kk,
      stamp,
      stamp,
      date,
      eventKey,
      planId,
      JSON.stringify(eligible),
      date,
      eventKey,
      requestId,
    );
}

/** Queue at most one threshold alert per participant and occurrence. The
 * receipt/count predicate and notification insert share a D1 transaction. */
export async function queueMeetingThreshold(
  db: D1Database,
  planId: string,
  date: string,
  now = new Date(),
): Promise<number> {
  const state = await context(db, planId, date, now);
  if (!state) return 0;
  const requestId = crypto.randomUUID(),
    eventKey = 'threshold';
  const result = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO meeting_notification_receipts
      (plan_id,occurrence_date,event_key,created_at,request_id)
      SELECT p.id,?,?,?,? FROM plans p WHERE p.id=? AND p.kind='event' AND p.version=?
      AND (SELECT count(*) FROM rsvps r JOIN plan_members m ON m.plan_id=r.plan_id AND m.user_id=r.user_id
        WHERE r.plan_id=p.id AND r.occurrence_date=? AND r.status='accepted')>=p.min_attendees
    `,
      )
      .bind(date, eventKey, now.toISOString(), requestId, planId, state.plan.version, date),
    notificationInsert(db, planId, date, eventKey, requestId, state.eligible, now, 'threshold'),
  ]);
  return result[1].meta.changes ?? 0;
}

/** Each participant can alert the group once per travel state per occurrence.
 * Late-minute changes remain visible in the meeting without sending new spam. */
export async function queueMeetingTravel(
  db: D1Database,
  planId: string,
  date: string,
  uid: string,
  status: MeetingTravelStatus,
  now = new Date(),
): Promise<number> {
  const state = await context(db, planId, date, now);
  if (!state || date !== localParts(now, state.plan.time_zone).date) return 0;
  const requestId = crypto.randomUUID(),
    eventKey = `travel:${uid}:${status}`;
  const result = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO meeting_notification_receipts
      (plan_id,occurrence_date,event_key,created_at,request_id)
      SELECT p.id,?,?,?,? FROM plans p JOIN meeting_travel t ON t.plan_id=p.id
      JOIN plan_members m ON m.plan_id=t.plan_id AND m.user_id=t.user_id
      JOIN rsvps r ON r.plan_id=t.plan_id AND r.user_id=t.user_id AND r.occurrence_date=t.occurrence_date
      WHERE p.id=? AND p.kind='event' AND p.version=? AND t.user_id=?
        AND t.occurrence_date=? AND t.status=? AND r.status='accepted'
    `,
      )
      .bind(
        date,
        eventKey,
        now.toISOString(),
        requestId,
        planId,
        state.plan.version,
        uid,
        date,
        status,
      ),
    notificationInsert(
      db,
      planId,
      date,
      eventKey,
      requestId,
      state.eligible.filter((member) => member !== uid),
      now,
      'travel',
    ),
  ]);
  return result[1].meta.changes ?? 0;
}
