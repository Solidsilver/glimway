-- Who left a homestead and when (review fixes for homesteads v2): the last
-- one out can take their deed back while the land is still under it, and a
-- lost deed's goods are written off on their ledger.
CREATE TABLE homestead_departures(
 homestead_id TEXT NOT NULL REFERENCES homesteads(id),
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id),
 left_at INTEGER NOT NULL,
 PRIMARY KEY(homestead_id,habitica_id)
);
CREATE INDEX homestead_departures_player ON homestead_departures(habitica_id);
