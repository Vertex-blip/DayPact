import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { HttpError, type Env, type Identity } from './types';

const googleKeys = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
  { timeoutDuration: 8000, cooldownDuration: 30000, cacheMaxAge: 3600000 },
);

/** All claims are checked locally; the account lookup additionally rejects disabled,
 * deleted, unverified and revoked accounts. No request-controlled test bypass exists. */
export function createAuthenticator(
  keys: JWTVerifyGetKey = googleKeys,
  transport: typeof fetch = fetch,
) {
  return async (request: Request, env: Env): Promise<Identity> => {
    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_WEB_API_KEY)
      throw new HttpError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured.');
    const header = request.headers.get('Authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9_.-]+$/.test(header) || header.length > 8192)
      throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    const token = header.slice(7);
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
        audience: env.FIREBASE_PROJECT_ID,
        requiredClaims: ['sub', 'iat', 'exp', 'auth_time'],
        clockTolerance: 5,
      }));
    } catch {
      throw new HttpError(401, 'AUTH_INVALID', 'Your session has expired. Sign in again.');
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      !claims.sub ||
      claims.sub.length > 128 ||
      !Number.isSafeInteger(claims.auth_time) ||
      (claims.auth_time as number) < 0 ||
      (claims.auth_time as number) > now + 5 ||
      !Number.isSafeInteger(claims.iat) ||
      (claims.iat as number) < 0 ||
      (claims.iat as number) > now + 5
    )
      throw new HttpError(401, 'AUTH_INVALID', 'Invalid authentication claims.');
    if (claims.email_verified !== true || typeof claims.email !== 'string')
      throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email to continue.');
    let response: Response;
    try {
      response = await transport(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: token }),
          signal: AbortSignal.timeout(8000),
        },
      );
    } catch {
      throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable.');
    }
    if (response.status >= 500 || response.status === 429)
      throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable.');
    if (!response.ok) throw new HttpError(401, 'AUTH_INVALID', 'Your session has expired.');
    let result: {
      users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
        disabled?: boolean;
        validSince?: string;
        displayName?: string;
      }>;
    };
    try {
      result = await response.json();
    } catch {
      throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable.');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Authentication metadata is unavailable.');
    if (!Array.isArray(result.users) || result.users.length !== 1)
      throw new HttpError(401, 'AUTH_REVOKED', 'Sign in again to continue.');
    const user = result.users?.[0];
    if (
      !user ||
      typeof user.localId !== 'string' ||
      typeof user.email !== 'string' ||
      typeof user.emailVerified !== 'boolean' ||
      (user.disabled !== undefined && typeof user.disabled !== 'boolean') ||
      typeof user.validSince !== 'string' ||
      !/^\d{1,12}$/.test(user.validSince) ||
      !Number.isSafeInteger(Number(user.validSince))
    )
      throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Authentication metadata is unavailable.');
    if (
      user.localId !== claims.sub ||
      user.disabled ||
      !user.emailVerified ||
      Number(user.validSince) > (claims.auth_time as number)
    )
      throw new HttpError(401, 'AUTH_REVOKED', 'Sign in again to continue.');
    return {
      uid: claims.sub,
      email: user.email,
      name: typeof user.displayName === 'string' ? user.displayName : undefined,
      authTime: claims.auth_time as number,
      token,
    };
  };
}
export const authenticate = createAuthenticator();

export async function deleteFirebaseAccount(identity: Identity, env: Env): Promise<void> {
  if (Date.now() / 1000 - identity.authTime > 300)
    throw new HttpError(401, 'REAUTH_REQUIRED', 'Sign in again before deleting your account.');
  let response: Response;
  try {
    response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: identity.token }),
        signal: AbortSignal.timeout(10000),
      },
    );
  } catch {
    throw new HttpError(503, 'AUTH_DELETE_PENDING', 'Account deletion is pending.');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    if (body.error?.message === 'USER_NOT_FOUND') return;
    throw new HttpError(503, 'AUTH_DELETE_PENDING', 'Account deletion is pending.');
  }
}
