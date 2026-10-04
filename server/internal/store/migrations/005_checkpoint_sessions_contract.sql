-- The ledger cursor distinguishes reports from checkpoints in the same second.
ALTER TABLE sync_baselines ADD COLUMN checkpoint_ledger_id INTEGER NOT NULL DEFAULT 0;
-- Preserve ambiguous same-second legacy reports for the first new checkpoint.
UPDATE sync_baselines SET checkpoint_ledger_id=COALESCE(
 (SELECT MAX(id) FROM ledger WHERE ledger.habitica_id=sync_baselines.habitica_id
  AND created_at<sync_baselines.checkpoint_at),0);
-- Wilds and placement audit rows do not enter the checkpoint report scan.
CREATE INDEX ledger_credit_reports ON ledger(habitica_id,id)
 WHERE reason IN ('sync','pending-held') AND reported_xp IS NOT NULL;
-- Existing sessions begin their idle window at the most recent recorded use.
-- Authentication updated expires_at under the old absolute-only policy, so
-- player last_seen_at is the best available legacy activity timestamp.
UPDATE sessions SET expires_at=MIN(expires_at,created_at+2592000,
 MAX(created_at,COALESCE((SELECT last_seen_at FROM players WHERE players.habitica_id=sessions.habitica_id),created_at))+604800);
-- Add the snapshot contract field to retained historical replay responses.
UPDATE idempotency SET response_json=json_set(response_json,'$.displayName',
 (SELECT display_name FROM players WHERE players.habitica_id=idempotency.habitica_id))
 WHERE json_type(response_json,'$.state')='object'
 AND json_type(response_json,'$.displayName') IS NULL;
