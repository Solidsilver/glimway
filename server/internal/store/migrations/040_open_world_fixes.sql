-- The open world's review (0.14 iteration 1). 039 dropped unheld wick
-- chunks' bodies, but a chunk made again beside a hold of the same wick
-- ignored that hold's edges until the store passed it as kept; drop the
-- unheld wick bodies again so every one is made by the fixed store. Run with
-- 039 or after it, this is the same set.
--
-- A remade chunk's objects keep their ids (kind:cx:cy:n) but not their
-- place, material or camp, so state about the old object would land on a
-- new one: a regenerated node already harvested, a camp already fallen, a
-- chest already opened, a point of interest already charted. Clear that
-- state for the generated objects of unheld wick chunks: entity state, camp
-- falls (their witnesses) and claims, personal claims and discoveries. A
-- held chunk keeps its body and so its state; the still epoch, town and
-- lots are untouched; ground changes (laid stones, clearings) and their
-- owners stay, as do places found ("place:..") and the rumour's find.
DELETE FROM wilds_chunks
 WHERE epoch_id IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=wilds_chunks.epoch_id
     AND h.layer=wilds_chunks.layer AND h.cx=wilds_chunks.cx AND h.cy=wilds_chunks.cy);
DELETE FROM fight_fall_witnesses
 WHERE layer=0 AND epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=fight_fall_witnesses.epoch
     AND h.layer=0 AND h.cx=fight_fall_witnesses.cx AND h.cy=fight_fall_witnesses.cy);
DELETE FROM fight_falls
 WHERE layer=0 AND epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=fight_falls.epoch
     AND h.layer=0 AND h.cx=fight_falls.cx AND h.cy=fight_falls.cy);
-- A generated object's id is kind:cx:cy:n; the chunk part is matched from
-- the first colon.
DELETE FROM entity_state
 WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND length(entity_id)-length(replace(entity_id,':',''))=3
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=entity_state.epoch AND h.layer=0
     AND substr(entity_state.entity_id,instr(entity_state.entity_id,':')) LIKE ':'||h.cx||':'||h.cy||':%');
DELETE FROM camp_claims
 WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND length(entity_id)-length(replace(entity_id,':',''))=3
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=camp_claims.epoch AND h.layer=0
     AND substr(camp_claims.entity_id,instr(camp_claims.entity_id,':')) LIKE ':'||h.cx||':'||h.cy||':%');
DELETE FROM personal_claims
 WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND length(entity_id)-length(replace(entity_id,':',''))=3
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=personal_claims.epoch AND h.layer=0
     AND substr(personal_claims.entity_id,instr(personal_claims.entity_id,':')) LIKE ':'||h.cx||':'||h.cy||':%');
DELETE FROM discoveries
 WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND length(entity_id)-length(replace(entity_id,':',''))=3
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=discoveries.epoch AND h.layer=0
     AND substr(discoveries.entity_id,instr(discoveries.entity_id,':')) LIKE ':'||h.cx||':'||h.cy||':%');
-- Sight's anchor (api/sight.go): where the server lets a player see from,
-- the travel it has saved (pixels) as of at, and the last place a client
-- claimed (seen_*); a saved place other than that one is the server's.
CREATE TABLE player_sight(
 account_id TEXT PRIMARY KEY REFERENCES players(account_id), world_id TEXT NOT NULL,
 x REAL NOT NULL, y REAL NOT NULL, saved REAL NOT NULL CHECK(saved>=0), at INTEGER NOT NULL,
 seen_area TEXT NOT NULL, seen_x REAL NOT NULL, seen_y REAL NOT NULL
);
