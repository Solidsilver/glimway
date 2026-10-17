-- Who may build on a Built claim's land (lamps.md 2.5): its keeper's rule
-- and the members it names. A claim is its holds row's holder (039): kind
-- and id, so a way-lamp camp is ('way-lamp', the camp's id); lot backland
-- and Wilds hearths may adopt it later. No row: the keeper's household
-- builds there, as before. The keeper always may, whatever the rule.
--   household: the keeper's household
--   listed:    the household and the members named
--   except:    every world member but those named
--   everyone:  every world member
CREATE TABLE claim_rules(
 world_id TEXT NOT NULL REFERENCES worlds(id),
 holder_kind TEXT NOT NULL,
 holder_id TEXT NOT NULL,
 rule TEXT NOT NULL CHECK(rule IN ('household','listed','except','everyone')),
 set_at INTEGER NOT NULL,
 PRIMARY KEY(world_id,holder_kind,holder_id)
);
CREATE TABLE claim_rule_members(
 world_id TEXT NOT NULL,
 holder_kind TEXT NOT NULL,
 holder_id TEXT NOT NULL,
 account_id TEXT NOT NULL REFERENCES players(account_id),
 PRIMARY KEY(world_id,holder_kind,holder_id,account_id),
 FOREIGN KEY(world_id,holder_kind,holder_id) REFERENCES claim_rules(world_id,holder_kind,holder_id)
);
