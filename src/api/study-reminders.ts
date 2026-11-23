import { DEFAULT_SETTINGS, type Settings } from '../shared/contracts';
import type { StudyData } from '../shared/study';
import { nextStudyReminder, studyOccurrences, studyWallInstant } from '../shared/studyTime';
import { isQuiet } from './domain/dates';
import type { StudyRow } from './study/repository';
import type { Env } from './types';

type DueStudyRow = StudyRow & { settings_json: string };

/** Each document takes one atomic, three-statement batch, including simultaneous lessons. */
export async function enqueueDueStudyReminders(
  env: Env,
  now = new Date(),
  limit = 2,
): Promise<number> {
  const timestamp = now.toISOString();
  const batchLimit = Number.isFinite(limit) ? Math.max(1, Math.min(2, Math.trunc(limit))) : 2;
  const due = await env.DB.prepare(
    `SELECT d.*,u.settings_json FROM study_documents d JOIN users u ON u.uid=d.user_id
    WHERE d.next_reminder_at IS NOT NULL AND d.next_reminder_at<=?
    ORDER BY d.next_reminder_at,d.user_id LIMIT ?`,
  )
    .bind(timestamp, batchLimit)
    .all<DueStudyRow>();
  let enqueued = 0;
  for (const row of due.results) {
    const data = JSON.parse(row.data_json) as StudyData;
    const settings: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(row.settings_json) };
    const allowsNotification = settings.notificationsEnabled && !isQuiet(now, settings);
    const cursor = Date.parse(row.next_reminder_at!);
    const items =
      data.term.remindMinutes < 0
        ? []
        : studyOccurrences(data, row.next_reminder_date!).flatMap((item) => {
            if (item.cancelled) return [];
            const startsAt = studyWallInstant(item.date, item.startTime, data.term.timeZone);
            if (startsAt.getTime() - data.term.remindMinutes * 60_000 !== cursor) return [];
            return [
              {
                lessonId: item.id,
                date: item.date,
                eligible: startsAt > now && allowsNotification,
              },
            ];
          });
    const next = nextStudyReminder(data, now);
    const serialized = JSON.stringify(items);
    // The complete cursor and version are checked inside every statement. A concurrent
    // edit or another cron invocation cannot enqueue an old snapshot or advance its winner.
    const current = `d.user_id=? AND d.version=? AND d.next_reminder_at=?
      AND d.next_reminder_date=? AND d.next_reminder_lesson=?`;
    const currentValues = [
      row.user_id,
      row.version,
      row.next_reminder_at,
      row.next_reminder_date,
      row.next_reminder_lesson,
    ];
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO notifications(id,user_id,plan_id,kind,title,body,created_at,next_attempt_at,dedupe_key,study_lesson_id,study_date,study_version)
        SELECT lower(hex(randomblob(16))),d.user_id,NULL,'reminder','DayPact',
        CASE WHEN json_extract(u.settings_json,'$.locale')='ru' THEN 'Скоро начнётся занятие.' ELSE 'Сабақ жақында басталады.' END,
        ?,?,'study:'||d.user_id||':'||json_extract(j.value,'$.lessonId')||':'||json_extract(j.value,'$.date'),
        json_extract(j.value,'$.lessonId'),json_extract(j.value,'$.date'),d.version
        FROM study_documents d JOIN users u ON u.uid=d.user_id,json_each(?) j
        WHERE ${current} AND json_extract(j.value,'$.eligible')=1 AND u.settings_json=?
        AND NOT EXISTS(SELECT 1 FROM deleted_accounts a WHERE a.uid=d.user_id)
        AND NOT EXISTS(SELECT 1 FROM user_moderation m WHERE m.user_id=d.user_id AND m.state<>'active')
        AND NOT EXISTS(SELECT 1 FROM study_reminder_receipts r WHERE r.user_id=d.user_id
          AND r.lesson_id=json_extract(j.value,'$.lessonId') AND r.occurrence_date=json_extract(j.value,'$.date'))`,
      ).bind(timestamp, timestamp, serialized, ...currentValues, row.settings_json),
      // Muted, quiet, moderated and already-started occurrences are consumed too: an
      // account/settings change must not replay them later on the same calendar day.
      env.DB.prepare(
        `INSERT OR IGNORE INTO study_reminder_receipts(user_id,lesson_id,occurrence_date)
        SELECT d.user_id,json_extract(j.value,'$.lessonId'),json_extract(j.value,'$.date')
        FROM study_documents d,json_each(?) j WHERE ${current}`,
      ).bind(serialized, ...currentValues),
      env.DB.prepare(
        `UPDATE study_documents AS d SET next_reminder_at=?,next_reminder_date=?,next_reminder_lesson=?
        WHERE ${current}`,
      ).bind(next?.at ?? null, next?.date ?? null, next?.lessonId ?? null, ...currentValues),
    ]);
    enqueued += results[0]?.meta.changes ?? 0;
  }
  return enqueued;
}
