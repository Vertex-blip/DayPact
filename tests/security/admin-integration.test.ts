import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createApi } from '../../src/api/app';
import { HttpError, type Env, type Identity } from '../../src/api/types';
import { totpCode, encodeBase32, encryptSecret, decryptSecret } from '../../src/api/admin/security';
import {
  listFirebaseUsers,
  lookupFirebaseUser,
  setFirebaseDisabled,
  deleteManagedFirebaseUser,
} from '../../src/api/admin/provider';

vi.mock('../../src/api/admin/provider', () => ({
  listFirebaseUsers: vi.fn(),
  lookupFirebaseUser: vi.fn(),
  setFirebaseDisabled: vi.fn(),
  deleteManagedFirebaseUser: vi.fn(),
}));

let mf: Miniflare, env: Env;
let authTime: number;
const now = Date.parse('2026-11-20T12:00:00Z');
type Managed = {
  localId: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string;
  passwordHash?: string;
  salt?: string;
};
let accounts: Map<string, Managed>;
const app = createApi(async (request) => {
  const uid = request.headers.get('x-test-user');
  if (!uid) throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in required');
  return {
    uid,
    email: accounts.get(uid)?.email ?? `${uid}@example.test`,
    name: uid,
    authTime: Number(request.headers.get('x-test-auth-time') ?? authTime),
    token: 'test-only-injected-authenticator',
  } satisfies Identity;
});

function call(
  uid: string | null,
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = '',
  headers: Record<string, string> = {},
) {
  return app.request(
    `https://app.example.test/api${path}`,
    {
      method,
      headers: {
        Origin: 'https://app.example.test',
        ...(uid ? { 'x-test-user': uid } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function setup() {
  const response = await call('owner', '/admin/security/setup', 'POST', {});
  expect(response.status).toBe(200);
  return (await response.json()) as { secret: string; otpauthUri: string; expiresAt: string };
}
async function enroll() {
  const data = await setup();
  const code = await totpCode(data.secret, Math.floor(Date.now() / 30000));
  const confirmed = await call('owner', '/admin/security/confirm', 'POST', { code });
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  const setCookie = confirmed.headers.get('set-cookie') ?? '';
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/Secure/i);
  expect(setCookie).toMatch(/SameSite=Strict/i);
  expect(setCookie).toContain('Path=/api/admin');
  return { ...data, code, cookie: setCookie.split(';')[0] };
}
async function action(
  cookie: string,
  uid: string,
  action: string,
  confirmEmail = accounts.get(uid)?.email ?? `${uid}@example.test`,
) {
  return call(
    'owner',
    `/admin/users/${encodeURIComponent(uid)}/action`,
    'POST',
    { action, confirmEmail },
    cookie,
  );
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("admin-security-test")}}',
      compatibilityDate: '2026-11-01',
      d1Databases: { DB: 'admin-security' },
      d1Persist: false,
    }),
  );
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const directory = new URL('../../migrations/', import.meta.url);
  const sql = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(new URL(name, directory), 'utf8'))
    .join('\n');
  let statement = '',
    trigger = false;
  for (const line of sql.split(/\r?\n/)) {
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
    APP_ORIGIN: 'https://app.example.test',
    FIREBASE_PROJECT_ID: 'test-admin-project',
    FIREBASE_WEB_API_KEY: 'public-test',
    ADMIN_OWNER_UID: 'owner',
    ADMIN_TOTP_KEY: Buffer.alloc(32, 7).toString('base64url'),
    ADMIN_FIREBASE_CLIENT_EMAIL: 'test@test-admin-project.iam.gserviceaccount.com',
    ADMIN_FIREBASE_PRIVATE_KEY: 'test-only-provider-is-mocked',
  };
}, 30000);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  authTime = Math.floor(now / 1000) - 10;
  accounts = new Map(
    ['owner', 'alice', 'bob'].map((uid) => [
      uid,
      {
        localId: uid,
        email: `${uid}@example.test`,
        displayName: uid,
        emailVerified: uid !== 'bob',
        disabled: false,
        createdAt: String(now - 86400000),
        lastLoginAt: String(now - 60000),
        passwordHash: 'MUST_NOT_LEAK_HASH',
        salt: 'MUST_NOT_LEAK_SALT',
      },
    ]),
  );
  vi.mocked(listFirebaseUsers)
    .mockReset()
    .mockImplementation(async () => ({ users: [...accounts.values()] }));
  vi.mocked(lookupFirebaseUser)
    .mockReset()
    .mockImplementation(
      async (_env, query) =>
        [...accounts.values()].find((u) =>
          query.uid ? u.localId === query.uid : u.email === query.email,
        ) ?? null,
    );
  vi.mocked(setFirebaseDisabled)
    .mockReset()
    .mockImplementation(async (_env, uid, disabled) => {
      const account = accounts.get(uid);
      if (account) account.disabled = disabled;
    });
  vi.mocked(deleteManagedFirebaseUser)
    .mockReset()
    .mockImplementation(async (_env, uid) => {
      accounts.delete(uid);
    });
  await env.DB.batch(
    [
      'admin_sessions',
      'admin_mfa_attempts',
      'admin_totp',
      'admin_audit',
      'user_moderation',
      'users',
      'deleted_accounts',
      'rate_limits',
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await mf?.dispose();
});

describe('administrator identity and second factor', () => {
  it('uses immutable owner UID, not email, role headers, or client flags', async () => {
    expect((await call(null, '/admin/access')).status).toBe(401);
    const impostor = accounts.get('alice')!;
    impostor.email = 'owner@example.test';
    expect(await (await call('alice', '/admin/access')).json()).toEqual({ eligible: false });
    for (const path of ['/admin/overview', '/admin/users', '/admin/support', '/admin/audit']) {
      expect(
        (await call('alice', path, 'GET', undefined, 'daypact_admin=fake', { 'x-admin': 'true' }))
          .status,
      ).toBe(403);
    }
    expect((await call('alice', '/admin/security/setup', 'POST', {})).status).toBe(403);
    expect(listFirebaseUsers).not.toHaveBeenCalled();
  });
  it('requires MFA even for owner and fresh sign-in for security enrollment', async () => {
    expect((await call('owner', '/admin/overview')).status).toBe(401);
    expect(
      (
        await call('owner', '/admin/security/setup', 'POST', {}, '', {
          'x-test-auth-time': String(authTime - 600),
        })
      ).status,
    ).toBe(401);
    const access = await (await call('owner', '/admin/access')).json();
    expect(access).toMatchObject({ eligible: true, setupRequired: true, unlocked: false });
  });
  it('rejects cross-origin changes, non-JSON forms, and caches no admin responses', async () => {
    const { cookie } = await enroll();
    const response = await call('owner', '/admin/users', 'GET', undefined, cookie);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('vary')).toContain('Cookie');
    for (const origin of ['https://attacker.example.test', 'null', '']) {
      expect(
        (await call('owner', '/admin/security/lock', 'POST', {}, cookie, { Origin: origin }))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await call('owner', '/admin/security/lock', 'POST', {}, cookie, {
          'Content-Type': 'text/plain',
        })
      ).status,
    ).toBe(415);
    expect((await call('owner', '/admin/overview', 'GET', undefined, cookie)).status).toBe(200);
  });
  it('encrypts TOTP secret, checks confirmation, sets an opaque bound session', async () => {
    const data = await setup();
    expect(data.secret).toMatch(/^[A-Z2-7]+$/);
    expect(data.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const pending = await env.DB.prepare('SELECT pending_cipher FROM admin_totp WHERE user_id=?')
      .bind('owner')
      .first<{ pending_cipher: string }>();
    expect(pending?.pending_cipher).not.toContain(data.secret);
    const invalid = await call('owner', '/admin/security/confirm', 'POST', { code: 'not-a-code' });
    expect(invalid.status).toBe(400);
    const code = await totpCode(data.secret, Math.floor(Date.now() / 30000));
    const response = await call('owner', '/admin/security/confirm', 'POST', { code });
    expect(response.status).toBe(200);
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
    const stored = await env.DB.prepare('SELECT token_hash FROM admin_sessions').first<{
      token_hash: string;
    }>();
    expect(stored?.token_hash).toBeTruthy();
    expect(stored?.token_hash).not.toBe(cookie.split('=')[1]);
    expect((await call('owner', '/admin/overview', 'GET', undefined, cookie)).status).toBe(200);
    expect(
      (
        await call('owner', '/admin/overview', 'GET', undefined, cookie, {
          'x-test-auth-time': String(authTime + 1),
        })
      ).status,
    ).toBe(401);
    expect(
      (await call('owner', '/admin/overview', 'GET', undefined, cookie + 'tampered')).status,
    ).toBe(401);
  });
  it('rejects expired enrollment, TOTP replay, expired sessions, and locked sessions', async () => {
    const pending = await setup();
    await env.DB.prepare('UPDATE admin_totp SET pending_expires_at=?')
      .bind(new Date(now - 1000).toISOString())
      .run();
    expect(
      (
        await call('owner', '/admin/security/confirm', 'POST', {
          code: await totpCode(pending.secret, Math.floor(now / 30000)),
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const session = await enroll();
    expect(
      (await call('owner', '/admin/security/unlock', 'POST', { code: session.code })).status,
    ).toBeGreaterThanOrEqual(400);
    await env.DB.prepare('UPDATE admin_sessions SET expires_at=?')
      .bind(new Date(now - 1000).toISOString())
      .run();
    expect((await call('owner', '/admin/overview', 'GET', undefined, session.cookie)).status).toBe(
      401,
    );
    vi.setSystemTime(now + 30000);
    const unlocked = await call('owner', '/admin/security/unlock', 'POST', {
      code: await totpCode(session.secret, Math.floor(Date.now() / 30000)),
    });
    expect(unlocked.status).toBe(200);
    const cookie = unlocked.headers.get('set-cookie')!.split(';')[0];
    expect((await call('owner', '/admin/security/lock', 'POST', {}, cookie)).status).toBe(200);
    expect((await call('owner', '/admin/overview', 'GET', undefined, cookie)).status).toBe(401);
  });
  it('bounds code guessing and rejects malformed or extra privileged input', async () => {
    const pending = await setup();
    const valid = await Promise.all(
      [-1, 0, 1].map((offset) => totpCode(pending.secret, Math.floor(now / 30000) + offset)),
    );
    const wrong = ['000000', '111111', '222222', '333333'].find((code) => !valid.includes(code))!;
    for (let i = 0; i < 5; i++)
      await call('owner', '/admin/security/confirm', 'POST', { code: wrong });
    expect((await call('owner', '/admin/security/confirm', 'POST', { code: wrong })).status).toBe(
      429,
    );
    expect(
      (await call('owner', '/admin/security/unlock', 'POST', { code: '123456', admin: true }))
        .status,
    ).toBe(400);
  });
  it('shares a rolling MFA limit across confirmation and unlock without fixed-window rollover', async () => {
    const pending = await setup();
    vi.setSystemTime(now + 590000);
    const code = await totpCode(pending.secret, Math.floor(Date.now() / 30000));
    const headers = { 'x-test-auth-time': String(Math.floor(Date.now() / 1000)) };
    expect(
      (await call('owner', '/admin/security/confirm', 'POST', { code }, '', headers)).status,
    ).toBe(200);
    for (let i = 0; i < 4; i++)
      expect(
        (await call('owner', '/admin/security/unlock', 'POST', { code }, '', headers)).status,
      ).toBe(401);
    vi.setSystemTime(now + 610000);
    expect(
      (await call('owner', '/admin/security/unlock', 'POST', { code }, '', headers)).status,
    ).toBe(429);
    vi.setSystemTime(now + 1190001);
    const freshCode = await totpCode(pending.secret, Math.floor(Date.now() / 30000));
    expect(
      (
        await call('owner', '/admin/security/unlock', 'POST', { code: freshCode }, '', {
          'x-test-auth-time': String(Math.floor(Date.now() / 1000)),
        })
      ).status,
    ).toBe(200);
  });
  it('admits only one concurrent use of a fresh TOTP and cannot overwrite enabled MFA', async () => {
    const enrolled = await enroll();
    expect((await call('owner', '/admin/security/setup', 'POST', {})).status).toBe(409);
    vi.setSystemTime(now + 30000);
    const code = await totpCode(enrolled.secret, Math.floor(Date.now() / 30000));
    const responses = await Promise.all(
      [1, 2].map(() => call('owner', '/admin/security/unlock', 'POST', { code })),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
  });
  it('requires fresh sign-in again before unlocking an expired session', async () => {
    const enrolled = await enroll();
    vi.setSystemTime(now + 16 * 60000);
    const code = await totpCode(enrolled.secret, Math.floor(Date.now() / 30000));
    expect((await call('owner', '/admin/security/unlock', 'POST', { code })).status).toBe(401);
    const unlocked = await call('owner', '/admin/security/unlock', 'POST', { code }, '', {
      'x-test-auth-time': String(Math.floor(Date.now() / 1000)),
    });
    expect(unlocked.status).toBe(200);
  });
  it('matches independent RFC 6238 SHA-1 vectors and binds encrypted keys to UID', async () => {
    const secret = encodeBase32(new TextEncoder().encode('12345678901234567890'));
    for (const [seconds, expected] of [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ] as const)
      expect(await totpCode(secret, Math.floor(seconds / 30))).toBe(expected);
    const encrypted = await encryptSecret(env, 'owner', secret);
    expect(await decryptSecret(env, 'owner', encrypted)).toBe(secret);
    await expect(decryptSecret(env, 'alice', encrypted)).rejects.toBeTruthy();
  });
});

describe('administrative user management and support', () => {
  it('lists unverified Firebase-only registrations without credential material', async () => {
    const { cookie } = await enroll();
    const response = await call('owner', '/admin/users', 'GET', undefined, cookie);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      users: Array<{
        uid: string;
        emailVerified: boolean;
        appRegistered: boolean;
        protected: boolean;
      }>;
    };
    expect(data.users.find((u) => u.uid === 'bob')).toMatchObject({
      emailVerified: false,
      appRegistered: false,
    });
    expect(data.users.find((u) => u.uid === 'owner')).toMatchObject({ protected: true });
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('MUST_NOT_LEAK');
    expect(serialized).not.toMatch(/passwordHash|salt|refreshToken|idToken/);
  });
  it('requires exact target confirmation and protects the owner from all removal actions', async () => {
    const { cookie } = await enroll();
    for (const mode of ['suspend', 'delete']) {
      expect((await action(cookie, 'owner', mode)).status).toBe(403);
      expect((await action(cookie, 'alice', mode, 'wrong@example.test')).status).toBe(400);
    }
    expect(setFirebaseDisabled).not.toHaveBeenCalled();
    expect(deleteManagedFirebaseUser).not.toHaveBeenCalled();
    expect((await call('owner', '/me', 'DELETE')).status).toBe(403);
    expect(
      (
        await call(
          'alice',
          '/admin/users/bob/action',
          'POST',
          { action: 'delete', confirmEmail: 'bob@example.test' },
          cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          'owner',
          '/admin/users/alice/action',
          'POST',
          { action: 'delete', confirmEmail: 'alice@example.test', owner: 'alice' },
          cookie,
        )
      ).status,
    ).toBe(400);
  });
  it('suspends normal access, preserves data, and restores the same account', async () => {
    const { cookie } = await enroll();
    expect((await call('alice', '/me')).status).toBe(200);
    const ticket = await call('alice', '/support', 'POST', {
      category: 'help',
      subject: 'Test request',
      message: 'Keep this during suspension',
    });
    expect(ticket.status).toBe(201);
    expect((await action(cookie, 'alice', 'suspend')).status).toBe(200);
    expect(setFirebaseDisabled).toHaveBeenLastCalledWith(env, 'alice', true);
    expect((await call('alice', '/me')).status).toBe(403);
    expect((await call('alice', '/support')).status).toBe(403);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM users WHERE uid=?').bind('alice').first('n'),
    ).toBe(1);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM support_tickets WHERE user_id=?')
        .bind('alice')
        .first('n'),
    ).toBe(1);
    expect((await action(cookie, 'alice', 'restore')).status).toBe(200);
    expect(setFirebaseDisabled).toHaveBeenLastCalledWith(env, 'alice', false);
    expect((await call('alice', '/me')).status).toBe(200);
  });
  it('fails closed on provider suspension failure and permits explicit retry', async () => {
    const { cookie } = await enroll();
    await call('alice', '/me');
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO push_tokens(user_id,device_id,token,updated_at) VALUES(?,?,?,?)',
      ).bind('alice', 'old-device', 'stale-device-token', new Date().toISOString()),
      env.DB.prepare(
        "INSERT INTO notifications(id,user_id,kind,title,body,created_at,next_attempt_at,dedupe_key) VALUES(?,'alice','reminder',?,?,?,?,?)",
      ).bind(
        'old-notification',
        'Private title',
        'Private content',
        new Date().toISOString(),
        new Date().toISOString(),
        'old-notification',
      ),
    ]);
    vi.mocked(setFirebaseDisabled).mockRejectedValueOnce(new Error('Provider outage'));
    expect((await action(cookie, 'alice', 'suspend')).status).toBe(503);
    expect((await call('alice', '/me')).status).toBe(403);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM push_tokens WHERE user_id=?')
        .bind('alice')
        .first('n'),
    ).toBe(0);
    expect(
      await env.DB.prepare('SELECT state FROM notifications WHERE id=?')
        .bind('old-notification')
        .first('state'),
    ).toBe('skipped');
    expect((await action(cookie, 'alice', 'suspend')).status).toBe(200);
    expect((await action(cookie, 'alice', 'restore')).status).toBe(200);
    expect(
      await env.DB.prepare('SELECT state FROM notifications WHERE id=?')
        .bind('old-notification')
        .first('state'),
    ).toBe('skipped');
    const audit = await (await call('owner', '/admin/audit', 'GET', undefined, cookie)).json();
    expect(JSON.stringify(audit)).toContain('failure');
    expect(JSON.stringify(audit)).not.toContain('Provider outage');
  });
  it('serializes conflicting moderation while the provider request is in progress', async () => {
    const { cookie } = await enroll();
    let started!: () => void, release!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(setFirebaseDisabled).mockImplementationOnce(async () => {
      started();
      await providerRelease;
    });
    const suspension = action(cookie, 'alice', 'suspend');
    await providerStarted;
    try {
      expect((await action(cookie, 'alice', 'restore')).status).toBe(409);
      expect((await call('alice', '/me')).status).toBe(403);
      expect(setFirebaseDisabled).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect((await suspension).status).toBe(200);
  });
  it('erases permanently, blocks old UID, and accepts a new UID with the same email', async () => {
    const { cookie } = await enroll();
    await call('alice', '/me');
    await call('alice', '/support', 'POST', {
      category: 'help',
      subject: 'Private ticket',
      message: 'Erase this with account',
    });
    await env.DB.prepare(
      'INSERT INTO push_tokens(user_id,device_id,token,updated_at) VALUES(?,?,?,?)',
    )
      .bind('alice', crypto.randomUUID(), 'fake-test-token', new Date().toISOString())
      .run();
    const deleted = await action(cookie, 'alice', 'delete');
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(deleteManagedFirebaseUser).toHaveBeenCalledExactlyOnceWith(env, 'alice');
    for (const table of ['users', 'support_tickets', 'push_tokens']) {
      const column = table === 'users' ? 'uid' : 'user_id';
      expect(
        await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`)
          .bind('alice')
          .first('n'),
      ).toBe(0);
    }
    const oldSession = await call('alice', '/me');
    expect(oldSession.status).toBe(403);
    expect(await oldSession.json()).toMatchObject({ error: { code: 'ACCOUNT_DELETED' } });
    accounts.set('alice-new', {
      ...accounts.get('bob')!,
      localId: 'alice-new',
      email: 'alice@example.test',
      emailVerified: true,
    });
    const recreated = await call('alice-new', '/me');
    expect(recreated.status).toBe(200);
    expect(await recreated.json()).toMatchObject({
      profile: { uid: 'alice-new', email: 'alice@example.test' },
    });
    expect(
      (await action(cookie, 'alice', 'restore', 'alice@example.test')).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await action(cookie, 'alice', 'delete', 'alice@example.test')).status).toBe(200);
    expect(deleteManagedFirebaseUser).toHaveBeenCalledTimes(1);
    expect(accounts.has('alice-new')).toBe(true);
  });
  it('retains a deletion tombstone through provider failure and can finish after a lost response', async () => {
    const { cookie } = await enroll();
    await call('alice', '/me');
    vi.mocked(deleteManagedFirebaseUser).mockImplementationOnce(async (_env, uid) => {
      accounts.delete(uid);
      throw new Error('Response lost after provider deletion');
    });
    expect((await action(cookie, 'alice', 'delete')).status).toBe(503);
    expect((await call('alice', '/me')).status).toBe(403);
    expect((await action(cookie, 'alice', 'restore', 'alice@example.test')).status).toBe(404);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM users WHERE uid=?').bind('alice').first('n'),
    ).toBe(0);
    const retry = await action(cookie, 'alice', 'delete', 'alice@example.test');
    expect(retry.status, await retry.clone().text()).toBe(200);
    const moderation = await env.DB.prepare(
      'SELECT state,pending_email FROM user_moderation WHERE user_id=?',
    )
      .bind('alice')
      .first();
    expect(moderation).toMatchObject({ state: 'deleted', pending_email: null });
  });
  it('keeps support private to author and admin, with scoped replies and deletion cleanup', async () => {
    const { cookie } = await enroll();
    const response = await call('alice', '/support', 'POST', {
      category: 'report',
      subject: 'Spam complaint',
      message: 'Please review this issue',
    });
    expect(response.status).toBe(201);
    const ticket = ((await response.json()) as { ticket: { id: string } }).ticket;
    expect(await (await call('bob', '/support')).json()).toEqual({ tickets: [] });
    expect(
      (
        await call(
          'bob',
          `/admin/support/${ticket.id}`,
          'PATCH',
          { status: 'closed', reply: 'Forged reply' },
          cookie,
        )
      ).status,
    ).toBe(403);
    const changed = await call(
      'owner',
      `/admin/support/${ticket.id}`,
      'PATCH',
      { status: 'closed', reply: 'Reviewed. Thank you.' },
      cookie,
    );
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await (await call('alice', '/support')).json()).toMatchObject({
      tickets: [{ id: ticket.id, status: 'closed', reply: 'Reviewed. Thank you.' }],
    });
    expect(
      (
        await call('alice', '/support', 'POST', {
          category: 'help',
          subject: 'Invalid',
          message: 'Override',
          userId: 'bob',
        })
      ).status,
    ).toBe(400);
  });
});
