import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { deliverNotifications } from '../../src/api/notifications';
import { createAuthenticator } from '../../src/api/auth';
import { DEFAULT_SETTINGS } from '../../src/shared/contracts';
import type { Env } from '../../src/api/types';

let mf: Miniflare, env: Env, privateKey: CryptoKey, keys: ReturnType<typeof createLocalJWKSet>;
const now = new Date('2026-11-19T08:00:00.000Z');
const notificationId = 'test-private-notification';
const planId = '2dbdd702-afde-48df-8775-98674caa7b33';
let sends: Array<Record<string, any>> = [];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'audit', alg: 'RS256' }],
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("audit")}}',
      compatibilityDate: '2026-11-01',
      d1Databases: { DB: 'audit-notifications' },
      d1Persist: false,
    }),
  );
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  let statement = '',
    trigger = false;
  for (const line of readFileSync(
    new URL('../../migrations/0001_initial.sql', import.meta.url),
    'utf8',
  ).split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    if (clean.startsWith('CREATE TRIGGER')) trigger = true;
    statement += ` ${clean}`;
    if ((!trigger && clean.endsWith(';')) || (trigger && /END;$/.test(clean))) {
      await db.prepare(statement).run();
      statement = '';
      trigger = false;
    }
  }
  env = {
    DB: db,
    ASSETS: {} as Fetcher,
    FIREBASE_PROJECT_ID: 'push-test',
    FIREBASE_WEB_API_KEY: 'public-test',
    APP_ORIGIN: 'https://daypact.example',
    FIREBASE_CLIENT_EMAIL: 'test@push-test.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: await exportPKCS8(privateKey),
  };
}, 30000);
beforeEach(async () => {
  sends = [];
  env.FIREBASE_CLIENT_EMAIL = `test-${crypto.randomUUID()}@push-test.iam.gserviceaccount.com`;
  await env.DB.prepare('DELETE FROM users').run();
  const settings = { ...DEFAULT_SETTINGS, quietStart: '00:00', quietEnd: '00:00' };
  await env.DB.prepare(
    'INSERT INTO users(uid,email,display_name,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',
  )
    .bind(
      'alice',
      'alice@private.invalid',
      'Private name',
      JSON.stringify(settings),
      now.toISOString(),
      now.toISOString(),
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO plans(id,owner_id,title,description,kind,cadence,start_date,time,time_zone,remind_minutes,mutation_id,created_at,updated_at) VALUES(?,'alice','PRIVATE PLAN TITLE','PRIVATE DESCRIPTION','habit','daily','2026-11-19','13:00','Asia/Almaty',0,'test',?,?)`,
  )
    .bind(planId, now.toISOString(), now.toISOString())
    .run();
  await env.DB.prepare('INSERT INTO plan_members(plan_id,user_id,joined_at) VALUES(?,?,?)')
    .bind(planId, 'alice', now.toISOString())
    .run();
  await env.DB.prepare(
    `INSERT INTO notifications(id,user_id,plan_id,kind,title,body,created_at,next_attempt_at,dedupe_key) VALUES(?,'alice',?,'nudge','PRIVATE PLAN TITLE','PRIVATE CONTENT',?,?,?)`,
  )
    .bind(notificationId, planId, now.toISOString(), now.toISOString(), notificationId)
    .run();
  await addDevice('device-1');
  transport(() => Response.json({ name: 'messages/success' }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => mf?.dispose());
async function addDevice(id: string) {
  await env.DB.prepare(
    'INSERT INTO push_tokens(user_id,device_id,token,updated_at) VALUES(?,?,?,?)',
  )
    .bind('alice', id, `secret-token-${id}`, now.toISOString())
    .run();
}
function transport(send: (message: Record<string, any>) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token'))
      return Response.json({ access_token: 'test-oauth-token', expires_in: 3600 });
    if (!String(url).startsWith('https://fcm.googleapis.com/v1/projects/push-test/messages:send'))
      throw new Error('Unexpected test network access');
    const message = JSON.parse(String(init?.body)).message as Record<string, any>;
    sends.push(message);
    return send(message);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function pending() {
  return env.DB.prepare(
    'SELECT state,attempts,next_attempt_at,delivered_at FROM notifications WHERE id=?',
  )
    .bind(notificationId)
    .first<{
      state: string;
      attempts: number;
      next_attempt_at: string;
      delivered_at: string | null;
    }>();
}

describe('FCM delivery and privacy', () => {
  it('does not lease or send with malformed OAuth credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(null)),
    );
    await expect(deliverNotifications(env, now)).rejects.toThrow('PUSH_AUTH_UNAVAILABLE');
    expect((await pending())?.attempts).toBe(0);
  });
  it('retries malformed provider error envelopes instead of crashing the batch', async () => {
    transport(() => Response.json({ error: { details: 'invalid' } }, { status: 503 }));
    expect((await deliverNotifications(env, now)).delivered).toBe(0);
    expect(await pending()).toMatchObject({ state: 'pending', attempts: 1 });
  });
  it('does nothing without server-side credentials', async () => {
    const result = await deliverNotifications({ ...env, FIREBASE_PRIVATE_KEY: undefined }, now);
    expect(result).toEqual({ delivered: 0, configured: false });
    expect(sends).toHaveLength(0);
    expect((await pending())?.attempts).toBe(0);
  });
  it('sends a generic notification with recipient scope, never private plan/profile details', async () => {
    const result = await deliverNotifications(env, now);
    expect(result.delivered).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0].data).toMatchObject({ recipientUid: 'alice', planId, notificationId });
    const serialized = JSON.stringify(sends[0]);
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('alice@private.invalid');
    expect(serialized).not.toContain('Private name');
    expect(await pending()).toMatchObject({ state: 'delivered', attempts: 1 });
  });
  it('leases prevent duplicate sends across concurrent cron invocations', async () => {
    const results = await Promise.all([
      deliverNotifications(env, now),
      deliverNotifications(env, now),
    ]);
    expect(results.reduce((n, r) => n + r.delivered, 0)).toBe(1);
    expect(sends).toHaveLength(1);
    expect((await pending())?.attempts).toBe(1);
  });
  it('uses fresh preferences when a recipient opts out after the initial queue read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
          await env.DB.prepare('UPDATE users SET settings_json=? WHERE uid=?')
            .bind(
              JSON.stringify({
                ...DEFAULT_SETTINGS,
                quietStart: '00:00',
                quietEnd: '00:00',
                friendNudges: false,
              }),
              'alice',
            )
            .run();
          return Response.json({ access_token: 'test-oauth-token', expires_in: 3600 });
        }
        throw new Error('FCM must not be called after opting out');
      }),
    );
    expect((await deliverNotifications(env, now)).delivered).toBe(0);
    expect((await pending())?.state).toBe('skipped');
  });
  it('retries transient errors with a later attempt and stable deduplication id', async () => {
    transport(() => Response.json({ error: { code: 503 } }, { status: 503 }));
    expect((await deliverNotifications(env, now)).delivered).toBe(0);
    const first = await pending();
    expect(first).toMatchObject({ state: 'pending', attempts: 1, delivered_at: null });
    expect(Date.parse(first!.next_attempt_at)).toBeGreaterThan(now.getTime());
    await deliverNotifications(env, new Date(now.getTime() + 30000));
    expect(sends).toHaveLength(1);
    transport(() => Response.json({ name: 'messages/success' }));
    await deliverNotifications(env, new Date(first!.next_attempt_at));
    expect(await pending()).toMatchObject({ state: 'delivered', attempts: 2 });
    expect(sends.every((message) => message.data.notificationId === notificationId)).toBe(true);
  });
  it('exhausts bounded retries rather than leaving a poison message pending forever', async () => {
    await env.DB.prepare('UPDATE notifications SET attempts=5 WHERE id=?')
      .bind(notificationId)
      .run();
    transport(() => Response.json({ error: { code: 503 } }, { status: 503 }));
    await deliverNotifications(env, now);
    expect(await pending()).toMatchObject({ state: 'failed', attempts: 6, delivered_at: null });
  });
  it('removes unregistered tokens and does not call that a delivery', async () => {
    transport(() =>
      Response.json({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 }),
    );
    expect((await deliverNotifications(env, now)).delivered).toBe(0);
    expect(await pending()).toMatchObject({ state: 'skipped', delivered_at: null });
    expect(
      (await env.DB.prepare('SELECT count(*) AS n FROM push_tokens').first<{ n: number }>())?.n,
    ).toBe(0);
  });
  it.each([
    ['notifications disabled', { notificationsEnabled: false }],
    ['friend nudges disabled', { friendNudges: false }],
    ['quiet hours', { quietStart: '12:00', quietEnd: '14:00' }],
  ] as const)('respects %s without sending', async (_label, patch) => {
    await env.DB.prepare('UPDATE users SET settings_json=? WHERE uid=?')
      .bind(
        JSON.stringify({ ...DEFAULT_SETTINGS, quietStart: '00:00', quietEnd: '00:00', ...patch }),
        'alice',
      )
      .run();
    await deliverNotifications(env, now);
    expect(sends).toHaveLength(0);
    expect((await pending())?.state).toBe('skipped');
  });
  it('suppresses stale reminders instead of delivering old private activity', async () => {
    await env.DB.prepare('UPDATE notifications SET created_at=? WHERE id=?')
      .bind('2026-11-17T08:00:00.000Z', notificationId)
      .run();
    await deliverNotifications(env, now);
    expect(sends).toHaveLength(0);
    expect((await pending())?.state).toBe('skipped');
  });
});

describe('live Firebase metadata fail-closed regressions', () => {
  async function token(claims: Record<string, unknown> = {}) {
    return new SignJWT({
      email: 'alice@example.test',
      email_verified: true,
      auth_time: Math.floor(Date.now() / 1000),
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'audit' })
      .setSubject('alice')
      .setAudience('push-test')
      .setIssuer('https://securetoken.google.com/push-test')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }
  function request(jwt: string) {
    return new Request('https://daypact.example/api/me', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }
  it.each(['not-a-number', '-1', 'Infinity'])(
    'rejects malformed validSince %s',
    async (validSince) => {
      const lookup = vi.fn(async () =>
        Response.json({
          users: [
            { localId: 'alice', email: 'alice@example.test', emailVerified: true, validSince },
          ],
        }),
      ) as unknown as typeof fetch;
      await expect(
        createAuthenticator(keys, lookup)(request(await token()), env),
      ).rejects.toMatchObject({ status: 503 });
    },
  );
  it('rejects a valid token issued before the provider revocation timestamp', async () => {
    const lookup = vi.fn(async () =>
      Response.json({
        users: [
          {
            localId: 'alice',
            email: 'alice@example.test',
            emailVerified: true,
            validSince: String(Math.floor(Date.now() / 1000) + 60),
          },
        ],
      }),
    ) as unknown as typeof fetch;
    await expect(
      createAuthenticator(keys, lookup)(request(await token()), env),
    ).rejects.toMatchObject({ status: 401 });
  });
});
