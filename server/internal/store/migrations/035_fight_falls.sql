-- 0.9 Shared fights (shared-fights.md 1.3, 1.9): the server sees a camp
-- fall. A generated camp's fall is written by one writer, off the room's
-- tick, keyed by the room's full identity, the camp and its cycle. The
-- witnesses are every account whose 3x3 covered the room from the camp's
-- first aggro to its fall; each may claim that fallen cycle once. Chests,
-- points of interest and the rumour keep personal_claims (once an epoch);
-- entity_state keeps one row a camp, now written by its fall.
CREATE TABLE fight_falls(
 world_id TEXT NOT NULL, realm TEXT NOT NULL, layer INTEGER NOT NULL, cx INTEGER NOT NULL, cy INTEGER NOT NULL,
 epoch TEXT NOT NULL REFERENCES wild_epochs(id) ON DELETE CASCADE, entity_id TEXT NOT NULL,
 cycle INTEGER NOT NULL CHECK(cycle>=0), fell_at INTEGER NOT NULL,
 PRIMARY KEY(world_id,realm,layer,cx,cy,epoch,entity_id,cycle)
);
CREATE TABLE fight_fall_witnesses(
 world_id TEXT NOT NULL, realm TEXT NOT NULL, layer INTEGER NOT NULL, cx INTEGER NOT NULL, cy INTEGER NOT NULL,
 epoch TEXT NOT NULL, entity_id TEXT NOT NULL, cycle INTEGER NOT NULL,
 account_id TEXT NOT NULL REFERENCES players(account_id),
 PRIMARY KEY(world_id,realm,layer,cx,cy,epoch,entity_id,cycle,account_id),
 FOREIGN KEY(world_id,realm,layer,cx,cy,epoch,entity_id,cycle)
  REFERENCES fight_falls(world_id,realm,layer,cx,cy,epoch,entity_id,cycle) ON DELETE CASCADE
);
-- The near read names, for its reader, the falls they witnessed.
CREATE INDEX fight_fall_witnesses_account ON fight_fall_witnesses(account_id,epoch);
-- A fallen cycle claimed: once an account, a camp and a cycle.
CREATE TABLE camp_claims(
 epoch TEXT NOT NULL REFERENCES wild_epochs(id) ON DELETE CASCADE, entity_id TEXT NOT NULL,
 cycle INTEGER NOT NULL CHECK(cycle>=0), account_id TEXT NOT NULL REFERENCES players(account_id),
 at INTEGER NOT NULL, PRIMARY KEY(epoch,entity_id,cycle,account_id)
);
CREATE INDEX camp_claims_account ON camp_claims(account_id,epoch);
