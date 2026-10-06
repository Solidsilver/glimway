-- Migration 017: Warden-stone tools and Wilds find caps.
-- worn_at tracks the timestamp when a tool was last worn, for 1-hour healing on a tool rack.
ALTER TABLE item_instances ADD COLUMN worn_at INTEGER NOT NULL DEFAULT 0;

-- warden_finds tracks the rare capped finds of warden-stone slivers (at most 1 per player per UTC day).
CREATE TABLE warden_finds(
 habitica_id TEXT NOT NULL,
 utc_day INTEGER NOT NULL,
 PRIMARY KEY(habitica_id, utc_day)
);
