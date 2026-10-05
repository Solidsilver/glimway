package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestPhase5UpgradePreservesPlacementsAndInventory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phase4.sqlite")
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
		if file.Name() == "008_phase5.sql" {
			// 008 itself keeps placements and instances (checked before the
			// homestead v2 reset in 010 runs on Open).
			if _, err = old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',0);
 INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at,rev) VALUES('alice','Keeper','w',1,100,9);
 INSERT INTO homesteads VALUES('alice','w',0,1);
 INSERT INTO homestead_items(id,habitica_id,item_def,scene,x,y,rotation) VALUES('placed','alice','wooden-stool','outdoor',2,3,90),('unplaced','alice','wooden-stool',NULL,NULL,NULL,NULL);
 INSERT INTO inventory VALUES('alice','beeswax-candle',3);
 INSERT INTO materials VALUES('alice','timber',40);`); err != nil {
				t.Fatal(err)
			}
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
	var scene, location string
	var x, y, rotation, n int
	if err = old.QueryRow("SELECT scene,x,y,rotation,location FROM homestead_items WHERE id='placed'").Scan(&scene, &x, &y, &rotation, &location); err != nil || scene != "outdoor" || x != 2 || y != 3 || rotation != 90 || location != "inventory" {
		t.Fatal("placement changed", err)
	}
	if err = old.QueryRow("SELECT count(*) FROM homestead_items WHERE location='inventory'").Scan(&n); err != nil || n != 2 {
		t.Fatal("lost instances", err)
	}
	if err = old.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var rev int
	if err = s.DB.QueryRow("SELECT rev FROM players WHERE habitica_id='alice'").Scan(&rev); err != nil || rev != 9 {
		t.Fatal("revision changed", err)
	}
	// 010 resets homesteads (nobody plays on a server yet); carried goods stay.
	if err = s.DB.QueryRow("SELECT count(*) FROM homestead_items").Scan(&n); err != nil || n != 0 {
		t.Fatal("homestead reset", err)
	}
	if err = s.DB.QueryRow("SELECT count(*) FROM homesteads").Scan(&n); err != nil || n != 0 {
		t.Fatal("homestead reset", err)
	}
	if err = s.DB.QueryRow("SELECT qty FROM inventory WHERE habitica_id='alice'").Scan(&n); err != nil || n != 3 {
		t.Fatal("lost trinkets", err)
	}
	if err = s.DB.QueryRow("SELECT qty FROM materials WHERE habitica_id='alice'").Scan(&n); err != nil || n != 40 {
		t.Fatal("lost materials", err)
	}
}
