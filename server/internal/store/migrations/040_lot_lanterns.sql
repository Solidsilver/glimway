-- Lot lanterns (roadmap 0.12; hearthwick-2.md 6): each lot's lantern on its
-- back line holds the backland chunk behind it while it has oil. The hold
-- itself is the holds row (039); this is the lantern's store of oil, in
-- wicks, and whether it is dimming (out of oil, a wick of warning left).
CREATE TABLE lot_lanterns(
 homestead_id TEXT PRIMARY KEY REFERENCES homesteads(id),
 oil INTEGER NOT NULL DEFAULT 0 CHECK(oil>=0),
 dimming INTEGER NOT NULL DEFAULT 0 CHECK(dimming IN (0,1))
);

-- The backland is stored in lot-local tiles past the lot: west lots use
-- x -24..-1, so placed pieces and plants may sit at a negative x now.
CREATE TABLE homestead_items_v4(
 id TEXT PRIMARY KEY, item_def TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT 'inventory' CHECK(location IN ('inventory','placed','storage','personal','mail','shelf')),
 account_id TEXT REFERENCES players(account_id), homestead_id TEXT REFERENCES homesteads(id),
 scene TEXT CHECK(scene IN ('indoor','outdoor','gate')), x INTEGER, y INTEGER, rotation INTEGER, name TEXT,
 stalls INTEGER CHECK(stalls IS NULL OR stalls BETWEEN 1 AND 6),
 CHECK((location IN ('inventory','personal','mail') AND account_id IS NOT NULL AND homestead_id IS NULL) OR
 (location IN ('placed','storage','shelf') AND account_id IS NULL AND homestead_id IS NOT NULL)),
 CHECK((location='placed') = (scene IS NOT NULL)),
 CHECK((scene IS NULL AND x IS NULL AND y IS NULL AND rotation IS NULL) OR
 (scene IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL AND rotation IS NOT NULL AND x>=-24 AND y>=0 AND rotation IN (0,90,180,270)))
);
INSERT INTO homestead_items_v4(id,item_def,location,account_id,homestead_id,scene,x,y,rotation,name,stalls)
 SELECT id,item_def,location,account_id,homestead_id,scene,x,y,rotation,name,stalls FROM homestead_items;
DROP TABLE homestead_items;
ALTER TABLE homestead_items_v4 RENAME TO homestead_items;
CREATE INDEX homestead_items_owner ON homestead_items(account_id,location,item_def);
CREATE INDEX homestead_items_home ON homestead_items(homestead_id,location,item_def);

CREATE TABLE homestead_plants_v2(
 id TEXT PRIMARY KEY,
 homestead_id TEXT NOT NULL REFERENCES homesteads(id),
 item_def TEXT NOT NULL,
 x INTEGER NOT NULL CHECK(x>=-24),
 y INTEGER NOT NULL CHECK(y>=0),
 planted_at INTEGER NOT NULL,
 planted_day INTEGER NOT NULL
);
INSERT INTO homestead_plants_v2 SELECT id,homestead_id,item_def,x,y,planted_at,planted_day FROM homestead_plants;
DROP TABLE homestead_plants;
ALTER TABLE homestead_plants_v2 RENAME TO homestead_plants;
CREATE INDEX homestead_plants_home ON homestead_plants(homestead_id);
