-- One-town cutover. Historical migrations remain unchanged.
UPDATE players SET version=version+1 WHERE account_id IN
 (SELECT account_id FROM player_place WHERE area='village' OR area='commons'
  OR (area='outdoors' AND y>=384) OR area GLOB 'home:[0-9]*');
-- Hearthwick 2: village saves go to the spawn (5,60); homes go to their lot
-- doorstep (origin + (11,8)), west lots at x -48 and east lots at x 48;
-- Commons and old lot-row saves go to the Tangle Arch anchor (2,26).
UPDATE player_place SET
 x=CASE WHEN area='village' THEN 88 WHEN area GLOB 'home:[0-9]*' AND CAST(substr(area,6) AS INTEGER) BETWEEN 0 AND 7
   THEN (CASE CAST(substr(area,6) AS INTEGER)%2 WHEN 0 THEN -48 ELSE 48 END+11)*16+8 ELSE 40 END,
 y=CASE WHEN area='village' THEN 968 WHEN area GLOB 'home:[0-9]*' AND CAST(substr(area,6) AS INTEGER) BETWEEN 0 AND 7
   THEN (24+24*(CAST(substr(area,6) AS INTEGER)/2)+8)*16+8 ELSE 424 END,
 area='outdoors',place_set_version=(SELECT version FROM players p WHERE p.account_id=player_place.account_id)
 WHERE area='village' OR area='commons' OR (area='outdoors' AND y>=384) OR area GLOB 'home:[0-9]*';
-- Fallen way-lamps are free markers, with no inventory source item to refund.
-- Preserve every marker and its owner outside the expiring epoch for recovery.
CREATE TABLE one_town_lantern_archive(
 id TEXT PRIMARY KEY, epoch TEXT NOT NULL, world_id TEXT NOT NULL,
 owner_id TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
 lit_by TEXT, at INTEGER NOT NULL, lit_at INTEGER
);
INSERT INTO one_town_lantern_archive
 SELECT l.id,l.epoch,l.world_id,l.owner_id,l.x,l.y,l.lit_by,l.at,l.lit_at FROM lanterns l JOIN wild_epochs e ON e.id=l.epoch WHERE e.kind='wick';
-- Expire wick terrain and all epoch-owned gameplay state, as at season change:
-- falls, camp claims, personal claims and discoveries. Fresh epochs get new IDs.
DELETE FROM world_changes WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick');
UPDATE player_place SET last_wick_epoch='',last_wick_starts_at=NULL WHERE last_wick_epoch IN (SELECT id FROM wild_epochs WHERE kind='wick');
DELETE FROM wild_epochs WHERE kind='wick';
-- Preserve the more recent fishery clock when both realm keys exist.
INSERT INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at,changed_by,ends_at)
 SELECT world_id,'hearthwick',layer,chunk,epoch,entity,kind,state,changed_at,changed_by,ends_at
 FROM world_changes WHERE realm='village' AND kind='fishery'
 ON CONFLICT(world_id,realm,layer,chunk,epoch,entity) DO UPDATE SET
 state=excluded.state,changed_at=excluded.changed_at,changed_by=excluded.changed_by,ends_at=excluded.ends_at
 WHERE excluded.changed_at>world_changes.changed_at;
DELETE FROM world_changes WHERE realm='village' AND kind='fishery';
-- Non-physical clears/stumps and displaced plant metadata remain recoverable.
CREATE TABLE homestead_land_archive(
 homestead_id TEXT NOT NULL REFERENCES homesteads(id), kind TEXT NOT NULL,
 identity TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(homestead_id,kind,identity)
);
