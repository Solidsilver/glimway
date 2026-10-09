-- 0.5 Crafts (docs/design/crafts.md 6.4): companions and the stable, the
-- magic marks, the ability cooldowns, the world-changes table with the mill
-- pond's stock as its first writer, and the account's fishing. No backfill:
-- no rows means Habitica's current pet, an empty yard, no stable and a full
-- pond.
CREATE TABLE player_companions(
 account_id TEXT PRIMARY KEY REFERENCES players(account_id),
 follow_pet TEXT NOT NULL DEFAULT '', mount_out TEXT NOT NULL DEFAULT '', mount_home TEXT
);
-- One yard per pet key: a pet stands in one slot, never two (6.2, "no repeats").
CREATE TABLE yard_pets(
 account_id TEXT NOT NULL REFERENCES players(account_id), slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),
 pet_key TEXT NOT NULL, PRIMARY KEY(account_id,slot), UNIQUE(account_id,pet_key)
);
-- One mount per owner's stalls here: the same mount moves rather than
-- standing twice (6.2).
CREATE TABLE homestead_stalls(
 homestead_id TEXT NOT NULL REFERENCES homesteads(id), stall INTEGER NOT NULL CHECK(stall BETWEEN 1 AND 6),
 mount_key TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES players(account_id),
 PRIMARY KEY(homestead_id,stall), UNIQUE(homestead_id,owner_id,mount_key)
);
ALTER TABLE homestead_items ADD COLUMN stalls INTEGER CHECK(stalls IS NULL OR stalls BETWEEN 1 AND 6);
ALTER TABLE sync_baselines ADD COLUMN class_mark TEXT;
CREATE TABLE player_ability_ready(
 account_id TEXT NOT NULL REFERENCES players(account_id), ability TEXT NOT NULL,
 ready_at REAL NOT NULL, PRIMARY KEY(account_id,ability)
);
-- One shared row per world entity whose state outlives a request (plan.md,
-- "Shared foundations"): the ProtoJSON of the kind's state message, and the
-- turn it expires at (NULL: never). Reads ignore a row whose ends_at has
-- passed; nothing cleans up on a timer.
CREATE TABLE world_changes(
 world_id TEXT NOT NULL REFERENCES worlds(id), realm TEXT NOT NULL, layer INTEGER NOT NULL,
 chunk TEXT NOT NULL, epoch TEXT NOT NULL, entity TEXT NOT NULL, kind TEXT NOT NULL,
 state TEXT NOT NULL, changed_at INTEGER NOT NULL, changed_by TEXT REFERENCES players(account_id),
 ends_at INTEGER, PRIMARY KEY(world_id,realm,layer,chunk,epoch,entity)
);
-- seq is the account's cast sequence: the species roll is seeded by it, so
-- a duplicated seq is a bug the database catches (6.2).
CREATE TABLE fishing_casts(
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES players(account_id),
 world_id TEXT NOT NULL REFERENCES worlds(id), water TEXT NOT NULL, bank TEXT NOT NULL, rod TEXT NOT NULL,
 species TEXT NOT NULL, band TEXT NOT NULL, seq INTEGER NOT NULL,
 started_at REAL NOT NULL, ready_at REAL NOT NULL, hold_until REAL NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('open','kept','released','cancelled','lapsed')), closed_at INTEGER,
 UNIQUE(account_id,seq)
);
CREATE UNIQUE INDEX fishing_casts_open ON fishing_casts(account_id) WHERE state='open';
-- Lapsing is lazy, by the next operation or read that touches a water
-- (5.4): its open casts are found by this index, never a full scan.
CREATE INDEX fishing_casts_water_open ON fishing_casts(world_id,water,hold_until) WHERE state='open';
CREATE TABLE player_fishing(
 account_id TEXT PRIMARY KEY REFERENCES players(account_id), cast_seq INTEGER NOT NULL DEFAULT 0, last_start REAL
);
PRAGMA foreign_key_check;
