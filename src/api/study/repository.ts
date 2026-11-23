import type { StudyData, StudyDocument } from '../../shared/study';
import { nextStudyReminder } from '../../shared/studyTime';
import { assertUserActive } from '../admin/guards';
import { HttpError, type Env } from '../types';

export interface StudyRow {
  user_id: string;
  data_json: string;
  version: number;
  updated_at: string;
  next_reminder_at: string | null;
  next_reminder_date: string | null;
  next_reminder_lesson: string | null;
}
export function studyDocument(row: StudyRow): StudyDocument {
  return {
    ...(JSON.parse(row.data_json) as StudyData),
    version: row.version,
    updatedAt: row.updated_at,
  };
}
export async function getStudyDocument(env: Env, uid: string): Promise<StudyDocument | null> {
  const row = await env.DB.prepare('SELECT * FROM study_documents WHERE user_id=?')
    .bind(uid)
    .first<StudyRow>();
  return row ? studyDocument(row) : null;
}
/** Caller passes schema-parsed data. The UID always comes from the verified identity. */
export async function saveStudyDocument(
  env: Env,
  uid: string,
  version: number,
  data: StudyData,
  now = new Date(),
): Promise<StudyDocument> {
  const serialized = JSON.stringify(data),
    updatedAt = now.toISOString();
  const next = nextStudyReminder(data, now);
  const active = `EXISTS(SELECT 1 FROM users WHERE uid=?)
    AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE uid=?)
    AND NOT EXISTS(SELECT 1 FROM user_moderation WHERE user_id=? AND state<>'active')`;
  const write =
    version === 0
      ? env.DB.prepare(
          `INSERT INTO study_documents(user_id,data_json,version,updated_at,next_reminder_at,next_reminder_date,next_reminder_lesson)
      SELECT ?,?,1,?,?,?,? WHERE ${active} ON CONFLICT(user_id) DO NOTHING RETURNING *`,
        ).bind(
          uid,
          serialized,
          updatedAt,
          next?.at ?? null,
          next?.date ?? null,
          next?.lessonId ?? null,
          uid,
          uid,
          uid,
        )
      : env.DB.prepare(
          `UPDATE study_documents SET data_json=?,version=version+1,updated_at=?,next_reminder_at=?,next_reminder_date=?,next_reminder_lesson=?
      WHERE user_id=? AND version=? AND ${active} RETURNING *`,
        ).bind(
          serialized,
          updatedAt,
          next?.at ?? null,
          next?.date ?? null,
          next?.lessonId ?? null,
          uid,
          version,
          uid,
          uid,
          uid,
        );
  const results = await env.DB.batch<StudyRow>([
    write,
    // A failed CAS cannot invalidate the winner's queue. An exact retry may safely
    // repeat invalidation, but never inserts another reminder receipt.
    env.DB.prepare(
      `UPDATE notifications SET state='skipped'
      WHERE user_id=? AND study_version IS NOT NULL AND state='pending' AND study_version<>?
      AND EXISTS(SELECT 1 FROM study_documents WHERE user_id=? AND version=? AND data_json=?)`,
    ).bind(uid, version + 1, uid, version + 1, serialized),
  ]);
  await assertUserActive(env, uid);
  const saved = results[0]?.results[0];
  if (saved) return studyDocument(saved);
  const current = await env.DB.prepare('SELECT * FROM study_documents WHERE user_id=?')
    .bind(uid)
    .first<StudyRow>();
  if (current?.version === version + 1 && current.data_json === serialized)
    return studyDocument(current);
  const exists = await env.DB.prepare('SELECT uid FROM users WHERE uid=?').bind(uid).first();
  if (!exists) throw new HttpError(403, 'ACCOUNT_DELETED', 'This account is unavailable.');
  throw new HttpError(409, 'VERSION_CONFLICT', 'The timetable changed. Refresh before saving.');
}
