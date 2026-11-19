import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createApi } from '../../src/api/app';
import { deleteFirebaseAccount } from '../../src/api/auth';
import type { Env, Identity } from '../../src/api/types';
import { HttpError } from '../../src/api/types';
import { enqueueDueReminders } from '../../src/api/domain/reminders';
import { DEFAULT_SETTINGS, type Plan, type PlanInput } from '../../src/shared/contracts';
import { localParts } from '../../src/api/domain/dates';

vi.mock('../../src/api/auth', () => ({
  authenticate: async () => {
    throw new Error('Real authenticator must not be used by route tests');
  },
  deleteFirebaseAccount: vi.fn(async () => undefined),
}));
let mf: Miniflare, env: Env;
const app = createApi(async (request) => {
  const uid = request.headers.get('x-test-user');
  if (!uid) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  return {
    uid,
    email: `${uid}@example.test`,
    name: uid,
    authTime: Math.floor(Date.now() / 1000),
    token: 'test-only-injected',
  } satisfies Identity;
});
function call(
  uid: string | null,
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(
    `https://app.example.test/api${path}`,
    {
      method,
      headers: {
        ...(uid ? { 'x-test-user': uid } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function json(
  uid: string,
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await call(uid, path, method, body, headers);
  return { status: response.status, data: (await response.json()) as any };
}
const today = () => localParts(new Date(), 'Asia/Almaty').date;
const input = (changes: Partial<PlanInput> = {}): PlanInput => ({
  title: 'Ортақ жоспар',
  description: '',
  kind: 'habit',
  cadence: 'daily',
  startDate: today(),
  time: '19:00',
  memberIds: [],
  remindMinutes: 15,
  ...changes,
});
async function befriend(a: string, b: string) {
  await call(a, '/me');
  await call(b, '/me');
  const invite = await json(a, '/friends/invitations', 'POST', {});
  const accepted = await json(b, '/friends/accept', 'POST', { token: invite.data.token });
  expect(accepted.status).toBe(200);
  return invite.data.token as string;
}
async function plan(owner = 'alice', changes: Partial<PlanInput> = {}): Promise<Plan> {
  const made = await json(owner, '/plans', 'POST', input(changes));
  expect(made.status, JSON.stringify(made.data)).toBe(201);
  return made.data.plan;
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: '2026-11-01',
      d1Databases: { DB: 'test-daypact' },
      d1Persist: false,
    }),
  );
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const sql = readFileSync(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8');
  // D1 exec accepts a line per statement; keep CREATE TRIGGER blocks intact.
  const statements: string[] = [];
  let current = '';
  let trigger = false;
  for (const line of sql.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    if (clean.startsWith('CREATE TRIGGER')) trigger = true;
    current += ` ${clean}`;
    if ((!trigger && clean.endsWith(';')) || (trigger && /END;$/.test(clean))) {
      statements.push(current.trim());
      current = '';
      trigger = false;
    }
  }
  for (const statement of statements) await db.prepare(statement).run();
  env = {
    DB: db,
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_WEB_API_KEY: 'test-api',
    APP_ORIGIN: 'https://app.example.test',
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
  };
}, 30000);
beforeEach(async () => {
  vi.mocked(deleteFirebaseAccount).mockReset().mockResolvedValue(undefined);
  await env.DB.batch(
    ['DELETE FROM users', 'DELETE FROM deleted_accounts', 'DELETE FROM rate_limits'].map((sql) =>
      env.DB.prepare(sql),
    ),
  );
});
afterAll(async () => {
  await mf?.dispose();
});

describe('identity and validation', () => {
  it('requires authentication and initializes only the verified user', async () => {
    expect((await call(null, '/me')).status).toBe(401);
    const mine = await json('alice', '/me');
    expect(mine.data.profile.uid).toBe('alice');
    expect(mine.data.profile.settings.locale).toBe('kk');
  });
  it('rejects unknown privilege fields and invalid real dates', async () => {
    const res = await json('alice', '/plans', 'POST', { ...input(), ownerId: 'bob' });
    expect(res.status).toBe(400);
    expect((await json('alice', '/plans', 'POST', input({ startDate: '2026-02-30' }))).status).toBe(
      400,
    );
  });
  it('enforces unique normalized usernames', async () => {
    const fields = { displayName: 'Alice', username: 'alice_1', bio: '', city: 'Astana' };
    expect((await json('alice', '/me', 'PUT', fields)).status).toBe(200);
    expect((await json('bob', '/me', 'PUT', { ...fields, username: 'ALICE_1' })).status).toBe(409);
  });
});
describe('sharing and ownership', () => {
  it('prevents outsider reads, edits, checkins and nudges', async () => {
    const p = await plan();
    expect((await json('mallory', `/plans?date=${today()}`)).data.plans).toEqual([]);
    expect(
      (await json('mallory', `/plans/${p.id}`, 'PATCH', { version: 1, title: 'stolen' })).status,
    ).toBe(404);
    expect(
      (
        await json('mallory', `/plans/${p.id}/checkins`, 'POST', {
          date: today(),
          completed: true,
          operationId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(404);
    expect(
      (await json('mallory', `/plans/${p.id}/nudges`, 'POST', { date: today(), toUserId: 'alice' }))
        .status,
    ).toBe(404);
  });
  it('adds only existing friends, lets members complete only themselves, forbids member edits', async () => {
    await call('bob', '/me');
    expect((await json('alice', '/plans', 'POST', input({ memberIds: ['bob'] }))).status).toBe(400);
    await befriend('alice', 'bob');
    const p = await plan('alice', { memberIds: ['bob'] });
    expect(
      (await json('bob', `/plans/${p.id}`, 'PATCH', { version: 1, title: 'bad' })).status,
    ).toBe(403);
    expect(
      (
        await json('bob', `/plans/${p.id}/checkins`, 'POST', {
          date: today(),
          completed: true,
          operationId: crypto.randomUUID(),
          userId: 'alice',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await json('bob', `/plans/${p.id}/checkins`, 'POST', {
          date: today(),
          completed: true,
          operationId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    const current = (await json('alice', `/plans?date=${today()}`)).data.plans[0];
    expect(current.members.find((m: any) => m.uid === 'bob').completed).toBe(true);
    expect(current.members.find((m: any) => m.uid === 'alice').completed).toBe(false);
  });
  it('consumes invitation only once and rejects self-invite', async () => {
    await call('alice', '/me');
    const invite = (await json('alice', '/friends/invitations', 'POST', {})).data;
    const self = await json('alice', '/friends/accept', 'POST', { token: invite.token });
    expect(self.status).toBe(400);
    expect(self.data.error.code).toBe('SELF_INVITE');
    expect((await json('bob', '/friends/accept', 'POST', { token: invite.token })).status).toBe(
      200,
    );
    expect((await json('charlie', '/friends/accept', 'POST', { token: invite.token })).status).toBe(
      410,
    );
    const raw = await env.DB.prepare('SELECT token_hash FROM invitations').first<{
      token_hash: string;
    }>();
    expect(raw?.token_hash).not.toBe(invite.token);
  });
  it('allows just one recipient to consume a concurrently accepted invitation', async () => {
    await call('alice', '/me');
    const invite = (await json('alice', '/friends/invitations', 'POST', {})).data;
    const responses = await Promise.all([
      json('bob', '/friends/accept', 'POST', { token: invite.token }),
      json('charlie', '/friends/accept', 'POST', { token: invite.token }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 410]);
    expect((await json('alice', '/friends')).data.friends).toHaveLength(1);
  });
  it('rejects an expired invitation without creating a friendship', async () => {
    await call('alice', '/me');
    const invite = (await json('alice', '/friends/invitations', 'POST', {})).data;
    await env.DB.prepare("UPDATE invitations SET expires_at='2000-01-01T00:00:00.000Z'").run();
    expect((await json('bob', '/friends/accept', 'POST', { token: invite.token })).status).toBe(
      410,
    );
    expect((await json('bob', '/friends')).data.friends).toHaveLength(0);
  });
  it('revokes reciprocal owned-plan membership and checkins after unfriending', async () => {
    await befriend('alice', 'bob');
    const p = await plan('alice', { memberIds: ['bob'] });
    await json('bob', `/plans/${p.id}/checkins`, 'POST', {
      date: today(),
      completed: true,
      operationId: crypto.randomUUID(),
    });
    expect((await json('bob', '/friends/alice', 'DELETE')).status).toBe(200);
    expect((await json('bob', `/plans?date=${today()}`)).data.plans).toEqual([]);
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM checkins WHERE user_id=?')
          .bind('bob')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it('allows only one optimistic concurrent update and keeps the winning members', async () => {
    const p = await plan();
    const outcomes = await Promise.all([
      json('alice', `/plans/${p.id}`, 'PATCH', { version: 1, title: 'First' }),
      json('alice', `/plans/${p.id}`, 'PATCH', { version: 1, title: 'Second' }),
    ]);
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
    const current = (await json('alice', `/plans?date=${today()}`)).data.plans[0];
    expect(current.version).toBe(2);
    expect(current.members).toHaveLength(1);
  });
  it('can edit a plan with the maximum twenty friends without counting its owner as an extra input member', async () => {
    await call('alice', '/me');
    const ids = Array.from({ length: 20 }, (_, i) => `friend${i}`),
      stamp = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users(uid,email,display_name,settings_json,created_at,updated_at) SELECT value,value||'@example.test',value,?,?,? FROM json_each(?)",
      ).bind(JSON.stringify(DEFAULT_SETTINGS), stamp, stamp, JSON.stringify(ids)),
      env.DB.prepare(
        "INSERT INTO friendships(user_low,user_high,created_at) SELECT 'alice',value,? FROM json_each(?)",
      ).bind(stamp, JSON.stringify(ids)),
    ]);
    const p = await plan('alice', { memberIds: ids });
    expect(p.members).toHaveLength(21);
    const edited = await json('alice', `/plans/${p.id}`, 'PATCH', { version: 1, title: 'Updated' });
    expect(edited.status).toBe(200);
    expect(edited.data.plan.members).toHaveLength(21);
  });
});
describe('offline operations and reminders', () => {
  it('creates an offline plan exactly once under concurrent retries and binds the key to its payload', async () => {
    const headers = { 'Idempotency-Key': crypto.randomUUID() },
      body = input({ place: { lat: 51.128, lng: 71.43, label: 'Бәйтерек' } });
    const responses = await Promise.all([
      json('alice', '/plans', 'POST', body, headers),
      json('alice', '/plans', 'POST', body, headers),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(responses[0].data.plan.id).toBe(responses[1].data.plan.id);
    const changed = await json('alice', '/plans', 'POST', { ...body, title: 'Different' }, headers);
    expect(changed.status).toBe(409);
    expect(changed.data.error.code).toBe('OPERATION_CONFLICT');
    expect((await json('alice', `/plans?date=${today()}`)).data.plans).toHaveLength(1);
    expect((await json('bob', '/plans', 'POST', body, headers)).status).toBe(201);
    expect(
      (await json('alice', '/plans', 'POST', body, { 'Idempotency-Key': 'not-a-uuid' })).status,
    ).toBe(400);
  });
  it('does not restore revoked members or deleted plans when replaying a creation receipt', async () => {
    await befriend('alice', 'bob');
    const headers = { 'Idempotency-Key': crypto.randomUUID() },
      body = input({ memberIds: ['bob'] });
    const created = await json('alice', '/plans', 'POST', body, headers);
    expect(created.status).toBe(201);
    await json('bob', '/friends/alice', 'DELETE');
    const replay = await json('alice', '/plans', 'POST', body, headers);
    expect(replay.status).toBe(200);
    expect(replay.data.plan.members.map((m: any) => m.uid)).toEqual(['alice']);
    expect(
      (await json('alice', '/plans', 'POST', body, { 'Idempotency-Key': crypto.randomUUID() })).data
        .error.code,
    ).toBe('MEMBER_NOT_FRIEND');
    await json('alice', `/plans/${created.data.plan.id}`, 'DELETE');
    expect((await json('alice', '/plans', 'POST', body, headers)).data.error.code).toBe(
      'PLAN_NOT_FOUND',
    );
    expect((await json('alice', `/plans?date=${today()}`)).data.plans).toHaveLength(0);
  });
  it('does not mutate the winning plan when simultaneous creation payloads reuse a key', async () => {
    const headers = { 'Idempotency-Key': crypto.randomUUID() };
    const responses = await Promise.all([
      json('alice', '/plans', 'POST', input({ title: 'First' }), headers),
      json('alice', '/plans', 'POST', input({ title: 'Second' }), headers),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const current = (await json('alice', `/plans?date=${today()}`)).data.plans;
    expect(current).toHaveLength(1);
    expect(current[0].title).toBe(responses.find((r) => r.status === 201)!.data.plan.title);
  });
  it('rolls back plan and receipt when friendship is revoked between validation and the creation transaction', async () => {
    await befriend('alice', 'bob');
    const key = crypto.randomUUID();
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare("DELETE FROM friendships WHERE user_low='alice' AND user_high='bob'")
              .run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await app.request(
      'https://app.example.test/api/plans',
      {
        method: 'POST',
        headers: {
          'x-test-user': 'alice',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(input({ memberIds: ['bob'] })),
      },
      { ...env, DB: db },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error.code).toBe('MEMBER_NOT_FRIEND');
    expect(
      (await env.DB.prepare('SELECT count(*) AS n FROM plans').first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM plan_create_operations').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });
  it('replays the same contribution exactly once and rejects changed payloads', async () => {
    const p = await plan('alice', { kind: 'savings', targetAmount: 40000 });
    const operation = {
      date: today(),
      completed: true,
      contribution: 20000,
      operationId: crypto.randomUUID(),
    };
    expect((await json('alice', `/plans/${p.id}/checkins`, 'POST', operation)).status).toBe(200);
    expect((await json('alice', `/plans/${p.id}/checkins`, 'POST', operation)).status).toBe(200);
    expect(
      (
        await json('alice', `/plans/${p.id}/checkins`, 'POST', {
          ...operation,
          contribution: 40000,
        })
      ).status,
    ).toBe(409);
    const current = (await json('alice', `/plans?date=${today()}`)).data.plans[0];
    expect(current.members[0].contribution).toBe(20000);
  });
  it('does not let an older replay overwrite a later offline change', async () => {
    const p = await plan();
    const first = { date: today(), completed: true, operationId: crypto.randomUUID() };
    await json('alice', `/plans/${p.id}/checkins`, 'POST', first);
    await json('alice', `/plans/${p.id}/checkins`, 'POST', {
      ...first,
      completed: false,
      operationId: crypto.randomUUID(),
    });
    await json('alice', `/plans/${p.id}/checkins`, 'POST', first);
    expect((await json('alice', `/plans?date=${today()}`)).data.plans[0].members[0].completed).toBe(
      false,
    );
  });
  it('enforces nudge preferences, recipients, completion, and daily cooldown', async () => {
    await befriend('alice', 'bob');
    await json('bob', '/settings', 'PATCH', { quietStart: '00:00', quietEnd: '00:00' });
    const p = await plan('alice', { memberIds: ['bob'] });
    const payload = { date: today(), toUserId: 'bob' };
    expect((await json('alice', `/plans/${p.id}/nudges`, 'POST', payload)).status).toBe(200);
    expect((await json('alice', `/plans/${p.id}/nudges`, 'POST', payload)).status).toBe(429);
    expect(
      (await json('alice', `/plans/${p.id}/nudges`, 'POST', { ...payload, toUserId: 'mallory' }))
        .status,
    ).toBe(403);
    expect((await json('bob', '/notifications')).data.notifications).toHaveLength(1);
    expect((await json('alice', '/notifications')).data.notifications).toHaveLength(0);
  });
  it('cron queues each incomplete recipient once and skips completed members', async () => {
    await befriend('alice', 'bob');
    await json('alice', '/settings', 'PATCH', { quietStart: '00:00', quietEnd: '00:00' });
    await json('bob', '/settings', 'PATCH', { quietStart: '00:00', quietEnd: '00:00' });
    const p = await plan('alice', { memberIds: ['bob'] });
    await json('alice', `/plans/${p.id}/checkins`, 'POST', {
      date: today(),
      completed: true,
      operationId: crypto.randomUUID(),
    });
    const now = new Date();
    await env.DB.prepare('UPDATE plans SET next_reminder_at=?,next_reminder_date=? WHERE id=?')
      .bind(new Date(now.getTime() - 1000).toISOString(), today(), p.id)
      .run();
    expect(await enqueueDueReminders(env, now)).toBe(1);
    expect(await enqueueDueReminders(env, now)).toBe(0);
    expect((await json('bob', '/notifications')).data.notifications).toHaveLength(1);
    expect((await json('alice', '/notifications')).data.notifications).toHaveLength(0);
  });
  it('stores no due date for disabled reminders', async () => {
    const p = await plan('alice', { remindMinutes: -1 });
    const row = await env.DB.prepare('SELECT next_reminder_at FROM plans WHERE id=?')
      .bind(p.id)
      .first<{ next_reminder_at: string | null }>();
    expect(row?.next_reminder_at).toBeNull();
  });
  it('honors quiet hours and completed-recipient state before creating any nudge', async () => {
    await befriend('alice', 'bob');
    const p = await plan('alice', { memberIds: ['bob'] });
    await json('bob', '/settings', 'PATCH', {
      quietStart: '00:00',
      quietEnd: '00:00',
      friendNudges: false,
    });
    expect(
      (await json('alice', `/plans/${p.id}/nudges`, 'POST', { date: today(), toUserId: 'bob' }))
        .data.error.code,
    ).toBe('NUDGES_DISABLED');
    await json('bob', '/settings', 'PATCH', { friendNudges: true });
    await json('bob', `/plans/${p.id}/checkins`, 'POST', {
      date: today(),
      completed: true,
      operationId: crypto.randomUUID(),
    });
    expect(
      (await json('alice', `/plans/${p.id}/nudges`, 'POST', { date: today(), toUserId: 'bob' }))
        .data.error.code,
    ).toBe('ALREADY_COMPLETED');
    expect((await json('bob', '/notifications')).data.notifications).toHaveLength(0);
  });
});
describe('privacy and deletion', () => {
  it('caps push registration at three devices and allows replacing an existing one', async () => {
    const devices = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    for (let i = 0; i < 3; i++)
      expect(
        (
          await json('alice', '/push/tokens', 'POST', {
            deviceId: devices[i],
            token: `token-device-${i}-123456789012345`,
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await json('alice', '/push/tokens', 'POST', {
          deviceId: devices[3],
          token: 'token-device-4-123456789012345',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await json('alice', '/push/tokens', 'POST', {
          deviceId: devices[0],
          token: 'replacement-token-123456789012345',
        })
      ).status,
    ).toBe(200);
  });
  it('enforces the device cap even when registrations race', async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        json('alice', '/push/tokens', 'POST', {
          deviceId: crypto.randomUUID(),
          token: `concurrent-device-${i}-1234567890`,
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 409]);
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM push_tokens WHERE user_id=?')
          .bind('alice')
          .first<{ n: number }>()
      )?.n,
    ).toBe(3);
  });
  it("does not expose another user's email or push tokens in export", async () => {
    await befriend('alice', 'bob');
    await plan('alice', { memberIds: ['bob'] });
    await json('bob', '/push/tokens', 'POST', {
      deviceId: crypto.randomUUID(),
      token: 'private-bob-device-token-12345678',
    });
    const exported = await json('alice', '/export');
    expect(JSON.stringify(exported.data)).not.toContain('bob@example.test');
    expect(JSON.stringify(exported.data)).not.toContain('private-bob');
  });
  it("paginates same-date checkins without omissions, duplicates or another user's data", async () => {
    const plans = await Promise.all([plan('alice'), plan('alice'), plan('alice')]);
    for (const p of plans)
      await json('alice', `/plans/${p.id}/checkins`, 'POST', {
        date: today(),
        completed: true,
        operationId: crypto.randomUUID(),
      });
    const other = await plan('bob');
    await json('bob', `/plans/${other.id}/checkins`, 'POST', {
      date: today(),
      completed: true,
      operationId: crypto.randomUUID(),
    });
    const first = await json('alice', '/export?limit=2');
    expect(first.data.checkins).toHaveLength(2);
    expect(first.data.nextCursor).toBeTypeOf('string');
    expect(first.data.profile.uid).toBe('alice');
    const second = await json('alice', `/export?limit=2&cursor=${first.data.nextCursor}`);
    expect(second.data.checkins).toHaveLength(1);
    expect(second.data.nextCursor).toBeNull();
    expect(second.data.profile).toBeUndefined();
    expect(
      [...first.data.checkins, ...second.data.checkins].map((r: any) => r.plan_id).sort(),
    ).toEqual(plans.map((p) => p.id).sort());
    expect((await json('alice', '/export?limit=1001')).status).toBe(400);
    expect((await json('alice', '/export?cursor=invalid')).status).toBe(400);
  });
  it('erases owned/shared data and permanently prevents profile recreation', async () => {
    await befriend('alice', 'bob');
    await plan('alice', { memberIds: ['bob'] });
    expect((await json('alice', '/me', 'DELETE')).status).toBe(200);
    expect((await json('alice', '/me')).status).toBe(401);
    expect((await json('bob', `/plans?date=${today()}`)).data.plans).toEqual([]);
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM users WHERE uid=?')
          .bind('alice')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it('requires recent authentication before erasing any data', async () => {
    await plan('alice');
    const stale = createApi(async () => ({
      uid: 'alice',
      email: 'alice@example.test',
      authTime: Math.floor(Date.now() / 1000) - 3600,
      token: 'stale',
    }));
    const response = await stale.request(
      'https://app.example.test/api/me',
      { method: 'DELETE' },
      env,
    );
    expect(response.status).toBe(401);
    expect((await json('alice', `/plans?date=${today()}`)).data.plans).toHaveLength(1);
    expect(vi.mocked(deleteFirebaseAccount)).not.toHaveBeenCalled();
  });
  it('keeps a tombstone when external auth deletion fails and permits a deletion retry', async () => {
    await plan('alice');
    vi.mocked(deleteFirebaseAccount).mockRejectedValueOnce(new Error('Provider unavailable'));
    const first = await json('alice', '/me', 'DELETE');
    expect(first.status).toBe(503);
    expect(first.data.error.code).toBe('AUTH_DELETE_PENDING');
    expect((await json('alice', '/me')).data.error.code).toBe('ACCOUNT_DELETED');
    expect((await json('alice', '/me', 'DELETE')).status).toBe(200);
  });
});
