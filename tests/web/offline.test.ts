import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { Plan, Profile } from '../../src/shared/contracts';

const mocked = vi.hoisted(() => ({ uid: 'alice', write: vi.fn() }));
vi.mock('../../src/web/firebase', () => ({
  currentAuth: () => ({ currentUser: mocked.uid ? { uid: mocked.uid } : null }),
}));
vi.mock('../../src/web/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/web/api')>('../../src/web/api');
  return { ...actual, writeApi: mocked.write };
});
import { ApiError } from '../../src/web/api';
import {
  activatePrivateSession,
  applyPending,
  clearPrivateData,
  enqueueCheckin,
  enqueuePlan,
  isPrivateSessionPaused,
  loadSnapshot,
  pendingCheckins,
  pendingPlans,
  resumePrivateSession,
  saveSnapshot,
  syncCheckins,
  type PendingCheckin,
} from '../../src/web/offline';
import { DEFAULT_SETTINGS } from '../../src/shared/contracts';

const plan: Plan = {
  id: 'plan',
  ownerId: 'alice',
  title: 'Read together',
  kind: 'habit',
  cadence: 'daily',
  startDate: '2026-11-19',
  time: '09:00',
  memberIds: ['alice', 'bob'],
  remindMinutes: 15,
  version: 1,
  date: '2026-11-19',
  members: [
    {
      uid: 'alice',
      displayName: 'A',
      completed: false,
      contribution: 0,
      rsvp: 'pending',
      updatedAt: null,
    },
    {
      uid: 'bob',
      displayName: 'B',
      completed: false,
      contribution: 0,
      rsvp: 'pending',
      updatedAt: null,
    },
  ],
  createdAt: '2026-11-19T00:00:00Z',
  updatedAt: '2026-11-19T00:00:00Z',
};
function profile(uid: string): Profile {
  return {
    uid,
    displayName: uid,
    username: uid,
    bio: '',
    city: 'Astana',
    email: `${uid}@example.test`,
    settings: DEFAULT_SETTINGS,
    createdAt: '2026-11-19T00:00:00Z',
  };
}
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  activatePrivateSession('alice');
  activatePrivateSession('bob');
  mocked.uid = 'alice';
  mocked.write.mockReset();
  mocked.write.mockResolvedValue({ ok: true });
});
describe('private offline state', () => {
  it('isolates snapshots and queue by account; deleting Alice leaves Bob untouched', async () => {
    for (const uid of ['alice', 'bob']) {
      await saveSnapshot(uid, {
        profile: profile(uid),
        friends: [],
        plans: [plan],
        meetings: [{ ...plan, id: `meeting-${uid}`, kind: 'event', cadence: 'once' }],
        date: plan.date,
        savedAt: 1,
      });
      await enqueueCheckin(uid, 'plan', {
        date: plan.date,
        completed: true,
        operationId: `${uid}-op`,
      });
    }
    expect((await loadSnapshot('bob'))?.profile.uid).toBe('bob');
    expect((await loadSnapshot('bob'))?.meetings?.map((item) => item.id)).toEqual(['meeting-bob']);
    expect(await loadSnapshot('eve')).toBeUndefined();
    await clearPrivateData('alice');
    expect(await loadSnapshot('alice')).toBeUndefined();
    expect((await loadSnapshot('bob'))?.meetings?.map((item) => item.id)).toEqual(['meeting-bob']);
    expect(await pendingCheckins('alice')).toEqual([]);
    expect((await pendingCheckins('bob')).length).toBe(1);
    expect((await loadSnapshot('bob'))?.profile.uid).toBe('bob');
  });
  it('keeps one operationId entry and sends the same ID to the API', async () => {
    const input = { date: plan.date, completed: true, operationId: 'op-1' };
    await enqueueCheckin('alice', 'plan', input);
    await enqueueCheckin('alice', 'plan', input);
    expect(await pendingCheckins('alice')).toHaveLength(1);
    expect(await syncCheckins('alice')).toEqual({ sent: 1, failed: 0, blocked: false });
    expect(mocked.write).toHaveBeenCalledWith('/plans/plan/checkins', 'POST', input, 'alice');
    expect(await pendingCheckins('alice')).toEqual([]);
  });
  it('never sends remaining operations under a different signed-in account', async () => {
    await enqueueCheckin('alice', 'one', { date: plan.date, completed: true, operationId: 'one' });
    await enqueueCheckin('alice', 'two', { date: plan.date, completed: true, operationId: 'two' });
    mocked.write.mockImplementationOnce(async () => {
      mocked.uid = 'bob';
      return { ok: true };
    });
    expect(await syncCheckins('alice')).toEqual({ sent: 1, failed: 0, blocked: true });
    expect(mocked.write).toHaveBeenCalledTimes(1);
    expect(await pendingCheckins('alice')).toHaveLength(1);
  });
  it('retains forbidden operations for visible review but stops optimistic completion', async () => {
    await enqueueCheckin('alice', 'plan', {
      date: plan.date,
      completed: true,
      operationId: 'denied',
    });
    mocked.write.mockRejectedValue(new ApiError('FORBIDDEN', 403));
    expect((await syncCheckins('alice')).failed).toBe(1);
    const pending = await pendingCheckins('alice');
    expect(pending[0].error).toBe('FORBIDDEN');
    expect(applyPending([plan], 'alice', pending)[0].members[0].completed).toBe(false);
    await syncCheckins('alice');
    expect(mocked.write).toHaveBeenCalledTimes(1);
  });
  it('keeps network failures retryable rather than discarding them', async () => {
    await enqueueCheckin('alice', 'plan', {
      date: plan.date,
      completed: true,
      operationId: 'retry',
    });
    mocked.write.mockRejectedValueOnce(new ApiError('NETWORK'));
    await syncCheckins('alice');
    expect(await pendingCheckins('alice')).toHaveLength(1);
    await syncCheckins('alice');
    expect(await pendingCheckins('alice')).toHaveLength(0);
  });
  it('invalidates delayed private writes before clearing the account', async () => {
    const pendingSave = saveSnapshot('alice', {
      profile: profile('alice'),
      friends: [],
      plans: [plan],
      date: plan.date,
      savedAt: 1,
    });
    const pendingWrite = enqueueCheckin('alice', 'plan', {
      date: plan.date,
      completed: true,
      operationId: 'logout-race',
    });
    const results = Promise.allSettled([pendingSave, pendingWrite]);
    await clearPrivateData('alice');
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
    expect(await loadSnapshot('alice')).toBeUndefined();
    expect(await pendingCheckins('alice')).toEqual([]);
  });
  it('queues a shared place offline and reuses its creation key after network failure', async () => {
    const input = {
      title: 'Meet at the park',
      kind: 'event' as const,
      cadence: 'once' as const,
      startDate: plan.date,
      time: '18:00',
      memberIds: ['bob'],
      place: { lat: 51.1283, lng: 71.4304, label: 'Бәйтерек' },
      remindMinutes: 15,
    };
    const key = '5bd2c68d-5aad-4811-af30-44f11bc624fe';
    await enqueuePlan('alice', input, key);
    expect(await pendingPlans('bob')).toEqual([]);
    mocked.write.mockRejectedValueOnce(new ApiError('NETWORK'));
    await syncCheckins('alice');
    expect(await pendingPlans('alice')).toHaveLength(1);
    await syncCheckins('alice');
    expect(await pendingPlans('alice')).toEqual([]);
    expect(mocked.write).toHaveBeenNthCalledWith(1, '/plans', 'POST', input, 'alice', {
      'Idempotency-Key': key,
    });
    expect(mocked.write).toHaveBeenNthCalledWith(2, '/plans', 'POST', input, 'alice', {
      'Idempotency-Key': key,
    });
  });
  it('keeps a forbidden shared draft visible for review without repeated writes', async () => {
    await enqueuePlan(
      'alice',
      {
        title: 'Shared',
        kind: 'habit',
        cadence: 'daily',
        startDate: plan.date,
        time: '18:00',
        memberIds: ['bob'],
        remindMinutes: 15,
      },
      'draft',
    );
    mocked.write.mockRejectedValue(new ApiError('NOT_FRIENDS', 403));
    await syncCheckins('alice');
    expect((await pendingPlans('alice'))[0].error).toBe('NOT_FRIENDS');
    await syncCheckins('alice');
    expect(mocked.write).toHaveBeenCalledTimes(1);
    await clearPrivateData('alice');
    expect(await pendingPlans('alice')).toEqual([]);
  });
  it('preserves pending work across authentication pause, permits same-user recovery, and erases it on logout', async () => {
    await saveSnapshot('alice', {
      profile: profile('alice'),
      friends: [],
      plans: [plan],
      date: plan.date,
      savedAt: 1,
    });
    await enqueueCheckin('alice', 'plan', {
      date: plan.date,
      completed: true,
      operationId: 'paused-check',
    });
    await enqueuePlan(
      'alice',
      {
        title: 'Offline plan',
        kind: 'habit',
        cadence: 'daily',
        startDate: plan.date,
        time: '18:00',
        memberIds: [],
        remindMinutes: 15,
      },
      'paused-draft',
    );
    mocked.write.mockRejectedValueOnce(new ApiError('UNAUTHENTICATED', 401));
    expect((await syncCheckins('alice')).blocked).toBe(true);
    expect(await isPrivateSessionPaused('alice')).toBe(true);
    expect(await loadSnapshot('alice')).toBeUndefined();
    expect(await pendingCheckins('alice')).toHaveLength(1);
    expect(await pendingPlans('alice')).toHaveLength(1);
    await syncCheckins('alice');
    expect(mocked.write).toHaveBeenCalledTimes(1);
    mocked.uid = 'bob';
    await expect(resumePrivateSession('alice')).rejects.toMatchObject({ status: 401 });
    mocked.uid = 'alice';
    await resumePrivateSession('alice');
    expect(await isPrivateSessionPaused('alice')).toBe(false);
    expect((await syncCheckins('alice')).sent).toBe(2);
    await enqueueCheckin('alice', 'plan', {
      date: plan.date,
      completed: false,
      operationId: 'delete-on-logout',
    });
    await clearPrivateData('alice');
    expect(await pendingCheckins('alice')).toEqual([]);
    expect(await pendingPlans('alice')).toEqual([]);
    expect(await isPrivateSessionPaused('alice')).toBe(false);
  });
  it.each(['plan', 'checkin'] as const)(
    'promptly sends a late %s after joining an already active pass without duplicate writes',
    async (kind) => {
      let release!: () => void;
      mocked.write.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await enqueueCheckin('alice', 'old', {
        date: plan.date,
        completed: true,
        operationId: 'old-op',
      });
      const background = syncCheckins('alice');
      await vi.waitFor(() => expect(mocked.write).toHaveBeenCalledTimes(1));
      if (kind === 'plan') {
        await enqueuePlan(
          'alice',
          {
            title: 'Late shared plan',
            kind: 'habit',
            cadence: 'daily',
            startDate: plan.date,
            time: '09:00',
            memberIds: ['bob'],
            remindMinutes: -1,
          },
          'late-op',
        );
      } else {
        await enqueueCheckin('alice', 'late', {
          date: plan.date,
          completed: true,
          operationId: 'late-op',
        });
      }
      expect(syncCheckins('alice')).toBe(background);
      const explicit = syncCheckins('alice', true);
      release();
      expect(await explicit).toEqual({ sent: 2, failed: 0, blocked: false });
      expect(mocked.write).toHaveBeenCalledTimes(2);
      expect(await pendingCheckins('alice')).toEqual([]);
      expect(await pendingPlans('alice')).toEqual([]);
    },
  );
  it.each(['blocked', 'account-switch', 'session-change'] as const)(
    'does not start the follow-up after %s while waiting for the active pass',
    async (condition) => {
      let release!: () => void;
      let reject!: (error: unknown) => void;
      mocked.write.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, fail) => {
            release = resolve;
            reject = fail;
          }),
      );
      await enqueueCheckin('alice', 'old', {
        date: plan.date,
        completed: true,
        operationId: 'old-op',
      });
      const background = syncCheckins('alice');
      await vi.waitFor(() => expect(mocked.write).toHaveBeenCalledTimes(1));
      await enqueuePlan(
        'alice',
        {
          title: 'Retained draft',
          kind: 'habit',
          cadence: 'daily',
          startDate: plan.date,
          time: '09:00',
          memberIds: [],
          remindMinutes: -1,
        },
        'retained-op',
      );
      const explicit = syncCheckins('alice', true);
      if (condition === 'blocked') reject(new ApiError('UNAUTHENTICATED', 401));
      else {
        if (condition === 'account-switch') mocked.uid = 'bob';
        else activatePrivateSession('alice');
        release();
      }
      await background;
      expect((await explicit).blocked).toBe(true);
      expect(mocked.write).toHaveBeenCalledTimes(1);
      expect(await pendingPlans('alice')).toHaveLength(1);
    },
  );
  it('bounds an explicit enqueue to one follow-up rather than draining indefinitely', async () => {
    let firstRelease!: () => void, secondRelease!: () => void;
    mocked.write
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            firstRelease = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            secondRelease = resolve;
          }),
      );
    await enqueueCheckin('alice', 'first', {
      date: plan.date,
      completed: true,
      operationId: 'first',
    });
    void syncCheckins('alice');
    await vi.waitFor(() => expect(mocked.write).toHaveBeenCalledTimes(1));
    await enqueueCheckin('alice', 'second', {
      date: plan.date,
      completed: true,
      operationId: 'second',
    });
    const explicit = syncCheckins('alice', true);
    firstRelease();
    await vi.waitFor(() => expect(mocked.write).toHaveBeenCalledTimes(2));
    await enqueueCheckin('alice', 'third', {
      date: plan.date,
      completed: true,
      operationId: 'third',
    });
    secondRelease();
    expect((await explicit).sent).toBe(2);
    expect(mocked.write).toHaveBeenCalledTimes(2);
    expect((await pendingCheckins('alice')).map((item) => item.planId)).toEqual(['third']);
  });
  it('applies only the active account and exact occurrence; leaves other member data intact', () => {
    const rows: PendingCheckin[] = [
      {
        uid: 'bob',
        key: 'bob:x',
        planId: 'plan',
        input: { date: plan.date, completed: true, operationId: 'x' },
        createdAt: 1,
      },
      {
        uid: 'alice',
        key: 'alice:y',
        planId: 'plan',
        input: { date: '2026-11-20', completed: true, operationId: 'y' },
        createdAt: 2,
      },
    ];
    expect(applyPending([plan], 'alice', rows)).toEqual([plan]);
    rows.push({
      uid: 'alice',
      key: 'alice:z',
      planId: 'plan',
      input: { date: plan.date, completed: true, contribution: 20000, operationId: 'z' },
      createdAt: 3,
    });
    const output = applyPending([plan], 'alice', rows)[0];
    expect(output.members[0].completed).toBe(true);
    expect(output.members[0].contribution).toBe(20000);
    expect(output.members[1]).toEqual(plan.members[1]);
    expect(plan.members[0].completed).toBe(false);
  });
});
