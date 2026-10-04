CREATE TABLE homesteads(
 habitica_id TEXT PRIMARY KEY REFERENCES players(habitica_id), world_id TEXT NOT NULL REFERENCES worlds(id),
 plot_index INTEGER NOT NULL CHECK(plot_index>=0), tier INTEGER NOT NULL DEFAULT 0 CHECK(tier BETWEEN 0 AND 4),
 UNIQUE(world_id,plot_index)
);
CREATE TABLE homestead_items(
 id TEXT PRIMARY KEY, habitica_id TEXT NOT NULL REFERENCES homesteads(habitica_id), item_def TEXT NOT NULL,
 scene TEXT CHECK(scene IN ('indoor','outdoor')), x INTEGER, y INTEGER, rotation INTEGER,
 CHECK((scene IS NULL AND x IS NULL AND y IS NULL AND rotation IS NULL) OR
 (scene IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL AND rotation IS NOT NULL AND x>=0 AND y>=0 AND rotation IN (0,90,180,270)))
);
CREATE INDEX homestead_inventory ON homestead_items(habitica_id,id);
CREATE TABLE materials(habitica_id TEXT NOT NULL REFERENCES players(habitica_id), material TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>=0), PRIMARY KEY(habitica_id,material));
CREATE TABLE region_epochs(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id), region_id TEXT NOT NULL,
 world_seed TEXT NOT NULL, generator_version INTEGER NOT NULL, season TEXT NOT NULL,
 starts_at INTEGER NOT NULL, ends_at INTEGER, UNIQUE(world_id,region_id,season)
);
CREATE TABLE entity_state(
 epoch TEXT NOT NULL REFERENCES region_epochs(id), entity_id TEXT NOT NULL,
 cycle INTEGER NOT NULL DEFAULT 0 CHECK(cycle>=0), state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','cleared','harvested','charted')),
 available_at INTEGER NOT NULL DEFAULT 0, by_id TEXT REFERENCES players(habitica_id), at INTEGER,
 PRIMARY KEY(epoch,entity_id)
);
CREATE TABLE personal_claims(
 epoch TEXT NOT NULL REFERENCES region_epochs(id), entity_id TEXT NOT NULL, habitica_id TEXT NOT NULL REFERENCES players(habitica_id),
 at INTEGER NOT NULL, PRIMARY KEY(epoch,entity_id,habitica_id)
);
CREATE TABLE discoveries(
 epoch TEXT NOT NULL REFERENCES region_epochs(id), entity_id TEXT NOT NULL, poi_id TEXT NOT NULL,
 discoverer_id TEXT NOT NULL REFERENCES players(habitica_id), at INTEGER NOT NULL, PRIMARY KEY(epoch,entity_id)
);
CREATE TABLE lanterns(
 id TEXT PRIMARY KEY, epoch TEXT NOT NULL REFERENCES region_epochs(id), world_id TEXT NOT NULL REFERENCES worlds(id),
 region_id TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES players(habitica_id), x INTEGER NOT NULL, y INTEGER NOT NULL,
 lit_by TEXT REFERENCES players(habitica_id), at INTEGER NOT NULL, lit_at INTEGER,
 UNIQUE(world_id,region_id,owner_id)
);
CREATE TABLE lantern_rewards(habitica_id TEXT NOT NULL REFERENCES players(habitica_id), utc_day TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>=0), PRIMARY KEY(habitica_id,utc_day));
CREATE TABLE claim_rate(habitica_id TEXT PRIMARY KEY REFERENCES players(habitica_id), window_at INTEGER NOT NULL, qty INTEGER NOT NULL CHECK(qty>0));
