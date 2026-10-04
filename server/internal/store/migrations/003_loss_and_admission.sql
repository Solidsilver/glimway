-- Loss audit is independent of both the healing baseline and the paid mark.
ALTER TABLE sync_baselines ADD COLUMN loss_level REAL NOT NULL DEFAULT 1;
ALTER TABLE sync_baselines ADD COLUMN loss_xp REAL NOT NULL DEFAULT 0;
ALTER TABLE sync_baselines ADD COLUMN loss_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_baselines ADD COLUMN verified_high_level REAL NOT NULL DEFAULT 1;
CREATE TABLE access_removals(habitica_id TEXT PRIMARY KEY,removed_at INTEGER NOT NULL);
-- Existing admitted players without access were removed under the old policy.
INSERT INTO access_removals SELECT habitica_id,last_seen_at FROM players
 WHERE NOT EXISTS(SELECT 1 FROM allowlist WHERE allowlist.habitica_id=players.habitica_id);
UPDATE invites SET revoked_at=COALESCE(revoked_at,
 (SELECT removed_at FROM access_removals WHERE habitica_id=invites.created_by))
 WHERE used_by IS NULL AND created_by IN(SELECT habitica_id FROM access_removals);
CREATE INDEX pending_expiry ON pending_credits(created_at);
-- Existing sessions also obey the new absolute lifetime, measured from login.
UPDATE sessions SET expires_at=MIN(expires_at,created_at+2592000);
