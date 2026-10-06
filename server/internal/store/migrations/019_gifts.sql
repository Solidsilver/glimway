-- 019_gifts.sql: gate shelf and maker's-mark thank-you mail

-- Allow 'thanks' mail kind (qty = 0, no items attached).
CREATE TABLE mail_v3(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
 from_id TEXT NOT NULL REFERENCES players(habitica_id), to_id TEXT NOT NULL REFERENCES players(habitica_id),
 kind TEXT NOT NULL CHECK(kind IN ('material','item','decoration','instance','thanks')), item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK((kind != 'thanks' AND qty > 0) OR (kind = 'thanks' AND qty = 0)),
 instance_ids TEXT NOT NULL DEFAULT '[]',
 sent_at INTEGER NOT NULL, claimed_at INTEGER,
 returned_at INTEGER CHECK(returned_at IS NULL OR claimed_at IS NULL),
 return_reason TEXT CHECK(
  (returned_at IS NULL AND return_reason IS NULL) OR
  (returned_at IS NOT NULL AND return_reason IS NOT NULL AND return_reason IN ('recalled','expired','recipient-removed'))
 ),
 makers TEXT NOT NULL DEFAULT '[]',
 CHECK(from_id!=to_id)
);
INSERT INTO mail_v3 SELECT * FROM mail;
DROP TABLE mail;
ALTER TABLE mail_v3 RENAME TO mail;
CREATE INDEX mail_recipient ON mail(world_id,to_id,sent_at);
CREATE INDEX mail_sender ON mail(world_id,from_id,sent_at);
CREATE INDEX mail_pending_sender ON mail(from_id,sent_at DESC,id DESC) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_pending_recipient ON mail(to_id,sent_at DESC,id DESC) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_pending_expiry ON mail(sent_at,id) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_history_sender ON mail(from_id,world_id,sent_at DESC,id DESC) WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL;
CREATE INDEX mail_history_recipient ON mail(to_id,world_id,sent_at DESC,id DESC) WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL;
CREATE INDEX mail_send_rate ON mail(from_id,sent_at);
CREATE INDEX mail_thanks_rate ON mail(from_id,to_id,kind,sent_at);

-- Allow 'shelf' location in item_instances for tools/gear placed on the gate shelf.
CREATE TABLE item_instances_v2(
 id TEXT PRIMARY KEY, item_def TEXT NOT NULL,
 location TEXT NOT NULL CHECK(location IN ('pack','storage','personal','mail','fitted','shelf')),
 owner TEXT NOT NULL,
 condition INTEGER NOT NULL CHECK(condition>=0),
 max_condition INTEGER NOT NULL CHECK(max_condition>=0 AND condition<=max_condition),
 maker_id TEXT NOT NULL DEFAULT '',
 worn_day INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 worn_at INTEGER NOT NULL DEFAULT 0,
 racked_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO item_instances_v2(id,item_def,location,owner,condition,max_condition,maker_id,worn_day,created_at,worn_at,racked_at)
 SELECT id,item_def,location,owner,condition,max_condition,maker_id,worn_day,created_at,worn_at,racked_at FROM item_instances;
DROP TABLE item_instances;
ALTER TABLE item_instances_v2 RENAME TO item_instances;
CREATE INDEX item_instances_owner ON item_instances(location,owner,item_def);

-- Allow 'gate' scene and 'shelf' location in homestead_items for gate-shelf placement and decoration stocking.
CREATE TABLE homestead_items_v3(
 id TEXT PRIMARY KEY, item_def TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT 'inventory' CHECK(location IN ('inventory','placed','storage','personal','mail','shelf')),
 habitica_id TEXT REFERENCES players(habitica_id), homestead_id TEXT REFERENCES homesteads(id),
 scene TEXT CHECK(scene IN ('indoor','outdoor','gate')), x INTEGER, y INTEGER, rotation INTEGER, name TEXT,
 CHECK((location IN ('inventory','personal','mail') AND habitica_id IS NOT NULL AND homestead_id IS NULL) OR
 (location IN ('placed','storage','shelf') AND habitica_id IS NULL AND homestead_id IS NOT NULL)),
 CHECK((location='placed') = (scene IS NOT NULL)),
 CHECK((scene IS NULL AND x IS NULL AND y IS NULL AND rotation IS NULL) OR
 (scene IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL AND rotation IS NOT NULL AND x>=0 AND y>=0 AND rotation IN (0,90,180,270)))
);
INSERT INTO homestead_items_v3 SELECT * FROM homestead_items;
DROP TABLE homestead_items;
ALTER TABLE homestead_items_v3 RENAME TO homestead_items;
CREATE INDEX homestead_items_owner ON homestead_items(habitica_id,location,item_def);
CREATE INDEX homestead_items_home ON homestead_items(homestead_id,location,item_def);

-- Gate shelf slots: up to 6 slots per homestead gate shelf.
CREATE TABLE gate_shelf_slots(
 homestead_id TEXT NOT NULL REFERENCES homesteads(id),
 slot INTEGER NOT NULL CHECK(slot >= 0 AND slot < 6),
 kind TEXT NOT NULL CHECK(kind IN ('material','item','decoration','instance')),
 item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty > 0),
 maker_id TEXT NOT NULL DEFAULT '',
 instance_id TEXT DEFAULT NULL,
 stocked_by TEXT NOT NULL REFERENCES players(habitica_id),
 stocked_at INTEGER NOT NULL,
 PRIMARY KEY(homestead_id, slot)
);
CREATE INDEX gate_shelf_slots_home ON gate_shelf_slots(homestead_id);

-- One take per player per shelf per day (UTC day).
CREATE TABLE gate_shelf_takes(
 homestead_id TEXT NOT NULL REFERENCES homesteads(id),
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id),
 day INTEGER NOT NULL,
 PRIMARY KEY(homestead_id, habitica_id, day)
);
CREATE INDEX gate_shelf_takes_home ON gate_shelf_takes(homestead_id, day);
