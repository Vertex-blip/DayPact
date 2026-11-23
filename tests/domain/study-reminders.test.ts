import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/contracts';
import type { StudyData } from '../../src/shared/study';
import { nextStudyReminder } from '../../src/shared/studyTime';
import { createStudySeed } from '../fixtures/study';
import { saveStudyDocument, type StudyRow } from '../../src/api/study/repository';
import { enqueueDueStudyReminders } from '../../src/api/study-reminders';
import type { Env } from '../../src/api/types';

let mf: Miniflare, env: Env;
const beforeTerm = new Date('2026-11-23T10:00:00Z');
const due = new Date('2026-12-07T07:50:30Z');
function data(): StudyData {
  const value = createStudySeed();
  value.lessons = value.lessons.filter((item) => item.weekday === 1 && item.startTime === '13:05');
  return value;
}
async function fixture(uid = 'alice', value = data(), preferences: Partial<Settings> = {}) {
  const settings = { ...DEFAULT_SETTINGS, quietStart: '00:00', quietEnd: '00:00', ...preferences };
  await env.DB.prepare(
    'INSERT INTO users(uid,email,display_name,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',
  )
    .bind(
      uid,
      `${uid}@example.test`,
      uid,
      JSON.stringify(settings),
      beforeTerm.toISOString(),
      beforeTerm.toISOString(),
    )
    .run();
  await saveStudyDocument(env, uid, 0, value, beforeTerm);
  return value;
}
async function row(uid = 'alice') {
  return (await env.DB.prepare('SELECT * FROM study_documents WHERE user_id=?')
    .bind(uid)
    .first<StudyRow>())!;
}
async function counts() {
  const result = await env.DB.prepare(
    'SELECT (SELECT count(*) FROM notifications) AS notifications,(SELECT count(*) FROM study_reminder_receipts) AS receipts',
  ).first<{ notifications: number; receipts: number }>();
  return result!;
}
async function rewind(uid = 'alice') {
  const current = await row(uid);
  const cursor = nextStudyReminder(JSON.parse(current.data_json) as StudyData, beforeTerm)!;
  await env.DB.prepare(
    'UPDATE study_documents SET next_reminder_at=?,next_reminder_date=?,next_reminder_lesson=? WHERE user_id=?',
  )
    .bind(cursor.at, cursor.date, cursor.lessonId, uid)
    .run();
}
/** A real D1 write between selection and the atomic enqueue transaction. */
function beforeBatch(callback: () => Promise<void>, sizes: number[] = []): Env {
  let called = false;
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          sizes.push(statements.length);
          if (!called) {
            called = true;
            await callback();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...env, DB: db };
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("study-reminders-test")}}',
      compatibilityDate: '2026-11-19',
      d1Databases: { DB: 'study-reminders-test' },
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
  await env.DB.batch(
    ['DELETE FROM users', 'DELETE FROM user_moderation', 'DELETE FROM deleted_accounts'].map(
      (sql) => env.DB.prepare(sql),
    ),
  );
});
afterAll(async () => {
  await mf.dispose();
});

describe('private timetable reminder queue', () => {
  it('queues owner-only metadata with no classroom, subject or teacher in stored push text', async () => {
    const value = await fixture();
    await fixture('bob');
    expect(await enqueueDueStudyReminders(env, due, 1)).toBe(1);
    const notification = await env.DB.prepare('SELECT * FROM notifications').first<
      Record<string, unknown>
    >();
    expect(notification).toMatchObject({
      user_id: 'alice',
      plan_id: null,
      kind: 'reminder',
      title: 'DayPact',
      body: 'Сабақ жақында басталады.',
      study_version: 1,
      study_date: '2026-12-07',
      study_lesson_id: value.lessons[0]!.id,
    });
    expect(notification?.dedupe_key).toBe(`study:alice:${value.lessons[0]!.id}:2026-12-07`);
    for (const privateText of [
      value.lessons[0]!.room,
      value.lessons[0]!.title,
      value.lessons[0]!.teacher,
    ])
      expect(String(notification?.body)).not.toContain(privateText);
    expect((await row()).next_reminder_at).toBe('2026-12-14T07:50:00.000Z');
    expect(await counts()).toEqual({ notifications: 1, receipts: 1 });
  });

  it('processes all 50 tied lessons in a fixed three-statement batch', async () => {
    const value = data();
    value.lessons = Array.from({ length: 50 }, (_, index) => ({
      ...value.lessons[0]!,
      id: crypto.randomUUID(),
      title: `Lesson ${index}`,
    }));
    await fixture('alice', value);
    const sizes: number[] = [];
    expect(
      await enqueueDueStudyReminders(
        beforeBatch(async () => {}, sizes),
        due,
      ),
    ).toBe(50);
    expect(sizes).toEqual([3]);
    expect(await counts()).toEqual({ notifications: 50, receipts: 50 });
  });

  it('deduplicates overlapping cron runs and exact retries', async () => {
    await fixture();
    const results = await Promise.all([
      enqueueDueStudyReminders(env, due),
      enqueueDueStudyReminders(env, due),
    ]);
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
    await rewind();
    expect(await enqueueDueStudyReminders(env, due)).toBe(0);
    expect(await counts()).toEqual({ notifications: 1, receipts: 1 });
  });

  it.each([{ notificationsEnabled: false }, { quietStart: '12:00', quietEnd: '14:00' }])(
    'consumes muted/quiet occurrences without replay after settings change: %j',
    async (preferences) => {
      await fixture('alice', data(), preferences);
      expect(await enqueueDueStudyReminders(env, due)).toBe(0);
      expect(await counts()).toEqual({ notifications: 0, receipts: 1 });
      await env.DB.prepare('UPDATE users SET settings_json=? WHERE uid=?')
        .bind(
          JSON.stringify({ ...DEFAULT_SETTINGS, quietStart: '00:00', quietEnd: '00:00' }),
          'alice',
        )
        .run();
      await rewind();
      expect(await enqueueDueStudyReminders(env, due)).toBe(0);
      expect((await row()).next_reminder_date).toBe('2026-12-14');
    },
  );

  it('drops an occurrence as soon as its class has begun', async () => {
    await fixture();
    expect(await enqueueDueStudyReminders(env, new Date('2026-12-07T08:05:00Z'))).toBe(0);
    expect(await counts()).toEqual({ notifications: 0, receipts: 1 });
  });

  it.each(['suspended', 'delete_pending', 'deleted'])(
    'does not enqueue for %s accounts',
    async (state) => {
      await fixture();
      await env.DB.prepare('INSERT INTO user_moderation(user_id,state,updated_at) VALUES(?,?,?)')
        .bind('alice', state, beforeTerm.toISOString())
        .run();
      expect(await enqueueDueStudyReminders(env, due)).toBe(0);
      expect(await counts()).toEqual({ notifications: 0, receipts: 1 });
    },
  );

  it('checks a deletion tombstone and current moderation inside the transaction', async () => {
    await fixture();
    const raced = beforeBatch(async () => {
      await env.DB.prepare('INSERT INTO deleted_accounts(uid,deleted_at) VALUES(?,?)')
        .bind('alice', due.toISOString())
        .run();
    });
    expect(await enqueueDueStudyReminders(raced, due)).toBe(0);
    expect(await counts()).toEqual({ notifications: 0, receipts: 1 });
  });

  it('never processes more than two user documents in one invocation', async () => {
    await fixture('alice');
    await fixture('bob');
    await fixture('charlie');
    expect(await enqueueDueStudyReminders(env, due, 1000)).toBe(2);
    expect((await row('charlie')).next_reminder_at).toBe('2026-12-07T07:50:00.000Z');
    expect(await enqueueDueStudyReminders(env, due)).toBe(1);
    expect(await counts()).toEqual({ notifications: 3, receipts: 3 });
  });

  it('cannot replay a consumed lesson/day after an edit moves it later', async () => {
    const value = await fixture();
    expect(await enqueueDueStudyReminders(env, due)).toBe(1);
    value.lessons[0]!.startTime = '13:35';
    value.lessons[0]!.endTime = '14:25';
    await saveStudyDocument(env, 'alice', 1, value, due);
    expect(await enqueueDueStudyReminders(env, new Date('2026-12-07T08:20:30Z'))).toBe(0);
    expect(await counts()).toEqual({ notifications: 1, receipts: 1 });
    expect(await env.DB.prepare('SELECT state FROM notifications').first('state')).toBe('skipped');
  });

  it('a concurrent cancellation invalidates the entire old cursor transaction', async () => {
    const value = await fixture();
    const lesson = value.lessons[0]!;
    value.overrides.push({
      lessonId: lesson.id,
      date: '2026-12-07',
      cancelled: true,
      startTime: lesson.startTime,
      endTime: lesson.endTime,
      room: lesson.room,
      campus: lesson.campus,
      format: lesson.format,
      url: lesson.url,
      note: 'Cancelled',
    });
    const raced = beforeBatch(async () => {
      await saveStudyDocument(env, 'alice', 1, value, due);
    });
    expect(await enqueueDueStudyReminders(raced, due)).toBe(0);
    expect(await counts()).toEqual({ notifications: 0, receipts: 0 });
    expect(await row()).toMatchObject({ version: 2, next_reminder_date: '2026-12-14' });
  });

  it('rechecks notification preferences before inserting after a concurrent mute', async () => {
    await fixture();
    const raced = beforeBatch(async () => {
      await env.DB.prepare('UPDATE users SET settings_json=? WHERE uid=?')
        .bind(JSON.stringify({ ...DEFAULT_SETTINGS, notificationsEnabled: false }), 'alice')
        .run();
    });
    expect(await enqueueDueStudyReminders(raced, due)).toBe(0);
    expect(await counts()).toEqual({ notifications: 0, receipts: 1 });
  });

  it('honors dated overrides and holidays and terminates at the teaching end', async () => {
    const value = data();
    value.term.holidays.push({ date: '2026-12-07', title: 'No classes' });
    await fixture('alice', value);
    expect((await row()).next_reminder_date).toBe('2026-12-14');
    expect(await enqueueDueStudyReminders(env, due)).toBe(0);
    const lesson = value.lessons[0]!;
    value.overrides.push({
      lessonId: lesson.id,
      date: '2026-12-07',
      cancelled: false,
      startTime: '14:00',
      endTime: '14:50',
      room: 'Changed room',
      campus: lesson.campus,
      format: lesson.format,
      url: '',
      note: 'Make-up class',
    });
    value.term.endDate = '2026-12-07';
    await saveStudyDocument(env, 'alice', 1, value, beforeTerm);
    expect((await row()).next_reminder_at).toBe('2026-12-07T08:45:00.000Z');
    expect(await enqueueDueStudyReminders(env, new Date('2026-12-07T08:45:30Z'))).toBe(1);
    expect(await row()).toMatchObject({
      next_reminder_at: null,
      next_reminder_date: null,
      next_reminder_lesson: null,
    });
  });
});
