import { currentAuth } from './firebase';
import type { Locale } from '../shared/contracts';
import { texts } from './i18n';

export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 0,
    message = code,
  ) {
    super(message);
  }
}
export interface ApiOptions extends RequestInit {
  expectedUid?: string;
}
export async function api<T>(path: string, options: ApiOptions = {}, retry = true): Promise<T> {
  const user = currentAuth()?.currentUser;
  if (!user || (options.expectedUid !== undefined && options.expectedUid !== user.uid))
    throw new ApiError('UNAUTHENTICATED', 401);
  let token: string;
  try {
    token = await user.getIdToken();
  } catch {
    throw new ApiError('UNAUTHENTICATED', 401);
  }
  if (currentAuth()?.currentUser?.uid !== user.uid) throw new ApiError('UNAUTHENTICATED', 401);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let response: Response;
    try {
      response = await fetch(`/api${path}`, {
        ...options,
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...options.headers,
        },
      });
    } catch {
      throw new ApiError('NETWORK');
    }
    if (currentAuth()?.currentUser?.uid !== user.uid) throw new ApiError('UNAUTHENTICATED', 401);
    if (response.status === 401 && retry) {
      try {
        await user.getIdToken(true);
      } catch {
        throw new ApiError('UNAUTHENTICATED', 401);
      }
      if (currentAuth()?.currentUser?.uid !== user.uid) throw new ApiError('UNAUTHENTICATED', 401);
      return api<T>(path, options, false);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(controller.signal.aborted ? 'NETWORK' : 'SERVER_ERROR', response.status);
    }
    if (currentAuth()?.currentUser?.uid !== user.uid) throw new ApiError('UNAUTHENTICATED', 401);
    if (!response.ok) {
      const error = (data as { error?: { code?: string; message?: string } })?.error;
      throw new ApiError(error?.code ?? 'SERVER_ERROR', response.status, error?.message);
    }
    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}
export const writeApi = <T>(
  path: string,
  method: string,
  body?: unknown,
  expectedUid?: string,
  headers?: Record<string, string>,
) =>
  api<T>(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    expectedUid,
    headers,
  });
export function readableError(error: unknown, locale: Locale): string {
  const t = texts(locale);
  const code =
    error instanceof ApiError
      ? error.code
      : ((error as { code?: string })?.code ?? (error instanceof Error ? error.message : ''));
  if (code === 'PUSH_UNSUPPORTED') return t.unsupportedNotifications;
  if (code === 'PUSH_SETUP') return t.notificationSetup;
  if (code === 'PUSH_DENIED') return t.blockedNotifications;
  if (code === 'PUSH_TIMEOUT')
    return locale === 'kk'
      ? 'Хабарландыруларды қосу ұзаққа созылды. Интернетті тексеріп, қайта көр.'
      : 'Не удалось вовремя подключить уведомления. Проверь интернет и попробуй ещё раз.';
  if (code === 'PASSWORDS_MISMATCH') return t.passwordsMismatch;
  if (code === 'PASSWORD_POLICY' || code === 'auth/password-does-not-meet-requirements')
    return locale === 'kk'
      ? 'Пароль қауіпсіздік талаптарына сай емес. Кемінде 12 таңба, бас және кіші әріп, сан және арнайы таңба қолдан.'
      : 'Пароль не соответствует требованиям безопасности. Используй минимум 12 символов, заглавную и строчную буквы, цифру и специальный символ.';
  if (code === 'ACCOUNT_DELETED' || code === 'AUTH_DELETE_PENDING')
    return locale === 'kk'
      ? 'Жеке деректерің жойылған. Аккаунтты жоюды аяқтау үшін пароліңді қайта енгіз.'
      : 'Личные данные удалены. Введи пароль ещё раз, чтобы завершить удаление аккаунта.';
  if (
    code === 'RECENT_LOGIN_REQUIRED' ||
    code === 'REAUTH_REQUIRED' ||
    code === 'auth/requires-recent-login'
  )
    return locale === 'kk'
      ? 'Қауіпсіздік үшін аккаунтқа қайта кіріп, әрекетті қайтала.'
      : 'Для безопасности войди в аккаунт снова и повтори действие.';
  if (code === 'EXPORT_TOO_LARGE')
    return locale === 'kk'
      ? 'Деректер көлемі осы құрылғы үшін тым үлкен. Экспортты компьютерден қайтала.'
      : 'Объём данных слишком велик для этого устройства. Повтори экспорт с компьютера.';
  if (code === 'PASSWORD_TOO_SHORT' || code === 'auth/weak-password') return t.weakPassword;
  if (code === 'auth/email-already-in-use') return t.emailUsed;
  if (code === 'auth/invalid-email') return t.invalidEmail;
  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found'
  )
    return t.authError;
  if (code === 'auth/too-many-requests' || (error instanceof ApiError && error.status === 429))
    return t.rateLimit;
  if (code === 'NETWORK' || code === 'auth/network-request-failed') return t.networkError;
  if (code === 'EMAIL_NOT_VERIFIED' || code === 'EMAIL_UNVERIFIED') return t.emailUnverified;
  if (error instanceof ApiError) {
    if (error.status === 401) return t.sessionExpired;
    if (error.status === 403) return t.permissionError;
    if (error.status === 404) return t.noPlanAccess;
    if (error.status === 409) return t.conflictError;
    if (error.status === 400 || error.status === 422) return t.invalidInput;
  }
  return t.genericError;
}
