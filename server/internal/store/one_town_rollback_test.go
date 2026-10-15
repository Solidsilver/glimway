package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// Migration 037 is one transaction: a failure after its SQL and destructive
// backfill have started leaves the 036 save as it was, and a retry applies it
// exactly once. A realistic 036 home, plant, clearing, outdoor furniture and wick epoch.
// Inject failure late enough to cover SQL plus the destructive backfill steps.
func TestOneTown037RollsBackAndRetriesWithoutDuplication(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cutover.sqlite")
	old := newUpgradeFixture(t, path, "036_outdoors.sql", nil)
	_, err := old.Exec(`
 INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES('alice','Alice','w',1,1,7);
 INSERT INTO player_place(account_id,area,x,y,place_set_version) VALUES('alice','home:0',200,100,3);
 INSERT INTO homesteads(id,world_id,gate,tier,claimed_at) VALUES('h','w',0,1,1);
 INSERT INTO homestead_members VALUES('alice','h',1);
 INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES('stool','wooden-stool','placed','h','outdoor',35,20,0);
 INSERT INTO homestead_cleared VALUES('h',35,20);
 INSERT INTO homestead_plants VALUES('plant','h','wild-thyme',35,20,1,1);
 INSERT INTO wild_epochs VALUES('wick','w','wick','seed',3,'t:1:9999999999',1,9999999999);
 CREATE TRIGGER reject_cutover BEFORE UPDATE ON homestead_items BEGIN SELECT RAISE(ABORT,'injected failure'); END;
 `)
	if err != nil {
		t.Fatal(err)
	}
	old.Close()
	if s, err := Open(path); err == nil {
		s.Close()
		t.Fatal("expected injected migration failure")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	var n int
	for _, q := range []string{
		"SELECT count(*) FROM schema_migrations WHERE name='037_one_town.sql'",
		"SELECT count(*) FROM sqlite_master WHERE name IN ('one_town_lantern_archive','homestead_land_archive')",
	} {
		if err = db.QueryRow(q).Scan(&n); err != nil || n != 0 {
			t.Fatal(q, n, err)
		}
	}
	for _, q := range []string{
		"SELECT count(*) FROM homestead_plants WHERE id='plant' AND x=35 AND y=20",
		"SELECT count(*) FROM homestead_cleared WHERE x=35 AND y=20",
		"SELECT count(*) FROM wild_epochs WHERE id='wick'",
		"SELECT count(*) FROM player_place WHERE area='home:0' AND x=200 AND y=100",
		"SELECT count(*) FROM players WHERE version=7",
	} {
		if err = db.QueryRow(q).Scan(&n); err != nil || n != 1 {
			t.Fatal(q, n, err)
		}
	}
	if _, err = db.Exec("DROP TRIGGER reject_cutover"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	for pass := 0; pass < 2; pass++ {
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, q := range []string{
			"SELECT count(*) FROM homestead_items WHERE id='stool' AND location='storage'",
			"SELECT qty FROM item_stacks WHERE owner='h' AND item_def='wild-thyme'",
			"SELECT count(*) FROM homestead_land_archive WHERE identity='plant'",
			"SELECT count(*) FROM schema_migrations WHERE name='037_one_town.sql'",
		} {
			if err = s.DB.QueryRow(q).Scan(&n); err != nil || n != 1 {
				t.Fatal(pass, q, n, err)
			}
		}
		s.Close()
	}
}
