package store

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"glimway/content"
)

// 0.9's migration 035 (shared-fights.md 1.3, 1.9) only adds tables: a
// database as 0.8 left it keeps its camp rows, chest claims and progress,
// and a 0.8 claim's cleared camp is no fall.
func TestFightFalls035UpgradeKeepsProgress(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.sqlite")
	old := newUpgradeFixture(t, path, "034_open_map.sql", nil)
	seed := `INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES('alice','Alice','w',1,1,7),('bob','Bob','w',1,1,7);
INSERT INTO wild_epochs VALUES('e','w','still','seed',3,'0',1,NULL);
INSERT INTO entity_state(epoch,entity_id,cycle,state,available_at,by_id,at) VALUES('e','camp:1:1:0',3,'cleared',900,'alice',100),('e','node:1:1:1',1,'harvested',50,'bob',10);
INSERT INTO personal_claims VALUES('e','chest:1:1:2','alice',1);`
	if _, err := old.Exec(seed); err != nil {
		t.Fatal(err)
	}
	old.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if n := fallRows(t, s, "SELECT count(*) FROM entity_state")*10 + fallRows(t, s, "SELECT count(*) FROM personal_claims"); n != 21 {
		t.Fatal("0.8 rows changed", n)
	}
	k := FallKey{World: "w", Realm: "wilds", CX: 1, CY: 1, Epoch: "e", Entity: "camp:1:1:0", Cycle: 3}
	if _, ok, err := ReadFall(ctx, s.DB, k); err != nil || ok {
		t.Fatal("a 0.8 cleared camp read as a fall", ok, err)
	}
	// A fall with its witnesses, the camp's row moved forward by it.
	ok, err := s.InsertFall(ctx, FallRecord{Key: FallKey{World: "w", Realm: "wilds", CX: 1, CY: 1, Epoch: "e", Entity: "camp:1:1:0", Cycle: 4}, FellAt: 2_000_500, Witnesses: []string{"alice", "bob"}})
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if fallRows(t, s, "SELECT cycle FROM entity_state WHERE entity_id='camp:1:1:0'") != 4 || fallRows(t, s, "SELECT available_at FROM entity_state WHERE entity_id='camp:1:1:0'") != 2000+int(content.WildsRules.GetTimers().GetCampRespawnSeconds()) {
		t.Fatal("the fall did not take the camp's row")
	}
	// An epoch's falls go with it.
	if _, err = s.DB.Exec("DELETE FROM wild_epochs WHERE id='e'"); err != nil {
		t.Fatal(err)
	}
	if fallRows(t, s, "SELECT count(*) FROM fight_falls")+fallRows(t, s, "SELECT count(*) FROM fight_fall_witnesses") != 0 {
		t.Fatal("falls outlived their epoch")
	}
}

func fallRows(t *testing.T, s *Store, q string, args ...any) int {
	t.Helper()
	var n int
	if err := s.DB.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatal(q, err)
	}
	return n
}

func fallFixture(t *testing.T) (*Store, FallKey) {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "falls.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if _, err = s.DB.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES('alice','Alice','w',1,1,1),('bob','Bob','w',1,1,1),('carol','Carol','w',1,1,1);
INSERT INTO wild_epochs VALUES('e','w','wick','seed',3,'t:1:2',1,NULL);`); err != nil {
		t.Fatal(err)
	}
	return s, FallKey{World: "w", Realm: "wilds", Layer: 0, CX: -2, CY: 3, Epoch: "e", Entity: "camp:-2:3:0", Cycle: 2}
}

func TestInsertFallIsIdempotentExactAndMonotonic(t *testing.T) {
	s, k := fallFixture(t)
	ctx := context.Background()
	respawn := int(content.WildsRules.GetTimers().GetCampRespawnSeconds())
	if ok, err := s.InsertFall(ctx, FallRecord{Key: k, FellAt: 10_999, Witnesses: []string{"bob", "ghost"}}); err != nil || !ok {
		t.Fatal(ok, err)
	}
	// Again, later, with one more witness: the first fell_at and timer stay,
	// witnesses merge, an account with no player row is left out.
	if ok, err := s.InsertFall(ctx, FallRecord{Key: k, FellAt: 50_000, Witnesses: []string{"alice", "bob"}}); err != nil || !ok {
		t.Fatal(ok, err)
	}
	f, ok, err := ReadFall(ctx, s.DB, k)
	if err != nil || !ok || f.FellAt != 10_999 || !slices.Equal(f.Witnesses, []string{"alice", "bob"}) || !f.Witnessed("alice") || f.Witnessed("carol") {
		t.Fatalf("%+v %v %v", f, ok, err)
	}
	if fallRows(t, s, "SELECT count(*) FROM entity_state WHERE epoch='e' AND entity_id=? AND cycle=2 AND state='cleared' AND by_id IS NULL AND at=10 AND available_at=?", k.Entity, 10+respawn) != 1 {
		t.Fatal("camp row")
	}
	// Exact: the key's every part counts, no other cycle or room answers.
	for _, other := range []FallKey{
		{World: k.World, Realm: k.Realm, CX: k.CX, CY: k.CY, Epoch: k.Epoch, Entity: k.Entity, Cycle: 1},
		{World: k.World, Realm: k.Realm, CX: k.CX, CY: k.CY, Epoch: k.Epoch, Entity: k.Entity, Cycle: 3},
		{World: k.World, Realm: k.Realm, Layer: 1, CX: k.CX, CY: k.CY, Epoch: k.Epoch, Entity: k.Entity, Cycle: 2},
		{World: "w2", Realm: k.Realm, CX: k.CX, CY: k.CY, Epoch: k.Epoch, Entity: k.Entity, Cycle: 2},
		{World: k.World, Realm: k.Realm, CX: k.CX, CY: k.CY, Epoch: k.Epoch, Entity: "camp:-2:3:1", Cycle: 2},
	} {
		if _, ok, err := ReadFall(ctx, s.DB, other); err != nil || ok {
			t.Fatal("inexact read", other)
		}
	}
	// A late copy of an older cycle's fall never moves the row back.
	older := k
	older.Cycle = 1
	if _, err := s.InsertFall(ctx, FallRecord{Key: older, FellAt: 90_000}); err != nil {
		t.Fatal(err)
	}
	if fallRows(t, s, "SELECT cycle FROM entity_state WHERE entity_id=?", k.Entity) != 2 {
		t.Fatal("the row went back a cycle")
	}
	// The next cycle's fall moves it on, timer from that fall.
	next := k
	next.Cycle = 3
	if _, err := s.InsertFall(ctx, FallRecord{Key: next, FellAt: 200_000, Witnesses: []string{"carol"}}); err != nil {
		t.Fatal(err)
	}
	if fallRows(t, s, "SELECT count(*) FROM entity_state WHERE entity_id=? AND cycle=3 AND available_at=?", k.Entity, 200+respawn) != 1 {
		t.Fatal("next cycle")
	}
	// A fall for an epoch that is gone is dropped, not retried forever.
	gone := k
	gone.Epoch = "gone"
	if ok, err := s.InsertFall(ctx, FallRecord{Key: gone, FellAt: 1}); err != nil || ok {
		t.Fatal("gone epoch", ok, err)
	}
}

func TestCampClaimsArePerCycle(t *testing.T) {
	s, k := fallFixture(t)
	ctx := context.Background()
	if err := InsertCampClaim(ctx, s.DB, k.Epoch, k.Entity, 2, "alice", 5); err != nil {
		t.Fatal(err)
	}
	if err := InsertCampClaim(ctx, s.DB, k.Epoch, k.Entity, 2, "alice", 6); err == nil {
		t.Fatal("claimed one cycle twice")
	}
	if err := InsertCampClaim(ctx, s.DB, k.Epoch, k.Entity, 3, "alice", 7); err != nil {
		t.Fatal("the next cycle", err)
	}
	for _, c := range []struct {
		cycle   int64
		account string
		want    bool
	}{{2, "alice", true}, {3, "alice", true}, {4, "alice", false}, {2, "bob", false}} {
		if got, err := CampClaimed(ctx, s.DB, k.Epoch, k.Entity, c.cycle, c.account); err != nil || got != c.want {
			t.Fatal(c, got, err)
		}
	}
}
