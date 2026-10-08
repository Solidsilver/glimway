ALTER TABLE players RENAME COLUMN rev TO version;
ALTER TABLE players ADD COLUMN play_seconds REAL NOT NULL DEFAULT 0 CHECK(play_seconds>=0);
CREATE TABLE player_vitals(
 account_id TEXT PRIMARY KEY REFERENCES players(account_id), hp REAL NOT NULL CHECK(hp>=0),
 mana REAL NOT NULL CHECK(mana>=0), vitals_at INTEGER NOT NULL,
 vitals_set_version INTEGER NOT NULL CHECK(vitals_set_version>=0),
 report_client TEXT NOT NULL DEFAULT '', report_seq REAL NOT NULL DEFAULT 0 CHECK(report_seq>=0),
 report_at INTEGER,
 report_generation TEXT NOT NULL DEFAULT '', cast_ready_at REAL NOT NULL DEFAULT 0,
 report_basis REAL NOT NULL DEFAULT 0 CHECK(report_basis>=0)
);
CREATE TABLE player_place(
 account_id TEXT PRIMARY KEY REFERENCES players(account_id), area TEXT NOT NULL,
 x REAL NOT NULL, y REAL NOT NULL, place_set_version INTEGER NOT NULL DEFAULT 0 CHECK(place_set_version>=0), last_outer_epoch TEXT NOT NULL DEFAULT '', last_outer_starts_at INTEGER
);
CREATE TABLE quest_progress(
 account_id TEXT NOT NULL REFERENCES players(account_id), quest TEXT NOT NULL, step TEXT NOT NULL,
 PRIMARY KEY(account_id,quest)
);
CREATE TABLE story_marks(
 account_id TEXT NOT NULL REFERENCES players(account_id), mark TEXT NOT NULL,
 writer TEXT NOT NULL CHECK(writer IN ('client','server','quest-item')), at INTEGER NOT NULL,
 PRIMARY KEY(account_id,mark)
);
CREATE TABLE wilds_chunks(
 epoch_id TEXT NOT NULL REFERENCES region_epochs(id) ON DELETE CASCADE, layer INTEGER NOT NULL DEFAULT 0, cx INTEGER NOT NULL, cy INTEGER NOT NULL,
 generator_version INTEGER NOT NULL, blob BLOB NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(epoch_id,layer,cx,cy)
);
-- Runnable intermediate state: the retained document stays authoritative until 028.
INSERT INTO player_vitals(account_id,hp,mana,vitals_at,vitals_set_version,cast_ready_at)
 SELECT p.account_id,MAX(0,COALESCE(json_extract(g.doc_json,'$.hp'),0)),MAX(0,COALESCE(json_extract(g.doc_json,'$.mana'),0)),g.updated_at,p.version,g.updated_at
 FROM players p JOIN progress g USING(account_id);
INSERT INTO player_place(account_id,area,x,y)
 SELECT account_id,COALESCE(json_extract(doc_json,'$.area'),'village'),COALESCE(json_extract(doc_json,'$.position.x'),400),COALESCE(json_extract(doc_json,'$.position.y'),300) FROM progress;
UPDATE players SET play_seconds=COALESCE((SELECT json_extract(doc_json,'$.playSeconds') FROM progress g WHERE g.account_id=players.account_id),0);
INSERT INTO quest_progress SELECT account_id,'lantern-road',json_extract(doc_json,'$.quest') FROM progress WHERE json_extract(doc_json,'$.quest') IS NOT NULL AND json_extract(doc_json,'$.quest')!='new';
INSERT OR IGNORE INTO story_marks SELECT g.account_id,j.value,'server',g.updated_at FROM progress g,json_each(g.doc_json,'$.flags') j;
-- V1 terrain and personal claims cannot be read by the new generator.
DELETE FROM entity_state WHERE epoch IN (SELECT id FROM region_epochs WHERE generator_version=1);
DELETE FROM personal_claims WHERE epoch IN (SELECT id FROM region_epochs WHERE generator_version=1);
DELETE FROM discoveries WHERE epoch IN (SELECT id FROM region_epochs WHERE generator_version=1);
DELETE FROM lanterns WHERE epoch IN (SELECT id FROM region_epochs WHERE generator_version=1);
DELETE FROM lantern_rewards;
DELETE FROM region_epochs WHERE generator_version=1;
PRAGMA foreign_key_check;
