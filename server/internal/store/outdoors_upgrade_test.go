package store

import (
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
			{"alice", "outdoors", "wick-e", -383.5, -1200, 8, 8},
			// Commons local pixels move by the footprint origin (-21, 24) tiles.
			{"bob", "outdoors", "", 40, 424, 10, 10},
			{"dave", "outdoors", "", 520.5, 392, 5, 5},
			{"carol", "village", "", 2, 3, 11, 7},
		} {
			var area, epoch string
			var x, y float64
			var version, barrier int
			err := s.DB.QueryRow(`SELECT area,x,y,last_wick_epoch,version,place_set_version FROM player_place JOIN players USING(account_id) WHERE account_id=?`, row.id).Scan(&area, &x, &y, &epoch, &version, &barrier)
			if err != nil || area != row.area || x != row.x || y != row.y || epoch != row.epoch || version != row.version || barrier != row.barrier {
				t.Fatalf("pass %d %s: %s %v %v %s %d %d: %v", pass, row.id, area, x, y, epoch, version, barrier, err)
			}
		}
		if fallRows(t, s, "SELECT count(*) FROM story_marks WHERE mark='wilds:turned'") != 1 || fallRows(t, s, "SELECT count(*) FROM wild_epochs") != 1 {
			t.Fatal("rename removed progress or epochs")
		}
		s.Close()
	}
}
