import type { User } from 'firebase/auth';
import { ApiError, readableError } from '../api';
import { currentAuth } from '../firebase';
import type { Locale } from '../../shared/contracts';
import { adminTexts } from './texts';

export async function adminApi<T>(
  user: User,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const assertCurrent = () => {
    if (currentAuth()?.currentUser?.uid !== user.uid) throw new ApiError('UNAUTHENTICATED', 401);
  };
  assertCurrent();
  const token = await user.getIdToken();
  assertCurrent();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    let response: Response;
    try {
      response = await fetch(`/api/admin${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('NETWORK');
    }
    assertCurrent();
    const data = await response.json().catch(() => null);
    assertCurrent();
    if (!response.ok) {
      const code = (data as { error?: { code?: unknown } } | null)?.error?.code;
      throw new ApiError(typeof code === 'string' ? code : 'SERVER_ERROR', response.status);
    }
    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function adminError(error: unknown, locale: Locale): string {
  const t = adminTexts(locale);
  const code = error instanceof ApiError ? error.code : '';
  if (code === 'ADMIN_CODE_INVALID') return t.codeInvalid;
  if (code === 'ADMIN_CODE_REUSED') return t.codeReused;
  if (code === 'ADMIN_FORBIDDEN') return t.noAccess;
  if (code === 'ADMIN_SETUP_REQUIRED' || code === 'ADMIN_UNLOCK_REQUIRED') return t.sessionExpired;
  if (code === 'ADMIN_CONFIGURATION') return t.configuration;
  if (code === 'ADMIN_PROVIDER_UNAVAILABLE') return t.providerUnavailable;
  if (code === 'ADMIN_ACTION_PENDING') return t.actionPending;
  if (code === 'ADMIN_ACTION_BUSY') return t.actionBusy;
  if (code === 'ADMIN_OWNER_PROTECTED') return t.ownerProtected;
  if (code === 'ADMIN_CONFIRMATION_REQUIRED') return t.confirmError;
  if (code === 'ACCOUNT_NOT_FOUND') return t.accountNotFound;
  return readableError(error, locale);
}
