/* Public app shell only. Authenticated API responses never enter this cache. */
const VERSION = 'daypact-shell-v1';
const BUILD_FILES = [];
const PUBLIC_FILES = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/brand/logo.webp',
  '/fonts/Roboto-Variable.ttf',
];
async function pushContext(write = false, uid = null) {
  return new Promise((resolve) => {
    const request = indexedDB.open('daypact-push-context', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('state', write ? 'readwrite' : 'readonly');
      const operation = write
        ? tx.objectStore('state').put(uid, 'activeUid')
        : tx.objectStore('state').get('activeUid');
      let value = null;
      operation.onsuccess = () => {
        value = write ? uid : operation.result;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(value);
      };
      tx.onerror = () => {
        db.close();
        resolve(null);
      };
    };
  });
}
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      const response = await fetch('/', { cache: 'reload' });
      if (!response.ok) throw new Error('Shell unavailable');
      await cache.put('/', response.clone());
      const html = await response.text();
      const resources = [...html.matchAll(/(?:src|href)="(\/assets\/[^"<>]+)"/g)].map((m) => m[1]);
      await cache.addAll([...new Set([...PUBLIC_FILES.slice(1), ...resources, ...BUILD_FILES])]);
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('daypact-shell-') && name !== VERSION) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
  if (event.data?.type === 'SET_ACTIVE_USER') {
    let trusted = false;
    try {
      trusted = !!event.source && new URL(event.source.url).origin === self.location.origin;
    } catch {}
    const uid = event.data.uid;
    if (trusted && (uid === null || (typeof uid === 'string' && uid.length <= 128)))
      event.waitUntil(pushContext(true, uid));
  }
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/maps/') ||
    url.pathname.startsWith('/map-assets/')
  )
    return;
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(VERSION);
            await cache.put('/', response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match('/', { ignoreVary: true });
          return cached ?? new Response('Offline', { status: 503 });
        }
      })(),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || PUBLIC_FILES.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        const cached = await cache.match(request, { ignoreVary: true });
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    (async () => {
      const data = payload.data ?? {};
      const activeUid = await pushContext();
      if (!activeUid || data.recipientUid !== activeUid) return;
      const notification = payload.notification ?? {};
      const title = typeof notification.title === 'string' ? notification.title : 'DayPact';
      const body =
        typeof notification.body === 'string'
          ? notification.body
          : typeof data.body === 'string'
            ? data.body
            : 'DayPact-та жаңа еске салу бар.';
      const planId =
        typeof data.planId === 'string' && data.planId.length <= 100 ? data.planId : null;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows)
        client.postMessage({ type: 'DAYPACT_PUSH', recipientUid: activeUid, planId });
      await self.registration.showNotification(title, {
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: typeof data.notificationId === 'string' ? data.notificationId : undefined,
        data: { planId, recipientUid: activeUid },
      });
    })(),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const activeUid = await pushContext();
      if (!activeUid || event.notification.data?.recipientUid !== activeUid) return;
      const planId = event.notification.data?.planId;
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if (typeof planId === 'string') client.postMessage({ type: 'DAYPACT_OPEN_PLAN', planId });
          return;
        }
      }
      await self.clients.openWindow(
        typeof planId === 'string' ? `/?plan=${encodeURIComponent(planId)}` : '/',
      );
    })(),
  );
});
