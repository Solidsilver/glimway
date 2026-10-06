-- Party admission controls (docs/home-server.md "Party worlds and world
-- moves"). opened_by: who opened a party's world, the operator-admitted
-- account whose sign-in made it, or an adopted world's former owner (NULL for
-- worlds made before this). party_closures: parties the operator closed
-- (`party close`): no one is admitted through them and no world is made for
-- them until `party open`.
ALTER TABLE worlds ADD COLUMN opened_by TEXT;
CREATE TABLE party_closures(
 party_id TEXT PRIMARY KEY,
 closed_at INTEGER NOT NULL
);
-- Leaving the party (docs/home-server.md): party_left_at is when a sign-in
-- first found a resident of a party's world outside that party (cleared when
-- they rejoin or leave); party_moved_out_at is when the grace period ran out
-- and the server moved them out, until the notice has been shown.
ALTER TABLE players ADD COLUMN party_left_at INTEGER;
ALTER TABLE players ADD COLUMN party_moved_out_at INTEGER;
