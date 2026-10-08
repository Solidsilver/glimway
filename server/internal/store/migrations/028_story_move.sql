-- Rebuild the bridge's story rows from the retained document in the Go backfill.
DELETE FROM story_marks;
DELETE FROM quest_progress;
ALTER TABLE idempotency ADD COLUMN payload_json TEXT NOT NULL DEFAULT 'null';
