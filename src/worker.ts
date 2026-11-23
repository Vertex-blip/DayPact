import { createApi } from './api/app';
import { authenticate } from './api/auth';
import { deliverNotifications } from './api/notifications';
import { enqueueDueReminders } from './api/domain/reminders';
import { enqueueDueStudyReminders } from './api/study-reminders';
import { applySecurity, digest, enforceOrigin, limitedBody, rateLimit } from './api/security';
import { HttpError, type Env } from './api/types';

const api = createApi(async (request, env) => {
  const identity = await authenticate(request, env);
  await rateLimit(env, `uid:${identity.uid}`, 90);
  return identity;
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return applySecurity(await env.ASSETS.fetch(request));
    const requestId = crypto.randomUUID();
    try {
      if (url.pathname !== '/api/health') {
        enforceOrigin(request, env);
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
        // Hash the edge-provided address; never trust a client X-Forwarded-For header.
        await rateLimit(env, `ip:${await digest(ip)}`, 180);
      }
      if (request.method === 'OPTIONS')
        return applySecurity(new Response(null, { status: 204 }), true);
      const limited = await limitedBody(
        request,
        url.pathname === '/api/study' && request.method === 'PUT' ? 64 * 1024 : 16384,
      );
      const result = await api.fetch(limited, env, ctx);
      const response = applySecurity(result, true);
      response.headers.set('X-Request-ID', requestId);
      if (response.status === 429) response.headers.set('Retry-After', '60');
      return response;
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known)
        console.error(
          JSON.stringify({
            event: 'request_failed',
            requestId,
            type: error instanceof Error ? error.name : 'unknown',
          }),
        );
      const response = Response.json(
        {
          error: {
            code: known ? error.code : 'INTERNAL_ERROR',
            message: known ? error.message : 'Request failed. Please try again.',
            requestId,
          },
        },
        { status: known ? error.status : 500 },
      );
      if (known && error.status === 429) response.headers.set('Retry-After', '60');
      return applySecurity(response, true);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const now = new Date();
          await enqueueDueReminders(env, now, 2);
          await enqueueDueStudyReminders(env, now, 1);
          const result = await deliverNotifications(env, now);
          if (now.getUTCMinutes() === 0)
            await env.DB.prepare(
              'DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at<? LIMIT 500)',
            )
              .bind(Math.floor(now.getTime() / 1000))
              .run();
          console.log(JSON.stringify({ event: 'reminders', ...result }));
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'reminders_failed',
              type: error instanceof Error ? error.name : 'unknown',
            }),
          );
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
