-- A lamp's naming follows the lamp (lamps.md 1.4, 2.8). A portable lamp, a
-- way-lamp piece set as a communal post or a camp's lamp, keeps its naming
-- wherever it is set, in any world: its row has no world (world_id NULL),
-- keyed by the piece's instance id alone, so it is named, and its lamp ash
-- given, once ever. An authored Lantern Road stone's id repeats between
-- worlds (lamp-stone:<cx>:<cy>), so its naming stays its world's.
--
-- Rows already written for a piece lose their world; where a piece was
-- named in two worlds, the first naming stands.
CREATE TABLE lamp_namings_v2(
 world_id TEXT REFERENCES worlds(id),
 lamp_id TEXT NOT NULL,
 parts TEXT NOT NULL DEFAULT '[]',
 landmark TEXT NOT NULL DEFAULT '',
 text TEXT NOT NULL,
 short_name TEXT NOT NULL,
 namer TEXT REFERENCES players(account_id),
 named_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX lamp_namings_lamp ON lamp_namings_v2(ifnull(world_id,''),lamp_id);
INSERT OR IGNORE INTO lamp_namings_v2(world_id,lamp_id,parts,landmark,text,short_name,namer,named_at)
 SELECT CASE WHEN lamp_id IN (SELECT id FROM homestead_items) THEN NULL ELSE world_id END,
  lamp_id,parts,landmark,text,short_name,namer,named_at
 FROM lamp_namings ORDER BY named_at,world_id;
DROP TABLE lamp_namings;
ALTER TABLE lamp_namings_v2 RENAME TO lamp_namings;
