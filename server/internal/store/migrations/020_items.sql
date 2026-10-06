-- The item system core (docs/items/). Carried things are either stacks by
-- count (per maker) or instances (tools, off-hand items, carry gear and
-- fittings), each with its own condition, fittings and maker. Nobody plays
-- on a server yet, but today's goods move across as they are: the pack's
-- materials and items, and both kinds of chest, become stacks with no maker.
CREATE TABLE item_stacks(
 location TEXT NOT NULL CHECK(location IN ('pack','storage','personal')),
 -- A player (pack, personal chest) or a homestead (its shared chest).
 owner TEXT NOT NULL, item_def TEXT NOT NULL,
 -- '' is unmarked; otherwise the player who made them.
 maker_id TEXT NOT NULL DEFAULT '',
 qty INTEGER NOT NULL CHECK(qty>0),
 PRIMARY KEY(location,owner,item_def,maker_id)
);
INSERT INTO item_stacks SELECT 'pack',habitica_id,material,'',qty FROM materials WHERE qty>0;
INSERT INTO item_stacks SELECT 'pack',habitica_id,item_def,'',qty FROM inventory;
INSERT INTO item_stacks SELECT 'storage',homestead_id,item_def,'',qty FROM home_storage;
INSERT INTO item_stacks SELECT 'personal',habitica_id,item_def,'',qty FROM personal_storage;
DROP TABLE materials;
DROP TABLE inventory;
DROP TABLE home_storage;
DROP TABLE personal_storage;
-- One row per instance. A fitting on a tool is 'fitted' with the tool's id as
-- its owner, and travels with the tool. Condition is in wear points
-- (content/items.json rules.wear); max_condition 0 means it never wears.
CREATE TABLE item_instances(
 id TEXT PRIMARY KEY, item_def TEXT NOT NULL,
 location TEXT NOT NULL CHECK(location IN ('pack','storage','personal','mail','fitted')),
 owner TEXT NOT NULL,
 condition INTEGER NOT NULL CHECK(condition>=0),
 max_condition INTEGER NOT NULL CHECK(max_condition>=0 AND condition<=max_condition),
 maker_id TEXT NOT NULL DEFAULT '',
 -- Warden-set tools heal overnight: the UTC day they were last used.
 worn_day INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE INDEX item_instances_owner ON item_instances(location,owner,item_def);
-- Pockets and the off hand point at things in the pack: a keepsake by
-- definition, or an instance by id.
CREATE TABLE item_slots(
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id),
 slot TEXT NOT NULL CHECK(slot IN ('pocket-1','pocket-2','off-hand')),
 item_def TEXT NOT NULL, instance_id TEXT,
 PRIMARY KEY(habitica_id,slot)
);
-- A quiet thank-you to a maker whose thing was used while they were away.
CREATE TABLE item_thanks(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 maker_id TEXT NOT NULL REFERENCES players(habitica_id),
 user_id TEXT NOT NULL REFERENCES players(habitica_id),
 item_def TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX item_thanks_maker ON item_thanks(maker_id,at DESC,id DESC);
