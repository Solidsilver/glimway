package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestPhase5UpgradePreservesPlacementsAndInventory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phase4.sqlite")
	old := newUpgradeFixture(t, path, "008_phase5.sql", func(name string, tx *sql.Tx) {
		if name == "008_phase5.sql" {
			if _, err := tx.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',0);
 INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at,rev) VALUES('alice','Keeper','w',1,100,9);
 INSERT INTO homesteads VALUES('alice','w',0,1);
 INSERT INTO homestead_items(id,habitica_id,item_def,scene,x,y,rotation) VALUES('placed','alice','wooden-stool','outdoor',2,3,90),('unplaced','alice','wooden-stool',NULL,NULL,NULL,NULL);
 INSERT INTO inventory VALUES('alice','beeswax-candle',3);
 INSERT INTO materials VALUES('alice','timber',40);`); err != nil {
				t.Fatal(err)
			}
		}
	})
	var err error
	var scene, location string
	var x, y, rotation, n int
	if err = old.QueryRow("SELECT scene,x,y,rotation,location FROM homestead_items WHERE id='placed'").Scan(&scene, &x, &y, &rotation, &location); err != nil || scene != "outdoor" || x != 2 || y != 3 || rotation != 90 || location != "inventory" {
		t.Fatal("placement changed", err)
	}
	if err = old.QueryRow("SELECT count(*) FROM homestead_items WHERE location='inventory'").Scan(&n); err != nil || n != 2 {
		t.Fatal("lost instances", err)
	}
	markFixtureOrigins(t, old)
	if err = old.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var rev int
	if err = s.DB.QueryRow("SELECT version FROM players WHERE account_id='alice'").Scan(&rev); err != nil || rev != 9 {
		t.Fatal("revision changed", err)
	}
	// 010 resets homesteads (nobody plays on a server yet); carried goods stay.
	if err = s.DB.QueryRow("SELECT count(*) FROM homestead_items").Scan(&n); err != nil || n != 0 {
		t.Fatal("homestead reset", err)
	}
	if err = s.DB.QueryRow("SELECT count(*) FROM homesteads").Scan(&n); err != nil || n != 0 {
		t.Fatal("homestead reset", err)
	}
	// 012 moves carried goods into the stack table, unmarked.
	if err = s.DB.QueryRow("SELECT qty FROM item_stacks WHERE location='pack' AND owner='alice' AND item_def='beeswax-candle' AND maker_id=''").Scan(&n); err != nil || n != 3 {
		t.Fatal("lost trinkets", err)
	}
	if err = s.DB.QueryRow("SELECT qty FROM item_stacks WHERE location='pack' AND owner='alice' AND item_def='timber' AND maker_id=''").Scan(&n); err != nil || n != 40 {
		t.Fatal("lost materials", err)
	}
}
