import type { Env } from '../types';
import type { Settings } from '../../shared/contracts';
import { nextReminder, isQuiet } from './dates';
import type { PlanRow } from './repository';

/** Bounded per-minute work. Dedupe + conditional advancement make overlapping Cron invocations safe. */
export async function enqueueDueReminders(env: Env, now: Date = new Date()): Promise<number> {
  const timestamp = now.toISOString();
  const due = await env.DB.prepare(
    'SELECT * FROM plans WHERE next_reminder_at IS NOT NULL AND next_reminder_at<=? ORDER BY next_reminder_at LIMIT 5',
  )
    .bind(timestamp)
    .all<PlanRow>();
  let enqueued = 0;
  for (const plan of due.results) {
    const date = plan.next_reminder_date!;
    const members = await env.DB.prepare(
      `SELECT u.uid,u.settings_json FROM plan_members m JOIN users u ON u.uid=m.user_id LEFT JOIN checkins c ON c.plan_id=m.plan_id AND c.user_id=m.user_id AND c.occurrence_date=? WHERE m.plan_id=? AND coalesce(c.completed,0)=0 LIMIT 21`,
    )
      .bind(date, plan.id)
      .all<{ uid: string; settings_json: string }>();
    const next = nextReminder(plan, now);
    const statements: D1PreparedStatement[] = [];
    const eligible: string[] = [];
    // Drop stale reminders after a day of outage, rather than delivering a misleading backlog.
    if (now.getTime() - Date.parse(plan.next_reminder_at!) < 86400000) {
      for (const member of members.results) {
        const settings = JSON.parse(member.settings_json) as Settings;
        if (!settings.notificationsEnabled || isQuiet(now, settings)) continue;
        eligible.push(member.uid);
      }
    }
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO notifications(id,user_id,plan_id,kind,title,body,created_at,next_attempt_at,dedupe_key)
      SELECT lower(hex(randomblob(16))),u.uid,p.id,'reminder','DayPact',CASE WHEN json_extract(u.settings_json,'$.locale')='ru' THEN 'У вас есть незавершённый план.' ELSE 'Орындалмаған жоспарың бар.' END,?,?, 'reminder:'||p.id||':'||?||':'||u.uid
      FROM plans p JOIN plan_members m ON m.plan_id=p.id JOIN users u ON u.uid=m.user_id
      WHERE p.id=? AND p.next_reminder_at=? AND u.uid IN(SELECT value FROM json_each(?))
      AND NOT EXISTS(SELECT 1 FROM checkins c WHERE c.plan_id=p.id AND c.user_id=u.uid AND c.occurrence_date=? AND c.completed=1)`,
      ).bind(
        timestamp,
        timestamp,
        date,
        plan.id,
        plan.next_reminder_at,
        JSON.stringify(eligible),
        date,
      ),
    );
    statements.push(
      env.DB.prepare(
        'UPDATE plans SET next_reminder_at=?,next_reminder_date=? WHERE id=? AND next_reminder_at=?',
      ).bind(next?.at ?? null, next?.date ?? null, plan.id, plan.next_reminder_at),
    );
    const results = await env.DB.batch(statements);
    enqueued += results.slice(0, -1).reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  }
  return enqueued;
}
