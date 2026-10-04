CREATE TABLE lantern_creations(
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id), utc_day TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>=0), PRIMARY KEY(habitica_id,utc_day)
);
-- Existing defeats count towards today's limit on upgrade, including replacements.
INSERT INTO lantern_creations(habitica_id,utc_day,qty)
 SELECT habitica_id,strftime('%Y-%m-%d',created_at,'unixepoch'),count(*)
 FROM ledger WHERE reason='wilds-defeat' AND currency='embers'
 GROUP BY habitica_id,strftime('%Y-%m-%d',created_at,'unixepoch');
