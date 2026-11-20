import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AdminAudit, AdminOverview, AdminSupportTicket } from '../../shared/admin';
import { supportTicket, type SupportRow } from '../domain/support';
import { rateLimit } from '../security';
import { HttpError, type Env, type Identity } from '../types';
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
  adminAccess,
  assertAdminSession,
  confirmTotp,
  lockAdminSession,
  requireOwner,
  setupTotp,
  unlockTotp,
  type AdminSession,
} from './security';
import { audit, managedUsers, mutateManagedUser } from './users';

type Bindings = { Bindings: Env; Variables: { identity: Identity } };
const empty = z.object({}).strict();
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export function createAdminApi() {
  const app = new Hono<Bindings>();
  app.use('/admin/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Authorization, Origin, Cookie');
    if (c.req.path.endsWith('/admin/access') && c.req.method === 'GET') {
      await next();
      return;
    }
    requireOwner(c.env, c.get('identity'));
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (c.req.header('Origin') !== c.env.APP_ORIGIN)
        throw new HttpError(403, 'ORIGIN_DENIED', 'This origin is not allowed.');
      if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json'))
        throw new HttpError(415, 'JSON_REQUIRED', 'Send application/json.');
    }
    if (!c.req.path.includes('/admin/security/'))
      await assertAdminSession(c.env, c.get('identity'), c.req.header('Cookie'));
    await next();
  });
  app.get('/admin/access', async (c) =>
    c.json(await adminAccess(c.env, c.get('identity'), c.req.header('Cookie'))),
  );
  app.post('/admin/security/setup', async (c) => {
    empty.parse(await c.req.json());
    try {
      const result = await setupTotp(c.env, c.get('identity'));
      await audit(c.env, c.get('identity'), 'security.setup', 'success');
      return c.json(result);
    } catch (error) {
      await audit(c.env, c.get('identity'), 'security.setup', 'failure');
      throw error;
    }
  });
  for (const mode of ['confirm', 'unlock'] as const) {
    app.post(`/admin/security/${mode}`, async (c) => {
      const { code } = codeSchema.parse(await c.req.json());
      let session: AdminSession;
      try {
        session = await (mode === 'confirm' ? confirmTotp : unlockTotp)(
          c.env,
          c.get('identity'),
          code,
        );
      } catch (error) {
        await audit(c.env, c.get('identity'), `security.${mode}`, 'failure');
        throw error;
      }
      await audit(c.env, c.get('identity'), `security.${mode}`, 'success');
      setCookie(c, ADMIN_COOKIE, session.token, {
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/api/admin',
        maxAge: ADMIN_SESSION_SECONDS,
      });
      return c.json({ unlocked: true as const, expiresAt: session.expiresAt });
    });
  }
  app.post('/admin/security/lock', async (c) => {
    empty.parse(await c.req.json());
    await lockAdminSession(c.env, c.get('identity'), c.req.header('Cookie'));
    setCookie(c, ADMIN_COOKIE, '', {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/api/admin',
      maxAge: 0,
    });
    await audit(c.env, c.get('identity'), 'security.lock', 'success');
    return c.json({ ok: true });
  });
  app.get('/admin/users', async (c) => {
    const input = z
      .object({
        query: z.string().trim().min(1).max(254).optional(),
        pageToken: z.string().min(1).max(2048).optional(),
      })
      .strict()
      .parse(c.req.query());
    return c.json(await managedUsers(c.env, input.query, input.pageToken));
  });
  app.post('/admin/users/:uid/action', async (c) => {
    const uid = z.string().min(1).max(128).parse(c.req.param('uid'));
    const input = z
      .object({
        action: z.enum(['suspend', 'restore', 'delete']),
        confirmEmail: z.string().trim().email().max(254),
      })
      .strict()
      .parse(await c.req.json());
    await rateLimit(c.env, `admin-actions:${c.get('identity').uid}`, 10, 600);
    try {
      await mutateManagedUser(c.env, c.get('identity'), uid, input.action, input.confirmEmail);
    } catch (error) {
      // Pending actions already record failure together with their persisted retry state.
      if (!(error instanceof HttpError) || error.code !== 'ADMIN_ACTION_PENDING')
        await audit(c.env, c.get('identity'), `user.${input.action}`, 'failure', uid);
      throw error;
    }
    return c.json({ ok: true });
  });
  app.get('/admin/overview', async (c) => {
    const counts = await c.env.DB.prepare(
      `SELECT (SELECT count(*) FROM users) appUsers,(SELECT count(*) FROM users WHERE created_at>=?) newUsers7Days,(SELECT count(*) FROM user_moderation WHERE state='suspended') suspendedUsers,(SELECT count(*) FROM support_tickets WHERE status='open') openTickets,(SELECT count(*) FROM plans) plans`,
    )
      .bind(new Date(Date.now() - 7 * 86400000).toISOString())
      .all<
        Pick<
          AdminOverview,
          'appUsers' | 'newUsers7Days' | 'suspendedUsers' | 'openTickets' | 'plans'
        >
      >();
    const [push, failures] = await Promise.all([
      c.env.DB.prepare('SELECT state,count(*) n FROM notifications GROUP BY state').all<{
        state: keyof AdminOverview['push'];
        n: number;
      }>(),
      c.env.DB.prepare(
        "SELECT id,user_id,kind,state,attempts,created_at FROM notifications WHERE state='failed' ORDER BY created_at DESC LIMIT 30",
      ).all<{
        id: string;
        user_id: string;
        kind: string;
        state: string;
        attempts: number;
        created_at: string;
      }>(),
    ]);
    const pushStates = { pending: 0, delivered: 0, skipped: 0, failed: 0 };
    for (const row of push.results)
      if (Object.hasOwn(pushStates, row.state)) pushStates[row.state] = row.n;
    const result: AdminOverview = {
      ...counts.results[0]!,
      databaseBytes: counts.meta.size_after ?? 0,
      databaseLimitBytes: 500 * 1024 * 1024,
      pushConfigured: !!(c.env.FIREBASE_CLIENT_EMAIL && c.env.FIREBASE_PRIVATE_KEY),
      accountManagementConfigured: !!(
        c.env.ADMIN_FIREBASE_CLIENT_EMAIL && c.env.ADMIN_FIREBASE_PRIVATE_KEY
      ),
      push: pushStates,
      recentPushFailures: failures.results.map((row) => ({
        id: row.id,
        userId: row.user_id,
        kind: row.kind,
        state: row.state,
        attempts: row.attempts,
        createdAt: row.created_at,
      })),
    };
    return c.json(result);
  });
  app.get('/admin/support', async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT t.*,u.email,u.display_name FROM support_tickets t JOIN users u ON u.uid=t.user_id ORDER BY CASE WHEN t.status='open' THEN 0 ELSE 1 END,t.created_at DESC LIMIT 100",
    ).all<SupportRow & { email: string; display_name: string }>();
    return c.json({
      tickets: rows.results.map(
        (row) =>
          ({
            ...supportTicket(row),
            email: row.email,
            displayName: row.display_name,
          }) satisfies AdminSupportTicket,
      ),
    });
  });
  app.patch('/admin/support/:id', async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const input = z
      .object({ status: z.enum(['open', 'closed']), reply: z.string().max(2000) })
      .strict()
      .parse(await c.req.json());
    await rateLimit(c.env, `admin-support:${c.get('identity').uid}`, 30, 600);
    try {
      const now = new Date().toISOString();
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          'UPDATE support_tickets SET status=?,reply=?,updated_at=? WHERE id=?',
        ).bind(input.status, input.reply, now, id),
        c.env.DB.prepare(
          "INSERT INTO admin_audit(id,actor_uid,target_uid,action,outcome,created_at) SELECT ?,?,user_id,'support.update','success',? FROM support_tickets WHERE id=?",
        ).bind(crypto.randomUUID(), c.get('identity').uid, now, id),
      ]);
      if (!result[0].meta.changes)
        throw new HttpError(404, 'SUPPORT_NOT_FOUND', 'Request not found.');
    } catch (error) {
      await audit(c.env, c.get('identity'), 'support.update', 'failure');
      throw error;
    }
    return c.json({ ok: true });
  });
  app.get('/admin/audit', async (c) => {
    const rows = await c.env.DB.prepare(
      'SELECT id,actor_uid,target_uid,action,outcome,created_at FROM admin_audit ORDER BY created_at DESC LIMIT 100',
    ).all<{
      id: string;
      actor_uid: string;
      target_uid: string | null;
      action: string;
      outcome: 'success' | 'failure';
      created_at: string;
    }>();
    return c.json({
      events: rows.results.map(
        (row) =>
          ({
            id: row.id,
            actorUid: row.actor_uid,
            targetUid: row.target_uid,
            action: row.action,
            outcome: row.outcome,
            createdAt: row.created_at,
          }) satisfies AdminAudit,
      ),
    });
  });
  return app;
}
