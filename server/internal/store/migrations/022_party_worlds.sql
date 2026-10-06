-- Party-linked worlds and world moves (docs/expansion-design.md "Worlds").
-- The party's world is the oldest world linked to that party.
CREATE INDEX worlds_party ON worlds(habitica_party_id,created_at,id) WHERE habitica_party_id IS NOT NULL;
-- The "your party plays in …'s world" prompt shows once per player and party world.
CREATE TABLE party_prompts(
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id),
 world_id TEXT NOT NULL REFERENCES worlds(id),
 seen_at INTEGER NOT NULL,
 PRIMARY KEY(habitica_id,world_id)
);
