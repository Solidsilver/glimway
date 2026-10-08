ALTER TABLE quest_progress ADD COLUMN reached_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quest_progress ADD COLUMN gate_at INTEGER NOT NULL DEFAULT 0;
UPDATE quest_progress SET reached_at=unixepoch(),gate_at=unixepoch();
INSERT INTO quest_progress(account_id,quest,step,reached_at,gate_at)
SELECT account_id,'signpost','light-first-lamp',reached_at,gate_at
FROM quest_progress WHERE quest='lantern-road';
