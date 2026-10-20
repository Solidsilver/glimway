-- The open world (0.14 iteration 1): the landform hashes its own version and
-- the south is ordinary land, so a wick chunk stored before this would meet a
-- new neighbour on another river. Unheld wick chunks lose their stored body
-- and are made again, by today's generator, the next time anyone reads them;
-- the epochs, their entity state, claims, discoveries, lanterns and ground
-- changes stay. A held chunk keeps its body (its neighbours read its edges
-- as kept), and the still epoch's output is unchanged.
DELETE FROM wilds_chunks
 WHERE epoch_id IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=wilds_chunks.epoch_id
     AND h.layer=wilds_chunks.layer AND h.cx=wilds_chunks.cx AND h.cy=wilds_chunks.cy);
