-- One-town cutover. Historical migrations remain unchanged.
UPDATE players SET version=version+1 WHERE account_id IN
 (SELECT account_id FROM player_place WHERE area='village' OR area='commons'
  OR (area='outdoors' AND y>=384) OR area GLOB 'home:[0-9]*');
UPDATE player_place SET
 x=CASE WHEN area='village' THEN 72 WHEN area GLOB 'home:[0-9]*' AND CAST(substr(area,6) AS INTEGER) BETWEEN 0 AND 7
   THEN (-72+24*(CAST(substr(area,6) AS INTEGER)%2)+11)*16+8 ELSE 40 END,
 y=CASE WHEN area='village' THEN 968 WHEN area GLOB 'home:[0-9]*' AND CAST(substr(area,6) AS INTEGER) BETWEEN 0 AND 7
   THEN (24+24*(CAST(substr(area,6) AS INTEGER)/2)+8)*16+8 ELSE 424 END,
 area='outdoors',place_set_version=(SELECT version FROM players p WHERE p.account_id=player_place.account_id)
 WHERE area='village' OR area='commons' OR (area='outdoors' AND y>=384) OR area GLOB 'home:[0-9]*';
-- These wick bytes predate the new fixed neighbours. Fresh epochs get new IDs.
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
