-- The Hearthwick Library: one shared donation shelf per world. The first
-- donor of a paper keeps the credit; the Keepers' starting shelf is client
-- content and is never stored here.
CREATE TABLE library_shelves(
 world_id TEXT NOT NULL REFERENCES worlds(id), paper_id TEXT NOT NULL,
 donor_id TEXT NOT NULL REFERENCES players(habitica_id), donated_at INTEGER NOT NULL,
 PRIMARY KEY(world_id,paper_id)
);
