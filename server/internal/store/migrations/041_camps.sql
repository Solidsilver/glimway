-- Camps (roadmap 0.13; lamps.md 2.5): a way-lamp set in a Wilds chunk holds
-- that one chunk while it has oil. The hold itself is the holds row (039,
-- holder kind "way-lamp", the camp's id); a camp's id is its lamp's, the
-- way-lamp piece standing in it. Its store of oil is in wicks; dimming, out
-- of oil with a wick of warning left. setter is who set the lamp: they (and
-- their household) build there.
CREATE TABLE camps(
 id TEXT PRIMARY KEY,
 world_id TEXT NOT NULL REFERENCES worlds(id),
 cx INTEGER NOT NULL, cy INTEGER NOT NULL,
 setter TEXT NOT NULL REFERENCES players(account_id),
 oil INTEGER NOT NULL DEFAULT 0 CHECK(oil>=0),
 dimming INTEGER NOT NULL DEFAULT 0 CHECK(dimming IN (0,1)),
 set_at INTEGER NOT NULL,
 UNIQUE(world_id,cx,cy)
);

-- A camp's pieces are home pieces at location 'camp', still their owner's
-- (account_id: whoever set them out), at camp-local tiles of its chunk. A
-- lapsed camp's pieces wait at location 'crate' (recovery_entries).
CREATE TABLE homestead_items_v5(
 id TEXT PRIMARY KEY, item_def TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT 'inventory' CHECK(location IN ('inventory','placed','storage','personal','mail','shelf','camp','crate')),
 account_id TEXT REFERENCES players(account_id), homestead_id TEXT REFERENCES homesteads(id),
 scene TEXT CHECK(scene IN ('indoor','outdoor','gate','camp')), x INTEGER, y INTEGER, rotation INTEGER, name TEXT,
 stalls INTEGER CHECK(stalls IS NULL OR stalls BETWEEN 1 AND 6),
 camp_id TEXT REFERENCES camps(id),
 CHECK((location IN ('inventory','personal','mail','camp','crate') AND account_id IS NOT NULL AND homestead_id IS NULL) OR
 (location IN ('placed','storage','shelf') AND account_id IS NULL AND homestead_id IS NOT NULL)),
 CHECK((location IN ('placed','camp')) = (scene IS NOT NULL)),
 CHECK((location='camp') = (scene IS 'camp')),
 CHECK((location='camp') = (camp_id IS NOT NULL)),
 CHECK((scene IS NULL AND x IS NULL AND y IS NULL AND rotation IS NULL) OR
 (scene IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL AND rotation IS NOT NULL AND x>=-24 AND y>=0 AND rotation IN (0,90,180,270)))
);
INSERT INTO homestead_items_v5(id,item_def,location,account_id,homestead_id,scene,x,y,rotation,name,stalls)
 SELECT id,item_def,location,account_id,homestead_id,scene,x,y,rotation,name,stalls FROM homestead_items;
DROP TABLE homestead_items;
ALTER TABLE homestead_items_v5 RENAME TO homestead_items;
CREATE INDEX homestead_items_owner ON homestead_items(account_id,location,item_def);
CREATE INDEX homestead_items_home ON homestead_items(homestead_id,location,item_def);
CREATE INDEX homestead_items_camp ON homestead_items(camp_id);

-- Seeds and saplings planted at a camp, by whoever planted them.
CREATE TABLE camp_plants(
 id TEXT PRIMARY KEY,
 camp_id TEXT NOT NULL REFERENCES camps(id),
 account_id TEXT NOT NULL REFERENCES players(account_id),
 item_def TEXT NOT NULL,
 x INTEGER NOT NULL CHECK(x>=0), y INTEGER NOT NULL CHECK(y>=0),
 planted_at INTEGER NOT NULL,
 planted_day INTEGER NOT NULL
);
CREATE INDEX camp_plants_camp ON camp_plants(camp_id);

-- Pell's recovery crates (lamps.md 2.7): what a lapsed claim packed, kept in
-- the world for good, one crate per claim and turning. Each entry is one
-- beneficiary's: a piece (the same instance, waiting at location 'crate'), a
-- stack (oil, path stone, a plant's seed) or a plant (its seed, with the
-- planting kept in state). Collected once, then it is marked, never deleted.
CREATE TABLE recovery_crates(
 id TEXT PRIMARY KEY,
 world_id TEXT NOT NULL REFERENCES worlds(id),
 source TEXT NOT NULL,
 cx INTEGER NOT NULL, cy INTEGER NOT NULL,
 lapsed_at INTEGER NOT NULL,
 UNIQUE(world_id,source,lapsed_at)
);
CREATE TABLE recovery_entries(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 crate_id TEXT NOT NULL REFERENCES recovery_crates(id),
 account_id TEXT NOT NULL REFERENCES players(account_id),
 kind TEXT NOT NULL CHECK(kind IN ('piece','stack','plant')),
 item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>=1),
 instance_id TEXT,
 state TEXT NOT NULL DEFAULT '{}',
 collected_at INTEGER,
 CHECK((kind='piece') = (instance_id IS NOT NULL))
);
CREATE INDEX recovery_entries_owner ON recovery_entries(account_id,collected_at);
