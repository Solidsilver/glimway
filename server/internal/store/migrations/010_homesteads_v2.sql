-- Homesteads v2 (docs/hands-on-design.md section 1). Nobody plays on a server
-- yet, so the plot-per-player homesteads are reset rather than migrated:
-- every home, decoration, stored good and decoration parcel goes.
DELETE FROM mail WHERE kind='decoration';
DROP TABLE home_storage;
DROP TABLE homestead_items;
DROP TABLE homesteads;
CREATE TABLE homesteads(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
 gate INTEGER NOT NULL CHECK(gate BETWEEN 0 AND 9999),
 tier INTEGER NOT NULL DEFAULT 0 CHECK(tier BETWEEN 0 AND 4),
 posts_bought INTEGER NOT NULL DEFAULT 0 CHECK(posts_bought>=0),
 claimed_at INTEGER NOT NULL, vacant_since INTEGER,
 UNIQUE(world_id,gate)
);
-- The primary key is the rule: one homestead per player, always.
CREATE TABLE homestead_members(
 habitica_id TEXT PRIMARY KEY REFERENCES players(habitica_id),
 homestead_id TEXT NOT NULL REFERENCES homesteads(id), joined_at INTEGER NOT NULL
);
CREATE INDEX homestead_members_home ON homestead_members(homestead_id,joined_at);
CREATE TABLE player_deeds(habitica_id TEXT PRIMARY KEY REFERENCES players(habitica_id), deeds INTEGER NOT NULL CHECK(deeds>=0));
CREATE TABLE lost_gates(
 world_id TEXT NOT NULL REFERENCES worlds(id), gate INTEGER NOT NULL CHECK(gate>=0), lost_at INTEGER NOT NULL,
 PRIMARY KEY(world_id,gate)
);
CREATE TABLE homestead_invites(
 homestead_id TEXT NOT NULL REFERENCES homesteads(id), to_id TEXT NOT NULL REFERENCES players(habitica_id),
 from_id TEXT NOT NULL REFERENCES players(habitica_id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 from_confirmed_at INTEGER, to_confirmed_at INTEGER,
 PRIMARY KEY(homestead_id,to_id), CHECK(from_id!=to_id)
);
CREATE INDEX homestead_invites_to ON homestead_invites(to_id);
CREATE INDEX homestead_invites_from ON homestead_invites(from_id);
CREATE TABLE homestead_cleared(
 homestead_id TEXT NOT NULL REFERENCES homesteads(id), x INTEGER NOT NULL CHECK(x>=0), y INTEGER NOT NULL CHECK(y>=0),
 PRIMARY KEY(homestead_id,x,y)
);
-- A decoration is in a player's pack ('inventory'), personal chest or mail
-- (owned by habitica_id), or placed on / stored in a homestead.
CREATE TABLE homestead_items(
 id TEXT PRIMARY KEY, item_def TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT 'inventory' CHECK(location IN ('inventory','placed','storage','personal','mail')),
 habitica_id TEXT REFERENCES players(habitica_id), homestead_id TEXT REFERENCES homesteads(id),
 scene TEXT CHECK(scene IN ('indoor','outdoor')), x INTEGER, y INTEGER, rotation INTEGER, name TEXT,
 CHECK((location IN ('inventory','personal','mail') AND habitica_id IS NOT NULL AND homestead_id IS NULL) OR
 (location IN ('placed','storage') AND habitica_id IS NULL AND homestead_id IS NOT NULL)),
 CHECK((location='placed') = (scene IS NOT NULL)),
 CHECK((scene IS NULL AND x IS NULL AND y IS NULL AND rotation IS NULL) OR
 (scene IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL AND rotation IS NOT NULL AND x>=0 AND y>=0 AND rotation IN (0,90,180,270)))
);
CREATE INDEX homestead_items_owner ON homestead_items(habitica_id,location,item_def);
CREATE INDEX homestead_items_home ON homestead_items(homestead_id,location,item_def);
CREATE TABLE home_storage(
 homestead_id TEXT NOT NULL REFERENCES homesteads(id),
 kind TEXT NOT NULL CHECK(kind IN ('material','item')), item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>0), PRIMARY KEY(homestead_id,kind,item_def)
);
CREATE TABLE personal_storage(
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id),
 kind TEXT NOT NULL CHECK(kind IN ('material','item')), item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>0), PRIMARY KEY(habitica_id,kind,item_def)
);
