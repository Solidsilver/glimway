package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOutdoors036UpgradeMovesPlacesAndRaisesBarrier(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.sqlite")
	old := newUpgradeFixture(t, path, "035_fight_falls.sql", nil)
	_, err := old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES
 ('alice','Alice','w',1,1,7),('bob','Bob','w',1,1,9),('carol','Carol','w',1,1,11),('dave','Dave','w',1,1,4);
 INSERT INTO player_place(account_id,area,x,y,place_set_version,last_wick_epoch,last_wick_starts_at) VALUES
 ('alice','wilds',-383.5,-1200,5,'wick-e',500),('bob','commons',376,40,6,'',NULL),('carol','village',2,3,7,'',NULL),('dave','commons',856.5,8,2,'',NULL);
 INSERT INTO story_marks VALUES('alice','wilds:turned','server',1);
 INSERT INTO wild_epochs VALUES('wick-e','w','wick','seed',3,'t:500:900',500,900);`)
	if err != nil {
		t.Fatal(err)
	}
	old.Close()
	for pass := 0; pass < 2; pass++ {
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range []struct {
			id, area, epoch  string
			x, y             float64
			version, barrier int
		}{
			{"alice", "outdoors", "", -383.5, -1200, 8, 8},
			// Commons local pixels move by the footprint origin (-21, 24) tiles.
			{"bob", "outdoors", "", 40, 424, 11, 11},
			{"dave", "outdoors", "", 40, 424, 6, 6},
			{"carol", "outdoors", "", 72, 968, 12, 12},
		} {
			var area, epoch string
			var x, y float64
			var version, barrier int
			err := s.DB.QueryRow(`SELECT area,x,y,last_wick_epoch,version,place_set_version FROM player_place JOIN players USING(account_id) WHERE account_id=?`, row.id).Scan(&area, &x, &y, &epoch, &version, &barrier)
			if err != nil || area != row.area || x != row.x || y != row.y || epoch != row.epoch || version != row.version || barrier != row.barrier {
				t.Fatalf("pass %d %s: %s %v %v %s %d %d: %v", pass, row.id, area, x, y, epoch, version, barrier, err)
			}
		}
		if fallRows(t, s, "SELECT count(*) FROM story_marks WHERE mark='wilds:turned'") != 1 || fallRows(t, s, "SELECT count(*) FROM wild_epochs") != 0 {
			t.Fatal("rename removed progress or epochs")
		}
		s.Close()
	}
}

func TestOneTown037UpgradePreservesHomesAndMovesSavedPlaces(t *testing.T) {
	path := filepath.Join(t.TempDir(), "one-town.sqlite")
	old := newUpgradeFixture(t, path, "036_outdoors.sql", nil)
	_, err := old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','village','seed',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES
 ('village','V','w',1,1,7),('commons','C','w',1,1,7),('tangle','T','w',1,1,7),('home','H','w',1,1,7),('room','R','w',1,1,7);
 INSERT INTO player_place(account_id,area,x,y,place_set_version) VALUES
 ('village','village',400,300,3),('commons','outdoors',40,424,3),('tangle','outdoors',40.5,-120.25,3),('home','home:0',200,100,3),('room','in:village:bakery',80.5,96.25,3);
 INSERT INTO homesteads(id,world_id,gate,tier,claimed_at) VALUES('house','w',0,1,1);
 INSERT INTO homestead_members VALUES('home','house',1);
 INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES
 ('kept','wooden-stool','placed','house','outdoor',17,14,0),('stored','wooden-stool','placed','house','outdoor',35,20,0),('reserved','wooden-stool','placed','house','outdoor',19,23,0),('indoor','wooden-stool','placed','house','indoor',2,3,0);
 INSERT INTO homestead_cleared VALUES('house',17,14),('house',35,20);
 INSERT INTO homestead_stumps VALUES('house',18,14,123);
 INSERT INTO homestead_plants VALUES('kept-plant','house','wild-thyme',18,14,1,1),('stored-plant','house','wild-thyme',35,20,1,1);
 INSERT INTO wild_epochs VALUES('still-old','w','still','seed',3,'0',1,NULL),('wick-old','w','wick','seed',3,'t:1:9999999999',1,9999999999);
 INSERT INTO world_changes VALUES('w','village',0,'','','water:village:mill-pond','fishery','{"stock":4,"at":100}',100,NULL,NULL);`)
	if err != nil {
		t.Fatal(err)
	}
	old.Close()
	for pass := 0; pass < 2; pass++ {
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range []struct {
			id, area         string
			x, y             float64
			version, barrier int
		}{
			{"village", "outdoors", 72, 968, 8, 8}, {"commons", "outdoors", 40, 424, 8, 8}, {"tangle", "outdoors", 40.5, -120.25, 7, 3}, {"home", "outdoors", -968, 520, 8, 8}, {"room", "in:village:bakery", 80.5, 96.25, 7, 3},
		} {
			var area string
			var x, y float64
			var version, barrier int
			err = s.DB.QueryRow(`SELECT area,x,y,version,place_set_version FROM player_place JOIN players USING(account_id) WHERE account_id=?`, row.id).Scan(&area, &x, &y, &version, &barrier)
			if err != nil || area != row.area || x != row.x || y != row.y || version != row.version || barrier != row.barrier {
				t.Fatalf("pass %d %s: %s %v,%v v%d barrier%d %v", pass, row.id, area, x, y, version, barrier, err)
			}
		}
		for _, id := range []string{"stored", "reserved"} {
			var location string
			var scene sql.NullString
			if err = s.DB.QueryRow("SELECT location,scene FROM homestead_items WHERE id=?", id).Scan(&location, &scene); err != nil || location != "storage" || scene.Valid {
				t.Fatal(id, location, scene, err)
			}
		}
		var x, y int
		if err = s.DB.QueryRow("SELECT x,y FROM homestead_items WHERE id='kept'").Scan(&x, &y); err != nil || x != 9 || y != 11 {
			t.Fatal("kept", x, y, err)
		}
		if fallRows(t, s, "SELECT count(*) FROM homestead_members WHERE homestead_id='house'") != 1 || fallRows(t, s, "SELECT count(*) FROM homestead_items") != 4 || fallRows(t, s, "SELECT count(*) FROM wild_epochs WHERE kind='wick'") != 0 || fallRows(t, s, "SELECT count(*) FROM wild_epochs WHERE id='still-old'") != 1 {
			t.Fatal("lost identity or stale wick")
		}
		if fallRows(t, s, "SELECT qty FROM item_stacks WHERE location='storage' AND owner='house' AND item_def='wild-thyme'") != 1 || fallRows(t, s, "SELECT count(*) FROM homestead_land_archive") != 2 {
			t.Fatal("displaced land not preserved")
		}
		if fallRows(t, s, "SELECT count(*) FROM world_changes WHERE realm='hearthwick' AND kind='fishery' AND json_extract(state,'$.stock')=4") != 1 {
			t.Fatal("fishery reset")
		}
		s.Close()
	}
}
