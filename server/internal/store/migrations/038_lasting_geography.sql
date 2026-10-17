-- Lasting geography (roadmap 0.12): wick land is drawn on the world's
-- landform (lands and the Wend no longer turn), so a wick chunk made before
-- this would meet a new neighbour on another river. The current wick ends
-- here, as at a turning (037 did the same): its terrain and epoch-owned state
-- go, fallen way-lamp markers are archived first. The still epoch's output
-- is unchanged, so the Tangle and its world changes stay.
INSERT OR IGNORE INTO one_town_lantern_archive
 SELECT l.id,l.epoch,l.world_id,l.owner_id,l.x,l.y,l.lit_by,l.at,l.lit_at FROM lanterns l JOIN wild_epochs e ON e.id=l.epoch WHERE e.kind='wick';
DELETE FROM world_changes WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick');
UPDATE player_place SET last_wick_epoch='',last_wick_starts_at=NULL WHERE last_wick_epoch IN (SELECT id FROM wild_epochs WHERE kind='wick');
DELETE FROM wild_epochs WHERE kind='wick';
