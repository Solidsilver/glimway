-- Holds (roadmap 0.12; location-seam.md 0 #2): a generated chunk pinned to
-- one wick epoch across turnings. The holder is a kind and an id (a lot
-- lantern and its lot, say); the kinds stay open. A released hold keeps its
-- chunk until the next turning, where it goes. The epoch has no cascade:
-- cleanup keeps any epoch a hold pins, so deleting one under a hold fails.
CREATE TABLE holds(
 world_id TEXT NOT NULL REFERENCES worlds(id),
 realm TEXT NOT NULL, layer INTEGER NOT NULL DEFAULT 0, cx INTEGER NOT NULL, cy INTEGER NOT NULL,
 epoch_id TEXT NOT NULL REFERENCES wild_epochs(id),
 holder_kind TEXT NOT NULL CHECK(holder_kind<>''), holder_id TEXT NOT NULL,
 since INTEGER NOT NULL, released_at INTEGER,
 PRIMARY KEY(world_id,realm,layer,cx,cy)
);
CREATE INDEX holds_epoch ON holds(epoch_id);
CREATE INDEX holds_holder ON holds(world_id,holder_kind,holder_id);
