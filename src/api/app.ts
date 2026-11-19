import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import { authenticate as defaultAuthenticate, deleteFirebaseAccount } from './auth';
import { HttpError, type Authenticator, type Env, type Identity } from './types';
import type { PlanInput } from '../shared/contracts';
import {
  dateSchema,
  profileSchema,
  settingsSchema,
  planSchema,
  planPatchSchema,
  checkinSchema,
  rsvpSchema,
  nudgeSchema,
  invitationSchema,
  pushSchema,
  idSchema,
  emptySchema,
} from './domain/schemas';
import {
  ensureUser,
  getUser,
  profileOf,
  settingsOf,
  memberPlan,
  ownerPlan,
  checkMembers,
  areFriends,
  serializePlan,
  serializePlans,
  rowInput,
  sha256,
  randomToken,
  type UserRow,
  type PlanRow,
} from './domain/repository';
import { occurs, localParts, nextReminder, isQuiet } from './domain/dates';

type Bindings = { Bindings: Env; Variables: { identity: Identity; user: UserRow } };
const ok = { ok: true } as const;
function requireOccurrence(p: PlanRow, date: string): void {
  if (!occurs(p.start_date, p.cadence, date))
    throw new HttpError(400, 'INVALID_OCCURRENCE', 'The plan does not occur on this date');
}
function ownsIdentity(c: { get: (key: 'identity') => Identity }): string {
  return c.get('identity').uid;
}
function friendView(u: UserRow) {
  return { uid: u.uid, displayName: u.display_name, username: u.username ?? '', city: u.city };
}
function errorResponse(status: number, code: string, message: string, requestId: string) {
  return new Response(JSON.stringify({ error: { code, message, requestId } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Dependencies can be injected by unit tests, never by an HTTP parameter or environment bypass. */
export function createApi(verify: Authenticator = defaultAuthenticate) {
  const app = new Hono<Bindings>().basePath('/api');
  app.use(
    '*',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: () =>
        errorResponse(413, 'BODY_TOO_LARGE', 'Request is too large', crypto.randomUUID()),
    }),
  );
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.path === '/api/health') {
      await next();
      return;
    }
    const identity = await verify(c.req.raw, c.env);
    c.set('identity', identity);
    // A tombstoned account may finish deletion but must never recreate its profile.
    if (!(c.req.method === 'DELETE' && c.req.path === '/api/me'))
      c.set('user', await ensureUser(c.env, identity));
    if (
      ['POST', 'PUT', 'PATCH'].includes(c.req.method) &&
      !c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')
    )
      throw new HttpError(415, 'JSON_REQUIRED', 'Send application/json');
    await next();
  });
  app.onError((error, c) => {
    const requestId = crypto.randomUUID();
    if (error instanceof HttpError)
      return errorResponse(error.status, error.code, error.message, requestId);
    if (error instanceof ZodError || error instanceof SyntaxError)
      return errorResponse(400, 'INVALID_INPUT', 'Check the submitted fields', requestId);
    const message = String(error.message);
    for (const [needle, code, status] of [
      ['users.username', 'USERNAME_TAKEN', 409],
      ['MEMBER_NOT_FRIEND', 'MEMBER_NOT_FRIEND', 400],
      ['PLAN_LIMIT', 'PLAN_LIMIT', 409],
      ['FRIEND_LIMIT', 'FRIEND_LIMIT', 409],
      ['INVITATION_LIMIT', 'INVITATION_LIMIT', 429],
      ['DEVICE_LIMIT', 'DEVICE_LIMIT', 409],
      ['push_tokens.token', 'TOKEN_CONFLICT', 409],
    ] as const) {
      if (message.includes(needle))
        return errorResponse(status, code, 'The request could not be completed', requestId);
    }
    console.error(
      JSON.stringify({ event: 'api_error', requestId, path: c.req.path, kind: error.name }),
    );
    return errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong; try again', requestId);
  });
  app.notFound(() => errorResponse(404, 'NOT_FOUND', 'Not found', crypto.randomUUID()));
  app.get('/health', (c) => c.json({ ok: true, service: 'daypact' }));
  app.get('/me', (c) => c.json({ profile: profileOf(c.get('user')) }));
  app.put('/me', async (c) => {
    const input = profileSchema.parse(await c.req.json());
    const uid = ownsIdentity(c);
    await c.env.DB.prepare(
      'UPDATE users SET display_name=?,username=?,bio=?,city=?,updated_at=? WHERE uid=?',
    )
      .bind(input.displayName, input.username, input.bio, input.city, new Date().toISOString(), uid)
      .run();
    return c.json({ profile: profileOf(await getUser(c.env.DB, uid)) });
  });
  app.patch('/settings', async (c) => {
    const partial = settingsSchema
      .partial()
      .strict()
      .parse(await c.req.json());
    const settings = settingsSchema.parse({ ...settingsOf(c.get('user')), ...partial });
    await c.env.DB.prepare('UPDATE users SET settings_json=?,updated_at=? WHERE uid=?')
      .bind(JSON.stringify(settings), new Date().toISOString(), ownsIdentity(c))
      .run();
    return c.json({ settings });
  });
  app.get('/friends', async (c) => {
    const uid = ownsIdentity(c);
    const rows = await c.env.DB.prepare(
      `SELECT u.uid,u.display_name,u.username,u.city FROM friendships f JOIN users u ON u.uid=CASE WHEN f.user_low=? THEN f.user_high ELSE f.user_low END WHERE f.user_low=? OR f.user_high=? ORDER BY u.display_name LIMIT 200`,
    )
      .bind(uid, uid, uid)
      .all<UserRow>();
    return c.json({ friends: rows.results.map(friendView) });
  });
  app.post('/friends/invitations', async (c) => {
    emptySchema.parse(await c.req.json());
    const token = randomToken(),
      now = new Date(),
      expiresAt = new Date(now.getTime() + 7 * 86400000).toISOString();
    await c.env.DB.prepare(
      'INSERT INTO invitations(token_hash,inviter_id,expires_at,created_at) VALUES(?,?,?,?)',
    )
      .bind(await sha256(token), ownsIdentity(c), expiresAt, now.toISOString())
      .run();
    return c.json({ token, expiresAt }, 201);
  });
  app.post('/friends/accept', async (c) => {
    const { token } = invitationSchema.parse(await c.req.json());
    const hash = await sha256(token),
      uid = ownsIdentity(c),
      now = new Date().toISOString(),
      requestId = crypto.randomUUID();
    const invitation = await c.env.DB.prepare(
      'SELECT inviter_id,accepted_by,expires_at FROM invitations WHERE token_hash=?',
    )
      .bind(hash)
      .first<{ inviter_id: string; accepted_by: string | null; expires_at: string }>();
    if (!invitation || invitation.accepted_by || invitation.expires_at <= now)
      throw new HttpError(410, 'INVITE_EXPIRED', 'Invitation is expired or already used');
    if (invitation.inviter_id === uid)
      throw new HttpError(400, 'SELF_INVITE', 'You cannot accept your own invitation');
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE invitations SET accepted_by=?,accepted_at=?,accepted_request_id=? WHERE token_hash=? AND accepted_by IS NULL AND expires_at>? AND inviter_id<>?',
      ).bind(uid, now, requestId, hash, now, uid),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO friendships(user_low,user_high,created_at) SELECT min(inviter_id,?),max(inviter_id,?),? FROM invitations WHERE token_hash=? AND accepted_request_id=?`,
      ).bind(uid, uid, now, hash, requestId),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(410, 'INVITE_EXPIRED', 'Invitation is expired or already used');
    return c.json({ friend: friendView(await getUser(c.env.DB, invitation.inviter_id)) });
  });
  app.delete('/friends/:uid', async (c) => {
    const uid = ownsIdentity(c),
      other = z.string().min(1).max(128).parse(c.req.param('uid'));
    await c.env.DB.prepare('DELETE FROM friendships WHERE user_low=min(?,?) AND user_high=max(?,?)')
      .bind(uid, other, uid, other)
      .run();
    return c.json(ok);
  });
  app.get('/plans', async (c) => {
    const date = dateSchema.parse(
      c.req.query('date') ?? localParts(new Date(), settingsOf(c.get('user')).timeZone).date,
    );
    const rows = await c.env.DB.prepare(
      'SELECT p.* FROM plans p JOIN plan_members m ON m.plan_id=p.id WHERE m.user_id=? AND p.start_date<=? ORDER BY p.time,p.created_at LIMIT 200',
    )
      .bind(ownsIdentity(c), date)
      .all<PlanRow>();
    return c.json({
      plans: await serializePlans(
        c.env.DB,
        rows.results.filter((p) => occurs(p.start_date, p.cadence, date)),
        date,
      ),
    });
  });
  app.post('/plans', async (c) => {
    const input = planSchema.parse(await c.req.json()),
      uid = ownsIdentity(c),
      id = crypto.randomUUID(),
      now = new Date(),
      stamp = now.toISOString();
    const key = idSchema.optional().parse(c.req.header('Idempotency-Key'));
    const members = [...new Set([uid, ...input.memberIds])].sort();
    // Hash explicit normalized request fields, not the current profile's default time zone:
    // a retry remains the same operation even if account preferences changed offline.
    const fingerprint = key
      ? await sha256(
          JSON.stringify({
            title: input.title,
            description: input.description ?? '',
            kind: input.kind,
            cadence: input.cadence,
            startDate: input.startDate,
            time: input.time,
            timeZone: input.timeZone ?? null,
            memberIds: members,
            place: input.place ?? null,
            targetAmount: input.kind === 'savings' ? input.targetAmount : null,
            remindMinutes: input.remindMinutes,
          }),
        )
      : '';
    const receipt = () =>
      c.env.DB.prepare(
        'SELECT fingerprint,plan_id FROM plan_create_operations WHERE user_id=? AND operation_id=?',
      )
        .bind(uid, key!)
        .first<{ fingerprint: string; plan_id: string }>();
    if (key) {
      const previous = await receipt();
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            'OPERATION_CONFLICT',
            'Operation id was reused for another change',
          );
        const saved = await memberPlan(c.env.DB, previous.plan_id, uid);
        return c.json({ plan: await serializePlan(c.env.DB, saved, saved.start_date) });
      }
    }
    await checkMembers(c.env.DB, uid, input.memberIds);
    const zone = input.timeZone ?? settingsOf(c.get('user')).timeZone;
    const due = nextReminder(
      {
        start_date: input.startDate,
        cadence: input.cadence,
        time: input.time,
        time_zone: zone,
        remind_minutes: input.remindMinutes,
      },
      now,
    );
    await c.env.DB.batch([
      ...(key
        ? [
            c.env.DB.prepare(
              'INSERT OR IGNORE INTO plan_create_operations(user_id,operation_id,fingerprint,plan_id,created_at) VALUES(?,?,?,?,?)',
            ).bind(uid, key, fingerprint, id, stamp),
          ]
        : []),
      c.env.DB.prepare(
        `INSERT INTO plans(id,owner_id,title,description,kind,cadence,start_date,time,time_zone,place_json,target_amount,remind_minutes,mutation_id,next_reminder_at,next_reminder_date,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM plan_create_operations WHERE user_id=? AND operation_id=? AND plan_id=?)`,
      ).bind(
        id,
        uid,
        input.title,
        input.description ?? '',
        input.kind,
        input.cadence,
        input.startDate,
        input.time,
        zone,
        input.place ? JSON.stringify(input.place) : null,
        input.kind === 'savings' ? (input.targetAmount ?? null) : null,
        input.remindMinutes,
        crypto.randomUUID(),
        due?.at ?? null,
        due?.date ?? null,
        stamp,
        stamp,
        key ?? null,
        uid,
        key ?? '',
        id,
      ),
      c.env.DB.prepare(
        'INSERT INTO plan_members(plan_id,user_id,joined_at) SELECT p.id,j.value,? FROM plans p,json_each(?) j WHERE p.id=? AND p.owner_id=?',
      ).bind(stamp, JSON.stringify(members), id, uid),
    ]);
    const saved = key ? await receipt() : null;
    if (saved && saved.fingerprint !== fingerprint)
      throw new HttpError(409, 'OPERATION_CONFLICT', 'Operation id was reused for another change');
    const result = await memberPlan(c.env.DB, saved?.plan_id ?? id, uid);
    return c.json(
      { plan: await serializePlan(c.env.DB, result, result.start_date) },
      result.id === id ? 201 : 200,
    );
  });
  app.patch('/plans/:id', async (c) => {
    const id = idSchema.parse(c.req.param('id')),
      uid = ownsIdentity(c),
      patch = planPatchSchema.parse(await c.req.json());
    const old = await ownerPlan(c.env.DB, id, uid);
    if (old.version !== patch.version)
      throw new HttpError(409, 'VERSION_CONFLICT', 'The plan has changed; refresh it');
    const existing = await c.env.DB.prepare('SELECT user_id FROM plan_members WHERE plan_id=?')
      .bind(id)
      .all<{ user_id: string }>();
    const { version, ...changes } = patch;
    const input = planSchema.parse({
      ...rowInput(
        old,
        existing.results.map((m) => m.user_id).filter((member) => member !== uid),
      ),
      ...changes,
    });
    await checkMembers(c.env.DB, uid, input.memberIds);
    const members = [...new Set([uid, ...input.memberIds])];
    const now = new Date(),
      stamp = now.toISOString(),
      mutation = crypto.randomUUID();
    const zone = input.timeZone ?? old.time_zone,
      due = nextReminder(
        {
          start_date: input.startDate,
          cadence: input.cadence,
          time: input.time,
          time_zone: zone,
          remind_minutes: input.remindMinutes,
        },
        now,
      );
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE plans SET title=?,description=?,kind=?,cadence=?,start_date=?,time=?,time_zone=?,place_json=?,target_amount=?,remind_minutes=?,version=version+1,mutation_id=?,next_reminder_at=?,next_reminder_date=?,updated_at=? WHERE id=? AND owner_id=? AND version=?`,
      ).bind(
        input.title,
        input.description ?? '',
        input.kind,
        input.cadence,
        input.startDate,
        input.time,
        zone,
        input.place ? JSON.stringify(input.place) : null,
        input.kind === 'savings' ? (input.targetAmount ?? null) : null,
        input.remindMinutes,
        mutation,
        due?.at ?? null,
        due?.date ?? null,
        stamp,
        id,
        uid,
        version,
      ),
      c.env.DB.prepare(
        `DELETE FROM plan_members WHERE plan_id=? AND user_id<>? AND user_id NOT IN(SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM plans WHERE id=? AND mutation_id=?)`,
      ).bind(id, uid, JSON.stringify(members), id, mutation),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO plan_members(plan_id,user_id,joined_at) SELECT p.id,j.value,? FROM plans p,json_each(?) j WHERE p.id=? AND p.mutation_id=?`,
      ).bind(stamp, JSON.stringify(members), id, mutation),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(409, 'VERSION_CONFLICT', 'The plan has changed; refresh it');
    return c.json({
      plan: await serializePlan(c.env.DB, await memberPlan(c.env.DB, id, uid), input.startDate),
    });
  });
  app.delete('/plans/:id', async (c) => {
    const id = idSchema.parse(c.req.param('id')),
      uid = ownsIdentity(c);
    await ownerPlan(c.env.DB, id, uid);
    await c.env.DB.prepare('DELETE FROM plans WHERE id=? AND owner_id=?').bind(id, uid).run();
    return c.json(ok);
  });
  app.post('/plans/:id/checkins', async (c) => {
    const id = idSchema.parse(c.req.param('id')),
      uid = ownsIdentity(c),
      input = checkinSchema.parse(await c.req.json());
    const plan = await memberPlan(c.env.DB, id, uid);
    requireOccurrence(plan, input.date);
    const today = localParts(new Date(), plan.time_zone).date;
    if (input.date > today)
      throw new HttpError(400, 'FUTURE_CHECKIN', 'Future plans cannot be completed yet');
    if (plan.kind !== 'savings' && input.contribution)
      throw new HttpError(400, 'INVALID_CONTRIBUTION', 'Only savings plans accept contributions');
    const amount = input.contribution ?? 0,
      fingerprint = await sha256(
        JSON.stringify({ id, date: input.date, completed: input.completed, amount }),
      );
    const seen = await c.env.DB.prepare(
      'SELECT fingerprint FROM operations WHERE user_id=? AND operation_id=?',
    )
      .bind(uid, input.operationId)
      .first<{ fingerprint: string }>();
    if (seen) {
      if (seen.fingerprint !== fingerprint)
        throw new HttpError(
          409,
          'OPERATION_CONFLICT',
          'Operation id was reused for another change',
        );
      return c.json(ok);
    }
    const stamp = new Date().toISOString();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT OR IGNORE INTO operations(user_id,operation_id,fingerprint,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM plan_members WHERE plan_id=? AND user_id=?)',
      ).bind(uid, input.operationId, fingerprint, stamp, id, uid),
      c.env.DB.prepare(
        `INSERT INTO checkins(plan_id,user_id,occurrence_date,completed,contribution,updated_at)
      SELECT ?,?,?,?,?,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM plan_members WHERE plan_id=? AND user_id=?)
      ON CONFLICT(plan_id,user_id,occurrence_date) DO UPDATE SET completed=excluded.completed,contribution=excluded.contribution,updated_at=excluded.updated_at`,
      ).bind(id, uid, input.date, input.completed ? 1 : 0, amount, stamp, id, uid),
    ]);
    if (!results[0].meta.changes) {
      const duplicate = await c.env.DB.prepare(
        'SELECT fingerprint FROM operations WHERE user_id=? AND operation_id=?',
      )
        .bind(uid, input.operationId)
        .first<{ fingerprint: string }>();
      if (!duplicate) throw new HttpError(404, 'PLAN_NOT_FOUND', 'Plan no longer available');
      if (duplicate.fingerprint !== fingerprint)
        throw new HttpError(409, 'OPERATION_CONFLICT', 'Operation id was reused');
    }
    if (results[0].meta.changes && !results[1].meta.changes)
      throw new HttpError(404, 'PLAN_NOT_FOUND', 'Plan no longer available');
    return c.json(ok);
  });
  app.post('/plans/:id/rsvp', async (c) => {
    const id = idSchema.parse(c.req.param('id')),
      uid = ownsIdentity(c),
      input = rsvpSchema.parse(await c.req.json());
    const plan = await memberPlan(c.env.DB, id, uid);
    requireOccurrence(plan, input.date);
    await c.env.DB.prepare(
      `INSERT INTO rsvps(plan_id,user_id,occurrence_date,status,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(plan_id,user_id,occurrence_date) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at`,
    )
      .bind(id, uid, input.date, input.status, new Date().toISOString())
      .run();
    return c.json(ok);
  });
  app.post('/plans/:id/nudges', async (c) => {
    const id = idSchema.parse(c.req.param('id')),
      from = ownsIdentity(c),
      input = nudgeSchema.parse(await c.req.json());
    const plan = await memberPlan(c.env.DB, id, from);
    requireOccurrence(plan, input.date);
    if (input.toUserId === from || !(await areFriends(c.env.DB, from, input.toUserId)))
      throw new HttpError(403, 'NUDGE_NOT_ALLOWED', 'Choose a current friend in the plan');
    await memberPlan(c.env.DB, id, input.toUserId);
    const recipient = await getUser(c.env.DB, input.toUserId),
      settings = settingsOf(recipient),
      now = new Date(),
      stamp = now.toISOString();
    if (input.date !== localParts(now, plan.time_zone).date)
      throw new HttpError(400, 'NUDGE_TODAY_ONLY', "Only today's plan can be nudged");
    if (!settings.friendNudges)
      throw new HttpError(403, 'NUDGES_DISABLED', 'This friend disabled nudges');
    if (isQuiet(now, settings))
      throw new HttpError(409, 'QUIET_HOURS', 'This friend is in quiet hours');
    const completed = await c.env.DB.prepare(
      'SELECT completed FROM checkins WHERE plan_id=? AND user_id=? AND occurrence_date=?',
    )
      .bind(id, input.toUserId, input.date)
      .first<{ completed: number }>();
    if (completed?.completed)
      throw new HttpError(409, 'ALREADY_COMPLETED', 'This friend already completed the plan');
    const requestId = crypto.randomUUID(),
      cutoff = new Date(now.getTime() - 86400000).toISOString(),
      ru = settings.locale === 'ru';
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO nudges(plan_id,from_user,to_user,occurrence_date,last_sent_at,request_id) VALUES(?,?,?,?,?,?) ON CONFLICT(plan_id,from_user,to_user,occurrence_date) DO UPDATE SET last_sent_at=excluded.last_sent_at,request_id=excluded.request_id WHERE nudges.last_sent_at<=?`,
      ).bind(id, from, input.toUserId, input.date, stamp, requestId, cutoff),
      c.env.DB.prepare(
        `INSERT INTO notifications(id,user_id,plan_id,kind,title,body,created_at,next_attempt_at,dedupe_key) SELECT ?,?,?,'nudge','DayPact',?,?,?,? WHERE EXISTS(SELECT 1 FROM nudges WHERE plan_id=? AND from_user=? AND to_user=? AND occurrence_date=? AND request_id=?)`,
      ).bind(
        crypto.randomUUID(),
        input.toUserId,
        id,
        ru ? 'Друг напоминает об общем плане.' : 'Досың ортақ жоспарды еске салды.',
        stamp,
        stamp,
        `nudge:${requestId}`,
        id,
        from,
        input.toUserId,
        input.date,
        requestId,
      ),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(
        429,
        'NUDGE_COOLDOWN',
        'A reminder was already sent in the last 24 hours',
      );
    return c.json(ok);
  });
  app.get('/notifications', async (c) => {
    const rows = await c.env.DB.prepare(
      'SELECT id,plan_id,kind,title,body,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100',
    )
      .bind(ownsIdentity(c))
      .all<{
        id: string;
        plan_id: string | null;
        kind: 'reminder' | 'nudge';
        title: string;
        body: string;
        read_at: string | null;
        created_at: string;
      }>();
    return c.json({
      notifications: rows.results.map((n) => ({
        id: n.id,
        planId: n.plan_id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        read: Boolean(n.read_at),
        createdAt: n.created_at,
      })),
    });
  });
  app.post('/notifications/read', async (c) => {
    const { ids } = z
      .object({ ids: z.array(z.string().min(1).max(64)).max(100) })
      .strict()
      .parse(await c.req.json());
    if (ids.length)
      await c.env.DB.prepare(
        'UPDATE notifications SET read_at=? WHERE user_id=? AND id IN(SELECT value FROM json_each(?)) AND read_at IS NULL',
      )
        .bind(new Date().toISOString(), ownsIdentity(c), JSON.stringify(ids))
        .run();
    return c.json(ok);
  });
  app.post('/push/tokens', async (c) => {
    const input = pushSchema.parse(await c.req.json()),
      uid = ownsIdentity(c);
    const count = await c.env.DB.prepare(
      'SELECT count(*) AS n FROM push_tokens WHERE user_id=? AND device_id<>?',
    )
      .bind(uid, input.deviceId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 3)
      throw new HttpError(
        409,
        'DEVICE_LIMIT',
        'Up to three devices can receive notifications; remove another device first',
      );
    await c.env.DB.prepare(
      'INSERT INTO push_tokens(user_id,device_id,token,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET token=excluded.token,updated_at=excluded.updated_at',
    )
      .bind(uid, input.deviceId, input.token, new Date().toISOString())
      .run();
    return c.json(ok);
  });
  app.delete('/push/tokens', async (c) => {
    const { deviceId } = z
      .object({ deviceId: idSchema })
      .strict()
      .parse(await c.req.json());
    await c.env.DB.prepare('DELETE FROM push_tokens WHERE user_id=? AND device_id=?')
      .bind(ownsIdentity(c), deviceId)
      .run();
    return c.json(ok);
  });
  app.get('/export', async (c) => {
    const uid = ownsIdentity(c),
      query = z
        .object({
          cursor: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[A-Za-z0-9_-]+$/)
            .optional(),
          limit: z.coerce.number().int().min(1).max(1000).default(1000),
        })
        .strict()
        .parse(c.req.query());
    let cursor: [string, string] | undefined;
    if (query.cursor) {
      try {
        cursor = z
          .tuple([dateSchema, idSchema])
          .parse(JSON.parse(atob(query.cursor.replace(/-/g, '+').replace(/_/g, '/'))));
      } catch {
        throw new HttpError(400, 'INVALID_CURSOR', 'Invalid export cursor');
      }
    }
    const checkins = await c.env.DB.prepare(
      `SELECT plan_id,occurrence_date,completed,contribution,updated_at FROM checkins WHERE user_id=? ${cursor ? 'AND (occurrence_date<? OR (occurrence_date=? AND plan_id>?))' : ''} ORDER BY occurrence_date DESC,plan_id ASC LIMIT ?`,
    )
      .bind(uid, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []), query.limit + 1)
      .all<{
        plan_id: string;
        occurrence_date: string;
        completed: number;
        contribution: number;
        updated_at: string;
      }>();
    const page = checkins.results.slice(0, query.limit),
      last = page.at(-1);
    const nextCursor =
      checkins.results.length > query.limit && last
        ? btoa(JSON.stringify([last.occurrence_date, last.plan_id]))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '')
        : null;
    let header: Record<string, unknown> = {};
    if (!cursor) {
      const [plans, friends] = await c.env.DB.batch([
        c.env.DB.prepare(
          `SELECT p.id,p.owner_id,p.title,p.description,p.kind,p.cadence,p.start_date,p.time,p.time_zone,p.place_json,p.target_amount,p.remind_minutes,p.created_at,p.updated_at FROM plans p JOIN plan_members m ON m.plan_id=p.id WHERE m.user_id=? LIMIT 200`,
        ).bind(uid),
        c.env.DB.prepare(
          'SELECT CASE WHEN user_low=? THEN user_high ELSE user_low END AS uid,created_at FROM friendships WHERE user_low=? OR user_high=? LIMIT 200',
        ).bind(uid, uid, uid),
      ]);
      header = {
        profile: profileOf(c.get('user')),
        plans: plans.results,
        friendships: friends.results,
      };
    }
    c.header('Content-Disposition', 'attachment; filename="daypact-data.json"');
    return c.json({
      exportedAt: new Date().toISOString(),
      ...header,
      checkins: page,
      nextCursor,
      limits: { pageSize: query.limit },
    });
  });
  app.delete('/me', async (c) => {
    const identity = c.get('identity');
    if (Date.now() / 1000 - identity.authTime > 300)
      throw new HttpError(
        401,
        'RECENT_LOGIN_REQUIRED',
        'Please sign in again before deleting your account',
      );
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT OR IGNORE INTO deleted_accounts(uid,deleted_at) VALUES(?,?)').bind(
        identity.uid,
        new Date().toISOString(),
      ),
      c.env.DB.prepare('DELETE FROM users WHERE uid=?').bind(identity.uid),
    ]);
    try {
      await deleteFirebaseAccount(identity, c.env);
    } catch {
      throw new HttpError(
        503,
        'AUTH_DELETE_PENDING',
        'Your data was erased; sign in again to finish removing the sign-in account',
      );
    }
    return c.json(ok);
  });
  return app;
}
