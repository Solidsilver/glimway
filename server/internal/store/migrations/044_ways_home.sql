-- Ways home (roadmap 0.13; lamps.md 1.4): the lamp a player's lamp-ash
-- pouches are bound to, one binding a player, for every pouch they carry.
-- lamp_id is a lamp's stable id (a camp's way-lamp piece, a relit stone's
-- lamp-stone:<cx>:<cy>, a communal post's piece) in world_id; the lamp may
-- since have gone dark, been packed at Pell's or been taken down, and the
-- binding stays as written until it is bound again.
CREATE TABLE ways_home_bindings(
 account_id TEXT PRIMARY KEY REFERENCES players(account_id),
 world_id TEXT NOT NULL REFERENCES worlds(id),
 lamp_id TEXT NOT NULL,
 bound_at INTEGER NOT NULL
);
