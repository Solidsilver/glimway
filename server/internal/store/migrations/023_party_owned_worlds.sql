-- Party worlds (docs/home-server.md "Party worlds and world moves"): a party's
-- world belongs to the party, not a person (owner_id ''), and a party has at
-- most one. Older links from a person's world to a party are cleared: a world
-- someone owns is theirs alone, and its residents stay where they are.
UPDATE worlds SET habitica_party_id=NULL WHERE owner_id!='';
DELETE FROM party_prompts WHERE world_id IN (SELECT id FROM worlds WHERE owner_id!='');
DROP INDEX worlds_party;
CREATE UNIQUE INDEX worlds_party ON worlds(habitica_party_id) WHERE owner_id='' AND habitica_party_id IS NOT NULL;
-- The move cooldown reads each player's last move.
CREATE INDEX ledger_world_moves ON ledger(habitica_id,created_at) WHERE reason='world-move';
