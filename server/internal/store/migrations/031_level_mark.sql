-- Magic's level mark (docs/design/crafts.md 4.2): the highest level a
-- verified sync has seen, sign-ins and profile syncs alike, which unlocks
-- moves and remembers a rebirth's magic. `verified_high_level` keeps its old,
-- stricter meaning -- the highest level a verified sign-in saw -- which is
-- what the rebirth and forgery checks trust (review finding 7).
ALTER TABLE sync_baselines ADD COLUMN level_mark INTEGER NOT NULL DEFAULT 0;
UPDATE sync_baselines SET level_mark = verified_high_level;
