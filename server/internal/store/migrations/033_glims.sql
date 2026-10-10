-- 033_glims.sql: embers and the purse's gold become one currency, glims
-- (docs/design/silas-yard.md 1.7). 032 and earlier are pinned by
-- history.json and never edited; this converts what 0.6.0 wrote.
--
-- One rounding rule for every halved ledger delta: half away from zero
-- (+3 -> +2, -3 -> -2), so a letter's escrow row and its closing row still
-- cancel, and a letter's qty halves the same way (rounded up, never 0).

-- Balances: embers -> glims, xp_embers -> xp_glims. SQLite's RENAME COLUMN
-- rewrites the table's CHECK(xp_embers<=embers) with the new names.
ALTER TABLE balances RENAME COLUMN embers TO glims;
ALTER TABLE balances RENAME COLUMN xp_embers TO xp_glims;
-- Held sync credit is counted in the same currency.
ALTER TABLE pending_credits RENAME COLUMN embers TO glims;

-- The merge row (one per account that held gold, or whose gold rows don't
-- halve to exactly its turn-in): written before the gold rows are renamed,
-- so its delta is the turn-in, gold/2 floored, less what the account's gold
-- rows halve to. With it, each account's glims rows still sum to the glim
-- balance. ref names the gold turned in ('gold:15'); earned_delta is 0
-- (gold was never earned from XP, design 1.4 rule 4).
INSERT INTO ledger(account_id,currency,delta,earned_delta,reason,ref,created_at)
 SELECT b.account_id,'glims',
  b.gold/2 - COALESCE((SELECT SUM(CASE WHEN l.delta>=0 THEN (l.delta+1)/2 ELSE -((1-l.delta)/2) END)
                       FROM ledger l WHERE l.account_id=b.account_id AND l.currency='gold'),0),
  0,'currency-merge','gold:'||b.gold,CAST(strftime('%s','now') AS INTEGER)
 FROM balances b
 WHERE b.gold>0 OR b.gold/2 <> COALESCE((SELECT SUM(CASE WHEN l.delta>=0 THEN (l.delta+1)/2 ELSE -((1-l.delta)/2) END)
                       FROM ledger l WHERE l.account_id=b.account_id AND l.currency='gold'),0);

-- The gold turned in at two to a glim, floored; then the column goes.
UPDATE balances SET glims=glims+gold/2;
ALTER TABLE balances DROP COLUMN gold;

-- The ledger: every 'embers' row is a glims row as it stands; every 'gold'
-- row and every gold letter's escrow row is halved for the log.
UPDATE ledger SET currency='glims' WHERE currency='embers';
UPDATE ledger SET currency='glims', delta=CASE WHEN delta>=0 THEN (delta+1)/2 ELSE -((1-delta)/2) END WHERE currency='gold';
UPDATE ledger SET currency='mail:glims:glims', delta=CASE WHEN delta>=0 THEN (delta+1)/2 ELSE -((1-delta)/2) END WHERE currency='mail:gold:gold';

-- A top-up records the glims it credits (silas-yard.md 1.5). 0.6.0's
-- top-ups credited gold, which the turn-in above halved.
ALTER TABLE purse_topups ADD COLUMN glims INTEGER NOT NULL DEFAULT 0 CHECK(glims>=0);
UPDATE purse_topups SET glims=amount/2;

-- The mail rebuild, the way 032 did it: SQLite can't change a CHECK in
-- place, so a new table from the live definition with 'glims' where 'gold'
-- was, the rows copied (a gold letter becomes a glim letter, its qty halved
-- rounded up, so its escrow row above still matches it), the old table
-- dropped, the new one renamed, and every mail index recreated: the nine
-- CREATE INDEX writes of 020_gifts.sql (032 recreated the same nine; the
-- tenth index is the primary key's autoindex).
CREATE TABLE mail_v5(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
 from_id TEXT NOT NULL REFERENCES players(account_id), to_id TEXT NOT NULL REFERENCES players(account_id),
 kind TEXT NOT NULL CHECK(kind IN ('material','item','decoration','instance','thanks','glims')), item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK((kind IN ('material','item','decoration','instance','glims') AND qty > 0) OR (kind = 'thanks' AND qty = 0)),
 instance_ids TEXT NOT NULL DEFAULT '[]',
 sent_at INTEGER NOT NULL, claimed_at INTEGER,
 returned_at INTEGER CHECK(returned_at IS NULL OR claimed_at IS NULL),
 return_reason TEXT CHECK(
  (returned_at IS NULL AND return_reason IS NULL) OR
  (returned_at IS NOT NULL AND return_reason IS NOT NULL AND return_reason IN ('recalled','expired','recipient-removed'))
 ),
 makers TEXT NOT NULL DEFAULT '[]',
 CHECK(from_id!=to_id),
 CHECK(kind <> 'glims' OR (item_def = 'glims' AND instance_ids = '[]' AND makers = '[]'))
);
INSERT INTO mail_v5(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,sent_at,claimed_at,returned_at,return_reason,makers)
 SELECT id,world_id,from_id,to_id,
  CASE WHEN kind='gold' THEN 'glims' ELSE kind END,
  CASE WHEN kind='gold' THEN 'glims' ELSE item_def END,
  CASE WHEN kind='gold' THEN (qty+1)/2 ELSE qty END,
  instance_ids,sent_at,claimed_at,returned_at,return_reason,makers FROM mail;
DROP TABLE mail;
ALTER TABLE mail_v5 RENAME TO mail;
CREATE INDEX mail_recipient ON mail(world_id,to_id,sent_at);
CREATE INDEX mail_sender ON mail(world_id,from_id,sent_at);
CREATE INDEX mail_pending_sender ON mail(from_id,sent_at DESC,id DESC) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_pending_recipient ON mail(to_id,sent_at DESC,id DESC) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_pending_expiry ON mail(sent_at,id) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_history_sender ON mail(from_id,world_id,sent_at DESC,id DESC) WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL;
CREATE INDEX mail_history_recipient ON mail(to_id,world_id,sent_at DESC,id DESC) WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL;
CREATE INDEX mail_send_rate ON mail(from_id,sent_at);
CREATE INDEX mail_thanks_rate ON mail(from_id,to_id,kind,sent_at);

-- No view or trigger names 'embers': the schema has neither (006's
-- 'embers' was a one-time INSERT…SELECT, not a view). 033's upgrade test
-- checks sqlite_master stays that way.
