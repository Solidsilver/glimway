package store

import (
	"path/filepath"
	"testing"
)

// A 0.11.2 database (through 037) with paths laid on the wick: 038 ends
// that wick's land, and 047 refunds each laid tile's material to whoever
// laid it, in a crate at Pell's marked "the land changed". Free clearing
// and a layer who has gone get nothing; the staging table goes.
func TestUpgradeRefundsPaidPaths(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.sqlite")
	db := newUpgradeFixture(t, path, "037_one_town.sql", nil)
	if _, err := db.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Alice','w',1,1),('bob','Bob','w',1,1);
 INSERT INTO wild_epochs(id,world_id,kind,world_seed,generator_version,season,starts_at,ends_at) VALUES('old','w','wick','seed',3,'t:1:604801',1,604801);
 INSERT INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at,changed_by,ends_at) VALUES
 ('w','hearthwick',0,'2:-1','old','ground','ground','{"changes":[{"tx":3,"ty":14,"change":"stone","by":"alice","at":2},{"tx":4,"ty":14,"change":"stone","by":"alice","at":2},{"tx":5,"ty":14,"change":"plank","by":"bob","at":3},{"tx":6,"ty":14,"change":"clear","by":"bob","at":3},{"tx":7,"ty":14,"change":"stone","by":"gone","at":3}]}',3,'alice',604801),
 ('w','hearthwick',0,'-3:5','old','ground','ground','{"changes":[{"tx":1,"ty":1,"change":"plank","by":"alice","at":4}]}',4,'alice',604801);`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var ground int
	if err = s.DB.QueryRow("SELECT count(*) FROM world_changes WHERE kind='ground'").Scan(&ground); err != nil || ground != 0 {
		t.Fatalf("the old wick's ground stays: %d %v", ground, err)
	}
	owed := func(account, def string) int {
		var n int
		if err := s.DB.QueryRow(`SELECT coalesce(sum(e.qty),0) FROM recovery_entries e JOIN recovery_crates c ON c.id=e.crate_id
 WHERE c.world_id='w' AND e.account_id=? AND e.item_def=? AND e.kind='stack' AND e.reason='land-changed' AND e.collected_at IS NULL`, account, def).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if owed("alice", "stone") != 2 || owed("alice", "timber") != 1 || owed("bob", "timber") != 1 || owed("bob", "stone") != 0 {
		t.Fatalf("refunds: alice stone=%d timber=%d, bob timber=%d stone=%d", owed("alice", "stone"), owed("alice", "timber"), owed("bob", "timber"), owed("bob", "stone"))
	}
	var crates int
	if err = s.DB.QueryRow("SELECT count(*) FROM recovery_crates WHERE world_id='w' AND source LIKE 'land-changed:%'").Scan(&crates); err != nil || crates != 2 {
		t.Fatalf("one crate a chunk: %d %v", crates, err)
	}
	var cx, cy int
	if err = s.DB.QueryRow("SELECT cx,cy FROM recovery_crates WHERE source='land-changed:-3:5'").Scan(&cx, &cy); err != nil || cx != -3 || cy != 5 {
		t.Fatalf("crate chunk: %d,%d %v", cx, cy, err)
	}
	var staged int
	if err = s.DB.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='lasting_geography_paths'").Scan(&staged); err != nil || staged != 0 {
		t.Fatalf("staging table left: %d %v", staged, err)
	}
	// The cursor starts with no wick: the next one judges its turning.
	var cursors int
	if err = s.DB.QueryRow("SELECT count(*) FROM wick_turnings").Scan(&cursors); err != nil || cursors != 0 {
		t.Fatalf("cursors: %d %v", cursors, err)
	}
}
