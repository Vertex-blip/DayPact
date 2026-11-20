import type { AdminAction, AdminPendingAction, AdminUser, AdminUsers } from '../../shared/admin';
import { digest } from '../security';
import { HttpError, type Env, type Identity } from '../types';
import { isAdminOwner } from './guards';
import {
  deleteManagedFirebaseUser,
  listFirebaseUsers,
  lookupFirebaseUser,
  setFirebaseDisabled,
  type FirebaseManagedUser,
} from './provider';

interface Moderation {
  user_id: string;
  state: AdminUser['moderation'];
  pending_action: AdminAction | null;
  pending_email: string | null;
  email_hash: string | null;
  operation_id: string | null;
  lease_until: string | null;
  updated_at: string;
}
export async function audit(
  env: Env,
  identity: Identity,
  action: string,
  outcome: 'success' | 'failure',
  targetUid: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO admin_audit(id,actor_uid,target_uid,action,outcome,created_at) VALUES(?,?,?,?,?,?)',
  )
    .bind(crypto.randomUUID(), identity.uid, targetUid, action, outcome, new Date().toISOString())
    .run();
}
function stamp(value: string | undefined): string | null {
  const millis = Number(value);
  return value && Number.isSafeInteger(millis) && millis > 0 && millis < 8640000000000000
    ? new Date(millis).toISOString()
    : null;
}
export async function managedUsers(
  env: Env,
  query?: string,
  pageToken?: string,
): Promise<AdminUsers> {
  let firebase: { users: FirebaseManagedUser[]; nextPageToken?: string };
  if (query) {
    const user = await lookupFirebaseUser(
      env,
      query.includes('@') ? { email: query } : { uid: query },
    );
    firebase = { users: user ? [user] : [] };
  } else firebase = await listFirebaseUsers(env, pageToken);
  const ids = JSON.stringify(firebase.users.map((u) => u.localId));
  const [moderation, registered, pending] = await Promise.all([
    env.DB.prepare('SELECT * FROM user_moderation WHERE user_id IN(SELECT value FROM json_each(?))')
      .bind(ids)
      .all<Moderation>(),
    env.DB.prepare('SELECT uid FROM users WHERE uid IN(SELECT value FROM json_each(?))')
      .bind(ids)
      .all<{ uid: string }>(),
    env.DB.prepare(
      'SELECT user_id,pending_email,pending_action,updated_at FROM user_moderation WHERE pending_action IS NOT NULL ORDER BY updated_at DESC LIMIT 50',
    ).all<Pick<Moderation, 'user_id' | 'pending_email' | 'pending_action' | 'updated_at'>>(),
  ]);
  const states = new Map(moderation.results.map((row) => [row.user_id, row.state]));
  const appUsers = new Set(registered.results.map((row) => row.uid));
  return {
    users: firebase.users.map((user) => ({
      uid: user.localId,
      email: user.email ?? '',
      displayName: user.displayName ?? '',
      emailVerified: user.emailVerified === true,
      disabled: user.disabled === true,
      createdAt: stamp(user.createdAt),
      lastSignInAt: stamp(user.lastLoginAt),
      protected: isAdminOwner(env, user.localId),
      appRegistered: appUsers.has(user.localId),
      moderation: states.get(user.localId) ?? 'active',
    })),
    nextPageToken: firebase.nextPageToken ?? null,
    pendingActions: pending.results.map(
      (row) =>
        ({
          uid: row.user_id,
          email: row.pending_email ?? '',
          action: row.pending_action!,
          updatedAt: row.updated_at,
        }) satisfies AdminPendingAction,
    ),
  };
}
export async function mutateManagedUser(
  env: Env,
  identity: Identity,
  uid: string,
  action: AdminAction,
  confirmEmail: string,
): Promise<void> {
  if (isAdminOwner(env, uid))
    throw new HttpError(403, 'ADMIN_OWNER_PROTECTED', 'The owner account is protected.');
  const previous = await env.DB.prepare('SELECT * FROM user_moderation WHERE user_id=?')
    .bind(uid)
    .first<Moderation>();
  const emailHash = await digest(confirmEmail.trim().toLowerCase());
  if (previous?.state === 'deleted') {
    if (action === 'delete' && previous.email_hash === emailHash) {
      await audit(env, identity, 'user.delete', 'success', uid);
      return;
    }
    throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
  }
  const firebase = await lookupFirebaseUser(env, { uid });
  if (firebase && firebase.localId !== uid)
    throw new HttpError(503, 'ADMIN_PROVIDER_UNAVAILABLE', 'Account metadata is unavailable.');
  const email = firebase?.email ?? previous?.pending_email;
  if (!email || (!firebase && action !== 'delete'))
    throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
  if (email.trim().toLowerCase() !== confirmEmail.trim().toLowerCase())
    throw new HttpError(
      400,
      'ADMIN_CONFIRMATION_REQUIRED',
      'Enter the selected account email to confirm.',
    );
  const now = new Date().toISOString(),
    operation = crypto.randomUUID(),
    lease = new Date(Date.now() + 90000).toISOString();
  const state = action === 'delete' ? 'delete_pending' : 'suspended';
  const claim = await env.DB.prepare(
    `INSERT INTO user_moderation(user_id,state,pending_action,pending_email,email_hash,operation_id,lease_until,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,pending_action=excluded.pending_action,pending_email=excluded.pending_email,email_hash=excluded.email_hash,operation_id=excluded.operation_id,lease_until=excluded.lease_until,updated_at=excluded.updated_at
    WHERE (user_moderation.lease_until IS NULL OR user_moderation.lease_until<=?) AND user_moderation.state<>'deleted' AND (user_moderation.state<>'delete_pending' OR excluded.pending_action='delete') RETURNING user_id`,
  )
    .bind(uid, state, action, email, emailHash, operation, lease, now, now)
    .first();
  if (!claim)
    throw new HttpError(409, 'ADMIN_ACTION_BUSY', 'An account action is already in progress.');
  try {
    if (action === 'delete') {
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO deleted_accounts(uid,deleted_at) VALUES(?,?)').bind(
          uid,
          now,
        ),
        env.DB.prepare('DELETE FROM users WHERE uid=?').bind(uid),
      ]);
      await deleteManagedFirebaseUser(env, uid);
    } else {
      if (action === 'suspend')
        await env.DB.batch([
          env.DB.prepare('DELETE FROM push_tokens WHERE user_id=?').bind(uid),
          env.DB.prepare(
            "UPDATE notifications SET state='skipped' WHERE user_id=? AND state='pending'",
          ).bind(uid),
        ]);
      await setFirebaseDisabled(env, uid, action === 'suspend');
    }
    const result = await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO admin_audit(id,actor_uid,target_uid,action,outcome,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM user_moderation WHERE user_id=? AND operation_id=?)',
      ).bind(
        crypto.randomUUID(),
        identity.uid,
        uid,
        `user.${action}`,
        'success',
        new Date().toISOString(),
        uid,
        operation,
      ),
      env.DB.prepare(
        'UPDATE user_moderation SET state=?,pending_action=NULL,pending_email=NULL,operation_id=NULL,lease_until=NULL,updated_at=? WHERE user_id=? AND operation_id=?',
      ).bind(
        action === 'delete' ? 'deleted' : action === 'suspend' ? 'suspended' : 'active',
        new Date().toISOString(),
        uid,
        operation,
      ),
    ]);
    if (!result[1].meta.changes) throw new Error('LEASE_LOST');
  } catch {
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE user_moderation SET lease_until=NULL,updated_at=? WHERE user_id=? AND operation_id=?',
      ).bind(new Date().toISOString(), uid, operation),
      env.DB.prepare(
        'INSERT INTO admin_audit(id,actor_uid,target_uid,action,outcome,created_at) VALUES(?,?,?,?,?,?)',
      ).bind(
        crypto.randomUUID(),
        identity.uid,
        uid,
        `user.${action}`,
        'failure',
        new Date().toISOString(),
      ),
    ]);
    throw new HttpError(
      503,
      'ADMIN_ACTION_PENDING',
      'The account action is pending. Retry this action.',
    );
  }
}
