package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMailReturnMigrationPreservesExistingTransitAndClaims(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phase5.sqlite")
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
	for _, file := range files {
		if file.Name() == "009_mail_returns.sql" {
			break
		}
		raw, err := migrations.ReadFile("migrations/" + file.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = old.Exec(string(raw)); err != nil {
			t.Fatal(err)
		}
		if _, err = old.Exec("INSERT INTO schema_migrations VALUES(?,0)", file.Name()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',0);
 INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at,rev) VALUES('alice','Alice','w',1,100,9),('bob','Bob','w',1,100,2);
 INSERT INTO homesteads VALUES('alice','w',0,1);
 INSERT INTO homestead_items(id,habitica_id,item_def,location) VALUES('original-chair','alice','reading-chair','mail');
 INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,sent_at,claimed_at) VALUES
 ('pending','w','alice','bob','decoration','reading-chair',1,'["original-chair"]',10,NULL),
 ('claimed','w','alice','bob','material','timber',50,'[]',5,7);`); err != nil {
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
	var n int
	if err = s.DB.QueryRow("SELECT COUNT(*) FROM mail WHERE returned_at IS NULL AND return_reason IS NULL").Scan(&n); err != nil || n != 2 {
		t.Fatal("migration changed mail", n, err)
	}
	if err = s.DB.QueryRow("SELECT rev FROM players WHERE habitica_id='alice'").Scan(&n); err != nil || n != 9 {
		t.Fatal("migration changed revision", n, err)
	}
	var raw, location string
	if err = s.DB.QueryRow("SELECT instance_ids FROM mail WHERE id='pending'").Scan(&raw); err != nil || raw != `["original-chair"]` {
		t.Fatal("instance identity changed", raw, err)
	}
	if err = s.DB.QueryRow("SELECT location FROM homestead_items WHERE id='original-chair'").Scan(&location); err != nil || location != "mail" {
		t.Fatal("transit lost", location, err)
	}
	for _, update := range []string{
		"UPDATE mail SET returned_at=20,return_reason='expired' WHERE id='claimed'",
		"UPDATE mail SET returned_at=20 WHERE id='pending'",
		"UPDATE mail SET return_reason='expired' WHERE id='pending'",
		"UPDATE mail SET returned_at=20,return_reason='other' WHERE id='pending'",
	} {
		if _, err = s.DB.Exec(update); err == nil {
			t.Fatal("invalid terminal state accepted", update)
		}
	}
}
