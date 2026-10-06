package store

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// Migration 023: a party's world belongs to the party. Older links from a
// person's world to a party are cleared (the worlds and their residents stay),
// and a party has at most one world from then on.
func TestPartyOwnedWorldsUpgrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "party.sqlite")
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	if _, err = old.Exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	files, err := migrations.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if f.Name() >= "023" {
			break
		}
		schema, err := migrations.ReadFile("migrations/" + f.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = old.Exec(string(schema)); err != nil {
			t.Fatal(f.Name(), err)
		}
		if f.Name() == "003_loss_and_admission.sql" {
			tx, err := old.Begin()
			if err != nil {
				t.Fatal(err)
			}
			if err = initializeLossReferences(tx); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(); err != nil {
				t.Fatal(err)
			}
		}
		if _, err = old.Exec("INSERT INTO schema_migrations VALUES(?,0)", f.Name()); err != nil {
			t.Fatal(err)
		}
	}
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
	if n("SELECT count(*) FROM worlds WHERE habitica_party_id IS NOT NULL") != 0 || n("SELECT count(*) FROM worlds") != 3 {
		t.Fatal("person-owned links not cleared, or a world lost")
	}
	if n("SELECT count(*) FROM players WHERE world_id='olive-w'") != 2 || n("SELECT count(*) FROM party_prompts") != 0 {
		t.Fatal("residents moved, or a stale prompt kept")
	}
	if _, err = s.DB.Exec("INSERT INTO worlds(id,owner_id,seed,habitica_party_id,created_at) VALUES('p1-w','','s','p1',9)"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("INSERT INTO worlds(id,owner_id,seed,habitica_party_id,created_at) VALUES('p1-x','','s','p1',9)"); err == nil || !strings.Contains(err.Error(), "UNIQUE") {
		t.Fatal("a second world for one party", err)
	}
}
