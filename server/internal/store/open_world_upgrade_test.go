package store

import (
	"path/filepath"
	"testing"
)

// A 0.13 database (through 038): 039 drops the stored bodies of unheld wick
// chunks, so they are made again on the new landform. A held chunk keeps its
// body, the still epoch keeps its chunks, and ground changes stay; 040
// clears the remade camp's state (open_world_fixes_upgrade_test.go).
func TestUpgradeRemakesUnheldWickChunks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.sqlite")
	db := newUpgradeFixture(t, path, "038_lamps.sql", nil)
	if _, err := db.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Alice','w',1,1);
 INSERT INTO wild_epochs(id,world_id,kind,world_seed,generator_version,season,starts_at,ends_at) VALUES
 ('still','w','still','seed',3,'0',1,NULL),('old','w','wick','seed',3,'t:1:604801',1,604801),('now','w','wick','seed',3,'t:604801:1209601',604801,1209601);
 INSERT INTO wilds_chunks(epoch_id,layer,cx,cy,generator_version,blob,created_at) VALUES
 ('still',0,0,-1,3,x'00',1),('old',0,4,4,3,x'00',1),('now',0,4,4,3,x'00',604802),('now',0,5,9,3,x'00',604802),('now',0,6,9,3,x'00',604802);
 INSERT INTO holds(world_id,realm,layer,cx,cy,epoch_id,holder_kind,holder_id,since) VALUES
 ('w','hearthwick',0,4,4,'old','way-lamp','lamp-1',2),('w','hearthwick',0,6,9,'now','lot-lantern','3',604803);
 INSERT INTO entity_state(epoch,entity_id,cycle,state,available_at,by_id,at) VALUES('now','camp:5:9:0',0,'cleared',0,'alice',604804);
 INSERT INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at,changed_by,ends_at) VALUES('w','hearthwick',0,'5:9','now','ground','ground','{"changes":[]}',604805,'alice',1209601);`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rows, err := s.DB.Query("SELECT epoch_id,cx,cy FROM wilds_chunks ORDER BY epoch_id,cx")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rows.Next() {
		var e string
		var cx, cy int
		if err = rows.Scan(&e, &cx, &cy); err != nil {
			t.Fatal(err)
		}
		got = append(got, e+":"+itoa(cx)+","+itoa(cy))
	}
	rows.Close()
	if want := []string{"now:6,9", "old:4,4", "still:0,-1"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("stored chunks %v, want %v", got, want)
	}
	var states, epochs, changes int
	if err = s.DB.QueryRow("SELECT count(*) FROM world_changes").Scan(&changes); err != nil || changes != 1 {
		t.Fatalf("ground changes: %d %v", changes, err)
	}
	if err = s.DB.QueryRow("SELECT count(*) FROM entity_state").Scan(&states); err != nil || states != 0 {
		t.Fatalf("entity state: %d %v", states, err)
	}
	if err = s.DB.QueryRow("SELECT count(*) FROM wild_epochs").Scan(&epochs); err != nil || epochs != 3 {
		t.Fatalf("epochs: %d %v", epochs, err)
	}
}

func itoa(n int) string {
	if n < 0 {
		return "-" + itoa(-n)
	}
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + itoa(n%10)
}
