CREATE TABLE village_repairs (
  world_id TEXT NOT NULL REFERENCES worlds(id),
  repair_id TEXT NOT NULL,
  mended_by TEXT REFERENCES players(habitica_id),
  mended_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(world_id, repair_id)
);
CREATE INDEX village_repairs_world ON village_repairs(world_id, repair_id);

CREATE TABLE village_repair_log (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  repair_id TEXT NOT NULL,
  mended_by TEXT NOT NULL REFERENCES players(habitica_id),
  mended_at INTEGER NOT NULL
);
CREATE INDEX village_repair_log_world ON village_repair_log(world_id, mended_at DESC);
