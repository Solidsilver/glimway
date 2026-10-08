-- Finish null origins from the last verified checkpoint in the Go backfill.
CREATE TEMP TABLE origins_026(account_id TEXT PRIMARY KEY);
INSERT INTO origins_026 SELECT habitica_id FROM players WHERE save_origin IS NULL;
ALTER TABLE balances RENAME COLUMN habitica_id TO account_id;
ALTER TABLE claim_rate RENAME COLUMN habitica_id TO account_id;
ALTER TABLE contributions RENAME COLUMN habitica_id TO account_id;
ALTER TABLE gate_shelf_takes RENAME COLUMN habitica_id TO account_id;
ALTER TABLE gathering_caps RENAME COLUMN habitica_id TO account_id;
ALTER TABLE homestead_departures RENAME COLUMN habitica_id TO account_id;
ALTER TABLE homestead_items RENAME COLUMN habitica_id TO account_id;
ALTER TABLE homestead_members RENAME COLUMN habitica_id TO account_id;
ALTER TABLE idempotency RENAME COLUMN habitica_id TO account_id;
ALTER TABLE item_slots RENAME COLUMN habitica_id TO account_id;
ALTER TABLE lantern_creations RENAME COLUMN habitica_id TO account_id;
ALTER TABLE lantern_rewards RENAME COLUMN habitica_id TO account_id;
ALTER TABLE ledger RENAME COLUMN habitica_id TO account_id;
ALTER TABLE outcomes RENAME COLUMN habitica_id TO account_id;
ALTER TABLE party_prompts RENAME COLUMN habitica_id TO account_id;
ALTER TABLE pending_credits RENAME COLUMN habitica_id TO account_id;
ALTER TABLE personal_claims RENAME COLUMN habitica_id TO account_id;
ALTER TABLE player_deeds RENAME COLUMN habitica_id TO account_id;
ALTER TABLE players RENAME COLUMN habitica_id TO account_id;
ALTER TABLE progress RENAME COLUMN habitica_id TO account_id;
ALTER TABLE sessions RENAME COLUMN habitica_id TO account_id;
ALTER TABLE storm_finds RENAME COLUMN habitica_id TO account_id;
ALTER TABLE sync_baselines RENAME COLUMN habitica_id TO account_id;
ALTER TABLE warden_finds RENAME COLUMN habitica_id TO account_id;
ALTER TABLE woodpile_stacks RENAME COLUMN habitica_id TO account_id;
ALTER TABLE players ADD COLUMN profile_source TEXT NOT NULL DEFAULT 'habitica' CHECK(profile_source IN ('habitica','none'));
CREATE TABLE sign_ins(
 account_id TEXT NOT NULL REFERENCES players(account_id), method TEXT NOT NULL,
 subject TEXT NOT NULL, secret_hash TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(method,subject), UNIQUE(account_id,method)
);
INSERT INTO sign_ins(account_id,method,subject,created_at) SELECT account_id,'habitica',account_id,created_at FROM players;
ALTER TABLE players DROP COLUMN save_origin;
ALTER TABLE players DROP COLUMN save_origin_at;
DELETE FROM idempotency;
ALTER TABLE idempotency RENAME COLUMN response_json TO result_json;
ALTER TABLE idempotency ADD COLUMN committed_version INTEGER NOT NULL DEFAULT 0 CHECK(committed_version>=0);
-- This cap table predates player foreign keys.
ALTER TABLE warden_finds RENAME TO warden_finds_old;
CREATE TABLE warden_finds(account_id TEXT NOT NULL REFERENCES players(account_id),found_at INTEGER NOT NULL,PRIMARY KEY(account_id,found_at));
INSERT INTO warden_finds SELECT account_id,found_at FROM warden_finds_old;
DROP TABLE warden_finds_old;
PRAGMA foreign_key_check;
