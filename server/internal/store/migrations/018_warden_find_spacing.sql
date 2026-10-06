-- Migration 018: rack clocks begin when a tool is stored; sliver finds are spaced by a week.
ALTER TABLE item_instances ADD COLUMN racked_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE warden_finds RENAME TO warden_finds_daily_legacy;
CREATE TABLE warden_finds(
 habitica_id TEXT NOT NULL,
 found_at INTEGER NOT NULL,
 PRIMARY KEY(habitica_id, found_at)
);
INSERT INTO warden_finds(habitica_id, found_at)
 SELECT habitica_id, utc_day * 86400 FROM warden_finds_daily_legacy;
DROP TABLE warden_finds_daily_legacy;
