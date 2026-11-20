import { HttpError, type Env } from '../types';

export function isAdminOwner(env: Env, uid: string): boolean {
  return !!env.ADMIN_OWNER_UID && uid === env.ADMIN_OWNER_UID;
}
export async function assertUserActive(env: Env, uid: string): Promise<void> {
  const row = await env.DB.prepare('SELECT state FROM user_moderation WHERE user_id=?')
    .bind(uid)
    .first<{ state: string }>();
  if (row && row.state !== 'active')
    throw new HttpError(
      403,
      row.state === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DELETED',
      'This account is unavailable.',
    );
}
