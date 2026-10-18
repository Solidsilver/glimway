-- Lasting geography and lamps (roadmap 0.12 and 0.13; lamps.md): the whole
-- schema step from 0.11.2 (037) to 0.13. It was built as eleven feature-lane
-- migrations that no release shipped; this is them folded into one, with each
-- table in its final shape.

-- Lasting geography: wick land is drawn on the world's landform (lands and
-- the Wend no longer turn), so a wick chunk made before this would meet a new
-- neighbour on another river. The current wick ends here, as at a turning
-- (037 did the same): its terrain and epoch-owned state go, fallen way-lamp
-- markers are archived first. The still epoch's output is unchanged, so the
-- Tangle and its world changes stay.
INSERT OR IGNORE INTO one_town_lantern_archive
 SELECT l.id,l.epoch,l.world_id,l.owner_id,l.x,l.y,l.lit_by,l.at,l.lit_at FROM lanterns l JOIN wild_epochs e ON e.id=l.epoch WHERE e.kind='wick';
-- The wick's ground changes hold paths players paid stone and timber for
-- (roadmap rule 3: never item loss). They wait here for Pell's crates below;
-- the backfill (migration_038_backfill.go) refunds each laid tile to whoever
-- laid it, then drops this table.
CREATE TABLE lasting_geography_paths(
 world_id TEXT NOT NULL, chunk TEXT NOT NULL, epoch TEXT NOT NULL, state TEXT NOT NULL
);
INSERT INTO lasting_geography_paths(world_id,chunk,epoch,state)
 SELECT world_id,chunk,epoch,state FROM world_changes
 WHERE kind='ground' AND layer=0 AND epoch IN (SELECT id FROM wild_epochs WHERE kind='wick');
DELETE FROM world_changes WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick');
UPDATE player_place SET last_wick_epoch='',last_wick_starts_at=NULL WHERE last_wick_epoch IN (SELECT id FROM wild_epochs WHERE kind='wick');
DELETE FROM wild_epochs WHERE kind='wick';

-- Holds (location-seam.md 0 #2): a generated chunk pinned to one wick epoch
-- across turnings. The holder is a kind and an id (a lot lantern and its lot,
-- say); the kinds stay open. A released hold keeps its chunk until the next
-- turning, where it goes. The epoch has no cascade: cleanup keeps any epoch a
-- hold pins, so deleting one under a hold fails.
CREATE TABLE holds(
 world_id TEXT NOT NULL REFERENCES worlds(id),
 realm TEXT NOT NULL, layer INTEGER NOT NULL DEFAULT 0, cx INTEGER NOT NULL, cy INTEGER NOT NULL,
 epoch_id TEXT NOT NULL REFERENCES wild_epochs(id),
 holder_kind TEXT NOT NULL CHECK(holder_kind<>''), holder_id TEXT NOT NULL,
 since INTEGER NOT NULL, released_at INTEGER,
 PRIMARY KEY(world_id,realm,layer,cx,cy)
);
CREATE INDEX holds_epoch ON holds(epoch_id);
CREATE INDEX holds_holder ON holds(world_id,holder_kind,holder_id);

-- The turning cursor (roadmap rule 4: upkeep judged once a week, at the
-- turning): the start of the newest calendar wick whose turning has been
-- judged. A world nobody visits across turnings has each missed one judged
-- in order, once, when it is next made (store/holds.go). No world has a wick
-- epoch now (it ended above), so no world has a cursor: the next wick made
-- judges its turning.
CREATE TABLE wick_turnings(
 world_id TEXT PRIMARY KEY REFERENCES worlds(id),
 judged_through INTEGER NOT NULL
);

-- Common ways (lamps.md 2.4): one row the first time a player stands in a
-- generated chunk during a calendar wick, and never another for that wick.
-- The turning reads them to keep laid paths (visited) or turn and refund them
-- (unvisited), and communal lamps are kept by them; nothing counts steps or
-- time.
CREATE TABLE chunk_visits(
 world_id TEXT NOT NULL REFERENCES worlds(id),
 realm TEXT NOT NULL, layer INTEGER NOT NULL DEFAULT 0, cx INTEGER NOT NULL, cy INTEGER NOT NULL,
 wick_start INTEGER NOT NULL, first_at INTEGER NOT NULL,
 PRIMARY KEY(world_id,realm,layer,cx,cy,wick_start)
);

-- Lot lanterns (hearthwick-2.md 6): each lot's lantern on its back line holds
-- the backland chunk behind it while it has oil. The hold itself is the holds
-- row; this is the lantern's store of oil, in wicks, and whether it is
-- dimming (out of oil, a wick of warning left).
CREATE TABLE lot_lanterns(
 homestead_id TEXT PRIMARY KEY REFERENCES homesteads(id),
 oil INTEGER NOT NULL DEFAULT 0 CHECK(oil>=0),
 dimming INTEGER NOT NULL DEFAULT 0 CHECK(dimming IN (0,1))
);

-- Camps (lamps.md 2.5): a way-lamp set in a Wilds chunk holds that one chunk
-- while it has oil. The hold itself is the holds row (holder kind
-- "way-lamp", the camp's id); a camp's id is its lamp's, the way-lamp piece
-- standing in it. Its store of oil is in wicks; dimming, out of oil with a
-- wick of warning left. setter is who set the lamp: they (and their
-- household) build there.
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

-- Home pieces, rebuilt once for three changes:
--   - The backland is stored in lot-local tiles past the lot: west lots use
--     x -24..-1, so placed pieces (and plants, below) may sit at a negative x.
--   - A camp's pieces are home pieces at location 'camp', still their
--     owner's (account_id: whoever set them out), at camp-local tiles of its
--     chunk. A lapsed camp's pieces wait at location 'crate'
--     (recovery_entries).
--   - A communal post's piece stands at location 'lamp': still its setter's,
--     with no scene (its tile is the communal_lamps row's).
CREATE TABLE homestead_items_v4(
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
INSERT INTO homestead_items_v4(id,item_def,location,account_id,homestead_id,scene,x,y,rotation,name,stalls)
 SELECT id,item_def,location,account_id,homestead_id,scene,x,y,rotation,name,stalls FROM homestead_items;
DROP TABLE homestead_items;
ALTER TABLE homestead_items_v4 RENAME TO homestead_items;
CREATE INDEX homestead_items_owner ON homestead_items(account_id,location,item_def);
CREATE INDEX homestead_items_home ON homestead_items(homestead_id,location,item_def);
CREATE INDEX homestead_items_camp ON homestead_items(camp_id);

-- Home plants may grow in the backland too (x -24..-1).
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

-- Plants carried in the pack (lamps.md 2.7): a plant lifted whole, from
-- Pell's crate or with the trowel, not its seed. id is the plant's own, kept
-- from where it grew; item_def its seed; planted_at when it was first
-- planted, its growth. Planting it again puts it back in the ground
-- (homestead_plants or camp_plants) with the same id and planted_at; its
-- planted_day there is the day it was set again, where its wandering starts.
CREATE TABLE carried_plants(
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES players(account_id),
 item_def TEXT NOT NULL,
 planted_at INTEGER NOT NULL,
 carried_at INTEGER NOT NULL
);
CREATE INDEX carried_plants_owner ON carried_plants(account_id);

-- A lost deed's crate (roadmap rule 3) holds the home chest's tools and gear
-- as the same instances: an entry of kind 'tool' names one, waiting at
-- location 'crate' (owner: the account it waits for).
CREATE TABLE item_instances_v3(
 id TEXT PRIMARY KEY, item_def TEXT NOT NULL,
 location TEXT NOT NULL CHECK(location IN ('pack','storage','personal','mail','fitted','shelf','crate')),
 owner TEXT NOT NULL,
 condition INTEGER NOT NULL CHECK(condition>=0),
 max_condition INTEGER NOT NULL CHECK(max_condition>=0 AND condition<=max_condition),
 maker_id TEXT NOT NULL DEFAULT '',
 worn_day INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 worn_at INTEGER NOT NULL DEFAULT 0,
 racked_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO item_instances_v3(id,item_def,location,owner,condition,max_condition,maker_id,worn_day,created_at,worn_at,racked_at)
 SELECT id,item_def,location,owner,condition,max_condition,maker_id,worn_day,created_at,worn_at,racked_at FROM item_instances;
DROP TABLE item_instances;
ALTER TABLE item_instances_v3 RENAME TO item_instances;
CREATE INDEX item_instances_owner ON item_instances(location,owner,item_def);

-- Pell's recovery crates (lamps.md 2.7): what a lapsed claim, a lost deed or
-- a changed land packed, kept in the world for good, one crate per claim and
-- turning. Each entry is one beneficiary's: a piece or a tool (the same
-- instance, waiting at location 'crate'), a stack (oil, path stone, a
-- plant's seed) or a plant (its seed, with the planting kept in state).
-- Collected once, then it is marked, never deleted. Each entry says why it is
-- waiting (reason), so Pell can say so:
--   '':             a lapsed claim packed it (the woods turned)
--   'land-changed': 0.12's lasting geography ended the wick it was paid on
--   'deed-lost':    its home's deed was lost
--   'packed-up':    its camp's keeper packed the camp up
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
 kind TEXT NOT NULL CHECK(kind IN ('piece','stack','plant','tool')),
 item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>=1),
 instance_id TEXT,
 state TEXT NOT NULL DEFAULT '{}',
 reason TEXT NOT NULL DEFAULT '',
 collected_at INTEGER,
 CHECK((kind IN ('piece','tool')) = (instance_id IS NOT NULL))
);
CREATE INDEX recovery_entries_owner ON recovery_entries(account_id,collected_at);

-- Communal lamps (lamps.md 1.3, 2.4): Common light, kept by presence
-- (chunk_visits), never by oil. One row a lit lamp. id is the lamp's stable
-- id: a relit Lantern Road stone's is its site's (lamp-stone:<cx>:<cy>, the
-- same in every wick), a communal post's is its way-lamp piece's. x, y are
-- chunk-local. setter is who relit or set it. A stone that goes dark at a
-- turning loses its row; a post that turns waits in a crate at Pell's for its
-- setter, its piece the same instance.
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

-- A lamp's naming (lamps.md 1.4, 2.8), by stable lamp id: the part ids (JSON
-- array), the landmark named, and the rendered sentence and short name as
-- written. It outlives the light: a stone gone dark or a post in a crate
-- keeps it, so relighting or setting it again finds it. A portable lamp, a
-- way-lamp piece set as a communal post or a camp's lamp, keeps its naming
-- wherever it is set, in any world: its row has no world (world_id NULL),
-- keyed by the piece's instance id alone, so it is named, and its lamp ash
-- given, once ever. An authored Lantern Road stone's id repeats between
-- worlds (lamp-stone:<cx>:<cy>), so its naming stays its world's.
CREATE TABLE lamp_namings(
 world_id TEXT REFERENCES worlds(id),
 lamp_id TEXT NOT NULL,
 parts TEXT NOT NULL DEFAULT '[]',
 landmark TEXT NOT NULL DEFAULT '',
 text TEXT NOT NULL,
 short_name TEXT NOT NULL,
 namer TEXT REFERENCES players(account_id),
 named_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX lamp_namings_lamp ON lamp_namings(ifnull(world_id,''),lamp_id);

-- Ways home (lamps.md 1.4): the lamp a player's lamp-ash pouches are bound
-- to, one binding a player, for every pouch they carry. lamp_id is a lamp's
-- stable id (a camp's way-lamp piece, a relit stone's lamp-stone:<cx>:<cy>, a
-- communal post's piece) in world_id; the lamp may since have gone dark, been
-- packed at Pell's or been taken down, and the binding stays as written until
-- it is bound again.
CREATE TABLE ways_home_bindings(
 account_id TEXT PRIMARY KEY REFERENCES players(account_id),
 world_id TEXT NOT NULL REFERENCES worlds(id),
 lamp_id TEXT NOT NULL,
 bound_at INTEGER NOT NULL
);

-- Who may build on a Built claim's land (lamps.md 2.5): its keeper's rule and
-- the members it names. A claim is its holds row's holder: kind and id, so a
-- way-lamp camp is ('way-lamp', the camp's id); lot backland and Wilds
-- hearths may adopt it later. No row: the keeper's household builds there, as
-- before. The keeper always may, whatever the rule.
--   household: the keeper's household
--   listed:    the household and the members named
--   except:    every world member but those named
--   everyone:  every world member
CREATE TABLE claim_rules(
 world_id TEXT NOT NULL REFERENCES worlds(id),
 holder_kind TEXT NOT NULL,
 holder_id TEXT NOT NULL,
 rule TEXT NOT NULL CHECK(rule IN ('household','listed','except','everyone')),
 set_at INTEGER NOT NULL,
 PRIMARY KEY(world_id,holder_kind,holder_id)
);
CREATE TABLE claim_rule_members(
 world_id TEXT NOT NULL,
 holder_kind TEXT NOT NULL,
 holder_id TEXT NOT NULL,
 account_id TEXT NOT NULL REFERENCES players(account_id),
 PRIMARY KEY(world_id,holder_kind,holder_id,account_id),
 FOREIGN KEY(world_id,holder_kind,holder_id) REFERENCES claim_rules(world_id,holder_kind,holder_id)
);

-- A place the server chose (a way home's landing, a settled reach, a
-- recovered room) is marked with the version it chose it at, apart from the
-- place watermark every written place raises: the client follows only that.
ALTER TABLE player_place ADD COLUMN place_moved_version INTEGER NOT NULL DEFAULT 0 CHECK(place_moved_version>=0);

-- The paths set aside above are refunded by the backfill
-- (migration_038_backfill.go), which then drops lasting_geography_paths.
