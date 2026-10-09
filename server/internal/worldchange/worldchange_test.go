package worldchange

import (
	"context"
	"path/filepath"
	"testing"

	"glimway/server/internal/store"
)

func open(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	// The rows' foreign keys are real: a world, and the account that writes.
	for _, world := range []string{"world", "other"} {
		if _, err = s.DB.Exec(`INSERT INTO worlds(id, owner_id, seed, created_at) VALUES(?,?,?,?)`, world, "account", "seed", 1000); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.DB.Exec(`INSERT INTO players(account_id, display_name, world_id, created_at, last_seen_at) VALUES('account','Tam','world',1000,1000)`); err != nil {
		t.Fatal(err)
	}
	return s
}

var pond = Key{
	WorldID: "world", Realm: "village", Layer: 0, Chunk: "", Epoch: "",
	Entity: "water:village:mill-pond",
}

// An absent row is untouched: a pond nobody has fished is full.
func TestGetAbsent(t *testing.T) {
	s := open(t)
	row, err := Get(context.Background(), s.DB, pond, "fishery", 1000)
	if err != nil || row != nil {
		t.Fatal("absent row is not untouched", row, err)
	}
}

// The key is the whole six-tuple: the same entity in another world, realm or
// epoch is another row.
func TestKeyIsPerEntity(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	others := []Key{
		{WorldID: "other", Realm: "village", Entity: pond.Entity},
		{WorldID: "world", Realm: "wilds", Entity: pond.Entity},
		{WorldID: "world", Realm: "village", Epoch: "epoch", Entity: pond.Entity},
		{WorldID: "world", Realm: "village", Entity: "water:village:mill-race"},
	}
	for i, key := range others {
		if err := Put(ctx, s.DB, Row{Key: key, Kind: "fishery", State: []byte(`{"stock":1}`)}, int64(1000+i)); err != nil {
			t.Fatal(err)
		}
	}
	for i, key := range append([]Key{pond}, others...) {
		want := ([]byte)(nil)
		if i > 0 {
			want = []byte(`{"stock":1}`)
		}
		row, err := Get(ctx, s.DB, key, "fishery", 2000)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			if row != nil {
				t.Fatal("the pond's own row appeared")
			}
			continue
		}
		if row == nil || string(row.State) != string(want) || row.Kind != "fishery" {
			t.Fatalf("row %d: %+v", i, row)
		}
	}
}

// Put stores the state and the clock it was written at; a later write
// replaces it (the recovered stock, stored with its time).
func TestPutAndGetRoundTrip(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	end := int64(4000)
	if err := Put(ctx, s.DB, Row{Key: pond, Kind: "fishery", State: []byte(`{"stock":11.5,"reserved":1,"at":1000.5}`), ChangedBy: "account", EndsAt: &end}, 1000); err != nil {
		t.Fatal(err)
	}
	row, err := Get(ctx, s.DB, pond, "fishery", 3999)
	if err != nil || row == nil {
		t.Fatal(row, err)
	}
	if row.WorldID != pond.WorldID || row.Realm != pond.Realm || row.Layer != 0 || row.Chunk != "" || row.Epoch != "" || row.Entity != pond.Entity {
		t.Fatal("key", row.Key)
	}
	if row.Kind != "fishery" || string(row.State) != `{"stock":11.5,"reserved":1,"at":1000.5}` || row.ChangedAt != 1000 || row.ChangedBy != "account" || row.EndsAt == nil || *row.EndsAt != end {
		t.Fatal("row", row)
	}
	if err = Put(ctx, s.DB, Row{Key: pond, Kind: "fishery", State: []byte(`{"stock":12,"reserved":0,"at":2000}`)}, 2000); err != nil {
		t.Fatal(err)
	}
	row, err = Get(ctx, s.DB, pond, "fishery", 2000)
	if err != nil || row == nil || string(row.State) != `{"stock":12,"reserved":0,"at":2000}` || row.ChangedAt != 2000 || row.ChangedBy != "" || row.EndsAt != nil {
		t.Fatal("overwrite", row, err)
	}
}

// An expired row reads as absent — the world is what it would be without it
// — and stays where it lies: nothing reaps on a timer. A row that never ends
// (a curated water) is still there at any clock.
func TestExpiry(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	end := int64(1500)
	turning := Key{WorldID: "world", Realm: "wilds", Chunk: "1:0", Epoch: "epoch", Entity: "node:1:0:0"}
	if err := Put(ctx, s.DB, Row{Key: turning, Kind: "work", State: []byte(`{"done":true}`), EndsAt: &end}, 1000); err != nil {
		t.Fatal(err)
	}
	if err := Put(ctx, s.DB, Row{Key: pond, Kind: "fishery", State: []byte(`{"stock":1}`)}, 1000); err != nil {
		t.Fatal(err)
	}
	for _, at := range []int64{1499, 1500} {
		if at == 1500 {
			if row, err := Get(ctx, s.DB, turning, "work", at); err != nil || row != nil {
				t.Fatal("an expired row was read", row, err)
			}
			continue
		}
		if row, err := Get(ctx, s.DB, turning, "work", at); err != nil || row == nil {
			t.Fatal("a live row went missing", row, err)
		}
	}
	var n int
	if err := s.DB.QueryRow(`SELECT count(*) FROM world_changes WHERE entity=?`, turning.Entity).Scan(&n); err != nil || n != 1 {
		t.Fatal("expiry reaped the row", n, err)
	}
	for _, at := range []int64{1000, 1 << 40} {
		if row, err := Get(ctx, s.DB, pond, "fishery", at); err != nil || row == nil {
			t.Fatal("a row that never ends was read as absent", at, row, err)
		}
	}
}

// A row of another kind at the same key is a caller's bug: its state is
// another message's ProtoJSON, so it errors rather than being read.
func TestGetKindMismatch(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	if err := Put(ctx, s.DB, Row{Key: pond, Kind: "work", State: []byte(`{"done":true}`)}, 1000); err != nil {
		t.Fatal(err)
	}
	if row, err := Get(ctx, s.DB, pond, "fishery", 1000); err == nil || row != nil {
		t.Fatal("a work row was read as a fishery", row, err)
	}
	if row, err := Get(ctx, s.DB, pond, "work", 1000); err != nil || row == nil || row.Kind != "work" {
		t.Fatal("the row's own kind was refused", row, err)
	}
}

// Put works inside the caller's transaction: a rolled-back write leaves
// nothing behind (it is always part of a larger change).
func TestPutInTransaction(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = Put(ctx, tx, Row{Key: pond, Kind: "fishery", State: []byte(`{"stock":3}`)}, 1000); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if row, err := Get(ctx, s.DB, pond, "fishery", 1000); err != nil || row != nil {
		t.Fatal("a rolled-back write landed", row, err)
	}
	tx, err = s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = Put(ctx, tx, Row{Key: pond, Kind: "fishery", State: []byte(`{"stock":3}`)}, 1000); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if row, err := Get(ctx, s.DB, pond, "fishery", 1000); err != nil || row == nil {
		t.Fatal("a committed write is missing", row, err)
	}
}
