-- First sign-in world choice (docs/home-server.md "Party worlds and world
-- moves"): a newcomer whose party has a world here, or who may open one, signs
-- in once and is asked where to live. Until POST /api/world/choose the sign-in
-- is held here, with no player row yet: the verified profile (never the
-- token) and the party it reported. Choosing makes the player and moves these
-- rows into sessions, keeping the cookie.
CREATE TABLE pending_sessions(
 id_hash TEXT PRIMARY KEY,
 habitica_id TEXT NOT NULL,
 display_name TEXT NOT NULL,
 habitica_party_id TEXT,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 checkpoint_json TEXT NOT NULL,
 checkpoint_xp REAL NOT NULL
);
CREATE INDEX pending_sessions_player ON pending_sessions(habitica_id);
