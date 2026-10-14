-- S3: saved Wilds coordinates already use world pixels.
UPDATE players SET version=version+1 WHERE account_id IN (SELECT account_id FROM player_place WHERE area='wilds');
UPDATE player_place SET area='outdoors', place_set_version=(SELECT version FROM players p WHERE p.account_id=player_place.account_id) WHERE area='wilds';
-- S5: the Commons joins the outdoors as the fixed footprint at origin tile (-21, 24):
-- local pixels move by (-21*16, 24*16) = (-336, +384).
UPDATE players SET version=version+1 WHERE account_id IN (SELECT account_id FROM player_place WHERE area='commons');
UPDATE player_place SET area='outdoors', x=x-336, y=y+384, place_set_version=(SELECT version FROM players p WHERE p.account_id=player_place.account_id) WHERE area='commons';
