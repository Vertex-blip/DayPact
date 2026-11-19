import { useSyncExternalStore } from 'react';
import type { MapManifest } from '../../shared/contracts';

export interface SupportAsset {
  url: string;
  bytes: number;
  sha256: string;
}
export interface OfflineManifest extends MapManifest {
  dataDate: string;
  totalBytes: number;
  supportAssets: SupportAsset[];
  placeCount: number;
}
export type MapPackageStatus =
  'idle' | 'checking' | 'downloading' | 'ready' | 'cancelled' | 'error';
export interface MapPackageState {
  status: MapPackageStatus;
  loaded: number;
  total: number;
  manifest: OfflineManifest | null;
  error: string | null;
  persistent: boolean;
}
const CACHE = 'daypact-public-map-v1';
const MANIFEST_PATH = '/maps/manifest.json';
let state: MapPackageState = {
  status: 'idle',
  loaded: 0,
  total: 0,
  manifest: null,
  error: null,
  persistent: false,
};
let pending: Promise<OfflineManifest> | undefined;
let controller: AbortController | undefined;
let inspectionController: AbortController | undefined;
const listeners = new Set<() => void>();
const emit = (patch: Partial<MapPackageState>) => {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
};
export function useMapPackage() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => state,
  );
}
export class MapPackageError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'MapPackageError';
  }
}
const absolute = (path: string) => new URL(path, location.origin).href;
const digest = async (bytes: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');

function validateManifest(raw: unknown): OfflineManifest {
  const m = raw as OfflineManifest;
  if (
    !m ||
    !/^astana-\d{8}$/.test(m.id) ||
    m.url !== `/maps/${m.id}.pmtiles` ||
    !/^[a-f0-9]{64}$/.test(m.sha256) ||
    !Number.isSafeInteger(m.bytes) ||
    m.bytes < 127 ||
    m.bytes > 25 * 1024 * 1024 ||
    !Array.isArray(m.supportAssets) ||
    m.supportAssets.length > 100 ||
    !Array.isArray(m.bounds) ||
    m.bounds.length !== 4 ||
    !m.bounds.every(Number.isFinite) ||
    !Array.isArray(m.center) ||
    m.center.length !== 2 ||
    !m.center.every(Number.isFinite)
  )
    throw new MapPackageError('manifest');
  if (
    m.supportAssets.some(
      (a) =>
        !/^\/map-assets\/[A-Za-z0-9%/@._-]+$/.test(a.url) ||
        a.url.includes('..') ||
        !Number.isSafeInteger(a.bytes) ||
        a.bytes < 1 ||
        a.bytes > 5 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(a.sha256),
    )
  )
    throw new MapPackageError('manifest');
  if (
    m.totalBytes !== m.bytes + m.supportAssets.reduce((sum, a) => sum + a.bytes, 0) ||
    m.totalBytes > 40 * 1024 * 1024
  )
    throw new MapPackageError('manifest');
  return m;
}

async function manifest(cache: Cache, signal?: AbortSignal): Promise<OfflineManifest> {
  const cached = await cache.match(absolute(MANIFEST_PATH));
  if (!navigator.onLine && cached) return validateManifest(await cached.json());
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 15000);
  const abort = () => timeout.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const response = await fetch(MANIFEST_PATH, {
      cache: 'no-cache',
      credentials: 'omit',
      signal: timeout.signal,
    });
    if (!response.ok) throw new MapPackageError('network');
    const m = validateManifest(await response.json());
    await cache.put(
      absolute(MANIFEST_PATH),
      new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } }),
    );
    return m;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (cached) return validateManifest(await cached.json());
    throw new MapPackageError(navigator.onLine ? 'network' : 'offline');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
async function cachedAsset(cache: Cache, asset: SupportAsset) {
  const result = await cache.match(absolute(asset.url));
  if (
    result?.headers.get('X-DayPact-SHA256') === asset.sha256 &&
    result.headers.get('Content-Length') === String(asset.bytes)
  )
    return result;
  return undefined;
}

async function downloadAsset(
  cache: Cache,
  asset: SupportAsset,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  signal.throwIfAborted();
  if (await cachedAsset(cache, asset)) {
    progress(asset.bytes);
    return;
  }
  const response = await fetch(asset.url, { credentials: 'omit', cache: 'no-store', signal });
  if (!response.ok || !response.body) throw new MapPackageError('network');
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > asset.bytes) {
        await reader.cancel();
        throw new MapPackageError('integrity');
      }
      chunks.push(new Uint8Array(value));
      progress(received);
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== asset.bytes) throw new MapPackageError('integrity');
  const body = await new Blob(chunks).arrayBuffer();
  if ((await digest(body)) !== asset.sha256) throw new MapPackageError('integrity');
  signal.throwIfAborted();
  await cache.put(
    absolute(asset.url),
    new Response(body, {
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
        'Content-Length': String(body.byteLength),
        'X-DayPact-SHA256': asset.sha256,
      },
    }),
  );
}

export async function inspectMapPackage(): Promise<boolean> {
  if (pending) {
    try {
      await pending;
      return true;
    } catch {
      return false;
    }
  }
  inspectionController?.abort();
  const current = new AbortController();
  inspectionController = current;
  try {
    if (!('caches' in window) || !crypto.subtle) throw new MapPackageError('unsupported');
    emit({ status: 'checking', error: null });
    const cache = await caches.open(CACHE),
      m = await manifest(cache, current.signal);
    const assets = [{ url: m.url, bytes: m.bytes, sha256: m.sha256 }, ...m.supportAssets];
    let loaded = 0;
    for (const asset of assets) if (await cachedAsset(cache, asset)) loaded += asset.bytes;
    current.signal.throwIfAborted();
    const ready = loaded === m.totalBytes;
    emit({
      manifest: m,
      total: m.totalBytes,
      loaded,
      status: ready ? 'ready' : 'idle',
      persistent: (await navigator.storage?.persisted?.()) ?? false,
    });
    return ready;
  } catch (error) {
    if (current.signal.aborted) {
      if (inspectionController === current) emit({ status: 'cancelled', error: null });
      return false;
    }
    emit({ status: 'error', error: error instanceof MapPackageError ? error.code : 'storage' });
    return false;
  } finally {
    if (inspectionController === current) inspectionController = undefined;
  }
}

export function ensureMapPackage(): Promise<OfflineManifest> {
  if (pending) return pending;
  inspectionController?.abort();
  inspectionController = undefined;
  controller = new AbortController();
  const signal = controller.signal;
  const run = async () => {
    if (!('caches' in window) || !crypto.subtle) throw new MapPackageError('unsupported');
    emit({ status: 'checking', error: null });
    const cache = await caches.open(CACHE),
      m = await manifest(cache, signal);
    emit({ manifest: m, total: m.totalBytes });
    const assets = [{ url: m.url, bytes: m.bytes, sha256: m.sha256 }, ...m.supportAssets];
    const counts = new Map<string, number>();
    for (const a of assets) counts.set(a.url, (await cachedAsset(cache, a)) ? a.bytes : 0);
    const loaded = () => [...counts.values()].reduce((sum, n) => sum + n, 0);
    const missing = m.totalBytes - loaded();
    emit({ loaded: loaded() });
    if (missing > 0) {
      if (!navigator.onLine) throw new MapPackageError('offline');
      const space = await navigator.storage?.estimate?.();
      if (space?.quota && space.usage !== undefined && space.quota - space.usage < missing * 1.15)
        throw new MapPackageError('quota');
      emit({ status: 'downloading' });
      // The archive is downloaded exactly once. Tile reads use Blob.slice, never HTTP Range.
      await downloadAsset(cache, assets[0], signal, (n) => {
        counts.set(m.url, n);
        emit({ loaded: loaded() });
      });
      for (let i = 1; i < assets.length; i += 4)
        await Promise.all(
          assets.slice(i, i + 4).map((a) =>
            downloadAsset(cache, a, signal, (n) => {
              counts.set(a.url, n);
              emit({ loaded: loaded() });
            }),
          ),
        );
    }
    signal.throwIfAborted();
    emit({
      status: 'ready',
      loaded: m.totalBytes,
      error: null,
      persistent: (await navigator.storage?.persisted?.()) ?? false,
    });
    return m;
  };
  pending = run()
    .catch((error) => {
      if (signal.aborted) emit({ status: 'cancelled', error: null });
      else {
        controller?.abort();
        emit({
          status: 'error',
          error:
            error instanceof MapPackageError
              ? error.code
              : error instanceof DOMException && error.name === 'QuotaExceededError'
                ? 'quota'
                : 'network',
        });
      }
      throw error;
    })
    .finally(() => {
      pending = undefined;
      controller = undefined;
    });
  return pending;
}

export function cancelMapDownload() {
  controller?.abort();
  inspectionController?.abort();
}
export async function keepMapOnDevice() {
  const persistent = (await navigator.storage?.persist?.()) ?? false;
  emit({ persistent });
  return persistent;
}
export async function removeMapPackage() {
  cancelMapDownload();
  if (pending)
    try {
      await pending;
    } catch {
      /* cancellation expected */
    }
  await caches.delete(CACHE);
  emit({ status: 'idle', loaded: 0, error: null, persistent: false });
}
export async function readMapResource(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!(path.startsWith('/map-assets/') || /^\/maps\/astana-\d{8}\.pmtiles$/.test(path)))
    throw new MapPackageError('resource');
  const cache = await caches.open(CACHE),
    resource = await cache.match(absolute(path));
  if (!resource) throw new MapPackageError('offline');
  return resource;
}
export async function mapArchiveFile(m: OfflineManifest) {
  const response = await readMapResource(m.url);
  return new File([await response.blob()], `${m.id}.pmtiles`, { type: 'application/octet-stream' });
}
export const formatMB = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
