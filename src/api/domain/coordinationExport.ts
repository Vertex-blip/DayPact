import { z } from 'zod';
import { HttpError } from '../types';

const kinds = z.enum([
  'attendance',
  'expense',
  'item',
  'paid',
  'time-option',
  'time-vote',
  'travel',
]);
const querySchema = z
  .object({
    cursor: z
      .string()
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(1000),
  })
  .strict();
/** Cursor paging keeps long-running recurring meetings exportable without unbounded responses. */
export async function coordinationExport(db: D1Database, uid: string, raw: Record<string, string>) {
  const query = querySchema.parse(raw);
  let cursor: [string, string] | undefined;
  if (query.cursor)
    try {
      cursor = z
        .tuple([kinds, z.string().min(1).max(200)])
        .parse(JSON.parse(atob(query.cursor.replace(/-/g, '+').replace(/_/g, '/'))));
    } catch {
      throw new HttpError(400, 'INVALID_CURSOR', 'Invalid export cursor');
    }
  const queries: Record<z.infer<typeof kinds>, string> = {
    attendance:
      "SELECT plan_id||':'||occurrence_date AS key,json_object('planId',plan_id,'date',occurrence_date,'status',status,'updatedAt',updated_at) AS data FROM rsvps WHERE user_id=?",
    travel:
      "SELECT plan_id||':'||occurrence_date AS key,json_object('planId',plan_id,'date',occurrence_date,'status',status,'lateMinutes',late_minutes,'updatedAt',updated_at) AS data FROM meeting_travel WHERE user_id=?",
    item: "SELECT id AS key,json_object('id',id,'planId',plan_id,'date',occurrence_date,'title',title,'createdBy',created_by,'claimedBy',claimed_by,'version',version) AS data FROM meeting_items WHERE created_by=? OR claimed_by=?",
    'time-vote':
      "SELECT plan_id||':'||option_id AS key,json_object('planId',plan_id,'optionId',option_id) AS data FROM meeting_time_votes WHERE user_id=?",
    'time-option':
      "SELECT t.id AS key,json_object('id',t.id,'planId',t.plan_id,'date',t.date,'time',t.time) AS data FROM meeting_times t JOIN plans p ON p.id=t.plan_id WHERE p.owner_id=?",
    expense:
      "SELECT e.plan_id||':'||e.occurrence_date AS key,json_object('planId',e.plan_id,'date',e.occurrence_date,'total',e.total,'version',e.version) AS data FROM meeting_expenses e JOIN plans p ON p.id=e.plan_id WHERE p.owner_id=?",
    paid: "SELECT plan_id||':'||occurrence_date AS key,json_object('planId',plan_id,'date',occurrence_date,'version',expense_version,'paid',paid) AS data FROM meeting_expense_paid WHERE user_id=?",
  };
  const rows: { kind: string; key: string; data: string }[] = [];
  // Seven fixed categories; read at most pageSize+1 rows in total, not per category.
  for (const kind of kinds.options) {
    if (cursor && kind < cursor[0]) continue;
    const batch = await db
      .prepare(`SELECT key,data FROM (${queries[kind]}) WHERE key>? ORDER BY key LIMIT ?`)
      .bind(
        uid,
        ...(kind === 'item' ? [uid] : []),
        cursor && kind === cursor[0] ? cursor[1] : '',
        query.limit + 1 - rows.length,
      )
      .all<{ key: string; data: string }>();
    rows.push(...batch.results.map((row) => ({ ...row, kind })));
    if (rows.length > query.limit) break;
  }
  const records = rows.slice(0, query.limit),
    last = records.at(-1);
  return {
    records: records.map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> })),
    nextCursor:
      rows.length > query.limit && last
        ? btoa(JSON.stringify([last.kind, last.key]))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '')
        : null,
  };
}
