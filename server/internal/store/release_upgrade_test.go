package store

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// A populated database from the last release (through 037), upgraded by
// every pending migration in one start, as live will be: pieces, tools and
// their fittings, plants, shelf goods and stacks come through unchanged; the
// wick's paid paths are refunded at Pell's; every new table takes writes in
// its final shape; and the schema is a fresh database's.
func TestUpgradeFromLastRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "release.sqlite")
	old := newUpgradeFixture(t, path, lastShippedMigration, nil)
	if _, err := old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES('alice','Alice','w',1,50,7),('bob','Bob','w',2,60,3);
 INSERT INTO player_place(account_id,area,x,y,place_set_version) VALUES('alice','outdoors',-424.5,-744,7),('bob','in:hearthwick:inn',40,56,0);
 INSERT INTO homesteads(id,world_id,gate,tier,claimed_at) VALUES('house','w',0,2,1);
 INSERT INTO homestead_members VALUES('alice','house',1),('bob','house',2);
 INSERT INTO homestead_items(id,item_def,location,account_id,homestead_id,scene,x,y,rotation,name,stalls) VALUES
 ('chair','reading-chair','placed',NULL,'house','outdoor',9,11,90,NULL,NULL),
 ('stool','wooden-stool','placed',NULL,'house','indoor',2,3,0,'Grandad''s stool',NULL),
 ('stable','stable','placed',NULL,'house','outdoor',12,5,0,NULL,2),
 ('chest-piece','wooden-stool','storage',NULL,'house',NULL,NULL,NULL,NULL,NULL,NULL),
 ('shelf-piece','reading-chair','shelf',NULL,'house',NULL,NULL,NULL,NULL,NULL,NULL),
 ('pack-piece','way-lamp','inventory','alice',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
 ('post-piece','way-lamp','inventory','bob',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
 ('mail-piece','wooden-stool','mail','bob',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
 ('personal-piece','lantern-post','personal','bob',NULL,NULL,NULL,NULL,NULL,'By the door',NULL);
 INSERT INTO item_instances(id,item_def,location,owner,condition,max_condition,maker_id,worn_day,created_at,worn_at,racked_at) VALUES
 ('axe','iron-axe','pack','alice',7,10,'bob',4,5,123,0),
 ('axe-fit','whetstone-edge','fitted','axe',2,3,'',0,6,0,0),
 ('rack-saw','bow-saw','storage','house',3,10,'',0,6,0,77),
 ('shelf-rod','willow-rod','shelf','house',5,5,'alice',0,8,0,0),
 ('rod-fit','brass-reel','fitted','shelf-rod',1,1,'alice',0,9,0,0),
 ('parcel-knife','camp-knife','mail','bob',4,4,'',0,10,0,0),
 ('personal-hoe','garden-hoe','personal','bob',9,12,'',2,11,40,0);
 INSERT INTO item_stacks VALUES('pack','alice','timber','',40),('storage','house','stone','',12),('personal','bob','wild-thyme','alice',3);
 INSERT INTO item_slots VALUES('alice','off-hand','iron-axe','axe');
 INSERT INTO gate_shelf_slots(homestead_id,slot,kind,item_def,qty,maker_id,instance_id,stocked_by,stocked_at,price) VALUES
 ('house',0,'material','timber',5,'',NULL,'alice',10,3),
 ('house',1,'instance','willow-rod',1,'alice','shelf-rod','alice',11,40),
 ('house',2,'decoration','reading-chair',1,'','shelf-piece','bob',12,0);
 INSERT INTO homestead_plants(id,homestead_id,item_def,x,y,planted_at,planted_day) VALUES('thyme','house','wild-thyme',5,6,100,3),('apple','house','apple-sapling',0,20,90,2);
 INSERT INTO wild_epochs VALUES('still','w','still','seed',3,'0',1,NULL),('wick','w','wick','seed',3,'t:1:604801',1,604801);
 INSERT INTO lanterns(id,epoch,world_id,owner_id,x,y,lit_by,at,lit_at) VALUES('fallen','wick','w','alice',-40,99,NULL,12,NULL);
 INSERT INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at,changed_by,ends_at) VALUES
 ('w','hearthwick',0,'0:-1','still','ground','ground','{"changes":[{"tx":1,"ty":1,"change":"stone","by":"alice","at":2}]}',2,'alice',NULL),
 ('w','hearthwick',0,'2:-1','wick','ground','ground','{"changes":[{"tx":3,"ty":14,"change":"stone","by":"alice","at":2},{"tx":4,"ty":14,"change":"stone","by":"alice","at":2},{"tx":5,"ty":14,"change":"plank","by":"bob","at":3},{"tx":6,"ty":14,"change":"clear","by":"bob","at":3}]}',3,'alice',604801),
 ('w','hearthwick',0,'2:-1','wick','tree:4:4','felled','{}',3,'bob',604801);`); err != nil {
		t.Fatal(err)
	}
	// What must come through unchanged, read in 037's columns.
	kept := []string{
		"SELECT * FROM worlds ORDER BY id",
		"SELECT * FROM players ORDER BY account_id",
		// Where each player stands and its watermark (038 adds place_moved_version beside them).
		"SELECT account_id,area,x,y,place_set_version FROM player_place ORDER BY account_id",
		"SELECT * FROM homesteads ORDER BY id",
		"SELECT * FROM homestead_members ORDER BY account_id",
		"SELECT id,item_def,location,account_id,homestead_id,scene,x,y,rotation,name,stalls FROM homestead_items ORDER BY id",
		"SELECT * FROM item_instances ORDER BY id",
		"SELECT * FROM item_stacks ORDER BY location,owner,item_def",
		"SELECT * FROM item_slots ORDER BY account_id,slot",
		"SELECT * FROM gate_shelf_slots ORDER BY homestead_id,slot",
		"SELECT * FROM homestead_plants ORDER BY id",
		"SELECT * FROM wild_epochs WHERE kind='still'",
		"SELECT * FROM world_changes WHERE epoch='still'",
	}
	before := make([][]string, len(kept))
	for i, q := range kept {
		before[i] = dumpRows(t, old, q)
		if len(before[i]) == 0 {
			t.Fatalf("the fixture seeds nothing for %s", q)
		}
	}
	old.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for i, q := range kept {
		if got := dumpRows(t, s.DB, q); !reflect.DeepEqual(got, before[i]) {
			t.Fatalf("%s changed:\n got %v\nwant %v", q, got, before[i])
		}
	}
	for q, want := range map[string]int{
		// The wick ended: its epoch and changes go, its fallen lamp is archived.
		"SELECT count(*) FROM wild_epochs WHERE kind='wick'":                      0,
		"SELECT count(*) FROM world_changes WHERE epoch='wick'":                   0,
		"SELECT count(*) FROM one_town_lantern_archive WHERE id='fallen'":         1,
		"SELECT count(*) FROM homestead_items WHERE camp_id IS NOT NULL":          0,
		"SELECT count(*) FROM sqlite_master WHERE name='lasting_geography_paths'": 0,
		// Its paid paths wait at Pell's, one crate for the chunk.
		"SELECT count(*) FROM recovery_crates WHERE world_id='w' AND source='land-changed:2:-1' AND cx=2 AND cy=-1":                                          1,
		"SELECT qty FROM recovery_entries WHERE account_id='alice' AND item_def='stone' AND kind='stack' AND reason='land-changed' AND collected_at IS NULL": 2,
		"SELECT qty FROM recovery_entries WHERE account_id='bob' AND item_def='timber' AND kind='stack' AND reason='land-changed' AND collected_at IS NULL":  1,
		"SELECT count(*) FROM recovery_entries": 2,
		// No place was chosen by the server before 038: nobody follows a move on upgrade.
		"SELECT count(*) FROM player_place WHERE place_moved_version=0": 2,
		// Nothing else starts populated.
		"SELECT count(*) FROM wick_turnings": 0,
		"SELECT count(*) FROM holds":         0,
		"SELECT count(*) FROM camps":         0,
		"SELECT count(*) FROM lamp_namings":  0,
		"SELECT count(*) FROM schema_migrations WHERE name>'" + lastShippedMigration + "'": countPending(t),
	} {
		if n := countRows(t, s, q); n != want {
			t.Fatalf("%s: %d, want %d", q, n, want)
		}
	}
	// Every new shape takes the writes 0.13 makes.
	if _, err = s.DB.Exec(`INSERT INTO holds VALUES('w','hearthwick',0,-1,1,'still','lot-lantern','house',100,NULL);
 INSERT INTO lot_lanterns VALUES('house',3,0);
 INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES('backland-stool','wooden-stool','placed','house','outdoor',-24,3,0);
 INSERT INTO homestead_plants VALUES('backland-thyme','house','wild-thyme',-24,4,101,4);
 INSERT INTO camps VALUES('pack-piece','w',3,4,'alice',2,0,100);
 INSERT INTO holds VALUES('w','hearthwick',0,3,4,'still','way-lamp','pack-piece',100,NULL);
 UPDATE homestead_items SET location='camp',scene='camp',x=7,y=8,rotation=0,camp_id='pack-piece' WHERE id='pack-piece';
 INSERT INTO camp_plants VALUES('camp-thyme','pack-piece','bob','wild-thyme',1,2,102,4);
 INSERT INTO claim_rules VALUES('w','way-lamp','pack-piece','listed',100);
 INSERT INTO claim_rule_members VALUES('w','way-lamp','pack-piece','bob');
 INSERT INTO chunk_visits VALUES('w','hearthwick',0,3,4,604801,604900);
 INSERT INTO communal_lamps VALUES('w','post-piece','post',5,5,8,8,'bob',100);
 UPDATE homestead_items SET location='lamp' WHERE id='post-piece';
 INSERT INTO lamp_namings(world_id,lamp_id,text,short_name,namer,named_at) VALUES(NULL,'post-piece','Bob''s light','Bob''s',NULL,100),('w','lamp-stone:1:2','Here','Here','alice',101);
 INSERT INTO ways_home_bindings VALUES('alice','w','post-piece',100);
 INSERT INTO wick_turnings VALUES('w',604801);
 INSERT INTO carried_plants VALUES('apple','alice','apple-sapling',90,103);
 DELETE FROM homestead_plants WHERE id='apple';
 INSERT INTO recovery_crates VALUES('deed','w','deed-lost:house',0,0,104);
 UPDATE item_instances SET location='crate',owner='alice' WHERE id='rack-saw';
 INSERT INTO recovery_entries(crate_id,account_id,kind,item_def,qty,instance_id,reason) VALUES('deed','alice','tool','bow-saw',1,'rack-saw','deed-lost');`); err != nil {
		t.Fatal(err)
	}
	// A portable lamp is named once ever, wherever it is set.
	if _, err = s.DB.Exec(`INSERT INTO lamp_namings(world_id,lamp_id,text,short_name,named_at) VALUES(NULL,'post-piece','Again','Again',105)`); err == nil {
		t.Fatal("a piece named twice")
	}
	if rows := dumpRows(t, s.DB, "PRAGMA foreign_key_check"); len(rows) != 0 {
		t.Fatal("foreign keys", rows)
	}
	upgraded := dumpSchema(t, s.DB)
	s.Close()

	fresh, err := Open(filepath.Join(t.TempDir(), "fresh.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if want := dumpSchema(t, fresh.DB); !reflect.DeepEqual(upgraded, want) {
		t.Fatalf("upgraded and fresh schemas differ:\n%v\n%v", upgraded, want)
	}
	// Opening again applies nothing more.
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if n := countRows(t, again, "SELECT count(*) FROM recovery_entries WHERE reason='land-changed'"); n != 2 {
		t.Fatalf("the refund ran again: %d", n)
	}
}

func countPending(t *testing.T) int {
	t.Helper()
	history, err := migrationHistory()
	if err != nil {
		t.Fatal(err)
	}
	return len(history) - len(shippedMigrationHistory)
}

// dumpRows renders every row of a query as text, for comparing whole tables.
func dumpRows(t *testing.T, db *sql.DB, query string) []string {
	t.Helper()
	rows, err := db.Query(query)
	if err != nil {
		t.Fatal(query, err)
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err = rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		parts := make([]string, len(vals))
		for i, v := range vals {
			if b, ok := v.([]byte); ok {
				v = string(b)
			}
			parts[i] = fmt.Sprintf("%s=%v", cols[i], v)
		}
		out = append(out, strings.Join(parts, " "))
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// dumpSchema is a database's tables and indexes, quoting and spacing aside
// (a table rebuilt and renamed keeps its new name quoted).
func dumpSchema(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows := dumpRows(t, db, "SELECT type,name,COALESCE(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
	for i, row := range rows {
		rows[i] = strings.ReplaceAll(strings.Join(strings.Fields(row), " "), `"`, "")
	}
	return rows
}
