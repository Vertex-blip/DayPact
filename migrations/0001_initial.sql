PRAGMA foreign_keys = ON;

CREATE TABLE users (
  uid TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  username TEXT UNIQUE,
  bio TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE deleted_accounts (uid TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
CREATE TABLE friendships (
  user_low TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  user_high TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_low,user_high), CHECK(user_low < user_high)
);
CREATE INDEX friendships_high ON friendships(user_high);
CREATE TRIGGER friendship_limit BEFORE INSERT ON friendships
WHEN NOT EXISTS(SELECT 1 FROM friendships WHERE user_low=NEW.user_low AND user_high=NEW.user_high)
AND ((SELECT count(*) FROM friendships WHERE user_low=NEW.user_low OR user_high=NEW.user_low)>=200
OR (SELECT count(*) FROM friendships WHERE user_low=NEW.user_high OR user_high=NEW.user_high)>=200)
BEGIN SELECT RAISE(ABORT,'FRIEND_LIMIT'); END;
CREATE TABLE invitations (
  token_hash TEXT PRIMARY KEY,
  inviter_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_by TEXT REFERENCES users(uid) ON DELETE CASCADE,
  accepted_at TEXT,
  accepted_request_id TEXT
);
CREATE INDEX invitations_inviter ON invitations(inviter_id,expires_at);
CREATE TRIGGER invitation_limit BEFORE INSERT ON invitations
WHEN (SELECT count(*) FROM invitations WHERE inviter_id=NEW.inviter_id AND accepted_by IS NULL AND expires_at>NEW.created_at)>=20
BEGIN SELECT RAISE(ABORT,'INVITATION_LIMIT'); END;
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('habit','event','savings')),
  cadence TEXT NOT NULL CHECK(cadence IN ('once','daily','weekly','monthly')),
  start_date TEXT NOT NULL,
  time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  place_json TEXT CHECK(place_json IS NULL OR json_valid(place_json)),
  target_amount INTEGER CHECK(target_amount IS NULL OR (target_amount > 0 AND target_amount <= 1000000000)),
  remind_minutes INTEGER NOT NULL CHECK(remind_minutes >= -1 AND remind_minutes <= 10080),
  version INTEGER NOT NULL DEFAULT 1,
  mutation_id TEXT NOT NULL,
  next_reminder_at TEXT,
  next_reminder_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX plans_owner ON plans(owner_id,created_at);
CREATE INDEX plans_due ON plans(next_reminder_at) WHERE next_reminder_at IS NOT NULL;
/* Keep the creation receipt after deletion so an offline retry cannot recreate a plan. */
CREATE TABLE plan_create_operations (
  user_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,operation_id)
);
CREATE TABLE plan_members (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY(plan_id,user_id)
);
CREATE INDEX plan_members_user ON plan_members(user_id,plan_id);
CREATE TRIGGER membership_limit BEFORE INSERT ON plan_members
WHEN NOT EXISTS(SELECT 1 FROM plan_members WHERE plan_id=NEW.plan_id AND user_id=NEW.user_id)
AND (SELECT count(*) FROM plan_members WHERE user_id=NEW.user_id)>=200
BEGIN SELECT RAISE(ABORT,'PLAN_LIMIT'); END;
CREATE TRIGGER plan_member_requires_friend BEFORE INSERT ON plan_members
WHEN NOT EXISTS (
 SELECT 1 FROM plans p WHERE p.id=NEW.plan_id AND (
 p.owner_id=NEW.user_id OR EXISTS(SELECT 1 FROM friendships f WHERE
 f.user_low=min(p.owner_id,NEW.user_id) AND f.user_high=max(p.owner_id,NEW.user_id))))
BEGIN SELECT RAISE(ABORT,'MEMBER_NOT_FRIEND'); END;
CREATE TABLE checkins (
  plan_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  completed INTEGER NOT NULL CHECK(completed IN(0,1)),
  contribution INTEGER NOT NULL DEFAULT 0 CHECK(contribution BETWEEN 0 AND 1000000000),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(plan_id,user_id,occurrence_date),
  FOREIGN KEY(plan_id,user_id) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE
);
CREATE INDEX checkins_user ON checkins(user_id,occurrence_date);
CREATE TABLE operations (
  user_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,operation_id)
);
CREATE INDEX operations_created ON operations(created_at);
CREATE TABLE rsvps (
  plan_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('accepted','declined')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(plan_id,user_id,occurrence_date),
  FOREIGN KEY(plan_id,user_id) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE
);
CREATE TABLE nudges (
  plan_id TEXT NOT NULL,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  last_sent_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  PRIMARY KEY(plan_id,from_user,to_user,occurrence_date),
  FOREIGN KEY(plan_id,from_user) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(plan_id,to_user) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  plan_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN('reminder','nudge')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  delivered_at TEXT,
  next_attempt_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','delivered','skipped','failed')),
  dedupe_key TEXT NOT NULL UNIQUE,
  FOREIGN KEY(plan_id,user_id) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE
);
CREATE INDEX notifications_user ON notifications(user_id,created_at DESC);
CREATE INDEX notifications_delivery ON notifications(state,next_attempt_at);
CREATE TABLE push_tokens (
  user_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,device_id)
);
CREATE TRIGGER push_device_limit BEFORE INSERT ON push_tokens
WHEN NOT EXISTS(SELECT 1 FROM push_tokens WHERE user_id=NEW.user_id AND device_id=NEW.device_id)
AND (SELECT count(*) FROM push_tokens WHERE user_id=NEW.user_id)>=3
BEGIN SELECT RAISE(ABORT,'DEVICE_LIMIT'); END;
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
CREATE TRIGGER remove_friend_memberships AFTER DELETE ON friendships BEGIN
 DELETE FROM plan_members WHERE
  (user_id=OLD.user_low AND plan_id IN(SELECT id FROM plans WHERE owner_id=OLD.user_high)) OR
  (user_id=OLD.user_high AND plan_id IN(SELECT id FROM plans WHERE owner_id=OLD.user_low));
END;
