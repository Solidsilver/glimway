-- Plants carried in the pack (lamps.md 2.7): a plant taken from Pell's crate
-- as itself, not its seed. id is the plant's own, kept from where it grew;
-- item_def its seed; planted_at when it was first planted, its growth.
-- Planting it again puts it back in the ground (homestead_plants or
-- camp_plants) with the same id and planted_at; its planted_day there is the
-- day it was set again, where its wandering starts.
CREATE TABLE carried_plants(
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES players(account_id),
 item_def TEXT NOT NULL,
 planted_at INTEGER NOT NULL,
 carried_at INTEGER NOT NULL
);
CREATE INDEX carried_plants_owner ON carried_plants(account_id);
