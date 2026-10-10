-- 032_purse_wardrobe.sql: the gold purse and the Habitica wardrobe
-- (docs/design/purse-and-wardrobe.md 6.4). Schema only, no backfill: an
-- account with no rows here has an empty purse, Habitica's look, no owned
-- gear checked yet, free shelf slots and no gold letters.

-- The purse: gold beside embers. No write replaces a balance (3.5); every
-- change is gold = gold + ? with its ledger row.
ALTER TABLE balances ADD COLUMN gold INTEGER NOT NULL DEFAULT 0 CHECK(gold>=0);

-- One row per top-up (2.2): the state its worker left it in, Habitica's gold
-- before and after, and whether a reward may still sit in the player's
-- Habitica Rewards. A working row older than 90 seconds has no live worker
-- and is settled when someone looks (2.4) — time is worked out, not ticked.
CREATE TABLE purse_topups(
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES players(account_id),
 op_key TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0),
 state TEXT NOT NULL CHECK(state IN ('reserved','created','scoring','checking','moved','not-enough','not-moved','unconfirmed')),
 gold_before INTEGER CHECK(gold_before IS NULL OR gold_before>=0),
 gold_after INTEGER CHECK(gold_after IS NULL OR gold_after>=0),
 note TEXT NOT NULL DEFAULT '',
 leftover INTEGER NOT NULL DEFAULT 0 CHECK(leftover IN (0,1)),
 created_at INTEGER NOT NULL,
 settled_at INTEGER,
 settled_by TEXT CHECK(settled_by IS NULL OR settled_by IN ('worker','look','owner')),
 UNIQUE(account_id, op_key),
 -- A row settles once: the four working states are exactly the unsettled
 -- ones, and a settled row carries who settled it (2.2, 2.4).
 CHECK((state IN ('reserved','created','scoring','checking')) = (settled_at IS NULL)),
 CHECK((settled_at IS NULL) = (settled_by IS NULL))
);
-- One working top-up per account (2.4); the four working states.
CREATE UNIQUE INDEX purse_topups_working ON purse_topups(account_id)
 WHERE state IN ('reserved','created','scoring','checking');
CREATE INDEX purse_topups_account ON purse_topups(account_id, created_at);

-- The wardrobe's choice (4.2): per account, per slot, a gear key or the
-- reserved "none" (which no Habitica key can collide with — they are
-- type_klass_index). No row means As on Habitica. The slots are Habitica's
-- drawn gear types; weaponSpecial is never drawn and isn't offered.
CREATE TABLE player_wardrobe(
 account_id TEXT NOT NULL REFERENCES players(account_id),
 slot TEXT NOT NULL CHECK(slot IN ('weapon','shield','armor','head','headAccessory','back','body','eyewear')),
 gear_key TEXT NOT NULL CHECK(gear_key<>''),
 PRIMARY KEY(account_id, slot)
);

-- A gate shelf slot can carry a price in gold (3.2): 0 stays a free gift.
ALTER TABLE gate_shelf_slots ADD COLUMN price INTEGER NOT NULL DEFAULT 0 CHECK(price>=0 AND price<=9999);

-- Owned gear (4.3): the sorted keys whose items.gear.owned value is true,
-- kept only while the catalog knows them. Filled by the server's own reads
-- only (sign-in, a top-up, the wardrobe check) — never from a browser
-- report — and never part of PlayerState.
CREATE TABLE player_gear(
 account_id TEXT PRIMARY KEY REFERENCES players(account_id),
 owned_json TEXT NOT NULL CHECK(json_valid(owned_json)),
 checked_at INTEGER NOT NULL
);

-- The mail rebuild (6.4): SQLite can't change a CHECK in place, so the
-- table is rebuilt the way 013 and 020 did it — a new table from the live
-- definition with 'gold' in the kind list, a qty rule of qty > 0 for it and
-- the gold-letter shape (6.4: kind 'gold', item_def 'gold', instance_ids and
-- makers '[]'), the rows copied, the old table dropped, the new one renamed, and every mail index
-- recreated (the nine CREATE INDEX writes of 020_gifts.sql — the table's
-- tenth index is its primary key's autoindex — and nothing later adds one).
-- A gold
-- letter carries kind='gold', item_def='gold', qty the amount, instance_ids
-- and makers '[]'; the gold waits in the letter until it is collected or
-- comes back (3.3), which is why every return path goes through
-- store.ReturnMail's gold case.
CREATE TABLE mail_v4(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
 from_id TEXT NOT NULL REFERENCES players(account_id), to_id TEXT NOT NULL REFERENCES players(account_id),
 kind TEXT NOT NULL CHECK(kind IN ('material','item','decoration','instance','thanks','gold')), item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK((kind IN ('material','item','decoration','instance','gold') AND qty > 0) OR (kind = 'thanks' AND qty = 0)),
 instance_ids TEXT NOT NULL DEFAULT '[]',
 sent_at INTEGER NOT NULL, claimed_at INTEGER,
 returned_at INTEGER CHECK(returned_at IS NULL OR claimed_at IS NULL),
 return_reason TEXT CHECK(
  (returned_at IS NULL AND return_reason IS NULL) OR
  (returned_at IS NOT NULL AND return_reason IS NOT NULL AND return_reason IN ('recalled','expired','recipient-removed'))
 ),
 makers TEXT NOT NULL DEFAULT '[]',
 CHECK(from_id!=to_id),
 CHECK(kind <> 'gold' OR (item_def = 'gold' AND instance_ids = '[]' AND makers = '[]'))
);
INSERT INTO mail_v4(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,sent_at,claimed_at,returned_at,return_reason,makers)
 SELECT id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,sent_at,claimed_at,returned_at,return_reason,makers FROM mail;
DROP TABLE mail;
ALTER TABLE mail_v4 RENAME TO mail;
CREATE INDEX mail_recipient ON mail(world_id,to_id,sent_at);
CREATE INDEX mail_sender ON mail(world_id,from_id,sent_at);
CREATE INDEX mail_pending_sender ON mail(from_id,sent_at DESC,id DESC) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_pending_recipient ON mail(to_id,sent_at DESC,id DESC) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_pending_expiry ON mail(sent_at,id) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_history_sender ON mail(from_id,world_id,sent_at DESC,id DESC) WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL;
CREATE INDEX mail_history_recipient ON mail(to_id,world_id,sent_at DESC,id DESC) WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL;
CREATE INDEX mail_send_rate ON mail(from_id,sent_at);
CREATE INDEX mail_thanks_rate ON mail(from_id,to_id,kind,sent_at);

-- The ledger needs no change: 'gold' and 'mail:gold:gold' join 'embers',
-- 'material:*', 'item:*' and the mail location currencies as free-text
-- currencies (content.StackCurrency, itemmove.LocationCurrency).
