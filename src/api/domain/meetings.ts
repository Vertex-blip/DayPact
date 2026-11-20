import type { MeetingPlaceOption, MeetingPlaces, Place, Plan } from '../../shared/contracts';
import { HttpError } from '../types';
import { addDays, localParts, occurs } from './dates';
import { memberPlan, ownerPlan, rowInput, serializePlan, sha256, type PlanRow } from './repository';

export function requireMeeting(plan: Pick<PlanRow, 'kind' | 'cadence'>): void {
  if (plan.kind !== 'event')
    throw new HttpError(400, 'MEETING_REQUIRED', 'Coordination is available for meetings');
}

export function samePlace(serialized: string | null, place: Place | null | undefined): boolean {
  const previous = serialized ? (JSON.parse(serialized) as Place) : null;
  return previous === null
    ? !place
    : !!place &&
        previous.lat === place.lat &&
        previous.lng === place.lng &&
        previous.label === place.label;
}

export function nextMeetingDate(
  plan: Pick<PlanRow, 'start_date' | 'cadence'>,
  from: string,
): string | null {
  let date = from > plan.start_date ? from : plan.start_date;
  if (plan.cadence === 'once') return date === plan.start_date ? date : null;
  for (let n = 0; n < 32; n++, date = addDays(date, 1))
    if (occurs(plan.start_date, plan.cadence, date)) return date;
  return null;
}
/** At most 200 member plans are evaluated; one bounded query reads the nearest 50 occurrences. */
export async function upcomingMeetings(db: D1Database, uid: string, from: string): Promise<Plan[]> {
  const candidates = await db
    .prepare(
      "SELECT p.* FROM plans p JOIN plan_members m ON m.plan_id=p.id WHERE m.user_id=? AND p.kind='event' LIMIT 200",
    )
    .bind(uid)
    .all<PlanRow>();
  const upcoming = candidates.results
    .map((p) => ({ id: p.id, date: nextMeetingDate(p, from), time: p.time, version: p.version }))
    .filter((p): p is typeof p & { date: string } => p.date !== null)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
    )
    .slice(0, 50);
  if (!upcoming.length) return [];
  const rows = await db
    .prepare(
      `
    WITH upcoming AS (
      SELECT p.*,json_extract(j.value,'$.date') AS occurrence_date FROM plans p JOIN plan_members viewer ON viewer.plan_id=p.id JOIN json_each(?) j ON json_extract(j.value,'$.id')=p.id
      WHERE viewer.user_id=? AND p.kind='event' AND p.version=json_extract(j.value,'$.version')
    )
    SELECT p.*,u.uid AS member_uid,u.display_name AS member_name,
      c.completed,c.contribution,c.updated_at AS progress_updated,r.status AS rsvp
    FROM upcoming p JOIN plan_members m ON m.plan_id=p.id JOIN users u ON u.uid=m.user_id
    LEFT JOIN checkins c ON c.plan_id=p.id AND c.user_id=m.user_id AND c.occurrence_date=p.occurrence_date
    LEFT JOIN rsvps r ON r.plan_id=p.id AND r.user_id=m.user_id AND r.occurrence_date=p.occurrence_date
    ORDER BY p.occurrence_date,p.time,p.id,CASE WHEN u.uid=p.owner_id THEN 0 ELSE 1 END,u.display_name,u.uid
  `,
    )
    .bind(JSON.stringify(upcoming), uid)
    .all<
      PlanRow & {
        member_uid: string;
        occurrence_date: string;
        member_name: string;
        completed: number | null;
        contribution: number | null;
        progress_updated: string | null;
        rsvp: 'accepted' | 'declined' | null;
      }
    >();
  const plans = new Map<string, Plan>();
  for (const row of rows.results) {
    let plan = plans.get(row.id);
    if (!plan) {
      plan = {
        ...rowInput(row, []),
        id: row.id,
        ownerId: row.owner_id,
        version: row.version,
        date: row.occurrence_date,
        members: [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      plans.set(row.id, plan);
    }
    plan.memberIds.push(row.member_uid);
    plan.members.push({
      uid: row.member_uid,
      displayName: row.member_name,
      completed: !!row.completed,
      contribution: row.contribution ?? 0,
      rsvp: row.rsvp ?? 'pending',
      updatedAt: row.progress_updated,
    });
  }
  return [...plans.values()];
}

/** Keep the viewer membership predicate in the same statement as the private rows. */
export async function meetingPlaces(
  db: D1Database,
  id: string,
  uid: string,
): Promise<MeetingPlaces> {
  const rows = await db
    .prepare(
      `
    SELECT p.version,p.kind,p.cadence,o.id,o.proposed_by,o.place_json,o.created_at,
      u.display_name,v.user_id AS voter_id
    FROM plans p JOIN plan_members viewer ON viewer.plan_id=p.id AND viewer.user_id=?
    LEFT JOIN meeting_places o ON o.plan_id=p.id LEFT JOIN users u ON u.uid=o.proposed_by
    LEFT JOIN meeting_place_votes v ON v.plan_id=o.plan_id AND v.option_id=o.id
    WHERE p.id=? ORDER BY o.created_at,o.id,v.user_id
  `,
    )
    .bind(uid, id)
    .all<{
      version: number;
      kind: PlanRow['kind'];
      cadence: PlanRow['cadence'];
      id: string | null;
      proposed_by: string | null;
      place_json: string | null;
      created_at: string | null;
      display_name: string | null;
      voter_id: string | null;
    }>();
  if (!rows.results.length) throw new HttpError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  requireMeeting(rows.results[0]);
  const options = new Map<string, MeetingPlaceOption>();
  for (const row of rows.results) {
    if (!row.id) continue;
    let option = options.get(row.id);
    if (!option) {
      option = {
        id: row.id,
        planId: id,
        proposedBy: row.proposed_by!,
        proposerName: row.display_name!,
        place: JSON.parse(row.place_json!),
        createdAt: row.created_at!,
        voterIds: [],
      };
      options.set(row.id, option);
    }
    if (row.voter_id) option.voterIds.push(row.voter_id);
  }
  return { planVersion: rows.results[0].version, options: [...options.values()] };
}

export async function proposeMeetingPlace(
  db: D1Database,
  id: string,
  uid: string,
  input: { operationId: string; place: Place },
): Promise<{ created: boolean; places: MeetingPlaces }> {
  requireMeeting(await memberPlan(db, id, uid));
  const fingerprint = await sha256(JSON.stringify({ planId: id, place: input.place }));
  const receipt = () =>
    db
      .prepare(
        'SELECT fingerprint FROM meeting_place_operations WHERE user_id=? AND operation_id=?',
      )
      .bind(uid, input.operationId)
      .first<{ fingerprint: string }>();
  const previous = await receipt();
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new HttpError(409, 'OPERATION_CONFLICT', 'Operation id was reused for another change');
    const present = await db
      .prepare('SELECT 1 FROM meeting_places WHERE id=? AND plan_id=? AND proposed_by=?')
      .bind(input.operationId, id, uid)
      .first();
    if (!present)
      throw new HttpError(404, 'PLACE_NOT_FOUND', 'The proposed place is no longer available');
    return { created: false, places: await meetingPlaces(db, id, uid) };
  }
  const stamp = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO meeting_place_operations(user_id,operation_id,plan_id,fingerprint,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM plans p JOIN plan_members m ON m.plan_id=p.id WHERE p.id=? AND m.user_id=? AND p.kind='event')
      ON CONFLICT(user_id,operation_id) DO NOTHING`,
      )
      .bind(uid, input.operationId, id, fingerprint, stamp, id, uid),
    db
      .prepare(
        `
    INSERT INTO meeting_places(id,plan_id,proposed_by,place_json,created_at)
    SELECT ?,p.id,?,?,? FROM plans p JOIN plan_members m ON m.plan_id=p.id AND m.user_id=?
    WHERE p.id=? AND p.kind='event' AND changes()=1
      AND EXISTS(SELECT 1 FROM meeting_place_operations WHERE user_id=? AND operation_id=? AND fingerprint=?)
    ON CONFLICT(id) DO NOTHING
  `,
      )
      .bind(
        input.operationId,
        uid,
        JSON.stringify(input.place),
        stamp,
        uid,
        id,
        uid,
        input.operationId,
        fingerprint,
      ),
  ]);
  const accepted = await receipt();
  if (accepted && accepted.fingerprint !== fingerprint)
    throw new HttpError(409, 'OPERATION_CONFLICT', 'Operation id was reused for another change');
  const saved = await db
    .prepare('SELECT plan_id,proposed_by,place_json FROM meeting_places WHERE id=?')
    .bind(input.operationId)
    .first<{ plan_id: string; proposed_by: string; place_json: string }>();
  if (!saved) {
    requireMeeting(await memberPlan(db, id, uid));
    throw new HttpError(404, 'PLACE_NOT_FOUND', 'The proposed place is no longer available');
  }
  if (
    saved.plan_id !== id ||
    saved.proposed_by !== uid ||
    !samePlace(saved.place_json, input.place)
  )
    throw new HttpError(409, 'OPERATION_CONFLICT', 'Operation id was reused for another change');
  return { created: !!results[1].meta.changes, places: await meetingPlaces(db, id, uid) };
}

export async function voteMeetingPlace(
  db: D1Database,
  id: string,
  uid: string,
  optionId: string | null,
): Promise<void> {
  requireMeeting(await memberPlan(db, id, uid));
  if (optionId === null) {
    await db
      .prepare(
        `DELETE FROM meeting_place_votes WHERE plan_id=? AND user_id=?
      AND EXISTS(SELECT 1 FROM plans p JOIN plan_members m ON m.plan_id=p.id WHERE p.id=? AND m.user_id=? AND p.kind='event')`,
      )
      .bind(id, uid, id, uid)
      .run();
    return;
  }
  const result = await db
    .prepare(
      `
    INSERT INTO meeting_place_votes(plan_id,user_id,option_id,updated_at)
    SELECT p.id,?,?,? FROM plans p JOIN plan_members m ON m.plan_id=p.id AND m.user_id=?
    JOIN meeting_places o ON o.plan_id=p.id AND o.id=?
    WHERE p.id=? AND p.kind='event'
    ON CONFLICT(plan_id,user_id) DO UPDATE SET option_id=excluded.option_id,updated_at=excluded.updated_at
  `,
    )
    .bind(uid, optionId, new Date().toISOString(), uid, optionId, id)
    .run();
  if (!result.meta.changes) {
    requireMeeting(await memberPlan(db, id, uid));
    throw new HttpError(404, 'PLACE_NOT_FOUND', 'Choose a current place in this meeting');
  }
}

export async function confirmMeetingPlace(
  db: D1Database,
  id: string,
  uid: string,
  input: { optionId: string; version: number },
): Promise<Plan> {
  const old = await ownerPlan(db, id, uid);
  requireMeeting(old);
  if (old.version !== input.version)
    throw new HttpError(409, 'VERSION_CONFLICT', 'The meeting has changed; refresh it');
  const option = await db
    .prepare('SELECT place_json FROM meeting_places WHERE plan_id=? AND id=?')
    .bind(id, input.optionId)
    .first<{ place_json: string }>();
  if (!option)
    throw new HttpError(404, 'PLACE_NOT_FOUND', 'Choose a current place in this meeting');
  const mutation = crypto.randomUUID();
  const today = localParts(new Date(), old.time_zone).date;
  const changed = !samePlace(old.place_json, JSON.parse(option.place_json));
  const results = await db.batch([
    db
      .prepare(
        `UPDATE plans SET place_json=(SELECT place_json FROM meeting_places WHERE plan_id=? AND id=?),version=version+1,mutation_id=?,updated_at=?
      WHERE id=? AND owner_id=? AND version=? AND kind='event'
      AND EXISTS(SELECT 1 FROM meeting_places WHERE plan_id=? AND id=?)`,
      )
      .bind(
        id,
        input.optionId,
        mutation,
        new Date().toISOString(),
        id,
        uid,
        input.version,
        id,
        input.optionId,
      ),
    db
      .prepare(
        'DELETE FROM rsvps WHERE plan_id=? AND occurrence_date>=? AND ?=1 AND EXISTS(SELECT 1 FROM plans WHERE id=? AND mutation_id=?)',
      )
      .bind(id, today, changed ? 1 : 0, id, mutation),
  ]);
  if (!results[0].meta.changes) {
    const current = await ownerPlan(db, id, uid);
    if (current.version !== input.version)
      throw new HttpError(409, 'VERSION_CONFLICT', 'The meeting has changed; refresh it');
    throw new HttpError(404, 'PLACE_NOT_FOUND', 'The proposed place is no longer available');
  }
  const current = await memberPlan(db, id, uid);
  return serializePlan(db, current, nextMeetingDate(current, today) ?? current.start_date);
}
