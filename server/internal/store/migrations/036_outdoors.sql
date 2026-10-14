-- S3: saved Wilds coordinates already use world pixels. S5 adds the Commons move.
UPDATE players SET version=version+1 WHERE account_id IN (SELECT account_id FROM player_place WHERE area='wilds');
UPDATE player_place SET area='outdoors', place_set_version=(SELECT version FROM players p WHERE p.account_id=player_place.account_id) WHERE area='wilds';
