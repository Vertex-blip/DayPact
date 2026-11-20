PRAGMA foreign_keys = ON;

CREATE TABLE meeting_place_operations (
  user_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,operation_id)
);

CREATE TABLE meeting_places (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  place_json TEXT NOT NULL CHECK(json_valid(place_json)),
  created_at TEXT NOT NULL,
  UNIQUE(plan_id,id),
  FOREIGN KEY(plan_id,proposed_by) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE
);
CREATE INDEX meeting_places_plan ON meeting_places(plan_id,created_at,id);
CREATE TRIGGER meeting_place_kind BEFORE INSERT ON meeting_places
WHEN NOT EXISTS(SELECT 1 FROM plans WHERE id=NEW.plan_id AND kind='event' AND cadence='once')
BEGIN SELECT RAISE(ABORT,'MEETING_REQUIRED'); END;
CREATE TRIGGER meeting_place_limit BEFORE INSERT ON meeting_places
WHEN NOT EXISTS(SELECT 1 FROM meeting_places WHERE id=NEW.id)
AND ((SELECT count(*) FROM meeting_places WHERE plan_id=NEW.plan_id)>=24
OR (SELECT count(*) FROM meeting_places WHERE plan_id=NEW.plan_id AND proposed_by=NEW.proposed_by)>=3)
BEGIN SELECT RAISE(ABORT,'PLACE_LIMIT'); END;

CREATE TABLE meeting_place_votes (
  plan_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(plan_id,user_id),
  FOREIGN KEY(plan_id,user_id) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(plan_id,option_id) REFERENCES meeting_places(plan_id,id) ON DELETE CASCADE
);
CREATE INDEX meeting_place_votes_option ON meeting_place_votes(plan_id,option_id);
CREATE TRIGGER clear_changed_meeting_places AFTER UPDATE OF kind,cadence ON plans
WHEN NEW.kind<>'event' OR NEW.cadence<>'once'
BEGIN DELETE FROM meeting_places WHERE plan_id=NEW.id; END;
