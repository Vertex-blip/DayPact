import { importPKCS8, SignJWT } from 'jose';
import { HttpError, type Env } from '../types';

export interface FirebaseManagedUser {
  localId: string;
  email?: string;
  displayName?: string;
  emailVerified?: boolean;
  disabled?: boolean;
  createdAt?: string;
  lastLoginAt?: string;
}
let cached: { project: string; email: string; token: string; expires: number } | undefined;
async function accessToken(env: Env): Promise<string> {
  if (!env.ADMIN_FIREBASE_CLIENT_EMAIL || !env.ADMIN_FIREBASE_PRIVATE_KEY)
    throw new HttpError(503, 'ADMIN_CONFIGURATION', 'Account management is not configured.');
  if (
    cached?.project === env.FIREBASE_PROJECT_ID &&
    cached.email === env.ADMIN_FIREBASE_CLIENT_EMAIL &&
    cached.expires > Date.now() + 60000
  )
    return cached.token;
  try {
    const key = await importPKCS8(env.ADMIN_FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), 'RS256');
    const assertion = await new SignJWT({
      scope: 'https://www.googleapis.com/auth/identitytoolkit',
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(env.ADMIN_FIREBASE_CLIENT_EMAIL)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (
      !response.ok ||
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in! <= 0 ||
      data.expires_in! > 7200
    )
      throw new Error();
    cached = {
      project: env.FIREBASE_PROJECT_ID,
      email: env.ADMIN_FIREBASE_CLIENT_EMAIL,
      token: data.access_token,
      expires: Date.now() + data.expires_in! * 1000,
    };
    return data.access_token;
  } catch {
    throw new HttpError(
      503,
      'ADMIN_PROVIDER_UNAVAILABLE',
      'Account management is temporarily unavailable.',
    );
  }
}
async function request(env: Env, suffix: string, body?: unknown): Promise<Record<string, unknown>> {
  const token = await accessToken(env);
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/accounts${suffix}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      },
    );
    const data = (await response.json()) as { error?: { message?: string } };
    if (!response.ok) {
      if (data.error?.message === 'USER_NOT_FOUND')
        throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
      throw new Error();
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      'ADMIN_PROVIDER_UNAVAILABLE',
      'Account management is temporarily unavailable.',
    );
  }
}
function sanitize(user: unknown): FirebaseManagedUser {
  if (
    !user ||
    typeof user !== 'object' ||
    typeof (user as { localId?: unknown }).localId !== 'string'
  )
    throw new HttpError(503, 'ADMIN_PROVIDER_UNAVAILABLE', 'Account metadata is unavailable.');
  const value = user as Record<string, unknown>;
  return {
    localId: value.localId as string,
    ...(typeof value.email === 'string' ? { email: value.email } : {}),
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
    emailVerified: value.emailVerified === true,
    disabled: value.disabled === true,
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
    ...(typeof value.lastLoginAt === 'string' ? { lastLoginAt: value.lastLoginAt } : {}),
  };
}
export async function listFirebaseUsers(
  env: Env,
  pageToken?: string,
): Promise<{ users: FirebaseManagedUser[]; nextPageToken?: string }> {
  const query = new URLSearchParams({ maxResults: '50' });
  if (pageToken) query.set('nextPageToken', pageToken);
  const data = await request(env, `:batchGet?${query}`);
  if (data.users !== undefined && !Array.isArray(data.users))
    throw new HttpError(503, 'ADMIN_PROVIDER_UNAVAILABLE', 'Account metadata is unavailable.');
  return {
    users: ((data.users ?? []) as unknown[]).map(sanitize),
    ...(typeof data.nextPageToken === 'string' ? { nextPageToken: data.nextPageToken } : {}),
  };
}
export async function lookupFirebaseUser(
  env: Env,
  input: { uid?: string; email?: string },
): Promise<FirebaseManagedUser | null> {
  try {
    const data = await request(
      env,
      ':lookup',
      input.uid ? { localId: [input.uid] } : { email: [input.email] },
    );
    if (!Array.isArray(data.users) || !data.users.length) return null;
    if (data.users.length !== 1) throw new Error();
    return sanitize(data.users[0]);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'ACCOUNT_NOT_FOUND') return null;
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'ADMIN_PROVIDER_UNAVAILABLE', 'Account metadata is unavailable.');
  }
}
export async function setFirebaseDisabled(env: Env, uid: string, disabled: boolean): Promise<void> {
  await request(env, ':update', {
    localId: uid,
    disableUser: disabled,
    validSince: String(Math.floor(Date.now() / 1000)),
    returnSecureToken: false,
  });
}
export async function deleteManagedFirebaseUser(env: Env, uid: string): Promise<void> {
  try {
    await request(env, ':delete', { localId: uid });
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== 'ACCOUNT_NOT_FOUND') throw error;
  }
}
