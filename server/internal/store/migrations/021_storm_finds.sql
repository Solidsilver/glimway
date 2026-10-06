-- Migration 021: storm-grade drop finds are spaced like warden-sliver finds
-- (docs/items/crafting-and-repair.md: very rare, deep Tangle and the Whitequiet).
CREATE TABLE storm_finds(
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id),
 found_at INTEGER NOT NULL,
 PRIMARY KEY(habitica_id, found_at)
);
