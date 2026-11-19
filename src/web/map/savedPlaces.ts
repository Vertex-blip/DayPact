import type { Place } from '../../shared/contracts';

export interface SavedPlace extends Place {
  id: string;
  userId: string;
  createdAt: string;
}
const DB = 'daypact-saved-places';
const epochs = new Map<string, number>();
const closedSessions = new Set<string>();
const clearing = new Map<string, Promise<void>>();
const epoch = (userId: string) => epochs.get(userId) ?? 0;
function assertSession(userId: string, expected: number) {
  if (closedSessions.has(userId) || epoch(userId) !== expected)
    throw new Error('Saved-place session ended');
}
export function activateSavedPlaceSession(userId: string) {
  if (userId) closedSessions.delete(userId);
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('places', { keyPath: 'id' });
      store.createIndex('userId', 'userId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open local places'));
  });
}
export async function listSavedPlaces(userId: string): Promise<SavedPlace[]> {
  const expected = epoch(userId);
  await clearing.get(userId);
  if (closedSessions.has(userId) || epoch(userId) !== expected) return [];
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('places', 'readonly');
    const request = transaction
      .objectStore('places')
      .index('userId')
      .getAll(IDBKeyRange.only(userId));
    transaction.oncomplete = () => {
      db.close();
      resolve(
        closedSessions.has(userId) || epoch(userId) !== expected
          ? []
          : (request.result as SavedPlace[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}
export async function savePlace(userId: string, place: Place) {
  if (
    !userId ||
    userId.length > 128 ||
    !Number.isFinite(place.lat) ||
    !Number.isFinite(place.lng) ||
    Math.abs(place.lat) > 90 ||
    Math.abs(place.lng) > 180
  )
    throw new Error('Invalid place');
  const expected = epoch(userId);
  assertSession(userId, expected);
  await clearing.get(userId);
  assertSession(userId, expected);
  const existing = await listSavedPlaces(userId);
  assertSession(userId, expected);
  const duplicate = existing.find(
    (p) => Math.abs(p.lat - place.lat) < 0.00001 && Math.abs(p.lng - place.lng) < 0.00001,
  );
  if (duplicate) return duplicate;
  if (existing.length >= 100) throw new Error('Saved place limit');
  const value: SavedPlace = {
    id: crypto.randomUUID(),
    userId,
    lat: place.lat,
    lng: place.lng,
    label: place.label.trim().slice(0, 120) || `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`,
    createdAt: new Date().toISOString(),
  };
  const db = await database();
  try {
    assertSession(userId, expected);
  } catch (error) {
    db.close();
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('places', 'readwrite');
    transaction.objectStore('places').put(value);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
  return value;
}
export async function deleteSavedPlace(userId: string, id: string) {
  const expected = epoch(userId);
  assertSession(userId, expected);
  await clearing.get(userId);
  assertSession(userId, expected);
  const db = await database();
  try {
    assertSession(userId, expected);
  } catch (error) {
    db.close();
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('places', 'readwrite'),
      store = transaction.objectStore('places'),
      request = store.get(id);
    request.onsuccess = () => {
      if (request.result?.userId === userId) store.delete(id);
    };
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}
export function clearSavedPlaces(userId: string): Promise<void> {
  closedSessions.add(userId);
  epochs.set(userId, epoch(userId) + 1);
  const existing = clearing.get(userId);
  if (existing) return existing;
  const run = (async () => {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('places', 'readwrite'),
        cursor = transaction
          .objectStore('places')
          .index('userId')
          .openCursor(IDBKeyRange.only(userId));
      cursor.onsuccess = () => {
        if (cursor.result) {
          cursor.result.delete();
          cursor.result.continue();
        }
      };
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    });
  })().finally(() => {
    if (clearing.get(userId) === run) clearing.delete(userId);
  });
  clearing.set(userId, run);
  return run;
}
