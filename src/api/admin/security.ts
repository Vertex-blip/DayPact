import { digest, rateLimit } from '../security';
import { HttpError, type Env, type Identity } from '../types';
import { isAdminOwner } from './guards';
import type { AdminAccess, AdminSetup } from '../../shared/admin';

export const ADMIN_COOKIE = '__Secure-daypact-admin';
export const ADMIN_SESSION_SECONDS = 900;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const encoder = new TextEncoder();
interface TotpRow {
  secret_cipher: string | null;
  pending_cipher: string | null;
  pending_expires_at: string | null;
  last_counter: number;
}
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0,
    value = 0,
    out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decodeBase32(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Z2-7]{16,128}$/.test(text)) throw new Error('INVALID_TOTP_SECRET');
  let value = 0,
    bits = 0;
  const bytes: number[] = [];
  for (const char of text) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
function unbase64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('INVALID_CIPHER');
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  try {
    const key = unbase64(env.ADMIN_TOTP_KEY ?? '');
    if (key.length !== 32) throw new Error();
    return await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    throw new HttpError(503, 'ADMIN_CONFIGURATION', 'Administration is not configured.');
  }
}
export async function encryptSecret(env: Env, uid: string, secret: string): Promise<string> {
  const key = await encryptionKey(env),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`daypact-admin:${uid}:v1`) },
    key,
    encoder.encode(secret),
  );
  return `v1.${base64(iv)}.${base64(new Uint8Array(cipher))}`;
}
export async function decryptSecret(env: Env, uid: string, cipher: string): Promise<string> {
  try {
    const [version, iv, value, ...extra] = cipher.split('.');
    if (version !== 'v1' || extra.length || !iv || !value) throw new Error();
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unbase64(iv),
        additionalData: encoder.encode(`daypact-admin:${uid}:v1`),
      },
      await encryptionKey(env),
      unbase64(value),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new HttpError(503, 'ADMIN_CONFIGURATION', 'Administration is not configured.');
  }
}
export async function totpCode(secret: string, counter: number): Promise<string> {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase32(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));
  const offset = hash[hash.length - 1]! & 15;
  const value =
    ((hash[offset]! & 127) << 24) |
    (hash[offset + 1]! << 16) |
    (hash[offset + 2]! << 8) |
    hash[offset + 3]!;
  return String(value % 1000000).padStart(6, '0');
}
function sameCode(a: string, b: string): boolean {
  let different = a.length ^ b.length;
  for (let i = 0; i < 6; i++) different |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return different === 0;
}
async function matchingCounter(secret: string, code: string): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(Date.now() / 30000);
  let matched: number | null = null;
  for (const counter of [current - 1, current, current + 1]) {
    if (sameCode(await totpCode(secret, counter), code)) matched = counter;
  }
  return matched;
}
export function requireOwner(env: Env, identity: Identity): void {
  if (!isAdminOwner(env, identity.uid))
    throw new HttpError(403, 'ADMIN_FORBIDDEN', 'Administration is not available.');
}
export function requireRecent(identity: Identity): void {
  if (Date.now() / 1000 - identity.authTime > 300 || identity.authTime > Date.now() / 1000 + 5)
    throw new HttpError(401, 'RECENT_LOGIN_REQUIRED', 'Confirm your password to continue.');
}
async function record(env: Env, uid: string): Promise<TotpRow | null> {
  return env.DB.prepare(
    'SELECT secret_cipher,pending_cipher,pending_expires_at,last_counter FROM admin_totp WHERE user_id=?',
  )
    .bind(uid)
    .first<TotpRow>();
}
async function limitCodeAttempts(env: Env, uid: string): Promise<void> {
  const now = Date.now(),
    cutoff = now - 600000;
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_mfa_attempts WHERE attempted_at<=?').bind(cutoff),
    env.DB.prepare(
      'INSERT INTO admin_mfa_attempts(id,user_id,attempted_at) SELECT ?,?,? WHERE (SELECT count(*) FROM admin_mfa_attempts WHERE user_id=? AND attempted_at>?)<5',
    ).bind(crypto.randomUUID(), uid, now, uid, cutoff),
  ]);
  if (!results[1].meta.changes)
    throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
}
export async function setupTotp(env: Env, identity: Identity): Promise<AdminSetup> {
  requireOwner(env, identity);
  requireRecent(identity);
  await rateLimit(env, `admin-setup:${identity.uid}`, 3, 600);
  const secret = encodeBase32(crypto.getRandomValues(new Uint8Array(20)));
  const cipher = await encryptSecret(env, identity.uid, secret);
  const now = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 600000).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO admin_totp(user_id,pending_cipher,pending_expires_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET pending_cipher=excluded.pending_cipher,pending_expires_at=excluded.pending_expires_at,updated_at=excluded.updated_at WHERE admin_totp.secret_cipher IS NULL RETURNING user_id`,
  )
    .bind(identity.uid, cipher, expiresAt, now)
    .first();
  if (!result)
    throw new HttpError(
      409,
      'ADMIN_ALREADY_CONFIGURED',
      'Two-step authentication is already configured.',
    );
  return {
    secret,
    expiresAt,
    otpauthUri: `otpauth://totp/${encodeURIComponent(`DayPact:${identity.email}`)}?secret=${secret}&issuer=DayPact&algorithm=SHA1&digits=6&period=30`,
  };
}
export interface AdminSession {
  token: string;
  expiresAt: string;
}
async function newSession(env: Env, identity: Identity): Promise<AdminSession> {
  const token = base64(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date().toISOString(),
    expiresAt = new Date(Date.now() + ADMIN_SESSION_SECONDS * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').bind(now),
    env.DB.prepare(
      'DELETE FROM admin_sessions WHERE user_id=? AND token_hash NOT IN(SELECT token_hash FROM admin_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 4)',
    ).bind(identity.uid, identity.uid),
    env.DB.prepare(
      'INSERT INTO admin_sessions(token_hash,user_id,auth_time,expires_at,created_at) VALUES(?,?,?,?,?)',
    ).bind(await digest(token), identity.uid, identity.authTime, expiresAt, now),
  ]);
  return { token, expiresAt };
}
export async function confirmTotp(
  env: Env,
  identity: Identity,
  code: string,
): Promise<AdminSession> {
  requireOwner(env, identity);
  requireRecent(identity);
  await limitCodeAttempts(env, identity.uid);
  const saved = await record(env, identity.uid),
    now = new Date().toISOString();
  if (
    !saved?.pending_cipher ||
    !saved.pending_expires_at ||
    saved.pending_expires_at <= now ||
    saved.secret_cipher
  )
    throw new HttpError(403, 'ADMIN_SETUP_REQUIRED', 'Start two-step authentication setup again.');
  const counter = await matchingCounter(
    await decryptSecret(env, identity.uid, saved.pending_cipher),
    code,
  );
  if (counter === null)
    throw new HttpError(401, 'ADMIN_CODE_INVALID', 'Check the authentication code.');
  const accepted = await env.DB.prepare(
    `UPDATE admin_totp SET secret_cipher=pending_cipher,pending_cipher=NULL,pending_expires_at=NULL,last_counter=?,updated_at=? WHERE user_id=? AND secret_cipher IS NULL AND pending_cipher=? AND pending_expires_at>? RETURNING user_id`,
  )
    .bind(counter, now, identity.uid, saved.pending_cipher, now)
    .first();
  if (!accepted) throw new HttpError(401, 'ADMIN_CODE_REUSED', 'Use a new authentication code.');
  return newSession(env, identity);
}
export async function unlockTotp(
  env: Env,
  identity: Identity,
  code: string,
): Promise<AdminSession> {
  requireOwner(env, identity);
  requireRecent(identity);
  await limitCodeAttempts(env, identity.uid);
  const saved = await record(env, identity.uid);
  if (!saved?.secret_cipher)
    throw new HttpError(403, 'ADMIN_SETUP_REQUIRED', 'Set up two-step authentication first.');
  const counter = await matchingCounter(
    await decryptSecret(env, identity.uid, saved.secret_cipher),
    code,
  );
  if (counter === null)
    throw new HttpError(401, 'ADMIN_CODE_INVALID', 'Check the authentication code.');
  const accepted = await env.DB.prepare(
    'UPDATE admin_totp SET last_counter=?,updated_at=? WHERE user_id=? AND secret_cipher=? AND last_counter<? RETURNING user_id',
  )
    .bind(counter, new Date().toISOString(), identity.uid, saved.secret_cipher, counter)
    .first();
  if (!accepted)
    throw new HttpError(401, 'ADMIN_CODE_REUSED', 'Wait for a new authentication code.');
  return newSession(env, identity);
}
function cookieToken(header: string | undefined): string | null {
  const token = header
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
export async function assertAdminSession(
  env: Env,
  identity: Identity,
  cookieHeader: string | undefined,
): Promise<{ expiresAt: string }> {
  requireOwner(env, identity);
  const token = cookieToken(cookieHeader);
  if (!token)
    throw new HttpError(401, 'ADMIN_UNLOCK_REQUIRED', 'Unlock administration to continue.');
  const session = await env.DB.prepare(
    'SELECT expires_at FROM admin_sessions WHERE token_hash=? AND user_id=? AND auth_time=? AND expires_at>?',
  )
    .bind(await digest(token), identity.uid, identity.authTime, new Date().toISOString())
    .first<{ expires_at: string }>();
  if (!session)
    throw new HttpError(401, 'ADMIN_UNLOCK_REQUIRED', 'Unlock administration to continue.');
  return { expiresAt: session.expires_at };
}
export async function adminAccess(
  env: Env,
  identity: Identity,
  cookieHeader: string | undefined,
): Promise<AdminAccess> {
  if (!isAdminOwner(env, identity.uid)) return { eligible: false };
  const saved = await record(env, identity.uid);
  let unlocked = false,
    expiresAt: string | undefined;
  if (saved?.secret_cipher) {
    try {
      expiresAt = (await assertAdminSession(env, identity, cookieHeader)).expiresAt;
      unlocked = true;
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'ADMIN_UNLOCK_REQUIRED') throw error;
    }
  }
  return {
    eligible: true,
    setupRequired: !saved?.secret_cipher,
    unlocked,
    ...(expiresAt ? { expiresAt } : {}),
  };
}
export async function lockAdminSession(
  env: Env,
  identity: Identity,
  cookieHeader: string | undefined,
): Promise<void> {
  requireOwner(env, identity);
  const token = cookieToken(cookieHeader);
  if (token)
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=? AND user_id=?')
      .bind(await digest(token), identity.uid)
      .run();
}
