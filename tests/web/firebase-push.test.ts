import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeApp: vi.fn(),
  getAuth: vi.fn(),
  setPersistence: vi.fn(),
  getMessaging: vi.fn(),
  getToken: vi.fn(),
  deleteToken: vi.fn(),
  isSupported: vi.fn(),
  permission: vi.fn(),
  register: vi.fn(),
  getRegistration: vi.fn(),
  getSubscription: vi.fn(),
}));
vi.mock('firebase/app', () => ({ initializeApp: mocks.initializeApp }));
vi.mock('firebase/auth', () => ({
  getAuth: mocks.getAuth,
  setPersistence: mocks.setPersistence,
  indexedDBLocalPersistence: {},
  browserLocalPersistence: {},
}));
vi.mock('firebase/messaging', () => ({
  getMessaging: mocks.getMessaging,
  getToken: mocks.getToken,
  deleteToken: mocks.deleteToken,
  isSupported: mocks.isSupported,
}));

let serviceWorker: {
  register: typeof mocks.register;
  getRegistration: typeof mocks.getRegistration;
  ready: Promise<unknown>;
};
let activeRegistration: {
  scope: string;
  active: object;
  pushManager: { getSubscription: typeof mocks.getSubscription };
};
let stored: Map<string, string>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
  for (const field of [
    'API_KEY',
    'AUTH_DOMAIN',
    'PROJECT_ID',
    'APP_ID',
    'MESSAGING_SENDER_ID',
    'VAPID_KEY',
  ])
    vi.stubEnv(`VITE_FIREBASE_${field}`, `test-${field}`);
  mocks.initializeApp.mockReturnValue({ name: 'test-app' });
  mocks.getAuth.mockReturnValue({ currentUser: { uid: 'alice' } });
  mocks.setPersistence.mockResolvedValue(undefined);
  mocks.getMessaging.mockReturnValue({});
  mocks.isSupported.mockResolvedValue(true);
  mocks.getToken.mockResolvedValue('current-token');
  mocks.deleteToken.mockResolvedValue(true);
  mocks.permission.mockResolvedValue('granted');
  activeRegistration = {
    scope: 'https://example.test/',
    active: {},
    pushManager: { getSubscription: mocks.getSubscription },
  };
  mocks.register.mockResolvedValue({ scope: activeRegistration.scope });
  mocks.getRegistration.mockResolvedValue(activeRegistration);
  mocks.getSubscription.mockResolvedValue({
    endpoint: 'https://push.example.test/subscription',
    expirationTime: null,
  });
  const notification = { requestPermission: mocks.permission, permission: 'granted' };
  serviceWorker = {
    register: mocks.register,
    getRegistration: mocks.getRegistration,
    ready: Promise.resolve(activeRegistration),
  };
  vi.stubGlobal('Notification', notification);
  vi.stubGlobal('window', { Notification: notification, PushManager: {}, isSecureContext: true });
  vi.stubGlobal('navigator', { serviceWorker });
  stored = new Map([['daypact.push.uid', 'alice']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
});

describe('bounded push cleanup', () => {
  it.each(['support', 'token'])(
    'allows logout to proceed after a stalled %s cleanup stage',
    async (stage) => {
      const pending = deferred<boolean>();
      if (stage === 'support') mocks.isSupported.mockReturnValueOnce(pending.promise);
      else mocks.deleteToken.mockReturnValueOnce(pending.promise);
      const { unregisterPush } = await firebase();
      const signedOut = vi.fn();
      const cleanupError = vi.fn();
      const logout = unregisterPush().catch(cleanupError).then(signedOut);
      await vi.advanceTimersByTimeAsync(4999);
      expect(signedOut).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await logout;
      expect(cleanupError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'PUSH_TIMEOUT' }),
      );
      expect(signedOut).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      const deletions = mocks.deleteToken.mock.calls.length;
      pending.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.deleteToken).toHaveBeenCalledTimes(deletions);
      expect(signedOut).toHaveBeenCalledTimes(1);
    },
  );

  it('does not let late cleanup delete a new account registration', async () => {
    const pending = deferred<boolean>();
    mocks.deleteToken.mockReturnValueOnce(pending.promise);
    const { unregisterPush, registerPush } = await firebase();
    const cleanup = unregisterPush().catch((error) => error as Error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await cleanup).toMatchObject({ message: 'PUSH_TIMEOUT' });
    const registered = vi.fn();
    const registration = registerPush().then(registered);
    await vi.advanceTimersByTimeAsync(4000);
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(registered).not.toHaveBeenCalled();
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await registration;
    expect(registered).toHaveBeenCalledExactlyOnceWith('current-token');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds new registration while previous cleanup remains unresolved', async () => {
    const pending = deferred<boolean>();
    mocks.deleteToken.mockReturnValueOnce(pending.promise);
    const { unregisterPush, registerPush } = await firebase();
    const cleanup = unregisterPush().catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);
    await cleanup;
    const registration = registerPush().catch((error) => error as Error);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await registration).toMatchObject({ message: 'PUSH_TIMEOUT' });
    expect(mocks.getToken).not.toHaveBeenCalled();
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getToken).not.toHaveBeenCalled();
    await expect(registerPush()).resolves.toBe('current-token');
  });

  it('clears the cleanup deadline after normal success or unsupported browsers', async () => {
    const { unregisterPush } = await firebase();
    await expect(unregisterPush()).resolves.toBeUndefined();
    expect(mocks.deleteToken).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    mocks.isSupported.mockResolvedValue(false);
    await expect(unregisterPush()).resolves.toBeUndefined();
    expect(mocks.deleteToken).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function firebase() {
  const module = await import('../../src/web/firebase');
  await module.initializeAuth();
  return module;
}
describe('bounded push setup', () => {
  it.each(['support', 'registration', 'ready', 'token'])(
    'bounds a stalled %s stage after permission grant',
    async (stage) => {
      const pending = deferred<any>();
      if (stage === 'support') mocks.isSupported.mockReturnValueOnce(pending.promise);
      if (stage === 'registration') mocks.register.mockReturnValueOnce(pending.promise);
      if (stage === 'ready') serviceWorker.ready = pending.promise;
      if (stage === 'token') mocks.getToken.mockReturnValueOnce(pending.promise);
      const { registerPush } = await firebase();
      const backendRegistration = vi.fn();
      let settled = false;
      const outcome = registerPush().then(
        (token) => {
          settled = true;
          backendRegistration(token);
          return null;
        },
        (error) => {
          settled = true;
          return error as Error;
        },
      );
      await vi.advanceTimersByTimeAsync(29999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await outcome)?.message).toBe('PUSH_TIMEOUT');
      expect(vi.getTimerCount()).toBe(0);
      const tokenCalls = mocks.getToken.mock.calls.length;
      pending.resolve(stage === 'support' ? true : stage === 'token' ? 'late-token' : {});
      await vi.advanceTimersByTimeAsync(0);
      expect(backendRegistration).not.toHaveBeenCalled();
      expect(mocks.getToken).toHaveBeenCalledTimes(tokenCalls);
      const { readableError } = await import('../../src/web/api');
      expect(readableError(new Error('PUSH_TIMEOUT'), 'kk')).toContain('қайта');
      expect(readableError(new Error('PUSH_TIMEOUT'), 'ru')).toContain('ещё раз');
    },
  );

  it('clears the deadline on success and permits a retry after a timed-out token request', async () => {
    const stalled = deferred<string>();
    mocks.getToken.mockReturnValueOnce(stalled.promise);
    const { registerPush } = await firebase();
    const first = registerPush().catch((error) => error as Error);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await first).toMatchObject({ message: 'PUSH_TIMEOUT' });
    const backendRegistration = vi.fn();
    await registerPush().then(backendRegistration);
    expect(backendRegistration).toHaveBeenCalledExactlyOnceWith('current-token');
    expect(vi.getTimerCount()).toBe(0);
    stalled.resolve('expired-token');
    await vi.advanceTimersByTimeAsync(30000);
    expect(backendRegistration).toHaveBeenCalledTimes(1);
  });

  it('keeps denied permission distinct and does not begin platform setup', async () => {
    Object.assign(Notification, { permission: 'default' });
    mocks.permission.mockResolvedValue('denied');
    const { registerPush } = await firebase();
    await expect(registerPush()).rejects.toThrow('PUSH_DENIED');
    expect(mocks.isSupported).not.toHaveBeenCalled();
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not time out while the user is still deciding on the permission prompt', async () => {
    Object.assign(Notification, { permission: 'default' });
    const permission = deferred<string>();
    mocks.permission.mockReturnValue(permission.promise);
    const { registerPush } = await firebase();
    const result = registerPush();
    await vi.advanceTimersByTimeAsync(120000);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.isSupported).not.toHaveBeenCalled();
    permission.resolve('granted');
    await expect(result).resolves.toBe('current-token');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('consented registration refresh', () => {
  it('refreshes the provider token on the active root worker without prompting again', async () => {
    const { registerPush } = await firebase();
    await expect(registerPush({ requestPermission: false })).resolves.toBe('current-token');
    expect(mocks.permission).not.toHaveBeenCalled();
    expect(mocks.getToken).toHaveBeenCalledWith(
      {},
      {
        vapidKey: 'test-VAPID_KEY',
        serviceWorkerRegistration: activeRegistration,
      },
    );
  });

  it.each(['default', 'denied'])(
    'never prompts silently when permission is %s',
    async (permission) => {
      Object.assign(Notification, { permission });
      const { registerPush } = await firebase();
      await expect(registerPush({ requestPermission: false })).rejects.toThrow('PUSH_DENIED');
      expect(mocks.permission).not.toHaveBeenCalled();
      expect(mocks.getToken).not.toHaveBeenCalled();
    },
  );

  it('requests a new permission in the same tap before SDK work begins', async () => {
    Object.assign(Notification, { permission: 'default' });
    const { registerPush } = await firebase();
    const result = registerPush();
    expect(mocks.permission).toHaveBeenCalledTimes(1);
    expect(mocks.isSupported).not.toHaveBeenCalled();
    await result;
  });

  it('rejects an unrelated active worker instead of registering push on it', async () => {
    serviceWorker.ready = Promise.resolve({
      ...activeRegistration,
      scope: 'https://example.test/other/',
    });
    const { registerPush } = await firebase();
    await expect(registerPush()).rejects.toThrow('PUSH_SETUP');
    expect(mocks.getToken).not.toHaveBeenCalled();
  });
});

describe('actual device subscription status', () => {
  it('requires both this account marker and a live subscription', async () => {
    const { isPushRegistered, hasPushRegistration } = await firebase();
    expect(hasPushRegistration('alice')).toBe(true);
    await expect(isPushRegistered('alice')).resolves.toBe(true);
    await expect(isPushRegistered('bob')).resolves.toBe(false);
    mocks.getSubscription.mockResolvedValue(null);
    await expect(isPushRegistered('alice')).resolves.toBe(false);
    expect(hasPushRegistration('alice')).toBe(true);
    expect(mocks.permission).not.toHaveBeenCalled();
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it('rejects expired subscriptions and removed registrations', async () => {
    const { isPushRegistered } = await firebase();
    mocks.getSubscription.mockResolvedValue({
      endpoint: 'https://push.example.test/expired',
      expirationTime: Date.now() - 1,
    });
    await expect(isPushRegistered('alice')).resolves.toBe(false);
    mocks.getRegistration.mockResolvedValue(undefined);
    await expect(isPushRegistered('alice')).resolves.toBe(false);
  });

  it.each(['registration', 'subscription'])(
    'bounds a stalled %s lookup and preserves consent',
    async (stage) => {
      const pending = deferred<any>();
      if (stage === 'registration') mocks.getRegistration.mockReturnValue(pending.promise);
      else mocks.getSubscription.mockReturnValue(pending.promise);
      const { isPushRegistered, hasPushRegistration } = await firebase();
      let settled = false;
      const result = isPushRegistered('alice').then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe(false);
      expect(hasPushRegistration('alice')).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      pending.resolve(stage === 'registration' ? activeRegistration : null);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it('does not accept a late lookup after the account marker changed', async () => {
    const pending = deferred<any>();
    mocks.getSubscription.mockReturnValue(pending.promise);
    const { isPushRegistered, markPushRegistration } = await firebase();
    const result = isPushRegistered('alice');
    await vi.advanceTimersByTimeAsync(0);
    markPushRegistration('bob');
    pending.resolve({ endpoint: 'https://push.example.test/subscription', expirationTime: null });
    await expect(result).resolves.toBe(false);
  });
});

describe('iPhone push availability', () => {
  it('requires Home Screen installation before prompting in iPhone Safari', async () => {
    Object.assign(navigator, {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    });
    const { registerPush, pushAvailability } = await firebase();
    expect(pushAvailability()).toBe('install');
    await expect(registerPush()).rejects.toThrow('PUSH_INSTALL_REQUIRED');
    expect(mocks.permission).not.toHaveBeenCalled();
  });

  it('accepts installed iPhone and desktop-mode iPad apps', async () => {
    Object.assign(navigator, { userAgent: 'iPhone', standalone: true });
    const { pushAvailability } = await firebase();
    expect(pushAvailability()).toBe('available');
    Object.assign(navigator, {
      userAgent: 'Macintosh',
      platform: 'MacIntel',
      maxTouchPoints: 5,
      standalone: false,
    });
    expect(pushAvailability()).toBe('install');
    Object.assign(window, { matchMedia: () => ({ matches: true }) });
    expect(pushAvailability()).toBe('available');
  });

  it('distinguishes blocked permission from unsupported platform', async () => {
    const { pushAvailability } = await firebase();
    Object.assign(Notification, { permission: 'denied' });
    expect(pushAvailability()).toBe('blocked');
    delete (window as unknown as Record<string, unknown>).PushManager;
    expect(pushAvailability()).toBe('unsupported');
  });
});

describe('required service-worker recipient context', () => {
  it('waits for the recipient context transaction to commit and rejects an aborted write', async () => {
    const transaction: any = { objectStore: () => ({ put: vi.fn() }) };
    const db = { close: vi.fn(), transaction: () => transaction };
    const request: any = { result: db };
    vi.stubGlobal('indexedDB', { open: () => request });
    const { setActivePushUser } = await firebase();
    let committed = false;
    const result = setActivePushUser('alice', true).then(() => {
      committed = true;
    });
    request.onsuccess();
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toBe(false);
    transaction.oncomplete();
    await result;
    expect(committed).toBe(true);
    const aborted = setActivePushUser('alice', true).catch((error) => error as Error);
    request.onsuccess();
    transaction.onabort();
    expect(await aborted).toMatchObject({ message: 'PUSH_STORAGE' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a pending context write superseded by logout', async () => {
    const transaction: any = { objectStore: () => ({ put: vi.fn() }) };
    const db = { close: vi.fn(), transaction: vi.fn(() => transaction) };
    const requests: any[] = [];
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request = { result: db };
        requests.push(request);
        return request;
      },
    });
    const { setActivePushUser } = await firebase();
    const first = setActivePushUser('alice', true).catch((error) => error as Error);
    const logout = setActivePushUser(null);
    requests[0].onsuccess();
    expect(await first).toMatchObject({ message: 'PUSH_STORAGE' });
    expect(db.transaction).not.toHaveBeenCalled();
    requests[1].onsuccess();
    transaction.oncomplete();
    await logout;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports unavailable storage during explicit setup but keeps logout best effort', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('storage unavailable');
      },
    });
    const { setActivePushUser } = await firebase();
    await expect(setActivePushUser('alice', true)).rejects.toThrow('PUSH_STORAGE');
    await expect(setActivePushUser(null)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds blocked storage and never writes from a late open callback', async () => {
    const db = { close: vi.fn(), transaction: vi.fn() };
    const request: any = { result: db };
    vi.stubGlobal('indexedDB', { open: () => request });
    const { setActivePushUser } = await firebase();
    const result = setActivePushUser('alice', true).catch((error) => error as Error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ message: 'PUSH_STORAGE' });
    request.onsuccess();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
