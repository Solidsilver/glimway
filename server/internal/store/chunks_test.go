package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/chunks/fakegen"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
)

func chunkStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "chunks.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	for _, w := range []string{"world-a", "world-b"} {
		if _, err := s.DB.Exec("INSERT INTO worlds(id,owner_id,seed,created_at) VALUES(?,?,?,0)", w, "owner", "seed-"+w); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func inTx(t *testing.T, s *Store, f func(*sql.Tx)) {
	t.Helper()
	tx, err := s.DB.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	f(tx)
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func countRows(t *testing.T, s *Store, q string, args ...any) int {
	t.Helper()
	var n int
	if err := s.DB.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Epochs by kind (open-map.md 2.3): the still epoch is made with the
// Tangle's nine chunks; a wick epoch's chunks are made the first time each
// is read, only inside the frontier and in the epoch their coordinates call
// for. At the turning the next wick epoch takes over and the ended one goes
// with everything under it; the still epoch stays.
func TestChunksEpochsAndOnDemand(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	now := int64(1795000000)
	g := fakegen.New()
	c := NewChunks(func() time.Time { return time.Unix(now, 0) }, g)
	var still, wick *contract.WildsEpoch
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Current(ctx, tx, "world-a", EpochStill, now); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("current before create: %v", err)
		}
		var err error
		if still, err = c.Create(ctx, tx, "world-a", EpochStill, now); err != nil {
			t.Fatal(err)
		}
		if still.Kind != "still" || still.GeneratorVersion != 3 || still.Season != "0" || still.EndsAt != nil || still.WorldSeed != "seed-world-a" {
			t.Fatalf("still epoch %+v", still)
		}
		if wick, err = c.Create(ctx, tx, "world-a", EpochWick, now); err != nil {
			t.Fatal(err)
		}
		day := content.CalendarAt(content.CalendarRules, now)
		if wick.Kind != "wick" || wick.EndsAt == nil || int64(wick.EndsAt.Value) != day.NextTurning || int64(wick.StartsAt) != day.StartsAt {
			t.Fatalf("wick epoch %+v", wick)
		}
		// A second Create of the same season answers the one stored.
		again, err := c.Create(ctx, tx, "world-a", EpochWick, now)
		if err != nil || again.Id != wick.Id {
			t.Fatalf("second create: %v %v", again, err)
		}
		if _, err = c.Create(ctx, tx, "world-a", "outer-1", now); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("a region kind: %v", err)
		}
	})
	if n := countRows(t, s, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=?", still.Id); n != 9 {
		t.Fatalf("the still epoch stored %d chunks", n)
	}
	if n := countRows(t, s, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=?", wick.Id); n != 0 {
		t.Fatalf("the wick epoch stored %d chunks up front", n)
	}
	inTx(t, s, func(tx *sql.Tx) {
		if e, err := c.Current(ctx, tx, "world-a", EpochWick, now); err != nil || e.Id != wick.Id {
			t.Fatalf("current %v %v", e, err)
		}
		m, err := c.Chunk(ctx, tx, "world-a", wick.Id, 0, -4, -8)
		if err != nil || m.Cx != -4 || m.Cy != -8 || m.EpochId != wick.Id || chunks.Validate(m) != nil {
			t.Fatalf("on-demand corner chunk: %v", err)
		}
		// Cached reads hand out copies.
		m.Look = "changed"
		if again, _ := c.Chunk(ctx, tx, "world-a", wick.Id, 0, -4, -8); again.Look == "changed" {
			t.Fatal("cache shared a chunk")
		}
		for _, bad := range []struct {
			world, epoch  string
			layer, cx, cy int32
		}{
			{"world-b", wick.Id, 0, -4, -8}, // another world's epoch
			{"world-a", wick.Id, 0, 5, 0},   // outside the frontier
			{"world-a", wick.Id, 0, 0, 1},   // south of it
			{"world-a", wick.Id, 0, 0, -1},  // a Tangle chunk under the wick
			{"world-a", still.Id, 0, 0, -4}, // a Whitequiet chunk under the still epoch
			{"world-a", wick.Id, 1, 2, -6},  // another layer
			{"world-a", "nope", 0, 2, -6},
		} {
			if _, err := c.Chunk(ctx, tx, bad.world, bad.epoch, bad.layer, bad.cx, bad.cy); !errors.Is(err, sql.ErrNoRows) {
				t.Fatalf("%+v: %v", bad, err)
			}
		}
	})
	if n := countRows(t, s, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=?", wick.Id); n != 1 || g.Made() != 10 {
		t.Fatalf("made %d, stored %d", g.Made(), n)
	}
	// Rows under the wick, to go with it at the turning.
	if _, err := s.DB.Exec(`INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at) VALUES('p','P','world-a',1,1);
INSERT INTO entity_state(epoch,entity_id) VALUES(?,'camp:-4:-8:0'),(?,'camp:0:-1:0');
INSERT INTO personal_claims VALUES(?,'chest:-4:-8:2','p',1);
INSERT INTO discoveries VALUES(?,'place:-1:-2','ruin','p',1);
INSERT INTO lanterns(id,epoch,world_id,owner_id,x,y,at) VALUES('l',?,'world-a','p',1,1,1);
INSERT INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at) VALUES('world-a','hearthwick',0,'-4:-8',?,'ground','ground','{}',1),('world-a','hearthwick',0,'0:-1',?,'ground','ground','{}',1)`,
		wick.Id, still.Id, wick.Id, wick.Id, wick.Id, wick.Id, still.Id); err != nil {
		t.Fatal(err)
	}
	// At the turning the ended wick stays (late claims hear epoch-ended)
	// until a later wick begins.
	turning := content.CalendarAt(content.CalendarRules, now).NextTurning
	c.Now = func() time.Time { return time.Unix(turning, 0) }
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Create(ctx, tx, "world-a", EpochWick, turning); err != nil {
			t.Fatal(err)
		}
	})
	if countRows(t, s, "SELECT count(*) FROM wild_epochs WHERE id=?", wick.Id) != 1 || countRows(t, s, "SELECT count(*) FROM entity_state WHERE epoch=?", wick.Id) != 1 {
		t.Fatal("the just-ended wick went at the turning")
	}
	later := turning + 86400*40
	c.Now = func() time.Time { return time.Unix(later, 0) }
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Chunk(ctx, tx, "world-a", wick.Id, 0, -4, -8); !errors.Is(err, chunks.ErrEpochEnded) {
			t.Fatalf("ended chunk read: %v", err)
		}
		if cur, err := c.Current(ctx, tx, "world-a", EpochWick, later); !errors.Is(err, chunks.ErrEpochEnded) {
			t.Fatalf("ended current: %v %v", cur, err)
		}
		next, err := c.Create(ctx, tx, "world-a", EpochWick, later)
		if err != nil || next.Id == wick.Id || next.Season == wick.Season {
			t.Fatalf("next wick: %v", err)
		}
		if cur, err := c.Current(ctx, tx, "world-a", EpochStill, later); err != nil || cur.Id != still.Id {
			t.Fatalf("the Tangle ended: %v", err)
		}
	})
	for _, table := range []string{"wilds_chunks WHERE epoch_id", "entity_state WHERE epoch", "personal_claims WHERE epoch", "discoveries WHERE epoch", "lanterns WHERE epoch", "world_changes WHERE epoch", "wild_epochs WHERE id"} {
		if n := countRows(t, s, "SELECT count(*) FROM "+table+"=?", wick.Id); n != 0 {
			t.Fatalf("%s: %d rows of the ended wick left", table, n)
		}
	}
	if countRows(t, s, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=?", still.Id) != 9 || countRows(t, s, "SELECT count(*) FROM entity_state WHERE epoch=?", still.Id) != 1 || countRows(t, s, "SELECT count(*) FROM world_changes WHERE epoch=?", still.Id) != 1 {
		t.Fatal("the still epoch's rows went at the turning")
	}
}

// Seams (open-map.md 2.3): a wick chunk beside the Tangle is made with its
// kept neighbours, read from the still epoch (made first when absent), and
// copies their edges; a chunk with no kept neighbour gets none.
func TestChunksSeamsPassKeptNeighbours(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	g := fakegen.New()
	c := NewChunks(nil, g)
	now := time.Now().Unix()
	inTx(t, s, func(tx *sql.Tx) {
		wick, err := c.Create(ctx, tx, "world-a", EpochWick, now)
		if err != nil {
			t.Fatal(err)
		}
		east, err := c.Chunk(ctx, tx, "world-a", wick.Id, 0, 2, -1)
		if err != nil {
			t.Fatal(err)
		}
		still, err := c.Current(ctx, tx, "world-a", EpochStill, now)
		if err != nil {
			t.Fatal("the still epoch was not made for the seam:", err)
		}
		call := g.Calls[len(g.Calls)-1]
		if call.CX != 2 || call.CY != -1 || len(call.Kept) != 3 {
			t.Fatalf("kept neighbours %+v", call)
		}
		for _, k := range call.Kept {
			if k.CX != 1 || k.Chunk.EpochId != still.Id || k.Chunk.Cy != int32(k.CY) {
				t.Fatalf("kept %+v", k)
			}
		}
		tangle, err := c.Chunk(ctx, tx, "world-a", still.Id, 0, 1, -1)
		if err != nil {
			t.Fatal(err)
		}
		solid := func(m *contract.WildsChunk, x, y int) bool { i := y*24 + x; return m.Solid[i/8]&(1<<(i%8)) != 0 }
		for y := range 24 {
			if solid(east, 0, y) != solid(tangle, 23, y) || solid(east, 1, y) != solid(tangle, 22, y) {
				t.Fatalf("seam row %d differs", y)
			}
		}
		if _, err = c.Chunk(ctx, tx, "world-a", wick.Id, 0, 3, -7); err != nil {
			t.Fatal(err)
		}
		if call := g.Calls[len(g.Calls)-1]; len(call.Kept) != 0 {
			t.Fatalf("kept beside nothing kept: %+v", call)
		}
		// The Whitequiet's south middle chunk meets the Tangle's north row.
		if _, err = c.Chunk(ctx, tx, "world-a", wick.Id, 0, 0, -3); err != nil {
			t.Fatal(err)
		}
		if call := g.Calls[len(g.Calls)-1]; len(call.Kept) != 3 {
			t.Fatalf("Whitequiet seam %+v", call)
		}
	})
}

// Two racing first reads store one blob: the read that loses the unique key
// answers the blob that won.
func TestChunksOnDemandRaceStoresOneBlob(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	g := fakegen.New()
	c := NewChunks(nil, g)
	now := time.Now().Unix()
	inTx(t, s, func(tx *sql.Tx) {
		wick, err := c.Create(ctx, tx, "world-a", EpochWick, now)
		if err != nil {
			t.Fatal(err)
		}
		// While this read makes the chunk, another stores it first.
		g.Hook = func(e *contract.WildsEpoch, cx, cy int32) {
			g.Hook = nil
			won, err := fakegen.New().Chunk(e, cx, cy, nil)
			if err != nil {
				t.Fatal(err)
			}
			won.Mark = "won"
			blob, _ := proto.Marshal(won)
			if _, err = tx.Exec("INSERT INTO wilds_chunks(epoch_id,layer,cx,cy,generator_version,blob,created_at) VALUES(?,0,?,?,3,?,0)", e.Id, cx, cy, blob); err != nil {
				t.Fatal(err)
			}
		}
		m, err := c.Chunk(ctx, tx, "world-a", wick.Id, 0, 3, -4)
		if err != nil {
			t.Fatal(err)
		}
		if m.Mark != "won" {
			t.Fatal("the losing read answered its own blob")
		}
		var n int
		if err = tx.QueryRow("SELECT count(*) FROM wilds_chunks WHERE epoch_id=? AND cx=3 AND cy=-4", wick.Id).Scan(&n); err != nil || n != 1 {
			t.Fatalf("%d blobs", n)
		}
	})
}

// An epoch of another generator version is invisible and gives way; with no
// generator nothing is made.
func TestChunksIgnoreOtherGenerators(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	c := NewChunks(nil, fakegen.New())
	if _, err := s.DB.Exec("INSERT INTO wild_epochs VALUES('old','world-a','still','seed',2,'0',0,NULL)"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec("INSERT INTO entity_state(epoch,entity_id) VALUES('old','camp:0:-1:0')"); err != nil {
		t.Fatal(err)
	}
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Current(ctx, tx, "world-a", EpochStill, 10); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("a v2 epoch counted as current: %v", err)
		}
		if _, err := c.Chunk(ctx, tx, "world-a", "old", 0, 0, -1); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("a v2 chunk read: %v", err)
		}
		if _, err := c.Create(ctx, tx, "world-a", EpochStill, 10); err != nil {
			t.Fatal(err)
		}
	})
	if n := countRows(t, s, "SELECT (SELECT count(*) FROM wild_epochs WHERE id='old')+(SELECT count(*) FROM entity_state WHERE epoch='old')"); n != 0 {
		t.Fatalf("stale epoch rows left: %d", n)
	}
	none := NewChunks(nil, nil)
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := none.Create(ctx, tx, "world-b", EpochWick, 10); !errors.Is(err, ErrGeneratorUnavailable) {
			t.Fatalf("no generator: %v", err)
		}
	})
}

func TestChunkCacheEvicts(t *testing.T) {
	c := NewChunks(nil, nil)
	for i := range ChunkCacheSize + 10 {
		c.put(chunkKey{epoch: "e", cx: int32(i)}, nil)
	}
	if c.order.Len() != ChunkCacheSize || len(c.byKey) != ChunkCacheSize {
		t.Fatalf("cache holds %d", c.order.Len())
	}
	if _, ok := c.byKey[chunkKey{epoch: "e", cx: 0}]; ok {
		t.Fatal("oldest entry kept")
	}
}

// Review 1, finding 1: a chunk made in a transaction that rolls back (a
// refused operation, a savepoint) is not trusted from the shared cache; the
// next read makes it again and stores it for good. Two stores with their own
// caches agree on what is stored.
func TestChunksRolledBackMakingIsNotCached(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	g := fakegen.New()
	c := NewChunks(nil, g)
	now := time.Now().Unix()
	var wick *contract.WildsEpoch
	inTx(t, s, func(tx *sql.Tx) {
		var err error
		if wick, err = c.Create(ctx, tx, "world-a", EpochWick, now); err != nil {
			t.Fatal(err)
		}
	})
	stored := func() int {
		return countRows(t, s, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=? AND cx=3 AND cy=-4", wick.Id)
	}
	// A whole transaction rolled back.
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.Chunk(ctx, tx, "world-a", wick.Id, 0, 3, -4); err != nil {
		t.Fatal(err)
	}
	tx.Rollback()
	// A savepoint rolled back inside a transaction that commits.
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := tx.Exec("SAVEPOINT gameplay"); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Chunk(ctx, tx, "world-a", wick.Id, 0, 3, -4); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec("ROLLBACK TO gameplay"); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Chunk(ctx, tx, "world-a", wick.Id, 0, 3, -4); err != nil {
			t.Fatal(err)
		}
	})
	if n := stored(); n != 1 {
		t.Fatalf("after the savepoint read: %d rows", n)
	}
	made := g.Made()
	// Another store (another server process) reads the stored blob; its
	// rolled-back making doesn't unmake anything.
	other := NewChunks(nil, g)
	inTx(t, s, func(tx *sql.Tx) {
		m, err := other.Chunk(ctx, tx, "world-a", wick.Id, 0, 3, -4)
		if err != nil || m.Cx != 3 || g.Made() != made {
			t.Fatal("the other store didn't read the stored chunk", err)
		}
	})
	tx, _ = s.DB.BeginTx(ctx, nil)
	if _, err = other.Chunk(ctx, tx, "world-a", wick.Id, 0, 2, -6); err != nil {
		t.Fatal(err)
	}
	tx.Rollback()
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Chunk(ctx, tx, "world-a", wick.Id, 0, 2, -6); err != nil {
			t.Fatal(err)
		}
		if _, err := other.Chunk(ctx, tx, "world-a", wick.Id, 0, 2, -6); err != nil {
			t.Fatal(err)
		}
	})
	if n := countRows(t, s, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=? AND cx=2 AND cy=-6", wick.Id); n != 1 {
		t.Fatalf("%d rows after the other store's rollback", n)
	}
}

// Review 1, finding 2: reaping an old wick deletes only the Wilds' world
// changes; another realm's row, or another world's, sharing the epoch id
// stays.
func TestStaleEpochsKeepOtherRealmsChanges(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	c := NewChunks(nil, fakegen.New())
	if _, err := s.DB.Exec(`INSERT INTO wild_epochs VALUES('old-wick','world-a','wick','seed',3,'t:1:2',1,2);
INSERT INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at) VALUES
 ('world-a','hearthwick',0,'0:-4','old-wick','ground','ground','{}',1),
 ('world-a','other-realm',0,'0:0','old-wick','thing','other','{}',1),
 ('world-b','hearthwick',0,'0:-4','old-wick','ground','ground','{}',1)`); err != nil {
		t.Fatal(err)
	}
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Create(ctx, tx, "world-a", EpochWick, time.Now().Unix()); err != nil {
			t.Fatal(err)
		}
	})
	if countRows(t, s, "SELECT count(*) FROM wild_epochs WHERE id='old-wick'") != 0 || countRows(t, s, "SELECT count(*) FROM world_changes WHERE world_id='world-a' AND realm='hearthwick'") != 0 {
		t.Fatal("the old wick's Wilds rows stayed")
	}
	if countRows(t, s, "SELECT count(*) FROM world_changes WHERE realm='other-realm'") != 1 || countRows(t, s, "SELECT count(*) FROM world_changes WHERE world_id='world-b'") != 1 {
		t.Fatal("another realm's or world's change went")
	}
}
