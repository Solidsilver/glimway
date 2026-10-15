package store

import (
	"bytes"
	"database/sql"
	"path/filepath"
	"testing"

	"glimway/content"
	contentv1 "glimway/gen/glimway/content/v1"
	"glimway/server/internal/chunks"
	"glimway/server/internal/land"
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
			{"carol", "outdoors", "", 88, 968, 12, 12},
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
 ('village','V','w',1,1,7),('commons','C','w',1,1,7),('tangle','T','w',1,1,7),('home','H','w',1,1,7),('east','E','w',1,1,7),('stray','S','w',1,1,7),('room','R','w',1,1,7);
 INSERT INTO player_place(account_id,area,x,y,place_set_version) VALUES
 ('village','village',400,300,3),('commons','outdoors',40,424,3),('tangle','outdoors',40.5,-120.25,3),('home','home:0',200,100,3),('east','home:3',200,100,3),('stray','home:9',200,100,3),('room','in:village:bakery',80.5,96.25,3);
 INSERT INTO homesteads(id,world_id,gate,tier,claimed_at) VALUES('house','w',0,1,1),('east-house','w',3,1,1);
 INSERT INTO homestead_members VALUES('home','house',1),('east','east-house',1);
 INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES
 ('kept','wooden-stool','placed','house','outdoor',17,14,0),('stored','wooden-stool','placed','house','outdoor',35,20,0),
 ('wide','wooden-stool','placed','house','outdoor',30,8,0),('post','lantern-post','placed','house','outdoor',25,8,0),
 ('west-path','wooden-stool','placed','house','outdoor',24,15,0),('east-yard','wooden-stool','placed','east-house','outdoor',24,15,0),
 ('indoor','wooden-stool','placed','house','indoor',2,3,0);
 INSERT INTO homestead_cleared VALUES('house',17,14),('house',35,20),('house',30,8),('house',25,8),('east-house',24,15);
 INSERT INTO homestead_stumps VALUES('house',18,14,123);
 INSERT INTO homestead_plants VALUES('kept-plant','house','wild-thyme',18,14,1,1),('stored-plant','house','wild-thyme',35,20,1,1),
 ('path-plant','house','wild-thyme',24,15,1,1),('east-plant','east-house','wild-thyme',24,15,1,1);
 INSERT INTO wild_epochs VALUES('still-old','w','still','seed',3,'0',1,NULL),('wick-old','w','wick','seed',3,'t:1:9999999999',1,9999999999);
 INSERT INTO world_changes VALUES('w','village',0,'','','water:village:mill-pond','fishery','{"stock":4,"at":100}',100,NULL,NULL);`)
	if err != nil {
		t.Fatal(err)
	}
	old.Close()
	doorstep := func(gate int) (float64, float64) {
		x, y := chunks.HomeDoorstep(gate)
		return float64(x*16 + 8), float64(y*16 + 8)
	}
	westX, westY := doorstep(0)
	eastX, eastY := doorstep(3)
	if westX != -584 || westY != 520 || eastX != 952 || eastY != 904 {
		t.Fatal("doorstep contract moved", westX, westY, eastX, eastY)
	}
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
			// Village saves land on the spawn (5,60); Commons and unknown lots on the arch (2,26).
			{"village", "outdoors", 88, 968, 8, 8}, {"commons", "outdoors", 40, 424, 8, 8}, {"tangle", "outdoors", 40.5, -120.25, 7, 3},
			{"home", "outdoors", westX, westY, 8, 8}, {"east", "outdoors", eastX, eastY, 8, 8}, {"stray", "outdoors", 40, 424, 8, 8},
			{"room", "in:village:bakery", 80.5, 96.25, 7, 3},
		} {
			var area string
			var x, y float64
			var version, barrier int
			err = s.DB.QueryRow(`SELECT area,x,y,version,place_set_version FROM player_place JOIN players USING(account_id) WHERE account_id=?`, row.id).Scan(&area, &x, &y, &version, &barrier)
			if err != nil || area != row.area || x != row.x || y != row.y || version != row.version || barrier != row.barrier {
				t.Fatalf("pass %d %s: %s %v,%v v%d barrier%d %v", pass, row.id, area, x, y, version, barrier, err)
			}
		}
		// Out of bounds, and the west lot's path to its front gate at x 23.
		for _, id := range []string{"stored", "west-path"} {
			var location string
			var scene sql.NullString
			if err = s.DB.QueryRow("SELECT location,scene FROM homestead_items WHERE id=?", id).Scan(&location, &scene); err != nil || location != "storage" || scene.Valid {
				t.Fatal(id, location, scene, err)
			}
		}
		// Old x 30 was outside the 3..20 bounds; it is now x 22, lit by a moved post.
		// The east lot's path runs west, so the same tile stays free there.
		for id, want := range map[string][2]int{"kept": {9, 11}, "wide": {22, 5}, "post": {17, 5}, "east-yard": {16, 12}} {
			var location string
			var x, y int
			if err = s.DB.QueryRow("SELECT location,x,y FROM homestead_items WHERE id=?", id).Scan(&location, &x, &y); err != nil || location != "placed" || x != want[0] || y != want[1] {
				t.Fatal(id, location, x, y, err)
			}
		}
		if fallRows(t, s, "SELECT count(*) FROM homestead_members WHERE homestead_id='house'") != 1 || fallRows(t, s, "SELECT count(*) FROM homestead_items") != 7 || fallRows(t, s, "SELECT count(*) FROM wild_epochs WHERE kind='wick'") != 0 || fallRows(t, s, "SELECT count(*) FROM wild_epochs WHERE id='still-old'") != 1 {
			t.Fatal("lost identity or stale wick")
		}
		// Two displaced plants refund a seed each; the out-of-bounds clear is archived.
		if fallRows(t, s, "SELECT qty FROM item_stacks WHERE location='storage' AND owner='house' AND item_def='wild-thyme'") != 2 || fallRows(t, s, "SELECT count(*) FROM item_stacks WHERE owner='east-house'") != 0 {
			t.Fatal("wrong seed refund")
		}
		if fallRows(t, s, "SELECT count(*) FROM homestead_land_archive") != 3 || fallRows(t, s, "SELECT count(*) FROM homestead_land_archive WHERE kind='homestead_plants' AND identity IN ('stored-plant','path-plant')") != 2 {
			t.Fatal("displaced land not preserved")
		}
		if fallRows(t, s, "SELECT count(*) FROM homestead_plants WHERE id='east-plant' AND x=16 AND y=12") != 1 || fallRows(t, s, "SELECT count(*) FROM homestead_plants WHERE id='kept-plant' AND x=10 AND y=11") != 1 || fallRows(t, s, "SELECT count(*) FROM homestead_stumps WHERE homestead_id='house' AND x=10 AND y=11 AND felled_at=123") != 1 {
			t.Fatal("kept land did not shift")
		}
		if fallRows(t, s, "SELECT count(*) FROM world_changes WHERE realm='hearthwick' AND kind='fishery' AND json_extract(state,'$.stock')=4") != 1 {
			t.Fatal("fishery reset")
		}
		s.Close()
	}
}

func TestOneTown037StoresBlockedAndUnlitPieces(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ground.sqlite")
	old := newUpgradeFixture(t, path, "036_outdoors.sql", nil)
	_, err := old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('frozen-world','owner','seed',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at) VALUES('owner','Owner','frozen-world',1,1);
 INSERT INTO homesteads(id,world_id,gate,tier,claimed_at) VALUES('h','frozen-world',0,1,1);
 INSERT INTO homestead_members VALUES('owner','h',1);`)
	if err != nil {
		t.Fatal(err)
	}
	ground := generate037("frozen-world", 0)
	start := [][3]int{{12, 7, 7}}
	used := map[[2]int]bool{}
	// A one-bay stable (4×3) that fits on lit, clearable or open ground stays placed.
	barn := [2]int{-1, -1}
	for y := 2; y <= 19 && barn[0] < 0; y++ {
	search:
		for x := 1; x <= 19; x++ {
			for dy := 0; dy < 3; dy++ {
				for dx := 0; dx < 4; dx++ {
					k := ground[(y+dy)*24+x+dx]
					if reserved037(0, x+dx, y+dy) || !lit037(start, x+dx, y+dy) || used[[2]int{x + dx, y + dy}] || k > 3 {
						continue search
					}
				}
			}
			barn = [2]int{x, y}
			break
		}
	}
	if barn[0] < 0 {
		t.Fatal("frozen fixture lacks room for a stable")
	}
	for dy := 0; dy < 3; dy++ {
		for dx := 0; dx < 4; dx++ {
			used[[2]int{barn[0] + dx, barn[1] + dy}] = true
		}
	}
	blocked, dark, cleared := [2]int{-1, -1}, [2]int{-1, -1}, [2]int{-1, -1}
	for y := 2; y <= 21; y++ {
		for x := 1; x <= 22; x++ {
			if reserved037(0, x, y) || used[[2]int{x, y}] {
				continue
			}
			lit := lit037(start, x, y)
			k := ground[y*24+x]
			if lit && (k == 1 || k == 2 || k == 3) {
				if blocked[0] < 0 {
					blocked = [2]int{x, y}
				} else if cleared[0] < 0 {
					cleared = [2]int{x, y}
				}
			}
			if !lit && k == 0 && dark[0] < 0 {
				dark = [2]int{x, y}
			}
		}
	}
	if blocked[0] < 0 || dark[0] < 0 || cleared[0] < 0 {
		t.Fatal("frozen fixture lacks required ground")
	}
	for id, p := range map[string][2]int{"blocked": blocked, "dark": dark, "cleared": cleared} {
		if _, err = old.Exec(`INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES(?,'wooden-stool','placed','h','outdoor',?,?,0)`, id, p[0]+8, p[1]+3); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = old.Exec(`INSERT INTO homestead_cleared(homestead_id,x,y) VALUES('h',?,?)`, cleared[0]+8, cleared[1]+3); err != nil {
		t.Fatal(err)
	}
	for dy := 0; dy < 3; dy++ {
		for dx := 0; dx < 4; dx++ {
			if k := ground[(barn[1]+dy)*24+barn[0]+dx]; k != 0 {
				if _, err = old.Exec(`INSERT INTO homestead_cleared(homestead_id,x,y) VALUES('h',?,?)`, barn[0]+dx+8, barn[1]+dy+3); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	// A multi-bay stable that no longer fits keeps its exact ID and stall rows;
	// at old (26,14) it would sit on the west lot's path to the gate.
	_, err = old.Exec(`INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation,stalls) VALUES('stable','stable','placed','h','outdoor',26,14,0,3),
 ('barn','stable','placed','h','outdoor',?,?,0,1);
 INSERT INTO homestead_stalls(homestead_id,stall,mount_key,owner_id) VALUES('h',3,'Wolf-Shade','owner'),('h',1,'Moss-Pony','owner');`, barn[0]+8, barn[1]+3)
	if err != nil {
		t.Fatal(err)
	}
	old.Close()
	for n := 0; n < 2; n++ {
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		for id, want := range map[string]string{"blocked": "storage", "dark": "storage", "cleared": "placed", "stable": "storage", "barn": "placed"} {
			var got string
			if err = s.DB.QueryRow("SELECT location FROM homestead_items WHERE id=?", id).Scan(&got); err != nil || got != want {
				t.Fatal(id, got, want, err)
			}
		}
		if fallRows(t, s, "SELECT count(*) FROM homestead_items WHERE id='barn' AND x=? AND y=?", barn[0], barn[1]) != 1 {
			t.Fatal("kept stable did not shift")
		}
		if fallRows(t, s, "SELECT count(*) FROM homestead_stalls WHERE homestead_id='h' AND stall=3 AND mount_key='Wolf-Shade'") != 1 || fallRows(t, s, "SELECT count(*) FROM homestead_stalls WHERE homestead_id='h' AND stall=1 AND mount_key='Moss-Pony'") != 1 {
			t.Fatal("lost stabled mount")
		}
		s.Close()
	}
}

// The frozen copies must agree with the runtime at the Hearthwick 2 cutover.
// The generator is checked against an explicit cutover config, so later live
// tuning of homestead.json cannot reach it.
func TestOneTown037FrozenGeometryMatchesCutover(t *testing.T) {
	i := func(v int32) *int32 { return &v }
	cfg := &contentv1.HomeLand{
		Generator: 2, Width: 24, Height: 24,
		Site:       &contentv1.HomeRect{X: i(8), Y: i(3), W: i(8), H: i(6)},
		Gate:       &contentv1.HomeGate{X: i(11), W: i(2)},
		StartLight: &contentv1.HomeStartLight{X: i(12), Y: i(7), Radius: i(7)},
		Trees:      48, Stumps: 6, Boulders: 4, StreamPermille: 350, SlopePermille: 350,
		Sides: map[string]*contentv1.HomeLandSide{
			"west": {Ground: "woods", Trees: 44, Stumps: 6, Boulders: 4},
			"east": {Ground: "meadow", Trees: 14, Stumps: 3, Boulders: 3, Flowers: 24},
		},
	}
	for _, world := range []string{"w", "frozen-world", "anaximander", "x"} {
		for gate := 0; gate < 8; gate++ {
			want := land.GenerateLot(land.Seed(world, gate, cfg), cfg, gate)
			if got := generate037(world, gate); !bytes.Equal(got, want.Tiles) {
				t.Fatalf("%s lot %d: frozen ground differs from land.GenerateLot", world, gate)
			}
		}
	}
	for gate := 0; gate < 2; gate++ {
		for y := 0; y < 24; y++ {
			for x := 0; x < 24; x++ {
				live := !chunks.InsideLot(x, y, gate)
				for _, r := range content.HomeOutdoorReserved(gate) {
					if x >= int(r.GetX()) && x < int(r.GetX()+r.GetW()) && y >= int(r.GetY()) && y < int(r.GetY()+r.GetH()) {
						live = true
					}
				}
				if reserved037(gate, x, y) != live {
					t.Fatalf("lot %d (%d,%d): frozen reserved %v, live %v", gate, x, y, !live, live)
				}
			}
		}
	}
}

// Way-lamps are free fall markers, not item-backed furnishings. Preserve their
// complete records rather than inventing an unrelated inventory refund.
func TestOneTown037ArchivesWickLampsBeforeExpiry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lamps.sqlite")
	old := newUpgradeFixture(t, path, "036_outdoors.sql", nil)
	_, err := old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Alice','w',1,1),('bob','Bob','w',1,1);
 INSERT INTO wild_epochs VALUES('wick','w','wick','seed',3,'t:1:9',1,9),('still','w','still','seed',3,'0',1,NULL);
 INSERT INTO lanterns(id,epoch,world_id,owner_id,x,y,lit_by,at,lit_at) VALUES
 ('fallen','wick','w','alice',-40,99,'bob',12,13),('kept','still','w','bob',1,2,NULL,14,NULL);`)
	if err != nil {
		t.Fatal(err)
	}
	old.Close()
	for pass := 0; pass < 2; pass++ {
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		if fallRows(t, s, `SELECT count(*) FROM one_town_lantern_archive WHERE id='fallen' AND epoch='wick' AND world_id='w' AND owner_id='alice' AND x=-40 AND y=99 AND lit_by='bob' AND at=12 AND lit_at=13`) != 1 || fallRows(t, s, `SELECT count(*) FROM one_town_lantern_archive`) != 1 {
			t.Fatal("lamp recovery record lost or duplicated")
		}
		if fallRows(t, s, `SELECT count(*) FROM lanterns WHERE id='kept' AND epoch='still' AND owner_id='bob'`) != 1 || fallRows(t, s, `SELECT count(*) FROM lanterns WHERE id='fallen'`) != 0 {
			t.Fatal("wrong epoch expired")
		}
		if fallRows(t, s, `SELECT count(*) FROM item_stacks`) != 0 || fallRows(t, s, `SELECT count(*) FROM homestead_items`) != 0 {
			t.Fatal("free lamp minted inventory")
		}
		s.Close()
	}
}
