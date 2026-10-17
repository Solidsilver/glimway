-- Communal lamps (roadmap 0.13; lamps.md 1.3, 2.4): Common light, kept by
-- presence (chunk_visits, 042), never by oil. One row a lit lamp. id is the
-- lamp's stable id: a relit Lantern Road stone's is its site's
-- (lamp-stone:<cx>:<cy>, the same in every wick), a communal post's is its
-- way-lamp piece's. x, y are chunk-local. setter is who relit or set it. A
-- stone that goes dark at a turning loses its row; a post that turns waits
-- in a crate at Pell's for its setter, its piece the same instance.
CREATE TABLE communal_lamps(
 world_id TEXT NOT NULL REFERENCES worlds(id),
 id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('stone','post')),
 cx INTEGER NOT NULL, cy INTEGER NOT NULL,
 x INTEGER NOT NULL CHECK(x>=0), y INTEGER NOT NULL CHECK(y>=0),
 setter TEXT NOT NULL REFERENCES players(account_id),
 lit_at INTEGER NOT NULL,
 PRIMARY KEY(world_id,id),
 UNIQUE(world_id,cx,cy,x,y)
);
CREATE INDEX communal_lamps_chunk ON communal_lamps(world_id,cx,cy);

-- A lamp's naming (lamps.md 2.8), by stable lamp id, communal or Built: the
-- part ids (JSON array), the landmark named, and the rendered sentence and
-- short name as written. It outlives the light: a stone gone dark or a post
-- in a crate keeps it, so relighting or setting it again finds it. The
-- Keeper's-hand lane writes it; nothing here does.
CREATE TABLE lamp_namings(
 world_id TEXT NOT NULL REFERENCES worlds(id),
 lamp_id TEXT NOT NULL,
 parts TEXT NOT NULL DEFAULT '[]',
 landmark TEXT NOT NULL DEFAULT '',
 text TEXT NOT NULL,
 short_name TEXT NOT NULL,
 namer TEXT REFERENCES players(account_id),
 named_at INTEGER NOT NULL,
 PRIMARY KEY(world_id,lamp_id)
);

-- A communal post's piece stands at location 'lamp': still its setter's,
-- with no scene (its tile is the communal_lamps row's).
CREATE TABLE homestead_items_v6(
 id TEXT PRIMARY KEY, item_def TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT 'inventory' CHECK(location IN ('inventory','placed','storage','personal','mail','shelf','camp','crate','lamp')),
 account_id TEXT REFERENCES players(account_id), homestead_id TEXT REFERENCES homesteads(id),
 scene TEXT CHECK(scene IN ('indoor','outdoor','gate','camp')), x INTEGER, y INTEGER, rotation INTEGER, name TEXT,
 stalls INTEGER CHECK(stalls IS NULL OR stalls BETWEEN 1 AND 6),
 camp_id TEXT REFERENCES camps(id),
 CHECK((location IN ('inventory','personal','mail','camp','crate','lamp') AND account_id IS NOT NULL AND homestead_id IS NULL) OR
 (location IN ('placed','storage','shelf') AND account_id IS NULL AND homestead_id IS NOT NULL)),
 CHECK((location IN ('placed','camp')) = (scene IS NOT NULL)),
 CHECK((location='camp') = (scene IS 'camp')),
 CHECK((location='camp') = (camp_id IS NOT NULL)),
 CHECK((scene IS NULL AND x IS NULL AND y IS NULL AND rotation IS NULL) OR
 (scene IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL AND rotation IS NOT NULL AND x>=-24 AND y>=0 AND rotation IN (0,90,180,270)))
);
INSERT INTO homestead_items_v6(id,item_def,location,account_id,homestead_id,scene,x,y,rotation,name,stalls,camp_id)
 SELECT id,item_def,location,account_id,homestead_id,scene,x,y,rotation,name,stalls,camp_id FROM homestead_items;
DROP TABLE homestead_items;
ALTER TABLE homestead_items_v6 RENAME TO homestead_items;
CREATE INDEX homestead_items_owner ON homestead_items(account_id,location,item_def);
CREATE INDEX homestead_items_home ON homestead_items(homestead_id,location,item_def);
CREATE INDEX homestead_items_camp ON homestead_items(camp_id);
