import { z } from 'zod';
import type { MeetingCoordination, MeetingTravelStatus } from '../../shared/meetingCoordination';
import { HttpError } from '../types';
import { dateSchema, idSchema, timeSchema } from './schemas';
import { addDays, localParts, nextReminder, occurs } from './dates';
import { memberPlan, ownerPlan, serializePlan, sha256, type PlanRow } from './repository';
import { nextMeetingDate, requireMeeting } from './meetings';

const version = z.number().int().positive();
const occurrenceFields = { date: dateSchema, version };
export const timeOptionsSchema = z
  .object({
    version,
    options: z
      .array(z.object({ id: idSchema, date: dateSchema, time: timeSchema }).strict())
      .min(2)
      .max(6)
      .refine(
        (a) =>
          new Set(a.map((o) => o.id)).size === a.length &&
          new Set(a.map((o) => `${o.date}T${o.time}`)).size === a.length,
      ),
  })
  .strict();
export const timeVotesSchema = z
  .object({
    version,
    optionIds: z
      .array(idSchema)
      .max(6)
      .refine((a) => new Set(a).size === a.length),
  })
  .strict();
export const travelSchema = z
  .object({
    ...occurrenceFields,
    status: z.enum(['on_way', 'late', 'arrived']),
    lateMinutes: z.number().int().min(1).max(240).optional(),
  })
  .strict()
  .refine((p) => (p.status === 'late' ? p.lateMinutes !== undefined : p.lateMinutes === undefined));
export const itemCreateSchema = z
  .object({ ...occurrenceFields, operationId: idSchema, title: z.string().trim().min(1).max(80) })
  .strict();
export const itemEditSchema = z
  .object({ ...occurrenceFields, title: z.string().trim().min(1).max(80) })
  .strict();
export const itemClaimSchema = z.object({ ...occurrenceFields, claimed: z.boolean() }).strict();
export const itemDeleteSchema = z.object(occurrenceFields).strict();
export const expenseSchema = z
  .object({
    date: dateSchema,
    version: z.number().int().min(0),
    total: z.number().int().min(0).max(1000000000),
  })
  .strict();
export const paidSchema = z.object({ date: dateSchema, version, paid: z.boolean() }).strict();

function conflict(): never {
  throw new HttpError(409, 'VERSION_CONFLICT', 'The meeting has changed; refresh it');
}
export async function occurrencePlan(
  db: D1Database,
  id: string,
  uid: string,
  date: string,
  write = false,
): Promise<PlanRow> {
  const plan = await memberPlan(db, id, uid);
  requireMeeting(plan);
  if (!occurs(plan.start_date, plan.cadence, date))
    throw new HttpError(400, 'INVALID_OCCURRENCE', 'The meeting does not occur on this date');
  const today = localParts(new Date(), plan.time_zone).date;
  if (write && (date < addDays(today, -1) || date > addDays(today, 366)))
    throw new HttpError(400, 'OCCURRENCE_WINDOW', 'Choose a current or upcoming occurrence');
  return plan;
}
const actorGuard = `EXISTS(SELECT 1 FROM plans p JOIN plan_members m ON m.plan_id=p.id WHERE p.id=? AND m.user_id=? AND p.kind='event' AND p.version=?)`;

/** All private rows share one D1 snapshot and repeat the viewer membership predicate. */
export async function coordination(
  db: D1Database,
  id: string,
  uid: string,
  date: string,
): Promise<MeetingCoordination> {
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT p.* FROM plans p JOIN plan_members v ON v.plan_id=p.id AND v.user_id=? WHERE p.id=?',
      )
      .bind(uid, id),
    db
      .prepare(
        'SELECT t.*,v.user_id FROM meeting_times t LEFT JOIN meeting_time_votes v ON v.plan_id=t.plan_id AND v.option_id=t.id WHERE t.plan_id=? AND EXISTS(SELECT 1 FROM plan_members WHERE plan_id=t.plan_id AND user_id=?) ORDER BY t.date,t.time,t.id,v.user_id',
      )
      .bind(id, uid),
    db
      .prepare(
        'SELECT t.* FROM meeting_travel t WHERE t.plan_id=? AND t.occurrence_date=? AND EXISTS(SELECT 1 FROM plan_members WHERE plan_id=t.plan_id AND user_id=?) ORDER BY t.user_id LIMIT 21',
      )
      .bind(id, date, uid),
    db
      .prepare(
        'SELECT i.* FROM meeting_items i WHERE i.plan_id=? AND i.occurrence_date=? AND EXISTS(SELECT 1 FROM plan_members WHERE plan_id=i.plan_id AND user_id=?) ORDER BY i.id LIMIT 30',
      )
      .bind(id, date, uid),
    db
      .prepare(
        `SELECT u.uid,u.display_name,r.status,e.total,e.version,ep.paid,ep.expense_version FROM plan_members m JOIN users u ON u.uid=m.user_id LEFT JOIN rsvps r ON r.plan_id=m.plan_id AND r.user_id=m.user_id AND r.occurrence_date=? LEFT JOIN meeting_expenses e ON e.plan_id=m.plan_id AND e.occurrence_date=? LEFT JOIN meeting_expense_paid ep ON ep.plan_id=m.plan_id AND ep.occurrence_date=? AND ep.user_id=m.user_id WHERE m.plan_id=? AND EXISTS(SELECT 1 FROM plan_members WHERE plan_id=m.plan_id AND user_id=?) ORDER BY u.uid LIMIT 21`,
      )
      .bind(date, date, date, id, uid),
  ]);
  const plan = results[0].results[0] as unknown as PlanRow | undefined;
  if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  requireMeeting(plan);
  if (!occurs(plan.start_date, plan.cadence, date))
    throw new HttpError(400, 'INVALID_OCCURRENCE', 'The meeting does not occur on this date');
  const options = new Map<string, MeetingCoordination['timeOptions']['options'][number]>();
  for (const row of results[1].results) {
    const id = String(row.id);
    let o = options.get(id);
    if (!o) {
      o = { id, date: String(row.date), time: String(row.time), availableUserIds: [] };
      options.set(id, o);
    }
    if (row.user_id) o.availableUserIds.push(String(row.user_id));
  }
  const accepted = results[4].results.filter((row) => row.status === 'accepted'),
    total = Number(results[4].results[0]?.total ?? 0),
    expenseVersion = Number(results[4].results[0]?.version ?? 0);
  return {
    planVersion: plan.version,
    date,
    minAttendees: plan.min_attendees,
    acceptedCount: accepted.length,
    confirmed: accepted.length >= plan.min_attendees,
    timeOptions: { scope: 'series', options: [...options.values()] },
    travel: results[2].results.map((row) => ({
      uid: String(row.user_id),
      status: row.status as MeetingTravelStatus,
      lateMinutes: row.late_minutes === null ? null : Number(row.late_minutes),
      updatedAt: String(row.updated_at),
    })),
    items: results[3].results.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      createdBy: String(row.created_by),
      claimedBy: row.claimed_by ? String(row.claimed_by) : null,
      version: Number(row.version),
    })),
    expense: {
      version: expenseVersion,
      total,
      shares: accepted.map((row, index) => ({
        uid: String(row.uid),
        displayName: String(row.display_name),
        amount: Math.floor(total / accepted.length) + (index < total % accepted.length ? 1 : 0),
        paid: !!row.paid && row.expense_version === expenseVersion,
      })),
    },
  };
}

export async function replaceTimeOptions(
  db: D1Database,
  id: string,
  uid: string,
  input: z.infer<typeof timeOptionsSchema>,
) {
  const plan = await ownerPlan(db, id, uid);
  requireMeeting(plan);
  if (plan.version !== input.version) conflict();
  const marker = crypto.randomUUID(),
    stamp = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        "UPDATE plans SET version=version+1,mutation_id=?,updated_at=? WHERE id=? AND owner_id=? AND kind='event' AND version=?",
      )
      .bind(marker, stamp, id, uid, input.version),
    db
      .prepare(
        'DELETE FROM meeting_times WHERE plan_id=? AND EXISTS(SELECT 1 FROM plans WHERE id=? AND mutation_id=?)',
      )
      .bind(id, id, marker),
    db
      .prepare(
        `INSERT INTO meeting_times(id,plan_id,date,time) SELECT json_extract(j.value,'$.id'),p.id,json_extract(j.value,'$.date'),json_extract(j.value,'$.time') FROM plans p,json_each(?) j WHERE p.id=? AND p.mutation_id=?`,
      )
      .bind(JSON.stringify(input.options), id, marker),
  ]);
  if (!results[0].meta.changes) conflict();
}
export async function voteTimes(
  db: D1Database,
  id: string,
  uid: string,
  input: z.infer<typeof timeVotesSchema>,
) {
  requireMeeting(await memberPlan(db, id, uid));
  const marker = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE plans SET mutation_id=? WHERE id=? AND version=? AND kind='event' AND EXISTS(SELECT 1 FROM plan_members WHERE plan_id=plans.id AND user_id=?) AND (SELECT count(*) FROM meeting_times WHERE plan_id=plans.id AND id IN(SELECT value FROM json_each(?)))=?`,
      )
      .bind(
        marker,
        id,
        input.version,
        uid,
        JSON.stringify(input.optionIds),
        input.optionIds.length,
      ),
    db
      .prepare(
        'DELETE FROM meeting_time_votes WHERE plan_id=? AND user_id=? AND EXISTS(SELECT 1 FROM plans WHERE id=? AND mutation_id=?)',
      )
      .bind(id, uid, id, marker),
    db
      .prepare(
        'INSERT INTO meeting_time_votes(plan_id,user_id,option_id) SELECT p.id,?,j.value FROM plans p,json_each(?) j WHERE p.id=? AND p.mutation_id=?',
      )
      .bind(uid, JSON.stringify(input.optionIds), id, marker),
  ]);
  if (!results[0].meta.changes) conflict();
}
export async function confirmTime(
  db: D1Database,
  id: string,
  uid: string,
  input: { version: number; optionId: string },
) {
  const old = await ownerPlan(db, id, uid);
  requireMeeting(old);
  if (old.version !== input.version) conflict();
  const option = await db
    .prepare('SELECT date,time FROM meeting_times WHERE plan_id=? AND id=?')
    .bind(id, input.optionId)
    .first<{ date: string; time: string }>();
  if (!option) throw new HttpError(404, 'TIME_NOT_FOUND', 'Choose a current time option');
  const now = new Date(),
    today = localParts(now, old.time_zone).date,
    marker = crypto.randomUUID(),
    changed = option.date !== old.start_date || option.time !== old.time;
  const due = nextReminder({ ...old, start_date: option.date, time: option.time }, now);
  const results = await db.batch([
    db
      .prepare(
        "UPDATE plans SET start_date=?,time=?,version=version+1,mutation_id=?,updated_at=?,next_reminder_at=?,next_reminder_date=? WHERE id=? AND owner_id=? AND version=? AND kind='event' AND EXISTS(SELECT 1 FROM meeting_times WHERE plan_id=? AND id=? AND date=? AND time=?)",
      )
      .bind(
        option.date,
        option.time,
        marker,
        now.toISOString(),
        due?.at ?? null,
        due?.date ?? null,
        id,
        uid,
        input.version,
        id,
        input.optionId,
        option.date,
        option.time,
      ),
    db
      .prepare(
        'DELETE FROM rsvps WHERE plan_id=? AND occurrence_date>=? AND ?=1 AND EXISTS(SELECT 1 FROM plans WHERE id=? AND mutation_id=?)',
      )
      .bind(id, today, changed ? 1 : 0, id, marker),
  ]);
  if (!results[0].meta.changes) conflict();
  const current = await memberPlan(db, id, uid);
  return serializePlan(db, current, nextMeetingDate(current, today) ?? current.start_date);
}
export async function updateTravel(
  db: D1Database,
  id: string,
  uid: string,
  input: z.infer<typeof travelSchema>,
) {
  const p = await occurrencePlan(db, id, uid, input.date, true);
  if (p.version !== input.version) conflict();
  if (input.date !== localParts(new Date(), p.time_zone).date)
    throw new HttpError(400, 'TRAVEL_TODAY_ONLY', 'Travel status is available on the meeting day');
  const result = await db
    .prepare(
      `INSERT INTO meeting_travel(plan_id,user_id,occurrence_date,status,late_minutes,updated_at) SELECT ?,?,?,?,?,? WHERE ${actorGuard} AND EXISTS(SELECT 1 FROM rsvps WHERE plan_id=? AND user_id=? AND occurrence_date=? AND status='accepted') ON CONFLICT(plan_id,user_id,occurrence_date) DO UPDATE SET status=excluded.status,late_minutes=excluded.late_minutes,updated_at=excluded.updated_at`,
    )
    .bind(
      id,
      uid,
      input.date,
      input.status,
      input.lateMinutes ?? null,
      new Date().toISOString(),
      id,
      uid,
      input.version,
      id,
      uid,
      input.date,
    )
    .run();
  if (!result.meta.changes) {
    const latest = await memberPlan(db, id, uid);
    if (latest.version !== input.version) conflict();
    throw new HttpError(409, 'ACCEPTED_REQUIRED', 'Accept the meeting first');
  }
}

export async function createItem(
  db: D1Database,
  id: string,
  uid: string,
  input: z.infer<typeof itemCreateSchema>,
) {
  const p = await occurrencePlan(db, id, uid, input.date, true);
  if (p.version !== input.version) conflict();
  const fingerprint = await sha256(JSON.stringify({ id, date: input.date, title: input.title }));
  const prior = await db
    .prepare('SELECT fingerprint FROM meeting_item_operations WHERE user_id=? AND operation_id=?')
    .bind(uid, input.operationId)
    .first<{ fingerprint: string }>();
  if (prior && prior.fingerprint !== fingerprint)
    throw new HttpError(409, 'OPERATION_CONFLICT', 'Operation id was reused');
  if (!prior)
    await db.batch([
      db
        .prepare(
          `INSERT INTO meeting_item_operations(user_id,operation_id,fingerprint) SELECT ?,?,? WHERE ${actorGuard} ON CONFLICT(user_id,operation_id) DO NOTHING`,
        )
        .bind(uid, input.operationId, fingerprint, id, uid, input.version),
      db
        .prepare(
          `INSERT INTO meeting_items(id,plan_id,occurrence_date,created_by,title) SELECT ?,?,?,?,? WHERE changes()=1 AND ${actorGuard} ON CONFLICT(id) DO NOTHING`,
        )
        .bind(input.operationId, id, input.date, uid, input.title, id, uid, input.version),
    ]);
  const row = await db
    .prepare(
      'SELECT i.* FROM meeting_items i JOIN plan_members m ON m.plan_id=i.plan_id AND m.user_id=? WHERE i.id=?',
    )
    .bind(uid, input.operationId)
    .first<{ plan_id: string; occurrence_date: string; created_by: string; title: string }>();
  if (!row) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Item is no longer available');
  const receipt = await db
    .prepare('SELECT fingerprint FROM meeting_item_operations WHERE user_id=? AND operation_id=?')
    .bind(uid, input.operationId)
    .first<{ fingerprint: string }>();
  if (
    receipt?.fingerprint !== fingerprint ||
    row.plan_id !== id ||
    row.occurrence_date !== input.date ||
    row.created_by !== uid
  )
    throw new HttpError(409, 'OPERATION_CONFLICT', 'Operation id was reused');
}

export async function mutateItem(
  db: D1Database,
  id: string,
  itemId: string,
  uid: string,
  input: { date: string; version: number; title?: string; claimed?: boolean },
  action: 'edit' | 'delete' | 'claim',
) {
  dateSchema.parse(input.date);
  const p =
    action === 'delete'
      ? await memberPlan(db, id, uid)
      : await occurrencePlan(db, id, uid, input.date, true);
  requireMeeting(p);
  const row = await db
    .prepare('SELECT * FROM meeting_items WHERE id=? AND plan_id=? AND occurrence_date=?')
    .bind(itemId, id, input.date)
    .first<{ created_by: string; claimed_by: string | null; version: number }>();
  if (!row) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Item not found');
  if (row.version !== input.version) conflict();
  if (action !== 'claim' && p.owner_id !== uid && row.created_by !== uid)
    throw new HttpError(
      403,
      'ITEM_OWNER_REQUIRED',
      'Only the item creator or organizer can edit it',
    );
  if (action === 'claim' && row.claimed_by !== null && row.claimed_by !== uid)
    throw new HttpError(409, 'ITEM_CLAIMED', 'Another member has claimed this item');
  const common = `id=? AND plan_id=? AND occurrence_date=? AND version=? AND ${actorGuard}`;
  const binds = [itemId, id, input.date, input.version, id, uid, p.version];
  let result;
  if (action === 'delete')
    result = await db
      .prepare(
        `DELETE FROM meeting_items WHERE ${common} AND (created_by=? OR EXISTS(SELECT 1 FROM plans WHERE id=? AND owner_id=?))`,
      )
      .bind(...binds, uid, id, uid)
      .run();
  else if (action === 'edit')
    result = await db
      .prepare(
        `UPDATE meeting_items SET claimed_by=CASE WHEN title<>? THEN NULL ELSE claimed_by END,title=?,version=version+1 WHERE ${common} AND (created_by=? OR EXISTS(SELECT 1 FROM plans WHERE id=? AND owner_id=?))`,
      )
      .bind(input.title!, input.title!, ...binds, uid, id, uid)
      .run();
  else
    result = await db
      .prepare(
        `UPDATE meeting_items SET claimed_by=?,version=version+1 WHERE ${common} AND (claimed_by IS NULL OR claimed_by=?)`,
      )
      .bind(input.claimed ? uid : null, ...binds, uid)
      .run();
  if (!result.meta.changes) conflict();
}

export async function updateExpense(
  db: D1Database,
  id: string,
  uid: string,
  input: z.infer<typeof expenseSchema>,
) {
  dateSchema.parse(input.date);
  // Existing records remain clearable after an organizer changes the series anchor.
  // The SQL below still requires the exact stored occurrence and expense version.
  const clearingExisting = input.total === 0 && input.version > 0;
  const p = clearingExisting
    ? await memberPlan(db, id, uid)
    : await occurrencePlan(db, id, uid, input.date, true);
  requireMeeting(p);
  if (p.owner_id !== uid)
    throw new HttpError(403, 'OWNER_REQUIRED', 'Only the organizer can set the total');
  const result = await db
    .prepare(
      `INSERT INTO meeting_expenses(plan_id,occurrence_date,total,version) SELECT ?,?,?,1 WHERE ${actorGuard} AND EXISTS(SELECT 1 FROM plans WHERE id=? AND owner_id=?) AND (?=0 OR EXISTS(SELECT 1 FROM meeting_expenses WHERE plan_id=? AND occurrence_date=? AND version=?)) ON CONFLICT(plan_id,occurrence_date) DO UPDATE SET total=excluded.total,version=meeting_expenses.version+1 WHERE meeting_expenses.version=?`,
    )
    .bind(
      id,
      input.date,
      input.total,
      id,
      uid,
      p.version,
      id,
      uid,
      input.version,
      id,
      input.date,
      input.version,
      input.version,
    )
    .run();
  if (!result.meta.changes) conflict();
}
export async function updatePaid(
  db: D1Database,
  id: string,
  uid: string,
  input: z.infer<typeof paidSchema>,
) {
  const p = await occurrencePlan(db, id, uid, input.date, true);
  const result = await db
    .prepare(
      `INSERT INTO meeting_expense_paid(plan_id,occurrence_date,user_id,expense_version,paid) SELECT ?,?,?,?,? WHERE ${actorGuard} AND EXISTS(SELECT 1 FROM meeting_expenses WHERE plan_id=? AND occurrence_date=? AND version=? AND total>0) AND EXISTS(SELECT 1 FROM rsvps WHERE plan_id=? AND occurrence_date=? AND user_id=? AND status='accepted') ON CONFLICT(plan_id,occurrence_date,user_id) DO UPDATE SET expense_version=excluded.expense_version,paid=excluded.paid`,
    )
    .bind(
      id,
      input.date,
      uid,
      input.version,
      input.paid ? 1 : 0,
      id,
      uid,
      p.version,
      id,
      input.date,
      input.version,
      id,
      input.date,
      uid,
    )
    .run();
  if (!result.meta.changes) conflict();
}
