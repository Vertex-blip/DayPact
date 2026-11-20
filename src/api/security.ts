import type { Env } from './types';
import { HttpError } from './types';

export function applySecurity(response: Response, api = false): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), payment=(), geolocation=(self)');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com https://www.googleapis.com; worker-src 'self' blob:; frame-src https://*.firebaseapp.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; manifest-src 'self'",
  );
  if (api) {
    headers.set('Cache-Control', 'private, no-store');
    headers.set(
      'Vary',
      [
        ...new Set([
          ...(headers.get('Vary') ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
          'Authorization',
          'Origin',
        ]),
      ].join(', '),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Mutation requests from browsers must originate from the configured application. */
export function enforceOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('Origin');
  const ownOrigin = new URL(request.url).origin;
  const expected = env.APP_ORIGIN || ownOrigin;
  if (origin && origin !== expected && origin !== ownOrigin)
    throw new HttpError(403, 'ORIGIN_DENIED', 'This origin is not allowed.');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site')
    throw new HttpError(403, 'ORIGIN_DENIED', 'Cross-site requests are not allowed.');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')
  )
    throw new HttpError(415, 'JSON_REQUIRED', 'Send application/json.');
}

export async function limitedBody(request: Request, limit = 16384): Promise<Request> {
  if (!request.body || ['GET', 'HEAD'].includes(request.method)) return request;
  if (Number(request.headers.get('Content-Length') || 0) > limit)
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Request is too large.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return new Request(request, { body: bytes });
}

export async function rateLimit(
  env: Env,
  key: string,
  max = 90,
  windowSeconds = 60,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000),
    window = Math.floor(now / windowSeconds) * windowSeconds;
  const result = await env.DB.prepare(
    `INSERT INTO rate_limits(key,window_start,count,expires_at) VALUES(?,?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,
    window_start=excluded.window_start,expires_at=excluded.expires_at RETURNING count`,
  )
    .bind(key, window, window + windowSeconds * 2)
    .first<{ count: number }>();
  if ((result?.count ?? max + 1) > max)
    throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
}

export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
