import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ uid: 'alice', getToken: vi.fn() }));
vi.mock('../../src/web/firebase', () => ({
  currentAuth: () => ({
    currentUser: state.uid ? { uid: state.uid, getIdToken: state.getToken } : null,
  }),
}));
import { api } from '../../src/web/api';
beforeEach(() => {
  state.uid = 'alice';
  state.getToken.mockReset();
  state.getToken.mockResolvedValue('alice-token');
  vi.stubGlobal('fetch', vi.fn());
});
describe('API identity binding', () => {
  it('does not dispatch after a user switch while awaiting a token', async () => {
    state.getToken.mockImplementation(async () => {
      state.uid = 'bob';
      return 'alice-token';
    });
    await expect(api('/me')).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('discards a private response if the account changed in flight', async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      state.uid = 'bob';
      return new Response(JSON.stringify({ profile: { uid: 'alice' } }), { status: 200 });
    });
    await expect(api('/me')).rejects.toMatchObject({ status: 401 });
  });
  it('never retries an old-account mutation using the new account token', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 401 }));
    state.getToken.mockImplementation(async (force?: boolean) => {
      if (force) state.uid = 'bob';
      return 'alice-token';
    });
    await expect(api('/me', { method: 'DELETE' })).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('discards private data when the account changes while the body is parsed', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        state.uid = 'bob';
        return { profile: { uid: 'alice' } };
      },
    } as Response);
    await expect(api('/me')).rejects.toMatchObject({ status: 401 });
  });
  it('rejects an old action before token retrieval when its expected user differs', async () => {
    state.uid = 'bob';
    await expect(api('/plans', { method: 'POST', expectedUid: 'alice' })).rejects.toMatchObject({
      status: 401,
    });
    expect(state.getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
