PRAGMA foreign_keys = ON;
ALTER TABLE plans ADD COLUMN min_attendees INTEGER NOT NULL DEFAULT 2 CHECK(min_attendees BETWEEN 2 AND 21);
DROP TRIGGER meeting_place_kind;
CREATE TRIGGER meeting_place_kind BEFORE INSERT ON meeting_places
WHEN NOT EXISTS(SELECT 1 FROM plans WHERE id=NEW.plan_id AND kind='event')
BEGIN SELECT RAISE(ABORT,'MEETING_REQUIRED'); END;
DROP TRIGGER clear_changed_meeting_places;
CREATE TRIGGER clear_changed_meeting_places AFTER UPDATE OF kind ON plans
WHEN NEW.kind<>'event'
BEGIN DELETE FROM meeting_places WHERE plan_id=NEW.id; END;

CREATE TABLE meeting_times (
 id TEXT PRIMARY KEY,
 plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
 date TEXT NOT NULL,
 time TEXT NOT NULL,
 UNIQUE(plan_id,id), UNIQUE(plan_id,date,time)
);
CREATE TRIGGER meeting_times_limit BEFORE INSERT ON meeting_times
WHEN (SELECT count(*) FROM meeting_times WHERE plan_id=NEW.plan_id)>=6
BEGIN SELECT RAISE(ABORT,'COORDINATION_LIMIT'); END;
CREATE TABLE meeting_time_votes (
 plan_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 option_id TEXT NOT NULL,
 PRIMARY KEY(plan_id,user_id,option_id),
 FOREIGN KEY(plan_id,user_id) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(plan_id,option_id) REFERENCES meeting_times(plan_id,id) ON DELETE CASCADE
);
CREATE TABLE meeting_travel (
 plan_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 occurrence_date TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('on_way','late','arrived')),
 late_minutes INTEGER CHECK(late_minutes IS NULL OR late_minutes BETWEEN 1 AND 240),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(plan_id,user_id,occurrence_date),
 FOREIGN KEY(plan_id,user_id) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE
);
CREATE TABLE meeting_item_operations (
 user_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
 operation_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 PRIMARY KEY(user_id,operation_id)
);
CREATE TABLE meeting_items (
 id TEXT PRIMARY KEY,
 plan_id TEXT NOT NULL,
 occurrence_date TEXT NOT NULL,
 created_by TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
 claimed_by TEXT REFERENCES users(uid) ON DELETE SET NULL,
 version INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(plan_id,created_by) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE
);
CREATE INDEX meeting_items_date ON meeting_items(plan_id,occurrence_date);
CREATE TRIGGER meeting_items_limit BEFORE INSERT ON meeting_items
WHEN (SELECT count(*) FROM meeting_items WHERE plan_id=NEW.plan_id)>=300
OR (SELECT count(*) FROM meeting_items WHERE plan_id=NEW.plan_id AND occurrence_date=NEW.occurrence_date)>=30
BEGIN SELECT RAISE(ABORT,'COORDINATION_LIMIT'); END;
CREATE TRIGGER unclaim_removed_member BEFORE DELETE ON plan_members
BEGIN UPDATE meeting_items SET claimed_by=NULL,version=version+1 WHERE plan_id=OLD.plan_id AND claimed_by=OLD.user_id; END;
CREATE TABLE meeting_expenses (
 plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
 occurrence_date TEXT NOT NULL,
 total INTEGER NOT NULL CHECK(total BETWEEN 0 AND 1000000000),
 version INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(plan_id,occurrence_date)
);
CREATE TRIGGER meeting_expenses_limit BEFORE INSERT ON meeting_expenses
WHEN NOT EXISTS(SELECT 1 FROM meeting_expenses WHERE plan_id=NEW.plan_id AND occurrence_date=NEW.occurrence_date)
AND NEW.total>0 AND (SELECT count(*) FROM meeting_expenses WHERE plan_id=NEW.plan_id AND total>0)>=366
BEGIN SELECT RAISE(ABORT,'COORDINATION_LIMIT'); END;
CREATE TRIGGER meeting_expenses_reopen_limit BEFORE UPDATE OF total ON meeting_expenses
WHEN OLD.total=0 AND NEW.total>0 AND (SELECT count(*) FROM meeting_expenses WHERE plan_id=NEW.plan_id AND total>0)>=366
BEGIN SELECT RAISE(ABORT,'COORDINATION_LIMIT'); END;
CREATE TABLE meeting_expense_paid (
 plan_id TEXT NOT NULL,
 occurrence_date TEXT NOT NULL,
 user_id TEXT NOT NULL,
 expense_version INTEGER NOT NULL,
 paid INTEGER NOT NULL CHECK(paid IN(0,1)),
 PRIMARY KEY(plan_id,occurrence_date,user_id),
 FOREIGN KEY(plan_id,occurrence_date) REFERENCES meeting_expenses(plan_id,occurrence_date) ON DELETE CASCADE,
 FOREIGN KEY(plan_id,user_id) REFERENCES plan_members(plan_id,user_id) ON DELETE CASCADE
);
CREATE TRIGGER expense_total_changed AFTER UPDATE OF total ON meeting_expenses
BEGIN DELETE FROM meeting_expense_paid WHERE plan_id=NEW.plan_id AND occurrence_date=NEW.occurrence_date; END;
CREATE TRIGGER expense_new_acceptance AFTER INSERT ON rsvps
WHEN NEW.status='accepted'
BEGIN
 UPDATE meeting_expenses SET version=version+1 WHERE plan_id=NEW.plan_id AND occurrence_date=NEW.occurrence_date;
 DELETE FROM meeting_expense_paid WHERE plan_id=NEW.plan_id AND occurrence_date=NEW.occurrence_date;
END;
CREATE TRIGGER expense_changed_acceptance AFTER UPDATE OF status ON rsvps
WHEN OLD.status<>NEW.status
BEGIN
 UPDATE meeting_expenses SET version=version+1 WHERE plan_id=NEW.plan_id AND occurrence_date=NEW.occurrence_date;
 DELETE FROM meeting_expense_paid WHERE plan_id=NEW.plan_id AND occurrence_date=NEW.occurrence_date;
 DELETE FROM meeting_travel WHERE plan_id=NEW.plan_id AND user_id=NEW.user_id AND occurrence_date=NEW.occurrence_date AND NEW.status<>'accepted';
END;
CREATE TRIGGER expense_removed_acceptance AFTER DELETE ON rsvps
BEGIN
 UPDATE meeting_expenses SET version=version+1 WHERE plan_id=OLD.plan_id AND occurrence_date=OLD.occurrence_date AND OLD.status='accepted';
 DELETE FROM meeting_expense_paid WHERE plan_id=OLD.plan_id AND occurrence_date=OLD.occurrence_date AND OLD.status='accepted';
 DELETE FROM meeting_travel WHERE plan_id=OLD.plan_id AND user_id=OLD.user_id AND occurrence_date=OLD.occurrence_date;
END;
CREATE TABLE meeting_notification_receipts (
 plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
 occurrence_date TEXT NOT NULL,
 event_key TEXT NOT NULL,
 request_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(plan_id,occurrence_date,event_key)
);
CREATE INDEX meeting_travel_user ON meeting_travel(user_id,plan_id,occurrence_date);
CREATE INDEX meeting_time_votes_user ON meeting_time_votes(user_id,plan_id,option_id);
CREATE INDEX meeting_items_creator ON meeting_items(created_by,id);
CREATE INDEX meeting_items_claimant ON meeting_items(claimed_by,id);
CREATE INDEX meeting_expense_paid_user ON meeting_expense_paid(user_id,plan_id,occurrence_date);
CREATE INDEX rsvps_user ON rsvps(user_id,plan_id,occurrence_date);
CREATE TRIGGER clear_nonmeeting_coordination AFTER UPDATE OF kind ON plans
WHEN NEW.kind<>'event'
BEGIN
 DELETE FROM meeting_times WHERE plan_id=NEW.id;
 DELETE FROM meeting_travel WHERE plan_id=NEW.id;
 DELETE FROM meeting_items WHERE plan_id=NEW.id;
 DELETE FROM meeting_expenses WHERE plan_id=NEW.id;
END;
