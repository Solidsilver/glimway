-- 0.8 The open map (docs/design/open-map.md 2.3, decision 4): a clean break.
-- The two 3x3 region epochs give way to two epoch kinds a world: "still"
-- (one, never ends: the Tangle) and "wick" (one a wick: everything else).
-- Chunks are made on demand under them, keyed on signed coordinates. The
-- Wilds' stored chunks, entity state, chest claims, discoveries and fallen
-- lanterns can't be read by the open map, so they go. Packs, home chests,
-- story marks and Echo progress live elsewhere and stay.
DROP TABLE wilds_chunks;
DROP TABLE entity_state;
DROP TABLE personal_claims;
DROP TABLE discoveries;
DROP TABLE lanterns;
DROP TABLE region_epochs;
CREATE TABLE wild_epochs(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
 kind TEXT NOT NULL CHECK(kind IN ('still','wick')), world_seed TEXT NOT NULL,
 generator_version INTEGER NOT NULL, season TEXT NOT NULL,
 starts_at INTEGER NOT NULL, ends_at INTEGER, UNIQUE(world_id,kind,season)
);
CREATE INDEX wild_epochs_current ON wild_epochs(world_id,kind,generator_version,starts_at);
-- Two racing first reads of a chunk store one blob: the key is unique.
CREATE TABLE wilds_chunks(
 epoch_id TEXT NOT NULL REFERENCES wild_epochs(id) ON DELETE CASCADE, layer INTEGER NOT NULL DEFAULT 0,
 cx INTEGER NOT NULL, cy INTEGER NOT NULL, generator_version INTEGER NOT NULL, blob BLOB NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(epoch_id,layer,cx,cy)
);
CREATE TABLE entity_state(
 epoch TEXT NOT NULL REFERENCES wild_epochs(id) ON DELETE CASCADE, entity_id TEXT NOT NULL,
 cycle INTEGER NOT NULL DEFAULT 0 CHECK(cycle>=0), state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','cleared','harvested','charted')),
 available_at INTEGER NOT NULL DEFAULT 0, by_id TEXT REFERENCES players(account_id), at INTEGER,
 PRIMARY KEY(epoch,entity_id)
);
CREATE TABLE personal_claims(
 epoch TEXT NOT NULL REFERENCES wild_epochs(id) ON DELETE CASCADE, entity_id TEXT NOT NULL,
 account_id TEXT NOT NULL REFERENCES players(account_id), at INTEGER NOT NULL,
 PRIMARY KEY(epoch,entity_id,account_id)
);
CREATE INDEX personal_claims_account ON personal_claims(account_id,epoch);
-- A point of interest charted, a place found first (decision 20) or the
-- rumour's find opened first: the first insert an epoch wins.
CREATE TABLE discoveries(
 epoch TEXT NOT NULL REFERENCES wild_epochs(id) ON DELETE CASCADE, entity_id TEXT NOT NULL, poi_id TEXT NOT NULL,
 discoverer_id TEXT NOT NULL REFERENCES players(account_id), at INTEGER NOT NULL, PRIMARY KEY(epoch,entity_id)
);
-- One fallen lantern an owner a world; x and y are world tiles.
CREATE TABLE lanterns(
 id TEXT PRIMARY KEY, epoch TEXT NOT NULL REFERENCES wild_epochs(id) ON DELETE CASCADE,
 world_id TEXT NOT NULL REFERENCES worlds(id), owner_id TEXT NOT NULL REFERENCES players(account_id),
 x INTEGER NOT NULL, y INTEGER NOT NULL, lit_by TEXT REFERENCES players(account_id), at INTEGER NOT NULL,
 lit_at INTEGER, UNIQUE(world_id,owner_id)
);
-- The world-changes layer under the Wilds (section 3) is keyed by epoch id;
-- the old epochs' ids are gone, so their rows go too (none were written).
DELETE FROM world_changes WHERE realm='hearthwick';
-- The wilds:turned flag reads the last wick epoch a player stood in.
ALTER TABLE player_place RENAME COLUMN last_outer_epoch TO last_wick_epoch;
ALTER TABLE player_place RENAME COLUMN last_outer_starts_at TO last_wick_starts_at;
-- Anyone saved in the Wilds steps back out through the Tangle arch on the
-- Commons (src/game/commons.ts COMMONS_FROM_WILDS, as 028 did), with a new
-- version so the client takes the moved place.
UPDATE players SET version=version+1 WHERE account_id IN (SELECT account_id FROM player_place WHERE area='wilds' OR area LIKE 'wilds:%');
UPDATE player_place SET area='commons', x=376, y=40, last_wick_epoch='', last_wick_starts_at=NULL,
 place_set_version=(SELECT version FROM players p WHERE p.account_id=player_place.account_id)
 WHERE area='wilds' OR area LIKE 'wilds:%';
