-- Party worlds (docs/home-server.md "Party worlds and world moves"): a party's
-- world belongs to the party, not a person (owner_id ''), and a party has at
-- most one. A person's world keeps any party id an older link (022) gave it,
-- but only as a record: it never counts as the party's world, and it keeps
-- its residents from being prompted to leave until the operator adopts it
-- (`party adopt`).
DELETE FROM party_prompts WHERE world_id IN (SELECT id FROM worlds WHERE owner_id!='');
DROP INDEX worlds_party;
CREATE UNIQUE INDEX worlds_party ON worlds(habitica_party_id) WHERE owner_id='' AND habitica_party_id IS NOT NULL;
-- The move cooldown reads each player's last move.
CREATE INDEX ledger_world_moves ON ledger(habitica_id,created_at) WHERE reason='world-move';
