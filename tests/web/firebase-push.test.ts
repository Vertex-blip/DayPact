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

let serviceWorker: { register: typeof mocks.register; ready: Promise<unknown> };
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
  mocks.register.mockResolvedValue({ scope: 'https://example.test/' });
  const notification = { requestPermission: mocks.permission, permission: 'granted' };
  serviceWorker = { register: mocks.register, ready: Promise.resolve({}) };
  vi.stubGlobal('Notification', notification);
  vi.stubGlobal('window', { Notification: notification });
  vi.stubGlobal('navigator', { serviceWorker });
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
    mocks.permission.mockResolvedValue('denied');
    const { registerPush } = await firebase();
    await expect(registerPush()).rejects.toThrow('PUSH_DENIED');
    expect(mocks.isSupported).not.toHaveBeenCalled();
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not time out while the user is still deciding on the permission prompt', async () => {
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
