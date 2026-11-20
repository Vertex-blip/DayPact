import { importPKCS8, SignJWT } from 'jose';
import { DEFAULT_SETTINGS, type Locale, type Settings } from '../shared/contracts';
import { HttpError, type Env } from './types';

let access: { project: string; email: string; token: string; expires: number } | undefined;
async function accessToken(env: Env): Promise<string> {
  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY)
    throw new Error('PUSH_NOT_CONFIGURED');
  if (
    access &&
    access.project === env.FIREBASE_PROJECT_ID &&
    access.email === env.FIREBASE_CLIENT_EMAIL &&
    access.expires > Date.now() + 60000
  )
    return access.token;
  const privateKey = await importPKCS8(env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), 'RS256');
  const assertion = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(env.FIREBASE_CLIENT_EMAIL)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('PUSH_AUTH_UNAVAILABLE');
  const value = (await response.json()) as { access_token: string; expires_in: number };
  if (
    !value ||
    typeof value.access_token !== 'string' ||
    !value.access_token ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 7200
  )
    throw new Error('PUSH_AUTH_UNAVAILABLE');
  access = {
    project: env.FIREBASE_PROJECT_ID,
    email: env.FIREBASE_CLIENT_EMAIL,
    token: value.access_token,
    expires: Date.now() + value.expires_in * 1000,
  };
  return access.token;
}

/** Explicit user-requested diagnostics target exactly one owned device. Provider
 * acceptance does not prove that the operating system displayed the notification. */
export async function sendTestPush(
  env: Env,
  uid: string,
  deviceId: string,
  locale: Locale,
): Promise<{ accepted: true }> {
  const device = await env.DB.prepare(
    'SELECT token FROM push_tokens WHERE user_id=? AND device_id=?',
  )
    .bind(uid, deviceId)
    .first<{ token: string }>();
  if (!device)
    throw new HttpError(409, 'PUSH_NOT_REGISTERED', 'Enable notifications on this device first.');
  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY || !env.APP_ORIGIN)
    throw new HttpError(503, 'PUSH_SETUP', 'Push delivery is not configured.');

  let response: Response;
  try {
    const token = await accessToken(env);
    response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          message: {
            token: device.token,
            data: { recipientUid: uid, notificationId: `test-${crypto.randomUUID()}` },
            webpush: {
              headers: { TTL: '60', Urgency: 'high' },
              notification: {
                title: 'DayPact',
                body:
                  locale === 'ru'
                    ? 'Это проверочное уведомление. Пуш на этом устройстве работает.'
                    : 'Бұл тексеру хабарламасы. Осы құрылғыда пуш жұмыс істейді.',
                icon: '/icons/icon-192.png',
              },
              fcm_options: { link: env.APP_ORIGIN },
            },
          },
        }),
      },
    );
  } catch {
    throw new HttpError(
      503,
      'PUSH_DELIVERY_FAILED',
      'The push provider could not accept the test.',
    );
  }
  if (response.ok) return { accepted: true };
  const body = (await response.json().catch(() => null)) as {
    error?: { details?: Array<{ errorCode?: string }> };
  } | null;
  if (
    Array.isArray(body?.error?.details) &&
    body.error.details.some((detail) => detail?.errorCode === 'UNREGISTERED')
  ) {
    await env.DB.prepare('DELETE FROM push_tokens WHERE user_id=? AND device_id=? AND token=?')
      .bind(uid, deviceId, device.token)
      .run();
    throw new HttpError(409, 'PUSH_NOT_REGISTERED', 'Enable notifications on this device again.');
  }
  throw new HttpError(503, 'PUSH_DELIVERY_FAILED', 'The push provider could not accept the test.');
}

export function isQuiet(
  settings: Pick<Settings, 'quietStart' | 'quietEnd' | 'timeZone'>,
  date: Date,
): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const time = `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
  const { quietStart: start, quietEnd: end } = settings;
  if (start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

interface Pending {
  id: string;
  user_id: string;
  plan_id: string | null;
  kind: string;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  settings_json: string;
}
/** Bounded work on the Free plan. A lease prevents overlapping cron deliveries.
 * Delivery is at-least-once; browser notification tags deduplicate retries. */
export async function deliverNotifications(
  env: Env,
  now = new Date(),
): Promise<{ delivered: number; configured: boolean }> {
  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY || !env.APP_ORIGIN)
    return { delivered: 0, configured: false };
  const nowIso = now.toISOString();
  const rows = await env.DB.prepare(
    `SELECT n.id,n.user_id,n.plan_id,n.kind,n.attempts,n.next_attempt_at,n.created_at,u.settings_json
    FROM notifications n JOIN users u ON u.uid=n.user_id
    WHERE n.state='pending' AND n.next_attempt_at<=? ORDER BY n.next_attempt_at LIMIT 3`,
  )
    .bind(nowIso)
    .all<Pending>();
  if (!rows.results.length) return { delivered: 0, configured: true };
  const token = await accessToken(env);
  let delivered = 0;
  for (const item of rows.results) {
    const leaseUntil = new Date(now.getTime() + 120000).toISOString();
    const claim = await env.DB.prepare(
      `UPDATE notifications SET attempts=attempts+1,next_attempt_at=? WHERE id=? AND state='pending' AND attempts=? AND next_attempt_at<=?
      RETURNING (SELECT settings_json FROM users WHERE uid=notifications.user_id) AS settings_json`,
    )
      .bind(leaseUntil, item.id, item.attempts, nowIso)
      .first<{ settings_json: string }>();
    if (!claim) continue;
    const settings: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(claim.settings_json) };
    const stale = now.getTime() - Date.parse(item.created_at) > 24 * 3600000;
    if (
      stale ||
      !settings.notificationsEnabled ||
      (item.kind === 'nudge' && !settings.friendNudges) ||
      isQuiet(settings, now)
    ) {
      await env.DB.prepare(`UPDATE notifications SET state='skipped' WHERE id=?`)
        .bind(item.id)
        .run();
      continue;
    }
    const devices = await env.DB.prepare(
      `SELECT token FROM push_tokens WHERE user_id=? ORDER BY updated_at DESC LIMIT 3`,
    )
      .bind(item.user_id)
      .all<{ token: string }>();
    if (!devices.results.length) {
      await env.DB.prepare(`UPDATE notifications SET state='skipped' WHERE id=?`)
        .bind(item.id)
        .run();
      continue;
    }
    let retry = false,
      successful = 0;
    for (const device of devices.results) {
      let response: Response;
      try {
        response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/messages:send`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10000),
            body: JSON.stringify({
              message: {
                token: device.token,
                data: {
                  notificationId: item.id,
                  planId: item.plan_id ?? '',
                  recipientUid: item.user_id,
                },
                webpush: {
                  headers: { TTL: '3600', Urgency: 'normal' },
                  notification: {
                    title: 'DayPact',
                    body:
                      settings.locale === 'ru'
                        ? 'У тебя новое напоминание. Открой свои планы.'
                        : 'Жаңа еске салу бар. Жоспарларыңды аш.',
                    icon: '/icons/icon-192.png',
                    tag: `daypact-${item.id}`,
                    renotify: false,
                    data: {
                      url: `${env.APP_ORIGIN}/?plan=${encodeURIComponent(item.plan_id ?? '')}`,
                    },
                  },
                  fcm_options: {
                    link: `${env.APP_ORIGIN}/?plan=${encodeURIComponent(item.plan_id ?? '')}`,
                  },
                },
              },
            }),
          },
        );
      } catch {
        retry = true;
        continue;
      }
      if (response.ok) successful++;
      else {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { details?: Array<{ errorCode?: string }> };
        };
        if (
          Array.isArray(body?.error?.details) &&
          body.error.details.some((d) => d?.errorCode === 'UNREGISTERED')
        )
          await env.DB.prepare('DELETE FROM push_tokens WHERE user_id=? AND token=?')
            .bind(item.user_id, device.token)
            .run();
        else retry = true;
      }
    }
    if (retry && item.attempts < 5) {
      const next = new Date(
        now.getTime() + Math.min(3600000, 60000 * 2 ** item.attempts),
      ).toISOString();
      await env.DB.prepare(`UPDATE notifications SET next_attempt_at=? WHERE id=?`)
        .bind(next, item.id)
        .run();
    } else {
      const state = retry ? 'failed' : successful ? 'delivered' : 'skipped';
      await env.DB.prepare('UPDATE notifications SET state=?,delivered_at=? WHERE id=?')
        .bind(state, state === 'delivered' ? nowIso : null, item.id)
        .run();
      if (state === 'delivered') delivered++;
    }
  }
  return { delivered, configured: true };
}
