CREATE TABLE study_documents (
  user_id TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  data_json TEXT NOT NULL CHECK(json_valid(data_json) AND length(CAST(data_json AS BLOB))<=49152),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at TEXT NOT NULL,
  next_reminder_at TEXT,
  next_reminder_date TEXT,
  next_reminder_lesson TEXT,
  CHECK((next_reminder_at IS NULL AND next_reminder_date IS NULL AND next_reminder_lesson IS NULL) OR (next_reminder_at IS NOT NULL AND next_reminder_date IS NOT NULL AND next_reminder_lesson IS NOT NULL))
);
CREATE INDEX study_documents_reminder ON study_documents(next_reminder_at) WHERE next_reminder_at IS NOT NULL;
CREATE TABLE study_reminder_receipts (
  user_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  PRIMARY KEY(user_id,lesson_id,occurrence_date)
);
ALTER TABLE notifications ADD COLUMN study_lesson_id TEXT;
ALTER TABLE notifications ADD COLUMN study_date TEXT;
ALTER TABLE notifications ADD COLUMN study_version INTEGER;
CREATE INDEX notifications_study_user ON notifications(user_id,study_version,state) WHERE study_version IS NOT NULL;
