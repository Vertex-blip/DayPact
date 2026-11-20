import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  indexedDBLocalPersistence,
  setPersistence,
  browserLocalPersistence,
  type Auth,
} from 'firebase/auth';
import { getMessaging, getToken, deleteToken, isSupported } from 'firebase/messaging';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};
export const firebaseConfigured = Object.values(config).every(
  (v) => typeof v === 'string' && v.length > 0 && !v.startsWith('your-'),
);
let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let initialization: Promise<Auth | null> | null = null;
let pendingPushCleanup: Promise<void> | null = null;
export function initializeAuth(): Promise<Auth | null> {
  if (!firebaseConfigured) return Promise.resolve(null);
  if (initialization) return initialization;
  initialization = (async () => {
    app = initializeApp(config);
    auth = getAuth(app);
    try {
      await setPersistence(auth, indexedDBLocalPersistence);
    } catch {
      await setPersistence(auth, browserLocalPersistence);
    }
    return auth;
  })();
  return initialization;
}
export const currentAuth = () => auth;
export function pushAvailability(): 'available' | 'install' | 'unsupported' | 'blocked' {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent ?? '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches;
  if (ios && !standalone) return 'install';
  if (
    window.isSecureContext === false ||
    !('serviceWorker' in navigator) ||
    !('Notification' in window) ||
    !('PushManager' in window)
  )
    return 'unsupported';
  return Notification.permission === 'denied' ? 'blocked' : 'available';
}
export async function registerPush(options: { requestPermission?: boolean } = {}): Promise<string> {
  if (!app || !import.meta.env.VITE_FIREBASE_VAPID_KEY) throw new Error('PUSH_SETUP');
  const availability = pushAvailability();
  if (availability === 'install') throw new Error('PUSH_INSTALL_REQUIRED');
  if (availability === 'unsupported') throw new Error('PUSH_UNSUPPORTED');
  if (availability === 'blocked') throw new Error('PUSH_DENIED');
  // Never prompt during a background refresh. A new permission prompt must run
  // directly from the user's tap, before any asynchronous SDK/platform work.
  const permission =
    Notification.permission === 'granted' || options.requestPermission === false
      ? Notification.permission
      : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('PUSH_DENIED');
  // Give the user as long as needed to answer the browser permission prompt. The
  // deadline covers only subsequent platform/SDK work, which can otherwise hang.
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      expired = true;
      reject(new Error('PUSH_TIMEOUT'));
    }, 30000);
  });
  const requirePending = () => {
    if (expired) throw new Error('PUSH_TIMEOUT');
  };
  const setup = async () => {
    // An expired logout cleanup may still be inside the SDK. Do not create a
    // replacement subscription until that operation can no longer remove it.
    await pendingPushCleanup?.catch(() => {});
    requirePending();
    const supported = await isSupported();
    requirePending();
    if (!supported) throw new Error('PUSH_UNSUPPORTED');
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    requirePending();
    const activeRegistration = await navigator.serviceWorker.ready;
    requirePending();
    if (activeRegistration.scope !== registration.scope || !activeRegistration.active)
      throw new Error('PUSH_SETUP');
    const token = await getToken(getMessaging(app!), {
      vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
      serviceWorkerRegistration: activeRegistration,
    });
    requirePending();
    if (!token) throw new Error('PUSH_SETUP');
    return token;
  };
  try {
    // Firebase does not expose cancellation here. A late SDK result is ignored,
    // so the caller cannot send a token from an expired setup to the backend.
    return await Promise.race([setup(), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}
export async function unregisterPush(): Promise<void> {
  if (!app) return;
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      expired = true;
      reject(new Error('PUSH_TIMEOUT'));
    }, 5000);
  });
  let cleanup = pendingPushCleanup;
  if (!cleanup) {
    const instance = app;
    cleanup = (async () => {
      const supported = await isSupported();
      if (expired) throw new Error('PUSH_TIMEOUT');
      if (supported) await deleteToken(getMessaging(instance));
    })();
    pendingPushCleanup = cleanup;
    const release = () => {
      if (pendingPushCleanup === cleanup) pendingPushCleanup = null;
    };
    void cleanup.then(release, release);
  }
  try {
    // Push cleanup is best effort; it must not prevent the caller from signing
    // out or finishing deletion when the browser/provider does not respond.
    await Promise.race([cleanup, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}
export function deviceId(): string {
  let id = localStorage.getItem('daypact.device');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('daypact.device', id);
  }
  return id;
}
export function hasPushRegistration(uid: string): boolean {
  try {
    return (
      'Notification' in window &&
      Notification.permission === 'granted' &&
      localStorage.getItem('daypact.push.uid') === uid
    );
  } catch {
    return false;
  }
}
export async function isPushRegistered(uid: string): Promise<boolean> {
  if (!hasPushRegistration(uid) || !('serviceWorker' in navigator)) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<false>((resolve) => {
    timeout = setTimeout(() => {
      expired = true;
      resolve(false);
    }, 5000);
  });
  const check = async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (expired || !registration?.active || !registration.pushManager) return false;
    const subscription = await registration.pushManager.getSubscription();
    return (
      hasPushRegistration(uid) &&
      !!subscription?.endpoint &&
      (subscription.expirationTime === null || subscription.expirationTime > Date.now())
    );
  };
  try {
    return await Promise.race([check(), deadline]);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
export function markPushRegistration(uid: string | null): void {
  try {
    if (uid) localStorage.setItem('daypact.push.uid', uid);
    else localStorage.removeItem('daypact.push.uid');
  } catch {
    /* The current session still reflects registration success. */
  }
}
let pushContextRevision = 0;
export async function setActivePushUser(uid: string | null, required = false): Promise<void> {
  const revision = ++pushContextRevision;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let connection: IDBDatabase | undefined;
  let transaction: IDBTransaction | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => {
        expired = true;
        try {
          transaction?.abort();
        } catch {
          /* The transaction may have already completed. */
        }
        connection?.close();
        reject(new Error('PUSH_STORAGE'));
      }, 5000);
      const request = indexedDB.open('daypact-push-context', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        connection = db;
        if (
          expired ||
          revision !== pushContextRevision ||
          (uid !== null && auth?.currentUser?.uid !== uid)
        ) {
          db.close();
          reject(new Error('PUSH_STORAGE'));
          return;
        }
        try {
          const tx = db.transaction('state', 'readwrite');
          transaction = tx;
          tx.objectStore('state').put(uid, 'activeUid');
          tx.oncomplete = () => {
            db.close();
            if (
              expired ||
              revision !== pushContextRevision ||
              (uid !== null && auth?.currentUser?.uid !== uid)
            )
              reject(new Error('PUSH_STORAGE'));
            else resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
          tx.onabort = () => {
            db.close();
            reject(new Error('PUSH_STORAGE'));
          };
        } catch {
          db.close();
          reject(new Error('PUSH_STORAGE'));
        }
      };
    });
  } catch {
    /* Worker reads this same store and fails closed if unavailable. */
    if (required) throw new Error('PUSH_STORAGE');
  } finally {
    clearTimeout(timeout);
  }
}
