-- Common ways (roadmap 0.13; lamps.md 2.4): one row the first time a player
-- stands in a generated chunk during a calendar wick, and never another for
-- that wick. The turning reads them to keep laid paths (visited) or turn
-- and refund them (unvisited); nothing counts steps or time.
CREATE TABLE chunk_visits(
 world_id TEXT NOT NULL REFERENCES worlds(id),
 realm TEXT NOT NULL, layer INTEGER NOT NULL DEFAULT 0, cx INTEGER NOT NULL, cy INTEGER NOT NULL,
 wick_start INTEGER NOT NULL, first_at INTEGER NOT NULL,
 PRIMARY KEY(world_id,realm,layer,cx,cy,wick_start)
);
