import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createApi } from '../../src/api/app';
import { HttpError, type Env, type Identity } from '../../src/api/types';
import { studyDataSchema } from '../../src/api/study/schema';
import { saveStudyDocument, type StudyRow } from '../../src/api/study/repository';
import type { StudyData, StudyResponse } from '../../src/shared/study';

let mf: Miniflare, env: Env;
const now = Date.parse('2026-11-23T10:00:00Z');
const firstId = 'c61ba791-28b8-4eb0-80d9-153453a0975c';
const secondId = 'b72d5f55-47c0-4df9-9b2b-416f92c88187';
const app = createApi(async (request) => {
  const uid = request.headers.get('x-test-user');
  if (!uid) throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in required');
  return {
    uid,
    email: `${uid}@example.test`,
    name: uid,
    authTime: Math.floor(Date.now() / 1000),
    token: 'injected-test-only',
  } satisfies Identity;
});
function data(): StudyData {
  return {
    term: {
      title: 'Winter trimester',
      institution: 'Test University',
      course: '2',
      startDate: '2026-12-07',
      endDate: '2027-02-13',
      timeZone: 'Asia/Almaty',
      remindMinutes: 15,
      roomInPush: false,
      periods: [
        {
          id: '96dd74f4-aecf-423e-b8d8-3fd78079270f',
          title: 'Exams',
          kind: 'exams',
          startDate: '2027-02-15',
          endDate: '2027-02-27',
        },
      ],
      holidays: [{ date: '2026-12-16', title: 'Holiday' }],
      incompleteDays: [
        { weekday: 6, note: 'Missing source', expectedCount: null, firstTime: '11:00' },
      ],
    },
    lessons: [
      {
        id: firstId,
        weekday: 1,
        startTime: '13:05',
        endTime: '13:55',
        title: 'Mathematics',
        teacher: 'Teacher',
        room: 'TEST-A42',
        campus: 'Main',
        kind: 'practice',
        format: 'campus',
        url: '',
      },
    ],
    overrides: [],
  };
}
function call(uid: string | null, method = 'GET', body?: unknown, suffix = '') {
  return app.request(
    `https://app.example.test/api/study${suffix}`,
    {
      method,
      headers: {
        Origin: env.APP_ORIGIN,
        ...(uid ? { 'x-test-user': uid } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function save(uid = 'alice', value = data(), version = 0) {
  const response = await call(uid, 'PUT', { version, data: value });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as StudyResponse;
}
async function row(uid = 'alice') {
  return env.DB.prepare('SELECT * FROM study_documents WHERE user_id=?')
    .bind(uid)
    .first<StudyRow>();
}
async function notification(uid: string, version: number | null) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO notifications(id,user_id,plan_id,kind,title,body,created_at,next_attempt_at,dedupe_key,study_lesson_id,study_date,study_version)
    VALUES(?,?,NULL,'reminder','DayPact','private fixture',?,?,?,?,?,?)`,
  )
    .bind(
      id,
      uid,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      id,
      version === null ? null : firstId,
      version === null ? null : '2026-12-07',
      version,
    )
    .run();
  return id;
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("study-api-test")}}',
      compatibilityDate: '2026-11-19',
      d1Databases: { DB: 'study-security' },
      d1Persist: false,
    }),
  );
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const directory = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    let statement = '',
      trigger = false;
    for (const line of readFileSync(new URL(file, directory), 'utf8').split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith('--')) continue;
      if (clean.startsWith('CREATE TRIGGER')) trigger = true;
      statement += ` ${clean}`;
      if ((!trigger && clean.endsWith(';')) || (trigger && /END;$/.test(clean))) {
        await db.prepare(statement).run();
        statement = '';
        trigger = false;
      }
    }
    expect(statement.trim()).toBe('');
  }
  env = {
    DB: db,
    ASSETS: {} as Fetcher,
    APP_ORIGIN: 'https://app.example.test',
    FIREBASE_PROJECT_ID: 'study-test',
    FIREBASE_WEB_API_KEY: 'public-test',
  };
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await env.DB.batch(
    [
      'DELETE FROM users',
      'DELETE FROM user_moderation',
      'DELETE FROM deleted_accounts',
      'DELETE FROM rate_limits',
    ].map((sql) => env.DB.prepare(sql)),
  );
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await mf.dispose();
});

describe('private study API', () => {
  it('requires authentication and never accepts a caller-selected user identity', async () => {
    expect((await call(null)).status).toBe(401);
    const saved = await save();
    expect(saved.study?.version).toBe(1);
    expect((await call('bob')).status).toBe(200);
    expect(((await (await call('bob')).json()) as StudyResponse).study).toBeNull();
    expect((await call('bob', 'GET', undefined, '?userId=alice')).status).toBe(400);
    expect((await call('bob', 'PUT', { version: 0, data: data(), userId: 'alice' })).status).toBe(
      400,
    );
    const own = await call('alice');
    expect(own.headers.get('Cache-Control')).toContain('no-store');
    expect(((await own.json()) as StudyResponse).study?.lessons[0]?.room).toBe('TEST-A42');
  });

  it('persists owner-specific changes and computes a future reminder cursor', async () => {
    await save('alice');
    const other = data();
    other.lessons[0]!.room = 'OTHER';
    await save('bob', other);
    const first = await row('alice'),
      second = await row('bob');
    expect(JSON.parse(first!.data_json).lessons[0].room).toBe('TEST-A42');
    expect(JSON.parse(second!.data_json).lessons[0].room).toBe('OTHER');
    expect(first?.next_reminder_at).toBe('2026-12-07T07:50:00.000Z');
    expect(first?.next_reminder_date).toBe('2026-12-07');
    expect(first?.next_reminder_lesson).toBe(firstId);
  });

  it('rejects invalid nested fields, dates, durations, zones and unsafe links', async () => {
    const corrupt: Array<(d: StudyData) => void> = [
      (d) => {
        (d.term as unknown as Record<string, unknown>).userId = 'bob';
      },
      (d) => {
        d.term.startDate = '2026-02-30';
      },
      (d) => {
        d.term.endDate = '2026-12-06';
      },
      (d) => {
        d.term.endDate = '2030-01-01';
      },
      (d) => {
        d.term.timeZone = 'Invalid/Zone';
      },
      (d) => {
        d.term.remindMinutes = 9999;
      },
      (d) => {
        d.lessons[0]!.endTime = '12:00';
      },
      (d) => {
        d.lessons[0]!.startTime = '25:00';
      },
      (d) => {
        d.lessons[0]!.url = 'javascript:alert(1)';
      },
      (d) => {
        d.lessons[0]!.url = 'http://example.test';
      },
      (d) => {
        d.lessons[0]!.url = 'https://secret:pass@example.test';
      },
      (d) => {
        d.lessons.push({ ...d.lessons[0]! });
      },
      (d) => {
        d.term.holidays.push({ ...d.term.holidays[0]! });
      },
      (d) => {
        d.term.incompleteDays.push({ ...d.term.incompleteDays[0]! });
      },
    ];
    for (const mutate of corrupt) {
      const value = data();
      mutate(value);
      expect((await call('alice', 'PUT', { version: 0, data: value })).status).toBe(400);
    }
    expect(await row()).toBeNull();
  });

  it('validates overrides against the same document, weekday and teaching dates', async () => {
    const value = data();
    value.overrides.push({
      lessonId: firstId,
      date: '2026-12-07',
      cancelled: false,
      startTime: '13:10',
      endTime: '14:00',
      room: 'NEW',
      campus: 'Main',
      format: 'campus',
      url: '',
      note: 'Moved',
    });
    await save('alice', value);
    for (const mutate of [
      (d: StudyData) => {
        d.overrides[0]!.lessonId = secondId;
      },
      (d: StudyData) => {
        d.overrides[0]!.date = '2026-12-08';
      },
      (d: StudyData) => {
        d.overrides[0]!.date = '2027-02-15';
      },
      (d: StudyData) => {
        d.overrides[0]!.endTime = '12:00';
      },
      (d: StudyData) => {
        d.overrides.push({ ...d.overrides[0]! });
      },
    ]) {
      const changed = structuredClone(value);
      mutate(changed);
      expect((await call('alice', 'PUT', { version: 1, data: changed })).status).toBe(400);
    }
    expect((await row())?.version).toBe(1);
  });

  it('supports periods beyond teaching end but bounds calendar resources', async () => {
    const value = data();
    value.term.holidays.push({ date: '2027-03-08', title: 'Holiday' });
    value.term.periods.push({
      id: secondId,
      title: 'Vacation',
      kind: 'vacation',
      startDate: '2027-03-01',
      endDate: '2027-03-13',
    });
    await save('alice', value);
    value.term.periods[1]!.endDate = '2099-01-01';
    expect((await call('alice', 'PUT', { version: 1, data: value })).status).toBe(400);
  });

  it('accepts exact request retries without advancing versions or restoring a consumed cursor', async () => {
    const value = data();
    await save('alice', value);
    await env.DB.prepare(
      'UPDATE study_documents SET next_reminder_at=NULL,next_reminder_date=NULL,next_reminder_lesson=NULL WHERE user_id=?',
    )
      .bind('alice')
      .run();
    await env.DB.prepare(
      'INSERT INTO study_reminder_receipts(user_id,lesson_id,occurrence_date) VALUES(?,?,?)',
    )
      .bind('alice', firstId, '2026-12-07')
      .run();
    const retry = await save('alice', value);
    expect(retry.study?.version).toBe(1);
    expect((await row())?.next_reminder_at).toBeNull();
    value.lessons[0]!.room = 'REVISED';
    await save('alice', value, 1);
    expect((await save('alice', value, 1)).study?.version).toBe(2);
    expect(
      await env.DB.prepare('SELECT 1 FROM study_reminder_receipts WHERE user_id=?')
        .bind('alice')
        .first(),
    ).not.toBeNull();
    expect((await call('alice', 'PUT', { version: 0, data: value })).status).toBe(409);
  });

  it('allows only one conflicting concurrent version update', async () => {
    await save();
    const first = data(),
      second = data();
    first.lessons[0]!.room = 'A';
    second.lessons[0]!.room = 'B';
    const responses = await Promise.all([
      call('alice', 'PUT', { version: 1, data: first }),
      call('alice', 'PUT', { version: 1, data: second }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const persisted = await row();
    expect(persisted?.version).toBe(2);
    expect(['A', 'B']).toContain(JSON.parse(persisted!.data_json).lessons[0].room);
  });

  it('invalidates stale queued study reminders only for a successful owner update', async () => {
    await save();
    await save('bob');
    const old = await notification('alice', 1),
      normal = await notification('alice', null),
      other = await notification('bob', 1);
    const value = data();
    value.lessons[0]!.room = 'NEW';
    await save('alice', value, 1);
    const state = async (id: string) =>
      (
        await env.DB.prepare('SELECT state FROM notifications WHERE id=?')
          .bind(id)
          .first<{ state: string }>()
      )?.state;
    expect(await state(old)).toBe('skipped');
    expect(await state(normal)).toBe('pending');
    expect(await state(other)).toBe('pending');
    const winner = await notification('alice', 2);
    expect((await call('alice', 'PUT', { version: 1, data: data() })).status).toBe(409);
    expect(await state(winner)).toBe('pending');
  });

  it('disables the cursor when reminders are off or the term is over', async () => {
    const value = data();
    value.term.remindMinutes = -1;
    await save('alice', value);
    expect((await row())?.next_reminder_at).toBeNull();
    value.term.remindMinutes = 15;
    vi.setSystemTime(Date.parse('2027-03-01T10:00:00Z'));
    await save('alice', value, 1);
    expect((await row())?.next_reminder_at).toBeNull();
  });

  it('rejects suspended identities and protects the atomic write against delayed access', async () => {
    await save();
    await env.DB.prepare(
      "INSERT INTO user_moderation(user_id,state,updated_at) VALUES(?,'suspended',?)",
    )
      .bind('alice', new Date(now).toISOString())
      .run();
    expect((await call('alice')).status).toBe(403);
    const value = data();
    value.lessons[0]!.room = 'FORBIDDEN';
    await expect(saveStudyDocument(env, 'alice', 1, value)).rejects.toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
    });
    expect((await row())?.version).toBe(1);
  });

  it('cascades private schedules and reminder receipts when the account is deleted', async () => {
    await save();
    await save('bob');
    await env.DB.prepare(
      'INSERT INTO study_reminder_receipts(user_id,lesson_id,occurrence_date) VALUES(?,?,?)',
    )
      .bind('alice', firstId, '2026-12-07')
      .run();
    const queued = await notification('alice', 1);
    await env.DB.prepare('DELETE FROM users WHERE uid=?').bind('alice').run();
    expect(await row()).toBeNull();
    expect(await row('bob')).not.toBeNull();
    expect(
      await env.DB.prepare('SELECT 1 FROM study_reminder_receipts WHERE user_id=?')
        .bind('alice')
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT 1 FROM notifications WHERE id=?').bind(queued).first(),
    ).toBeNull();
    await expect(saveStudyDocument(env, 'alice', 0, data())).rejects.toMatchObject({
      code: 'ACCOUNT_DELETED',
    });
  });

  it('limits editing attempts per authenticated user', async () => {
    for (let index = 0; index < 30; index++) await save();
    expect((await call('alice', 'PUT', { version: 0, data: data() })).status).toBe(429);
    expect((await save('bob')).study?.version).toBe(1);
  });

  it('bounds collection counts and UTF-8 storage size', () => {
    const large = data();
    large.lessons = Array.from({ length: 51 }, () => ({
      ...data().lessons[0]!,
      id: crypto.randomUUID(),
    }));
    expect(studyDataSchema.safeParse(large).success).toBe(false);
    large.lessons = Array.from({ length: 50 }, () => ({
      ...data().lessons[0]!,
      id: crypto.randomUUID(),
      title: 'Ж'.repeat(120),
      teacher: 'Ж'.repeat(100),
      room: 'Ж'.repeat(80),
      campus: 'Ж'.repeat(120),
    }));
    expect(studyDataSchema.safeParse(large).success).toBe(false);
  });
});
