package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks"
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

func TestChunksCreateCurrentRead(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	now := int64(1795000000)
	c := NewChunks(func() time.Time { return time.Unix(now, 0) })
	var epoch, outer string
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Current(ctx, tx, "world-a", "inner-1", now); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("current before create: %v", err)
		}
		e, err := c.Create(ctx, tx, "world-a", "inner-1", now)
		if err != nil {
			t.Fatal(err)
		}
		if e.GeneratorVersion != 2 || e.Season != "0" || e.EndsAt != nil || e.WorldSeed != "seed-world-a" {
			t.Fatalf("inner epoch %+v", e)
		}
		epoch = e.Id
		o, err := c.Create(ctx, tx, "world-a", "outer-1", now)
		if err != nil {
			t.Fatal(err)
		}
		day := content.CalendarAt(content.CalendarRules, now)
		if o.EndsAt == nil || int64(o.EndsAt.Value) != day.NextTurning || int64(o.StartsAt) != day.StartsAt {
			t.Fatalf("outer epoch %+v", o)
		}
		outer = o.Id
	})
	var n int
	if err := s.DB.QueryRow("SELECT count(*) FROM wilds_chunks WHERE epoch_id=? AND generator_version=2", epoch).Scan(&n); err != nil || n != 9 {
		t.Fatalf("stored %d chunks: %v", n, err)
	}
	inTx(t, s, func(tx *sql.Tx) {
		e, err := c.Current(ctx, tx, "world-a", "inner-1", now)
		if err != nil || e.Id != epoch {
			t.Fatalf("current %v %v", e, err)
		}
		for cy := range int32(3) {
			for cx := range int32(3) {
				m, err := c.Chunk(ctx, tx, "world-a", epoch, 0, cx, cy)
				if err != nil {
					t.Fatal(err)
				}
				if m.EpochId != epoch || m.Cx != cx || m.Cy != cy || chunks.Validate(m) != nil {
					t.Fatalf("chunk %d,%d identity", cx, cy)
				}
				// Cached reads hand out copies.
				m.Region = "changed"
				again, _ := c.Chunk(ctx, tx, "world-a", epoch, 0, cx, cy)
				if again.Region != "inner-1" {
					t.Fatal("cache shared a chunk")
				}
			}
		}
		if _, err := c.Chunk(ctx, tx, "world-b", epoch, 0, 1, 1); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("another world read a chunk: %v", err)
		}
		if _, err := c.Chunk(ctx, tx, "world-a", epoch, 0, 3, 1); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("chunk outside the grid: %v", err)
		}
		if _, err := c.Chunk(ctx, tx, "world-a", "nope", 0, 1, 1); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("unknown epoch: %v", err)
		}
	})
	// The Whitequiet turns: its epoch ends, reads and Current say so.
	later := now + 86400*40
	c.Now = func() time.Time { return time.Unix(later, 0) }
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Chunk(ctx, tx, "world-a", outer, 0, 1, 1); !errors.Is(err, chunks.ErrEpochEnded) {
			t.Fatalf("ended chunk read: %v", err)
		}
		if _, err := c.Current(ctx, tx, "world-a", "outer-1", later); !errors.Is(err, chunks.ErrEpochEnded) {
			t.Fatalf("ended current: %v", err)
		}
		next, err := c.Create(ctx, tx, "world-a", "outer-1", later)
		if err != nil || next.Id == outer {
			t.Fatalf("next wick: %v", err)
		}
		if cur, err := c.Current(ctx, tx, "world-a", "outer-1", later); err != nil || cur.Id != next.Id {
			t.Fatalf("current after turning: %v", err)
		}
		if _, err := c.Current(ctx, tx, "world-a", "inner-1", later); err != nil {
			t.Fatalf("the Tangle ended: %v", err)
		}
	})
}

// TestChunksTangleIsPermanent: two Tangle epochs made a wick apart, in two
// worlds with the same seed, get the same fixed season and byte-identical
// chunks; the Whitequiet made at those two moments gets two seasons and
// different chunks.
func TestChunksTangleIsPermanent(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	if _, err := s.DB.Exec("INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('world-twin','owner','seed-world-a',0)"); err != nil {
		t.Fatal(err)
	}
	early, late := int64(1795000000), int64(1795000000+86400*40)
	c := NewChunks(nil)
	made := map[string]*contract.WildsEpoch{}
	inTx(t, s, func(tx *sql.Tx) {
		for _, m := range []struct {
			key, world, region string
			now                int64
		}{{"inner-early", "world-a", "inner-1", early}, {"inner-late", "world-twin", "inner-1", late}, {"outer-early", "world-a", "outer-1", early}, {"outer-late", "world-twin", "outer-1", late}} {
			e, err := c.Create(ctx, tx, m.world, m.region, m.now)
			if err != nil {
				t.Fatal(err)
			}
			made[m.key] = e
		}
	})
	if made["inner-early"].Season != "0" || made["inner-late"].Season != "0" {
		t.Fatalf("Tangle seasons %q and %q", made["inner-early"].Season, made["inner-late"].Season)
	}
	if made["outer-early"].Season == made["outer-late"].Season {
		t.Fatal("the Whitequiet kept its season across a wick")
	}
	// The stored chunks, with the epoch id (the one field that names the row) cleared.
	chunk := func(epoch string, cx, cy int) []byte {
		var blob []byte
		if err := s.DB.QueryRow("SELECT blob FROM wilds_chunks WHERE epoch_id=? AND cx=? AND cy=?", epoch, cx, cy).Scan(&blob); err != nil {
			t.Fatal(err)
		}
		m := &contract.WildsChunk{}
		if err := proto.Unmarshal(blob, m); err != nil {
			t.Fatal(err)
		}
		m.EpochId = ""
		b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(m)
		return b
	}
	for cy := range 3 {
		for cx := range 3 {
			if !bytes.Equal(chunk(made["inner-early"].Id, cx, cy), chunk(made["inner-late"].Id, cx, cy)) {
				t.Fatalf("Tangle chunk %d,%d changed across a wick", cx, cy)
			}
		}
	}
	if bytes.Equal(chunk(made["outer-early"].Id, 1, 1), chunk(made["outer-late"].Id, 1, 1)) {
		t.Fatal("the Whitequiet's chunks did not turn")
	}
}

// A v1 epoch left on a development branch is invisible and gives way.
func TestChunksIgnoreOtherGenerators(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	c := NewChunks(nil)
	if _, err := s.DB.Exec("INSERT INTO region_epochs VALUES('old','world-a','inner-1','seed',1,'0',0,NULL)"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec("INSERT INTO entity_state(epoch,entity_id) VALUES('old','camp:1:1:0')"); err != nil {
		t.Fatal(err)
	}
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Current(ctx, tx, "world-a", "inner-1", 10); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("a v1 epoch counted as current: %v", err)
		}
		if _, err := c.Chunk(ctx, tx, "world-a", "old", 0, 1, 1); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("a v1 chunk read: %v", err)
		}
		if _, err := c.Create(ctx, tx, "world-a", "inner-1", 10); err != nil {
			t.Fatal(err)
		}
	})
	var n int
	if err := s.DB.QueryRow("SELECT (SELECT count(*) FROM region_epochs WHERE id='old')+(SELECT count(*) FROM entity_state WHERE epoch='old')").Scan(&n); err != nil || n != 0 {
		t.Fatalf("stale epoch rows left: %d %v", n, err)
	}
	c.GeneratorVersion = 3
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Create(ctx, tx, "world-a", "outer-1", 10); !errors.Is(err, ErrGeneratorUnavailable) {
			t.Fatalf("unknown generator: %v", err)
		}
	})
}

func TestChunkCacheEvicts(t *testing.T) {
	c := NewChunks(nil)
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
