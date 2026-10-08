package store

import (
	"path/filepath"
	"strings"
	"testing"
)

// Migrations 023 and 024: a party's world belongs to the party. Older links
// from a person's world to a party stay as a record (for prompts and `party
// adopt`) but never make it the party's world, and a party has at most one.
func TestPartyOwnedWorldsUpgrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "party.sqlite")
	old := newUpgradeFixture(t, path, "022_party_worlds.sql", nil)
	var err error
	if _, err = old.Exec(`INSERT INTO worlds(id,owner_id,seed,habitica_party_id,created_at) VALUES('olive-w','olive','s','p1',1),('bob-w','bob','s','p1',2),('solo','sam','s',NULL,3);
 INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at,habitica_party_id) VALUES('olive','Olive','olive-w',1,1,'p1'),('rue','Rue','olive-w',1,1,'p1'),('bob','Bob','bob-w',2,2,'p1');
 INSERT INTO party_prompts VALUES('bob','olive-w',5);`); err != nil {
		t.Fatal(err)
	}
	if err = old.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	n := func(q string) int {
		t.Helper()
		var v int
		if err := s.DB.QueryRow(q).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	if n("SELECT count(*) FROM worlds WHERE habitica_party_id='p1' AND owner_id!=''") != 2 || n("SELECT count(*) FROM worlds") != 3 || n("SELECT count(*) FROM worlds WHERE opened_by IS NOT NULL") != 0 {
		t.Fatal("person-owned links not kept as a record, or a world lost")
	}
	if n("SELECT count(*) FROM players WHERE world_id='olive-w'") != 2 || n("SELECT count(*) FROM party_prompts") != 0 {
		t.Fatal("residents moved, or a stale prompt kept")
	}
	if n("SELECT count(*) FROM players WHERE party_left_at IS NULL AND party_moved_out_at IS NULL") != 3 || n("SELECT count(*) FROM party_closures") != 0 {
		t.Fatal("024's columns")
	}
	// Two person-owned worlds carry p1, and the party can still have its own.
	if _, err = s.DB.Exec("INSERT INTO worlds(id,owner_id,seed,habitica_party_id,created_at) VALUES('p1-w','','s','p1',9)"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("INSERT INTO worlds(id,owner_id,seed,habitica_party_id,created_at) VALUES('p1-x','','s','p1',9)"); err == nil || !strings.Contains(err.Error(), "UNIQUE") {
		t.Fatal("a second world for one party", err)
	}
}
