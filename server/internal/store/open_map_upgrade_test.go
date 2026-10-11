package store

import (
	"path/filepath"
	"testing"
)

// 0.8's migration 034 (open-map.md 2.3, decision 4): a clean break. The
// fixture is a database as 0.7 left it (through 033) with both region
// epochs, their stored chunks, entity state, chest claims, a discovery and
// a fallen lantern; players saved in the Tangle, in the Whitequiet and in
// the village; packs, a home chest, story marks and Echo progress. After
// the upgrade the Wilds' rows are gone, the region tables with them, the
// two Wilds players stand at the Commons arch with a new version, and
// everything else is as it was.
func TestOpenMap034UpgradeIsACleanBreak(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.sqlite")
	old := newUpgradeFixture(t, path, "033_glims.sql", nil)
	seed := `INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES
 ('alice','Alice','w',1,1,7),('bob','Bob','w',1,1,7),('carol','Carol','w',1,1,7);
INSERT INTO player_place(account_id,area,x,y,place_set_version,last_outer_epoch,last_outer_starts_at) VALUES
 ('alice','wilds:inner-1',100,200,7,'',NULL),('bob','wilds:outer-1',30,40,7,'outer-e',500),('carol','village',2,3,7,'outer-e',500);
INSERT INTO region_epochs VALUES('inner-e','w','inner-1','seed',2,'0',1,NULL),('outer-e','w','outer-1','seed',2,'t:500:900',500,900);
INSERT INTO wilds_chunks VALUES('inner-e',0,1,1,2,x'00',1),('outer-e',0,1,1,2,x'00',1);
INSERT INTO entity_state(epoch,entity_id,state) VALUES('inner-e','camp:1:1:0','cleared');
INSERT INTO personal_claims VALUES('outer-e','chest:1:1:2','alice',1);
INSERT INTO discoveries VALUES('outer-e','poi:1:1:3','old-shrine','bob',1);
INSERT INTO lanterns(id,epoch,world_id,region_id,owner_id,x,y,at) VALUES('l','outer-e','w','outer-1','bob',5,5,1);
INSERT INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at) VALUES('w','village',0,'','','water:village:mill-pond','fishery','{}',1);
INSERT INTO story_marks VALUES('alice','echo:nan','server',1),('bob','wilds:turned','server',1),('alice','paper:eleven-days','server',1);
INSERT INTO item_stacks(location,owner,item_def,maker_id,qty) VALUES('pack','alice','timber','',5),('pack','bob','stone','',3),('storage','home','timber','',9);`
	if _, err := old.Exec(seed); err != nil {
		t.Fatal(err)
	}
	old.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	count := func(q string) int {
		t.Helper()
		var n int
		if err := s.DB.QueryRow(q).Scan(&n); err != nil {
			t.Fatal(q, err)
		}
		return n
	}
	for _, table := range []string{"wild_epochs", "wilds_chunks", "entity_state", "personal_claims", "discoveries", "lanterns"} {
		if n := count("SELECT count(*) FROM " + table); n != 0 {
			t.Errorf("%s kept %d rows", table, n)
		}
	}
	if n := count("SELECT count(*) FROM sqlite_master WHERE name IN ('region_epochs','region_epoch_interval')"); n != 0 {
		t.Error("the region tables stayed")
	}
	type place struct {
		area     string
		x, y     float64
		set      int
		epoch    string
		version  int
		hasStart bool
	}
	read := func(id string) place {
		var p place
		var starts *int64
		if err := s.DB.QueryRow("SELECT pp.area,pp.x,pp.y,pp.place_set_version,pp.last_wick_epoch,pp.last_wick_starts_at,p.version FROM player_place pp JOIN players p USING(account_id) WHERE account_id=?", id).Scan(&p.area, &p.x, &p.y, &p.set, &p.epoch, &starts, &p.version); err != nil {
			t.Fatal(err)
		}
		p.hasStart = starts != nil
		return p
	}
	for _, id := range []string{"alice", "bob"} {
		if p := read(id); p.area != "commons" || p.x != 376 || p.y != 40 || p.version != 8 || p.set != 8 || p.epoch != "" || p.hasStart {
			t.Errorf("%s: %+v", id, p)
		}
	}
	if p := read("carol"); p.area != "village" || p.x != 2 || p.version != 7 || p.set != 7 || p.epoch != "outer-e" || !p.hasStart {
		t.Errorf("carol moved: %+v", p)
	}
	if count("SELECT count(*) FROM story_marks") != 3 || count("SELECT COALESCE(SUM(qty),0) FROM item_stacks") != 17 || count("SELECT count(*) FROM world_changes") != 1 {
		t.Error("story, packs, the home chest or another world change were touched")
	}
	// The new tables take the open map's rows.
	if _, err := s.DB.Exec(`INSERT INTO wild_epochs VALUES('e','w','wick','seed',3,'t:1:2',1,2);
INSERT INTO wilds_chunks VALUES('e',0,-4,-8,3,x'00',1);
INSERT INTO lanterns(id,epoch,world_id,owner_id,x,y,at) VALUES('l2','e','w','bob',-90,-180,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`INSERT INTO wild_epochs VALUES('f','w','wick','seed',3,'t:1:2',1,2)`); err == nil {
		t.Error("two wick epochs for one season")
	}
	if _, err := s.DB.Exec(`INSERT INTO wild_epochs VALUES('g','w','outer','seed',3,'0',1,NULL)`); err == nil {
		t.Error("an epoch of no kind")
	}
	if _, err := s.DB.Exec(`DELETE FROM wild_epochs WHERE id='e'`); err != nil || count("SELECT count(*) FROM wilds_chunks")+count("SELECT count(*) FROM lanterns") != 0 {
		t.Error("an epoch's rows don't go with it", err)
	}
}
