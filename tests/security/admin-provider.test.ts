import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import type { Env } from '../../src/api/types';
import {
  deleteManagedFirebaseUser,
  listFirebaseUsers,
  lookupFirebaseUser,
  setFirebaseDisabled,
} from '../../src/api/admin/provider';

let privateKey: string, publicKey: CryptoKey, env: Env;
let calls: Array<{ url: URL; method: string; body: unknown }>;
let response: unknown;
let responseStatus: number;
let tokenStatus: number;
let assertions: string[];
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = await exportPKCS8(keys.privateKey);
  publicKey = keys.publicKey;
});
beforeEach(() => {
  const project = `test-admin-${crypto.randomUUID()}`;
  env = {
    FIREBASE_PROJECT_ID: project,
    ADMIN_FIREBASE_CLIENT_EMAIL: `test@${project}.iam.gserviceaccount.com`,
    ADMIN_FIREBASE_PRIVATE_KEY: privateKey,
  } as Env;
  calls = [];
  assertions = [];
  response = {};
  responseStatus = tokenStatus = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        assertions.push(body.get('assertion')!);
        return Response.json(
          tokenStatus === 200
            ? { access_token: 'fake-unit-test-token', expires_in: 3600 }
            : { error: 'SECRET_PROVIDER_ERROR' },
          { status: tokenStatus },
        );
      }
      expect(url.origin).toBe('https://identitytoolkit.googleapis.com');
      expect(url.pathname).toContain(`/v1/projects/${project}/accounts`);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-unit-test-token');
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(response, { status: responseStatus });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('administrator Firebase transport', () => {
  it('signs a short-lived service assertion scoped only to identitytoolkit and strips credential fields', async () => {
    response = {
      users: [
        {
          localId: 'alice',
          email: 'alice@example.test',
          emailVerified: false,
          passwordHash: 'SECRET_HASH',
          salt: 'SECRET_SALT',
          refreshToken: 'SECRET_TOKEN',
        },
      ],
      nextPageToken: 'next+/=',
    };
    const listed = await listFirebaseUsers(env, 'page+/=');
    expect(listed).toEqual({
      users: [
        { localId: 'alice', email: 'alice@example.test', emailVerified: false, disabled: false },
      ],
      nextPageToken: 'next+/=',
    });
    expect(calls[0].url.pathname).toMatch(/accounts:batchGet$/);
    expect(calls[0].url.searchParams.get('maxResults')).toBe('50');
    expect(calls[0].url.searchParams.get('nextPageToken')).toBe('page+/=');
    const verified = await jwtVerify(assertions[0], publicKey, {
      issuer: env.ADMIN_FIREBASE_CLIENT_EMAIL,
      audience: 'https://oauth2.googleapis.com/token',
      algorithms: ['RS256'],
    });
    expect(verified.payload.scope).toBe('https://www.googleapis.com/auth/identitytoolkit');
    expect(verified.payload.exp! - verified.payload.iat!).toBe(600);
    expect(JSON.stringify(listed)).not.toContain('SECRET');
  });
  it('suspends and restores the exact UID while revoking older sessions', async () => {
    const before = Math.floor(Date.now() / 1000);
    await setFirebaseDisabled(env, 'alice', true);
    await setFirebaseDisabled(env, 'alice', false);
    expect(assertions).toHaveLength(1);
    for (const [index, disabled] of [true, false].entries()) {
      expect(calls[index].url.pathname).toMatch(/accounts:update$/);
      expect(calls[index].body).toMatchObject({
        localId: 'alice',
        disableUser: disabled,
        returnSecureToken: false,
      });
      const validSince = Number((calls[index].body as { validSince: string }).validSince);
      expect(validSince).toBeGreaterThanOrEqual(before);
      expect(validSince).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    }
  });
  it('looks up one explicit identity and treats only USER_NOT_FOUND deletion as idempotent', async () => {
    response = { users: [{ localId: 'alice', email: 'alice@example.test' }] };
    expect(await lookupFirebaseUser(env, { email: 'alice@example.test' })).toMatchObject({
      localId: 'alice',
    });
    expect(calls[0].body).toEqual({ email: ['alice@example.test'] });
    responseStatus = 400;
    response = { error: { message: 'USER_NOT_FOUND' } };
    await expect(deleteManagedFirebaseUser(env, 'alice')).resolves.toBeUndefined();
    expect(calls[1].body).toEqual({ localId: 'alice' });
    expect(await lookupFirebaseUser(env, { uid: 'alice' })).toBeNull();
    response = { error: { message: 'PERMISSION_DENIED SECRET_PROVIDER_ERROR' } };
    await expect(deleteManagedFirebaseUser(env, 'alice')).rejects.toMatchObject({
      status: 503,
      code: 'ADMIN_PROVIDER_UNAVAILABLE',
    });
  });
  it('fails closed when account metadata is ambiguous or malformed', async () => {
    response = { users: [{ localId: 'alice' }, { localId: 'bob' }] };
    await expect(lookupFirebaseUser(env, { uid: 'alice' })).rejects.toMatchObject({ status: 503 });
    response = { users: [{ email: 'missing-uid@example.test' }] };
    await expect(listFirebaseUsers(env)).rejects.toMatchObject({ status: 503 });
    response = { users: 'unexpected' };
    await expect(listFirebaseUsers(env)).rejects.toMatchObject({ status: 503 });
  });
  it('does not contact account APIs when service authorization fails and reveals no provider details', async () => {
    tokenStatus = 403;
    await expect(listFirebaseUsers(env)).rejects.toMatchObject({
      status: 503,
      code: 'ADMIN_PROVIDER_UNAVAILABLE',
      message: 'Account management is temporarily unavailable.',
    });
    expect(calls).toHaveLength(0);
    await expect(
      listFirebaseUsers({ ...env, ADMIN_FIREBASE_PRIVATE_KEY: undefined }),
    ).rejects.toMatchObject({ status: 503, code: 'ADMIN_CONFIGURATION' });
  });
});
