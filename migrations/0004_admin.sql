CREATE TABLE admin_totp (
  user_id TEXT PRIMARY KEY,
  secret_cipher TEXT,
  pending_cipher TEXT,
  pending_expires_at TEXT,
  last_counter INTEGER NOT NULL DEFAULT -1,
  updated_at TEXT NOT NULL
);
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  auth_time INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE admin_mfa_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX admin_mfa_attempts_user_time ON admin_mfa_attempts(user_id,attempted_at);
CREATE TABLE user_moderation (
  user_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN('active','suspended','delete_pending','deleted')),
  pending_action TEXT CHECK(pending_action IN('suspend','restore','delete')),
  pending_email TEXT,
  email_hash TEXT,
  operation_id TEXT,
  lease_until TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  actor_uid TEXT NOT NULL,
  target_uid TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN('success','failure')),
  created_at TEXT NOT NULL
);
CREATE INDEX admin_audit_time ON admin_audit(created_at DESC);
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN('help','report')),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 120),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','closed')),
  reply TEXT NOT NULL DEFAULT '' CHECK(length(reply)<=2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX support_tickets_user ON support_tickets(user_id,created_at DESC);
CREATE INDEX support_tickets_status ON support_tickets(status,created_at DESC);
