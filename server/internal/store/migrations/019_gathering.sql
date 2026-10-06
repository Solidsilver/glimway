-- Gathering caps and homestead land changes (brief: gathering, migration 015).
-- Gathering caps: per player, per action (chop, break, dig) tracking daily and visit caps.
CREATE TABLE gathering_caps(
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id),
 action TEXT NOT NULL CHECK(action IN ('chop','break','dig')),
 day INTEGER NOT NULL,
 day_count INTEGER NOT NULL DEFAULT 0,
 area TEXT NOT NULL DEFAULT '',
 visit_id TEXT NOT NULL DEFAULT '',
 visit_count INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(habitica_id,action)
);

-- Homestead stumps: trees chopped inside lamplight stay stumps (drift rule: clearing is a choice).
CREATE TABLE homestead_stumps(
 homestead_id TEXT NOT NULL REFERENCES homesteads(id),
 x INTEGER NOT NULL CHECK(x>=0),
 y INTEGER NOT NULL CHECK(y>=0),
 felled_at INTEGER NOT NULL,
 PRIMARY KEY(homestead_id,x,y)
);

-- Homestead plants: seeds/saplings placed on homestead land (inside lamplight stay; outside wander).
CREATE TABLE homestead_plants(
 id TEXT PRIMARY KEY,
 homestead_id TEXT NOT NULL REFERENCES homesteads(id),
 item_def TEXT NOT NULL,
 x INTEGER NOT NULL CHECK(x>=0),
 y INTEGER NOT NULL CHECK(y>=0),
 planted_at INTEGER NOT NULL,
 planted_day INTEGER NOT NULL
);
CREATE INDEX homestead_plants_home ON homestead_plants(homestead_id);
