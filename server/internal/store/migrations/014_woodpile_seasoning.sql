-- Woodpile seasoning (docs/items/crafting-and-repair.md): green timber stacked
-- on a placed woodpile seasons after 1 real day (86,400s).
CREATE TABLE woodpile_stacks(
 id TEXT PRIMARY KEY,
 homestead_id TEXT NOT NULL REFERENCES homesteads(id),
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id),
 qty INTEGER NOT NULL CHECK (qty > 0),
 stacked_at INTEGER NOT NULL
);
CREATE INDEX woodpile_stacks_home ON woodpile_stacks(homestead_id);
CREATE INDEX woodpile_stacks_player ON woodpile_stacks(habitica_id);
