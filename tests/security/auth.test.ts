import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuthenticator } from '../../src/api/auth';
import { HttpError, type Env } from '../../src/api/types';

const env = { FIREBASE_PROJECT_ID: 'daypact-test', FIREBASE_WEB_API_KEY: 'public-test-key' } as Env;
let privateKey: CryptoKey, keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256' }],
  });
});
async function token(
  overrides: Record<string, unknown> = {},
  issuer = 'https://securetoken.google.com/daypact-test',
) {
  return new SignJWT({
    email: 'test@example.invalid',
    email_verified: true,
    auth_time: Math.floor(Date.now() / 1000),
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setSubject('alice')
    .setIssuer(issuer)
    .setAudience('daypact-test')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}
function transport(user: Record<string, unknown> = {}) {
  return vi.fn(async () =>
    Response.json({
      users: [
        {
          localId: 'alice',
          email: 'test@example.invalid',
          emailVerified: true,
          validSince: '0',
          ...user,
        },
      ],
    }),
  ) as unknown as typeof fetch;
}
function request(jwt: string) {
  return new Request('https://app.example/api/me', { headers: { Authorization: `Bearer ${jwt}` } });
}
describe('Firebase boundary', () => {
  it('accepts a signed verified current account', async () => {
    expect((await createAuthenticator(keys, transport())(request(await token()), env)).uid).toBe(
      'alice',
    );
  });
  it('rejects a project substitution before account lookup', async () => {
    const lookup = transport();
    await expect(
      createAuthenticator(keys, lookup)(
        request(await token({}, 'https://securetoken.google.com/other-project')),
        env,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects unverified addresses and future auth timestamps', async () => {
    await expect(
      createAuthenticator(keys, transport())(request(await token({ email_verified: false })), env),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    await expect(
      createAuthenticator(keys, transport())(
        request(await token({ auth_time: Date.now() / 1000 + 600 })),
        env,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rejects revoked, disabled, deleted or mismatched accounts', async () => {
    for (const user of [
      { disabled: true },
      { emailVerified: false },
      { localId: 'bob' },
      { validSince: String(Math.floor(Date.now() / 1000) + 60) },
    ])
      await expect(
        createAuthenticator(keys, transport(user))(request(await token()), env),
      ).rejects.toBeInstanceOf(HttpError);
    const deleted = vi.fn(async () => Response.json({ users: [] })) as unknown as typeof fetch;
    await expect(
      createAuthenticator(keys, deleted)(request(await token()), env),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('fails closed when verification service is unavailable', async () => {
    const failed = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(
      createAuthenticator(keys, failed)(request(await token()), env),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('rejects a malformed account envelope as unavailable', async () => {
    for (const value of [null, [], 'unexpected']) {
      const malformed = vi.fn(async () => Response.json(value)) as unknown as typeof fetch;
      await expect(
        createAuthenticator(keys, malformed)(request(await token()), env),
      ).rejects.toMatchObject({ status: 503 });
    }
  });
  it('rejects unsigned and tampered tokens', async () => {
    const valid = await token();
    const parts = valid.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
    await expect(
      createAuthenticator(keys, transport())(request(parts.join('.')), env),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      createAuthenticator(keys, transport())(request('e30.e30.'), env),
    ).rejects.toMatchObject({ status: 401 });
  });
});
