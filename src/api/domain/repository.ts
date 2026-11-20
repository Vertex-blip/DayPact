import {
  DEFAULT_SETTINGS,
  type Plan,
  type PlanInput,
  type Profile,
  type Settings,
  type Cadence,
} from '../../shared/contracts';
import { HttpError, type Env, type Identity } from '../types';
import { assertUserActive } from '../admin/guards';
export interface UserRow {
  uid: string;
  email: string;
  display_name: string;
  username: string | null;
  bio: string;
  city: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}
export interface PlanRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  kind: PlanInput['kind'];
  cadence: Cadence;
  start_date: string;
  time: string;
  time_zone: string;
  place_json: string | null;
  target_amount: number | null;
  remind_minutes: number;
  min_attendees: number;
  version: number;
  mutation_id: string;
  next_reminder_at: string | null;
  next_reminder_date: string | null;
  created_at: string;
  updated_at: string;
}
export function settingsOf(user: Pick<UserRow, 'settings_json'>): Settings {
  return { ...DEFAULT_SETTINGS, ...(JSON.parse(user.settings_json) as Settings) };
}
export function profileOf(user: UserRow): Profile {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.display_name,
    username: user.username ?? '',
    bio: user.bio,
    city: user.city,
    settings: settingsOf(user),
    createdAt: user.created_at,
  };
}
export async function getUser(db: D1Database, uid: string): Promise<UserRow> {
  const row = await db.prepare('SELECT * FROM users WHERE uid=?').bind(uid).first<UserRow>();
  if (!row) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  return row;
}
export async function ensureUser(env: Env, identity: Identity): Promise<UserRow> {
  await assertUserActive(env, identity.uid);
  const deleted = await env.DB.prepare('SELECT 1 FROM deleted_accounts WHERE uid=?')
    .bind(identity.uid)
    .first();
  if (deleted) throw new HttpError(401, 'ACCOUNT_DELETED', 'Account has been deleted');
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users(uid,email,display_name,settings_json,created_at,updated_at)
    SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE uid=?)
    AND NOT EXISTS(SELECT 1 FROM user_moderation WHERE user_id=? AND state<>'active')
    ON CONFLICT(uid) DO UPDATE SET email=excluded.email WHERE users.email<>excluded.email`,
  )
    .bind(
      identity.uid,
      identity.email,
      (identity.name?.trim() || identity.email.split('@')[0] || 'DayPact').slice(0, 70),
      JSON.stringify(DEFAULT_SETTINGS),
      now,
      now,
      identity.uid,
      identity.uid,
    )
    .run();
  await assertUserActive(env, identity.uid);
  return getUser(env.DB, identity.uid);
}
export async function memberPlan(db: D1Database, id: string, uid: string): Promise<PlanRow> {
  const p = await db
    .prepare(
      'SELECT p.* FROM plans p JOIN plan_members m ON m.plan_id=p.id WHERE p.id=? AND m.user_id=?',
    )
    .bind(id, uid)
    .first<PlanRow>();
  if (!p) throw new HttpError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  return p;
}
export async function ownerPlan(db: D1Database, id: string, uid: string): Promise<PlanRow> {
  const p = await memberPlan(db, id, uid);
  if (p.owner_id !== uid)
    throw new HttpError(403, 'OWNER_REQUIRED', 'Only the owner can change this plan');
  return p;
}
export async function areFriends(db: D1Database, a: string, b: string): Promise<boolean> {
  return Boolean(
    await db
      .prepare('SELECT 1 FROM friendships WHERE user_low=min(?,?) AND user_high=max(?,?)')
      .bind(a, b, a, b)
      .first(),
  );
}
export async function checkMembers(db: D1Database, owner: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].filter((id) => id !== owner);
  if (!unique.length) return;
  const result = await db
    .prepare(
      `SELECT CASE WHEN user_low=? THEN user_high ELSE user_low END AS uid FROM friendships WHERE user_low=? OR user_high=?`,
    )
    .bind(owner, owner, owner)
    .all<{ uid: string }>();
  const friends = new Set(result.results.map((r) => r.uid));
  if (unique.some((id) => !friends.has(id)))
    throw new HttpError(400, 'MEMBER_NOT_FRIEND', 'Every invited member must be a current friend');
}
export async function serializePlan(db: D1Database, row: PlanRow, date: string): Promise<Plan> {
  const progress = await db
    .prepare(
      `SELECT u.uid,u.display_name,c.completed,c.contribution,c.updated_at,r.status AS rsvp FROM plan_members m JOIN users u ON u.uid=m.user_id LEFT JOIN checkins c ON c.plan_id=m.plan_id AND c.user_id=m.user_id AND c.occurrence_date=? LEFT JOIN rsvps r ON r.plan_id=m.plan_id AND r.user_id=m.user_id AND r.occurrence_date=? WHERE m.plan_id=? ORDER BY CASE WHEN m.user_id=? THEN 0 ELSE 1 END,u.display_name`,
    )
    .bind(date, date, row.id, row.owner_id)
    .all<{
      uid: string;
      display_name: string;
      completed: number | null;
      contribution: number | null;
      updated_at: string | null;
      rsvp: 'pending' | 'accepted' | 'declined' | null;
    }>();
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    cadence: row.cadence,
    startDate: row.start_date,
    time: row.time,
    timeZone: row.time_zone,
    memberIds: progress.results.map((m) => m.uid),
    place: row.place_json ? JSON.parse(row.place_json) : null,
    targetAmount: row.target_amount,
    remindMinutes: row.remind_minutes,
    minAttendees: row.min_attendees,
    version: row.version,
    date,
    members: progress.results.map((m) => ({
      uid: m.uid,
      displayName: m.display_name,
      completed: Boolean(m.completed),
      contribution: m.contribution ?? 0,
      rsvp: m.rsvp ?? 'pending',
      updatedAt: m.updated_at,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export async function serializePlans(
  db: D1Database,
  rows: PlanRow[],
  date: string,
): Promise<Plan[]> {
  const result: Plan[] = [];
  for (let offset = 0; offset < rows.length; offset += 80) {
    const chunk = rows.slice(offset, offset + 80);
    const members = await db
      .prepare(
        `SELECT m.plan_id,u.uid,u.display_name,c.completed,c.contribution,c.updated_at,r.status AS rsvp FROM plan_members m JOIN users u ON u.uid=m.user_id LEFT JOIN checkins c ON c.plan_id=m.plan_id AND c.user_id=m.user_id AND c.occurrence_date=? LEFT JOIN rsvps r ON r.plan_id=m.plan_id AND r.user_id=m.user_id AND r.occurrence_date=? WHERE m.plan_id IN(${chunk.map(() => '?').join(',')}) ORDER BY u.display_name`,
      )
      .bind(date, date, ...chunk.map((p) => p.id))
      .all<{
        plan_id: string;
        uid: string;
        display_name: string;
        completed: number | null;
        contribution: number | null;
        updated_at: string | null;
        rsvp: 'accepted' | 'declined' | null;
      }>();
    for (const row of chunk) {
      const progress = members.results
        .filter((m) => m.plan_id === row.id)
        .sort((a, b) => Number(b.uid === row.owner_id) - Number(a.uid === row.owner_id));
      result.push({
        ...rowInput(
          row,
          progress.map((m) => m.uid),
        ),
        id: row.id,
        ownerId: row.owner_id,
        version: row.version,
        date,
        members: progress.map((m) => ({
          uid: m.uid,
          displayName: m.display_name,
          completed: Boolean(m.completed),
          contribution: m.contribution ?? 0,
          rsvp: m.rsvp ?? 'pending',
          updatedAt: m.updated_at,
        })),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  }
  return result;
}
export function rowInput(row: PlanRow, memberIds: string[]): PlanInput {
  return {
    title: row.title,
    description: row.description,
    kind: row.kind,
    cadence: row.cadence,
    startDate: row.start_date,
    time: row.time,
    timeZone: row.time_zone,
    memberIds,
    place: row.place_json ? JSON.parse(row.place_json) : null,
    targetAmount: row.target_amount,
    remindMinutes: row.remind_minutes,
    minAttendees: row.min_attendees,
  };
}
export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
