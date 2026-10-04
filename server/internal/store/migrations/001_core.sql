CREATE TABLE players (
 habitica_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, world_id TEXT NOT NULL REFERENCES worlds(id),
 rev INTEGER NOT NULL DEFAULT 0 CHECK(rev>=0), lease_id TEXT, lease_client TEXT, lease_seen_at INTEGER,
 flagged_at INTEGER, save_origin TEXT CHECK(save_origin IN ('migrated','fresh')), save_origin_at INTEGER,
 created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE allowlist(habitica_id TEXT PRIMARY KEY, added_by TEXT NOT NULL, added_at INTEGER NOT NULL);
CREATE TABLE worlds(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, seed TEXT NOT NULL, habitica_party_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE invites(code_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL, world_id TEXT REFERENCES worlds(id), created_at INTEGER NOT NULL, used_by TEXT, used_at INTEGER);
CREATE TABLE sessions(id_hash TEXT PRIMARY KEY, habitica_id TEXT NOT NULL REFERENCES players(habitica_id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, checkpoint_json TEXT NOT NULL, checkpoint_xp REAL NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE progress(habitica_id TEXT PRIMARY KEY REFERENCES players(habitica_id), schema_version INTEGER NOT NULL, rev INTEGER NOT NULL, doc_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE sync_baselines(habitica_id TEXT PRIMARY KEY REFERENCES players(habitica_id), profile_json TEXT, xp_mark REAL NOT NULL DEFAULT 0 CHECK(xp_mark>=0), pending INTEGER NOT NULL DEFAULT 0 CHECK(pending>=0), verified_xp REAL NOT NULL, checkpoint_json TEXT NOT NULL, checkpoint_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE balances(habitica_id TEXT PRIMARY KEY REFERENCES players(habitica_id), embers INTEGER NOT NULL CHECK(embers>=0), xp_embers INTEGER NOT NULL CHECK(xp_embers>=0 AND xp_embers<=embers));
CREATE TABLE ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, habitica_id TEXT NOT NULL REFERENCES players(habitica_id), currency TEXT NOT NULL, delta INTEGER NOT NULL, earned_delta INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT NOT NULL, reported_xp REAL, created_at INTEGER NOT NULL);
CREATE INDEX ledger_player ON ledger(habitica_id,id);
CREATE TABLE inventory(habitica_id TEXT NOT NULL REFERENCES players(habitica_id), item_def TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>0), PRIMARY KEY(habitica_id,item_def));
CREATE TABLE outcomes(habitica_id TEXT NOT NULL REFERENCES players(habitica_id), outcome_id TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(habitica_id,outcome_id));
CREATE TABLE idempotency(habitica_id TEXT NOT NULL REFERENCES players(habitica_id), op TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(habitica_id,op,key));
CREATE INDEX idempotency_expiry ON idempotency(created_at);
