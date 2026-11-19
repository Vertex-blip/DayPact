import { describe, expect, it } from 'vitest';
import { applySecurity, enforceOrigin, limitedBody } from '../../src/api/security';
import { isQuiet } from '../../src/api/notifications';
import type { Env } from '../../src/api/types';
describe('HTTP protection', () => {
  const env = { APP_ORIGIN: 'https://daypact.example' } as Env;
  it('rejects cross-origin writes and form submissions', () => {
    expect(() =>
      enforceOrigin(
        new Request('https://daypact.example/api/me', {
          method: 'POST',
          headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        }),
        env,
      ),
    ).toThrow();
    expect(() =>
      enforceOrigin(
        new Request('https://daypact.example/api/me', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
        env,
      ),
    ).toThrow();
  });
  it('caps streamed bodies without trusting Content-Length', async () => {
    const request = new Request('https://daypact.example/api/me', {
      method: 'POST',
      body: 'x'.repeat(17000),
    });
    await expect(limitedBody(request)).rejects.toMatchObject({ status: 413 });
  });
  it('does not make protected responses cacheable or embeddable', () => {
    const response = applySecurity(Response.json({ secret: 1 }), true);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
  it('interprets quiet hours in the account time zone, including overnight', () => {
    const settings = { quietStart: '22:00', quietEnd: '08:00', timeZone: 'Asia/Almaty' };
    expect(isQuiet(settings, new Date('2026-11-19T18:00:00Z'))).toBe(true);
    expect(isQuiet(settings, new Date('2026-11-19T05:00:00Z'))).toBe(false);
    expect(isQuiet({ ...settings, quietStart: '08:00', quietEnd: '08:00' }, new Date())).toBe(
      false,
    );
  });
});
