package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// 012 and 013 move today's goods into the item model without loss: pack
// materials and items, both chests, and parcels in transit (which keep
// returning to their senders correctly afterwards).
func TestItemsMigrationMovesGoodsAndParcels(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pre-items.sqlite")
	old := newUpgradeFixture(t, path, "011_homestead_departures.sql", nil)
	var err error
	if _, err = old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',0);
 INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at,rev) VALUES('alice','Keeper','w',1,100,4),('bob','Bo','w',1,100,2);
 INSERT INTO progress VALUES('alice',1,4,'{}',1),('bob',1,2,'{}',1);
 INSERT INTO homesteads(id,world_id,gate,tier,claimed_at) VALUES('h1','w',0,2,1);
 INSERT INTO materials VALUES('alice','timber',40),('alice','stone',0);
 INSERT INTO inventory VALUES('alice','lamp-wick',2);
 INSERT INTO home_storage VALUES('h1','material','fiber',6);
 INSERT INTO personal_storage VALUES('alice','item','beeswax-candle',1);
 INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,sent_at) VALUES('m1','w','alice','bob','material','amber',3,50);`); err != nil {
		t.Fatal(err)
	}
	if err = old.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	want := map[string]int{"pack/alice/timber": 40, "pack/alice/lamp-wick": 2, "storage/h1/fiber": 6, "personal/alice/beeswax-candle": 1}
	rows, err := s.DB.Query("SELECT location||'/'||owner||'/'||item_def,qty,maker_id FROM item_stacks")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for rows.Next() {
		var k, maker string
		var n int
		if err = rows.Scan(&k, &n, &maker); err != nil || maker != "" {
			t.Fatal("row", err, maker)
		}
		got[k] = n
	}
	rows.Close()
	if len(got) != len(want) {
		t.Fatal("stacks", got)
	}
	for k, n := range want {
		if got[k] != n {
			t.Fatal("stack", k, got[k])
		}
	}
	var makers string
	if err = s.DB.QueryRow("SELECT makers FROM mail WHERE id='m1'").Scan(&makers); err != nil || makers != `[{"maker":"","qty":3}]` {
		t.Fatal("parcel makers", makers, err)
	}
	ctx := context.Background()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if ok, err := ReturnMail(ctx, tx, "m1", "recalled", 60, false); err != nil || !ok {
		t.Fatal("return", err)
	}
	var n int
	if err = tx.QueryRow("SELECT qty FROM item_stacks WHERE location='pack' AND owner='alice' AND item_def='amber'").Scan(&n); err != nil || n != 3 {
		t.Fatal("returned amber", n, err)
	}
	if items, err := PackItems(ctx, tx, "alice"); err != nil || len(items) != 1 || items[0] != "lamp-wick" {
		t.Fatal("pack items", items, err)
	}
	if _, err = tx.Exec("INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,sent_at) VALUES('m2','w','alice','bob','instance','bench-axe',1,70)"); err != nil {
		t.Fatal("instance parcels", err)
	}
}

// A pending migration that sorts before the newest applied one would run
// against reshaped tables on an upgraded database: the store refuses to open.
func TestOutOfOrderMigrationIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// As if 012 had landed after a newer migration was already applied here.
	if _, err = s.DB.Exec("DELETE FROM schema_migrations WHERE name='012_items.sql'"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if _, err = Open(path); err == nil || !strings.Contains(err.Error(), "out-of-order migration 012_items.sql after ") {
		t.Fatal("opened with an out-of-order migration", err)
	}
	// Reopening an up-to-date database is untouched by the check.
	fresh := filepath.Join(t.TempDir(), "fresh.sqlite")
	for i := 0; i < 2; i++ {
		f, err := Open(fresh)
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
}
