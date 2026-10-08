package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestGiftMigrationMovesOutdoorShelfAndKeepsOnlyOnePerHome(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gifts-upgrade.sqlite")
	db := newUpgradeFixture(t, path, "019_gathering.sql", nil)
	var err error
	if _, err = db.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',1);
INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Alice','w',1,1);
INSERT INTO homesteads(id,world_id,gate,claimed_at) VALUES('home','w',0,1);
INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES
 ('a-shelf','gate-shelf','placed','home','outdoor',4,5,0),
 ('b-shelf','gate-shelf','placed','home','outdoor',6,7,90);`); err != nil {
		t.Fatal(err)
	}
	markFixtureOrigins(t, db)
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var scene sql.NullString
	var x, y, rotation sql.NullInt64
	if err = s.DB.QueryRow("SELECT scene,x,y,rotation FROM homestead_items WHERE id='a-shelf'").Scan(&scene, &x, &y, &rotation); err != nil {
		t.Fatal(err)
	}
	if !scene.Valid || scene.String != "gate" || !x.Valid || x.Int64 != 0 || !y.Valid || y.Int64 != 0 || !rotation.Valid || rotation.Int64 != 0 {
		t.Fatalf("first shelf was not moved to the gate: %v %v %v %v", scene, x, y, rotation)
	}
	var location string
	if err = s.DB.QueryRow("SELECT location FROM homestead_items WHERE id='b-shelf'").Scan(&location); err != nil || location != "storage" {
		t.Fatalf("extra shelf should be stored: %q (%v)", location, err)
	}
	var shelves int
	if err = s.DB.QueryRow("SELECT COUNT(*) FROM homestead_items WHERE homestead_id='home' AND item_def='gate-shelf' AND scene='gate'").Scan(&shelves); err != nil || shelves != 1 {
		t.Fatalf("expected one shelf at gate, got %d (%v)", shelves, err)
	}
	if _, err = s.DB.Exec(`INSERT INTO gate_shelf_slots(homestead_id,slot,kind,item_def,qty,instance_id,stocked_by,stocked_at)
VALUES('home',0,'item','comfrey-salve',1,'unexpected','alice',1)`); err == nil {
		t.Fatal("slot CHECK accepted instance_id for a stack")
	}
}
