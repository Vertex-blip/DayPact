import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

function worker() {
  const listeners: Record<string, (event: any) => void> = {};
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const context = {
    indexedDB: new IDBFactory(),
    URL,
    Response,
    Request,
    console,
    self: {
      location: { origin: 'https://daypact.test' },
      addEventListener: (type: string, listener: (event: any) => void) => {
        listeners[type] = listener;
      },
      registration: { showNotification },
      clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow },
      skipWaiting: vi.fn(),
    },
  };
  runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), context);
  async function dispatch(type: string, data: Record<string, unknown>) {
    let done = Promise.resolve();
    listeners[type]({
      ...data,
      waitUntil: (promise: Promise<void>) => {
        done = promise;
      },
    });
    await done;
  }
  return {
    showNotification,
    openWindow,
    dispatch,
    setUser: (uid: string | null) =>
      dispatch('message', {
        data: { type: 'SET_ACTIVE_USER', uid },
        source: { url: 'https://daypact.test/' },
      }),
  };
}
describe('notification privacy on a shared device', () => {
  it('fails closed without an active account and for another recipient', async () => {
    const w = worker();
    const payload = {
      data: { recipientUid: 'alice', notificationId: 'n1', planId: 'p1' },
      notification: { title: 'DayPact', body: 'Reminder' },
    };
    await w.dispatch('push', { data: { json: () => payload } });
    expect(w.showNotification).not.toHaveBeenCalled();
    await w.setUser('bob');
    await w.dispatch('push', { data: { json: () => payload } });
    expect(w.showNotification).not.toHaveBeenCalled();
  });
  it('shows only the active recipient and suppresses queued pushes after logout', async () => {
    const w = worker();
    await w.setUser('alice');
    const payload = {
      data: { recipientUid: 'alice', notificationId: 'n1', planId: 'p1' },
      notification: { title: 'DayPact', body: 'Reminder' },
    };
    await w.dispatch('push', { data: { json: () => payload } });
    expect(w.showNotification).toHaveBeenCalledTimes(1);
    expect(w.showNotification.mock.calls[0][1].tag).toBe('n1');
    await w.setUser(null);
    await w.dispatch('push', { data: { json: () => payload } });
    expect(w.showNotification).toHaveBeenCalledTimes(1);
  });
  it('ignores a cross-origin request to change the active push account', async () => {
    const w = worker();
    await w.dispatch('message', {
      data: { type: 'SET_ACTIVE_USER', uid: 'attacker' },
      source: { url: 'https://evil.test/' },
    });
    await w.dispatch('push', { data: { json: () => ({ data: { recipientUid: 'attacker' } }) } });
    expect(w.showNotification).not.toHaveBeenCalled();
  });
  it('constructs a same-origin plan link rather than trusting a payload URL', async () => {
    const w = worker();
    await w.setUser('alice');
    await w.dispatch('notificationclick', {
      notification: {
        close: vi.fn(),
        data: { recipientUid: 'alice', planId: 'https://evil.test/', url: 'https://evil.test/' },
      },
    });
    expect(w.openWindow).toHaveBeenCalledWith('/?plan=https%3A%2F%2Fevil.test%2F');
  });
});
