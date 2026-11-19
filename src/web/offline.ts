import type { CheckinInput, Plan, PlanInput, Profile, Friend } from '../shared/contracts';
import { api, ApiError, writeApi } from './api';
import { currentAuth } from './firebase';

const DB_NAME = 'daypact-private-v1';
const epochs = new Map<string, number>();
const closedSessions = new Set<string>();
const clearing = new Map<string, Promise<void>>();
export function activatePrivateSession(uid: string): void {
  closedSessions.delete(uid);
  epochs.set(uid, (epochs.get(uid) ?? 0) + 1);
}
const writeGuard = (uid: string) => {
  const epoch = epochs.get(uid) ?? 0;
  return () => !closedSessions.has(uid) && (epochs.get(uid) ?? 0) === epoch;
};
interface RecordValue {
  key: string;
  uid: string;
  value: unknown;
}
export interface PendingCheckin {
  key: string;
  uid: string;
  planId: string;
  input: CheckinInput;
  createdAt: number;
  error?: string;
}
export interface PendingPlan {
  key: string;
  uid: string;
  operationId: string;
  input: PlanInput;
  createdAt: number;
  error?: string;
}
export interface Snapshot {
  profile: Profile;
  friends: Friend[];
  plans: Plan[];
  date: string;
  savedAt: number;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 3);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const store of ['cache', 'queue', 'planQueue', 'state'])
        if (!db.objectStoreNames.contains(store))
          db.createObjectStore(store, { keyPath: 'key' }).createIndex('uid', 'uid');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function operation<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
  guard?: () => boolean,
): Promise<T> {
  const db = await database();
  if (guard && !guard()) {
    db.close();
    throw new ApiError('UNAUTHENTICATED', 401);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = run(tx.objectStore(store));
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}
export async function saveSnapshot(uid: string, snapshot: Snapshot): Promise<void> {
  const guard = writeGuard(uid);
  await clearing.get(uid);
  await operation(
    'cache',
    'readwrite',
    (s) =>
      s.put({ key: `${uid}:day:${snapshot.date}`, uid, value: snapshot } satisfies RecordValue),
    guard,
  );
  await operation(
    'cache',
    'readwrite',
    (s) => s.put({ key: `${uid}:last`, uid, value: snapshot } satisfies RecordValue),
    guard,
  );
}
export async function loadSnapshot(uid: string, date?: string): Promise<Snapshot | undefined> {
  const row = await operation<RecordValue | undefined>('cache', 'readonly', (s) =>
    s.get(`${uid}:${date ? `day:${date}` : 'last'}`),
  );
  return row?.value as Snapshot | undefined;
}
export async function enqueueCheckin(
  uid: string,
  planId: string,
  input: CheckinInput,
): Promise<void> {
  const guard = writeGuard(uid);
  await clearing.get(uid);
  await operation(
    'queue',
    'readwrite',
    (s) =>
      s.put({
        key: `${uid}:${input.operationId}`,
        uid,
        planId,
        input,
        createdAt: Date.now(),
      } satisfies PendingCheckin),
    guard,
  );
}
export async function pendingCheckins(uid: string): Promise<PendingCheckin[]> {
  return (
    await operation<PendingCheckin[]>('queue', 'readonly', (s) => s.index('uid').getAll(uid))
  ).sort((a, b) => a.createdAt - b.createdAt);
}
export async function enqueuePlan(
  uid: string,
  input: PlanInput,
  operationId: string,
): Promise<void> {
  const guard = writeGuard(uid);
  await clearing.get(uid);
  await operation(
    'planQueue',
    'readwrite',
    (s) =>
      s.put({
        key: `${uid}:${operationId}`,
        uid,
        operationId,
        input,
        createdAt: Date.now(),
      } satisfies PendingPlan),
    guard,
  );
}
export async function pendingPlans(uid: string): Promise<PendingPlan[]> {
  return (
    await operation<PendingPlan[]>('planQueue', 'readonly', (s) => s.index('uid').getAll(uid))
  ).sort((a, b) => a.createdAt - b.createdAt);
}
export async function forgetPendingPlan(key: string): Promise<void> {
  await operation('planQueue', 'readwrite', (s) => s.delete(key));
}
export async function forgetPending(key: string): Promise<void> {
  await operation('queue', 'readwrite', (s) => s.delete(key));
}
function cleanup(uid: string, pause: boolean): Promise<void> {
  closedSessions.add(uid);
  const epoch = (epochs.get(uid) ?? 0) + 1;
  epochs.set(uid, epoch);
  const previous = clearing.get(uid);
  const run = (async () => {
    await previous?.catch(() => {});
    const db = await database();
    const stores = pause ? ['cache', 'state'] : ['cache', 'queue', 'planQueue', 'state'];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      for (const store of stores) {
        const cursor = tx.objectStore(store).index('uid').openCursor(IDBKeyRange.only(uid));
        cursor.onsuccess = () => {
          if (cursor.result) {
            cursor.result.delete();
            cursor.result.continue();
          } else if (store === 'state' && pause && epochs.get(uid) === epoch)
            tx.objectStore('state').put({ key: `${uid}:paused`, uid, value: true });
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  })().finally(() => {
    if (clearing.get(uid) === run) clearing.delete(uid);
  });
  clearing.set(uid, run);
  return run;
}
export const clearPrivateData = (uid: string): Promise<void> => cleanup(uid, false);
export const pausePrivateSession = (uid: string): Promise<void> => cleanup(uid, true);
export async function isPrivateSessionPaused(uid: string): Promise<boolean> {
  await clearing.get(uid);
  return !!(
    await operation<RecordValue | undefined>('state', 'readonly', (s) => s.get(`${uid}:paused`))
  )?.value;
}
export async function resumePrivateSession(uid: string): Promise<void> {
  const expected = epochs.get(uid) ?? 0;
  const valid = () =>
    currentAuth()?.currentUser?.uid === uid && (epochs.get(uid) ?? 0) === expected;
  if (!valid()) throw new ApiError('UNAUTHENTICATED', 401);
  await clearing.get(uid);
  if (!valid()) throw new ApiError('UNAUTHENTICATED', 401);
  await operation('state', 'readwrite', (s) => s.delete(`${uid}:paused`), valid);
  if (!valid()) throw new ApiError('UNAUTHENTICATED', 401);
  activatePrivateSession(uid);
}
const syncing = new Map<string, Promise<{ sent: number; blocked: boolean; failed: number }>>();
export function syncCheckins(
  uid: string,
  followUpIfRunning = false,
): Promise<{ sent: number; blocked: boolean; failed: number }> {
  const running = syncing.get(uid);
  if (running) {
    if (!followUpIfRunning) return running;
    const sameSession = writeGuard(uid);
    // An explicit enqueue may arrive after the active pass took its snapshot.
    // Join that pass, then perform at most one ordinary pass for the new work.
    return running.then(async (first) => {
      if (first.blocked || currentAuth()?.currentUser?.uid !== uid || !sameSession()) {
        return { ...first, blocked: true };
      }
      const next = await syncCheckins(uid);
      return {
        sent: first.sent + next.sent,
        failed: Math.max(first.failed, next.failed),
        blocked: next.blocked,
      };
    });
  }
  const guard = writeGuard(uid);
  const run = (async () => {
    let sent = 0,
      failed = 0;
    if (await isPrivateSessionPaused(uid)) return { sent, failed, blocked: true };
    const [checkins, plans] = await Promise.all([pendingCheckins(uid), pendingPlans(uid)]);
    const items: Array<PendingCheckin | PendingPlan> = [...checkins, ...plans].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    for (const item of items) {
      if (currentAuth()?.currentUser?.uid !== uid || !guard())
        return { sent, failed, blocked: true };
      if (item.error) {
        failed++;
        continue;
      }
      try {
        if ('planId' in item) {
          await writeApi(
            '/plans/' + encodeURIComponent(item.planId) + '/checkins',
            'POST',
            item.input,
            uid,
          );
          await forgetPending(item.key);
        } else {
          await writeApi('/plans', 'POST', item.input, uid, {
            'Idempotency-Key': item.operationId,
          });
          await forgetPendingPlan(item.key);
        }
        sent++;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          if (currentAuth()?.currentUser?.uid === uid) await pausePrivateSession(uid);
          return { sent, failed, blocked: true };
        }
        if (error instanceof ApiError && [400, 403, 404, 409, 422].includes(error.status)) {
          await operation(
            'planId' in item ? 'queue' : 'planQueue',
            'readwrite',
            (s) => s.put({ ...item, error: error.code }),
            guard,
          );
          failed++;
          continue;
        }
        break;
      }
    }
    return { sent, failed, blocked: false };
  })().finally(() => {
    syncing.delete(uid);
  });
  syncing.set(uid, run);
  return run;
}
export function applyPending(plans: Plan[], uid: string, pending: PendingCheckin[]): Plan[] {
  return plans.map((plan) => {
    const changes = pending.filter(
      (p) => p.uid === uid && !p.error && p.planId === plan.id && p.input.date === plan.date,
    );
    const last = changes.at(-1);
    if (!last) return plan;
    return {
      ...plan,
      members: plan.members.map((member) =>
        member.uid === uid
          ? {
              ...member,
              completed: last.input.completed,
              contribution: last.input.contribution ?? member.contribution,
            }
          : member,
      ),
    };
  });
}
export async function fetchSnapshot(
  date: string,
  expectedUid?: string,
): Promise<Omit<Snapshot, 'savedAt'>> {
  const [me, friends, plans] = await Promise.all([
    api<{ profile: Profile }>('/me', { expectedUid }),
    api<{ friends: Friend[] }>('/friends', { expectedUid }),
    api<{ plans: Plan[] }>(`/plans?date=${encodeURIComponent(date)}`, { expectedUid }),
  ]);
  return { profile: me.profile, friends: friends.friends, plans: plans.plans, date };
}
