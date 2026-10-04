ALTER TABLE players ADD COLUMN habitica_party_id TEXT;
ALTER TABLE invites ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN revoked_at INTEGER;
UPDATE invites SET expires_at=created_at+2592000;
CREATE INDEX invites_creator ON invites(created_by,expires_at) WHERE used_by IS NULL AND revoked_at IS NULL;
CREATE TABLE pending_credits (
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id),
 reported_xp REAL NOT NULL CHECK(reported_xp>=0),
 embers INTEGER NOT NULL CHECK(embers>0), created_at INTEGER NOT NULL,
 PRIMARY KEY(habitica_id,reported_xp)
);
-- Existing held credit must reach its original reported high-water point.
INSERT INTO pending_credits SELECT habitica_id,xp_mark,pending,updated_at
 FROM sync_baselines WHERE pending>0;
