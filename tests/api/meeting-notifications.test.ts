import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  queueMeetingThreshold,
  queueMeetingTravel,
} from '../../src/api/domain/meeting-notifications';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/contracts';

let mf: Miniflare, db: D1Database;
const now = new Date('2026-11-20T10:00:00Z');
const date = '2026-11-20',
  next = '2026-11-27',
  planId = 'meeting-notification-test';
const stamp = now.toISOString();

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: '2026-11-01',
      d1Databases: { DB: 'meeting-notifications-test' },
      d1Persist: false,
    }),
  );
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const directory = new URL('../../migrations/', import.meta.url);
  const sql = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(new URL(name, directory), 'utf8'))
    .join('\n');
  let statement = '',
    trigger = false;
  for (const line of sql.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('--')) continue;
    if (text.startsWith('CREATE TRIGGER')) trigger = true;
    statement += ` ${text}`;
    if ((!trigger && text.endsWith(';')) || (trigger && /END;$/.test(text))) {
      await db.prepare(statement).run();
      statement = '';
      trigger = false;
    }
  }
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  await db.prepare('DELETE FROM users').run();
  for (const uid of ['alice', 'bob', 'carol', 'outsider']) {
    const settings = {
      ...DEFAULT_SETTINGS,
      quietStart: '00:00',
      quietEnd: '00:00',
      locale: uid === 'bob' ? 'ru' : 'kk',
    };
    await db
      .prepare(
        'INSERT INTO users(uid,email,display_name,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(uid, `${uid}@example.test`, uid, JSON.stringify(settings), stamp, stamp)
      .run();
  }
  await db.batch(
    ['bob', 'carol'].map((uid) =>
      db
        .prepare('INSERT INTO friendships(user_low,user_high,created_at) VALUES(?,?,?)')
        .bind('alice', uid, stamp),
    ),
  );
  await db
    .prepare(
      `INSERT INTO plans(id,owner_id,title,kind,cadence,start_date,time,time_zone,remind_minutes,mutation_id,created_at,updated_at,min_attendees)
    VALUES(?,'alice','Private sensitive title','event','weekly',?,'19:00','Asia/Almaty',-1,'fixture',?,?,2)`,
    )
    .bind(planId, date, stamp, stamp)
    .run();
  await db.batch(
    ['alice', 'bob', 'carol'].map((uid) =>
      db
        .prepare('INSERT INTO plan_members(plan_id,user_id,joined_at) VALUES(?,?,?)')
        .bind(planId, uid, stamp),
    ),
  );
});
const accept = (uid: string, day = date) =>
  db
    .prepare(
      `INSERT INTO rsvps(plan_id,user_id,occurrence_date,status,updated_at) VALUES(?,?,?,'accepted',?)
  ON CONFLICT(plan_id,user_id,occurrence_date) DO UPDATE SET status='accepted'`,
    )
    .bind(planId, uid, day, stamp)
    .run();
const rows = () =>
  db
    .prepare('SELECT user_id,body,dedupe_key FROM notifications ORDER BY user_id')
    .all<{ user_id: string; body: string; dedupe_key: string }>();
const preferences = (uid: string, changes: Partial<Settings>) =>
  db
    .prepare('UPDATE users SET settings_json=? WHERE uid=?')
    .bind(
      JSON.stringify({ ...DEFAULT_SETTINGS, quietStart: '00:00', quietEnd: '00:00', ...changes }),
      uid,
    )
    .run();
async function travel(uid = 'bob', status = 'on_way', day = date) {
  await db
    .prepare(
      `INSERT INTO meeting_travel(plan_id,user_id,occurrence_date,status,late_minutes,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(plan_id,user_id,occurrence_date) DO UPDATE SET status=excluded.status,late_minutes=excluded.late_minutes,updated_at=excluded.updated_at`,
    )
    .bind(planId, uid, day, status, status === 'late' ? 10 : null, stamp)
    .run();
}

describe('meeting notification privacy and durable bounds', () => {
  it('requires enough accepted members, localizes generic text, and never includes outsiders', async () => {
    await accept('alice');
    expect(await queueMeetingThreshold(db, planId, date, now)).toBe(0);
    await accept('bob');
    expect(await queueMeetingThreshold(db, planId, date, now)).toBe(3);
    const sent = (await rows()).results;
    expect(sent.map((row) => row.user_id)).toEqual(['alice', 'bob', 'carol']);
    expect(sent.find((row) => row.user_id === 'bob')?.body).toContain('Для встречи');
    expect(sent.find((row) => row.user_id === 'alice')?.body).toContain('Кездесуге');
    expect(JSON.stringify(sent)).not.toContain('Private sensitive title');
  });
  it('queues only once under concurrency, row deletion, and threshold recrossing', async () => {
    await accept('alice');
    await accept('bob');
    const changes = await Promise.all(
      Array.from({ length: 4 }, () => queueMeetingThreshold(db, planId, date, now)),
    );
    expect(changes.reduce((a, b) => a + b, 0)).toBe(3);
    await db.prepare('DELETE FROM notifications').run();
    await db.prepare("UPDATE rsvps SET status='declined' WHERE user_id='bob'").run();
    expect(await queueMeetingThreshold(db, planId, date, now)).toBe(0);
    await accept('bob');
    expect(await queueMeetingThreshold(db, planId, date, now)).toBe(0);
    expect((await rows()).results).toHaveLength(0);
  });
  it('keeps recurring occurrence notifications separate and rejects invalid/past dates', async () => {
    await accept('alice');
    await accept('bob');
    expect(await queueMeetingThreshold(db, planId, date, now)).toBe(3);
    await accept('alice', next);
    await accept('bob', next);
    expect(await queueMeetingThreshold(db, planId, next, now)).toBe(3);
    expect(await queueMeetingThreshold(db, planId, '2026-11-21', now)).toBe(0);
    await accept('alice', '2027-11-26');
    await accept('bob', '2027-11-26');
    expect(await queueMeetingThreshold(db, planId, '2027-11-26', now)).toBe(0);
    expect(await queueMeetingThreshold(db, planId, date, new Date('2026-11-21T10:00:00Z'))).toBe(0);
    expect((await rows()).results).toHaveLength(6);
  });
  it('honors disabled preferences and quiet hours without replaying muted alerts later', async () => {
    await accept('alice');
    await accept('bob');
    await preferences('alice', { notificationsEnabled: false });
    await preferences('bob', { friendNudges: false });
    await preferences('carol', { quietStart: '14:00', quietEnd: '16:00' });
    expect(await queueMeetingThreshold(db, planId, date, now)).toBe(0);
    for (const uid of ['alice', 'bob', 'carol']) await preferences(uid, {});
    expect(await queueMeetingThreshold(db, planId, date, now)).toBe(0);
  });
  it('requires a persisted accepted travel state and excludes the actor; repeats stay bounded', async () => {
    expect(await queueMeetingTravel(db, planId, date, 'bob', 'on_way', now)).toBe(0);
    await travel();
    expect(await queueMeetingTravel(db, planId, date, 'bob', 'on_way', now)).toBe(0);
    await accept('bob');
    expect(await queueMeetingTravel(db, planId, date, 'bob', 'late', now)).toBe(0);
    const values = await Promise.all([
      queueMeetingTravel(db, planId, date, 'bob', 'on_way', now),
      queueMeetingTravel(db, planId, date, 'bob', 'on_way', now),
    ]);
    expect(values.reduce((a, b) => a + b, 0)).toBe(2);
    expect((await rows()).results.map((row) => row.user_id)).toEqual(['alice', 'carol']);
    await travel('bob', 'late');
    expect(await queueMeetingTravel(db, planId, date, 'bob', 'late', now)).toBe(2);
    expect(await queueMeetingTravel(db, planId, date, 'bob', 'late', now)).toBe(0);
    await travel('bob', 'arrived');
    expect(await queueMeetingTravel(db, planId, date, 'bob', 'arrived', now)).toBe(2);
    expect((await rows()).results).toHaveLength(6);
  });
  it('does not send travel notifications for future dates or revoked memberships', async () => {
    await accept('bob', next);
    await travel('bob', 'on_way', next);
    expect(await queueMeetingTravel(db, planId, next, 'bob', 'on_way', now)).toBe(0);
    await accept('bob');
    await travel();
    await db.prepare("DELETE FROM friendships WHERE user_low='alice' AND user_high='bob'").run();
    expect(await queueMeetingTravel(db, planId, date, 'bob', 'on_way', now)).toBe(0);
    expect((await rows()).results).toHaveLength(0);
  });
});
