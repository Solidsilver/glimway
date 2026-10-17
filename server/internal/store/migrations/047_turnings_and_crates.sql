-- The turning cursor (roadmap rule 4: upkeep judged once a week, at the
-- turning): the start of the newest calendar wick whose turning has been
-- judged. A world nobody visits across turnings has each missed one judged
-- in order, once, when it is next made (store/holds.go). A world's newest
-- wick epoch was made at its turning, so that is where it stands now.
CREATE TABLE wick_turnings(
 world_id TEXT PRIMARY KEY REFERENCES worlds(id),
 judged_through INTEGER NOT NULL
);
INSERT INTO wick_turnings(world_id,judged_through)
 SELECT world_id,MAX(starts_at) FROM wild_epochs WHERE kind='wick' GROUP BY world_id;

-- A lost deed's crate (roadmap rule 3) holds the home chest's tools and
-- gear as the same instances: an entry of kind 'tool' names one, waiting
-- at location 'crate' (owner: the account it waits for).
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

-- Each entry says why it is waiting (reason), so Pell can say so:
--   '':             a lapsed claim packed it (the woods turned)
--   'land-changed': 0.12's lasting geography ended the wick it was paid on
--   'deed-lost':    its home's deed was lost
--   'packed-up':    its camp's keeper packed the camp up
CREATE TABLE recovery_entries_v2(
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
INSERT INTO recovery_entries_v2(id,crate_id,account_id,kind,item_def,qty,instance_id,state,collected_at)
 SELECT id,crate_id,account_id,kind,item_def,qty,instance_id,state,collected_at FROM recovery_entries;
DROP TABLE recovery_entries;
ALTER TABLE recovery_entries_v2 RENAME TO recovery_entries;
CREATE INDEX recovery_entries_owner ON recovery_entries(account_id,collected_at);

-- The paths 038 set aside are refunded by the backfill
-- (migration_047_backfill.go), which then drops lasting_geography_paths.
