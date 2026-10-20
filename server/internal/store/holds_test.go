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
	"glimway/server/internal/wildsgen"
	"glimway/server/internal/worldchange"
	"google.golang.org/protobuf/proto"
)

// turnAfter is a time in the wick after the one holding now.
func turnAfter(now int64) int64 {
	return content.CalendarAt(content.CalendarRules, now).NextTurning + 60
}

func wickNow(t *testing.T, s *Store, c *Chunks, world string, now int64) *contract.WildsEpoch {
	t.Helper()
	var e *contract.WildsEpoch
	inTx(t, s, func(tx *sql.Tx) {
		var err error
		if _, err = chunks.Epoch(context.Background(), tx, c, world, EpochStill, now); err != nil {
			t.Fatal(err)
		}
		if e, err = chunks.Epoch(context.Background(), tx, c, world, EpochWick, now); err != nil {
			t.Fatal(err)
		}
	})
	return e
}

func groundRow(world, epoch string, cx, cy int32) worldchange.Key {
	return worldchange.Key{WorldID: world, Realm: content.WildsRules.GetRealm(), Chunk: chunkName(cx, cy), Epoch: epoch, Entity: "ground"}
}

// A held chunk keeps its layout and ground changes across two turnings,
// served under its pinned epoch, which cleanup keeps (trimmed to the held
// chunk); the new wick's chunks are another layout. Released, it stays
// until the next turning, then turns with the new epoch, and its old epoch
// goes with everything under it.
func TestHoldKeepsChunkAcrossTurnings(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	now := int64(1795000000)
	c := NewChunks(func() time.Time { return time.Unix(now, 0) }, wildsgen.V3{})
	c.Holders = map[string]Holder{"lot-lantern": &testHolder{keep: true}}
	const world = "world-a"
	w1 := wickNow(t, s, c, world, now)
	var layout *contract.WorldChunk
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Chunk(ctx, tx, world, w1.Id, 0, -4, 1); err != nil {
			t.Fatal(err)
		}
		ends := int64(w1.EndsAt.Value)
		if err := worldchange.Put(ctx, tx, worldchange.Row{Key: groundRow(world, w1.Id, -3, 1), Kind: "ground", State: []byte(`{}`), EndsAt: &ends}, now); err != nil {
			t.Fatal(err)
		}
		h, err := c.Hold(ctx, tx, world, -3, 1, "lot-lantern", "1", now)
		if err != nil || h.Epoch != w1.Id || h.Since != now {
			t.Fatalf("hold %+v %v", h, err)
		}
		if layout, err = c.Chunk(ctx, tx, world, w1.Id, 0, -3, 1); err != nil {
			t.Fatal(err)
		}
	})
	for turning := 1; turning <= 2; turning++ {
		now = turnAfter(now)
		w := wickNow(t, s, c, world, now)
		if w.Id == w1.Id {
			t.Fatal("the wick didn't turn")
		}
		inTx(t, s, func(tx *sql.Tx) {
			m, err := c.Chunk(ctx, tx, world, w1.Id, 0, -3, 1)
			if err != nil || !proto.Equal(m, layout) {
				t.Fatalf("turning %d: held chunk %v", turning, err)
			}
			if _, err = c.Chunk(ctx, tx, world, w.Id, 0, -3, 1); !errors.Is(err, sql.ErrNoRows) {
				t.Fatalf("turning %d: a held chunk made in the new wick: %v", turning, err)
			}
			if _, err = c.Chunk(ctx, tx, world, w1.Id, 0, -4, 1); err == nil {
				t.Fatalf("turning %d: an unheld chunk of the pinned epoch is served", turning)
			}
			if r, err := worldchange.Get(ctx, tx, groundRow(world, w1.Id, -3, 1), "ground", now); err != nil || r == nil {
				t.Fatalf("turning %d: the held chunk's ground changes went: %v", turning, err)
			}
			beside, err := c.Chunk(ctx, tx, world, w.Id, 0, -4, 1)
			if err != nil || beside.EpochId != w.Id {
				t.Fatalf("turning %d: the new wick beside the hold: %v", turning, err)
			}
		})
		// The wick that ended at this one's start stays whole a turning longer.
		if n := countRows(t, s, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=?", w1.Id); turning > 1 && n != 1 {
			t.Fatalf("turning %d: the pinned epoch keeps %d chunks", turning, n)
		}
	}
	inTx(t, s, func(tx *sql.Tx) {
		if ok, err := c.Release(ctx, tx, world, -3, 1, "lot-lantern", "2", now); ok || err != nil {
			t.Fatalf("another holder released it: %v %v", ok, err)
		}
		if ok, err := c.Release(ctx, tx, world, -3, 1, "lot-lantern", "1", now); !ok || err != nil {
			t.Fatalf("release: %v %v", ok, err)
		}
		// Released, it stays put for the rest of the wick.
		if m, err := c.Chunk(ctx, tx, world, w1.Id, 0, -3, 1); err != nil || !proto.Equal(m, layout) {
			t.Fatalf("released chunk mid-wick: %v", err)
		}
	})
	now = turnAfter(now)
	w4 := wickNow(t, s, c, world, now)
	inTx(t, s, func(tx *sql.Tx) {
		if h, err := c.HoldAt(ctx, tx, world, -3, 1); h != nil || err != nil {
			t.Fatalf("the released hold outlived the turning: %+v %v", h, err)
		}
		m, err := c.Chunk(ctx, tx, world, w4.Id, 0, -3, 1)
		if err != nil || proto.Equal(m, layout) {
			t.Fatalf("the released chunk didn't turn: %v", err)
		}
	})
	if n := countRows(t, s, "SELECT count(*) FROM wild_epochs WHERE id=?", w1.Id); n != 0 {
		t.Fatal("the released epoch outlived its hold")
	}
	if n := countRows(t, s, "SELECT count(*) FROM world_changes WHERE epoch=?", w1.Id); n != 0 {
		t.Fatal("the released epoch's ground changes outlived it")
	}
}

type testHolder struct {
	keep     bool
	asked    int
	released []Hold
}

func (h *testHolder) Keeps(context.Context, *sql.Tx, Hold, int64) (bool, error) {
	h.asked++
	return h.keep, nil
}

func (h *testHolder) Released(_ context.Context, _ *sql.Tx, held Hold, _ int64) error {
	h.released = append(h.released, held)
	return nil
}

// The turning judges each hold once: the holder kind keeps it or not; one
// that lapses calls the holder's Released (the hook that sends placed pieces
// home) and its chunk turns. A kind with no holder keeps its holds.
func TestTurningJudgesHoldsOnce(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	now := int64(1795000000)
	g := fakegen.New()
	c := NewChunks(func() time.Time { return time.Unix(now, 0) }, g)
	lantern := &testHolder{keep: true}
	c.Holders = map[string]Holder{"lot-lantern": lantern}
	const world = "world-a"
	w1 := wickNow(t, s, c, world, now)
	inTx(t, s, func(tx *sql.Tx) {
		for _, h := range []struct {
			cx, cy int32
			kind   string
		}{{-3, 1, "lot-lantern"}, {-3, 2, "unknown-kind"}} {
			if _, err := c.Hold(ctx, tx, world, h.cx, h.cy, h.kind, "1", now); err != nil {
				t.Fatal(err)
			}
		}
	})
	now = turnAfter(now)
	w2 := wickNow(t, s, c, world, now)
	wickNow(t, s, c, world, now) // the same wick again: no second judgement
	if lantern.asked != 1 || len(lantern.released) != 0 {
		t.Fatalf("asked %d, released %d", lantern.asked, len(lantern.released))
	}
	// A chunk made beside the holds keeps their edges as held neighbours.
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Chunk(ctx, tx, world, w2.Id, 0, -4, 1); err != nil {
			t.Fatal(err)
		}
	})
	last := g.Calls[len(g.Calls)-1]
	held := 0
	for _, k := range last.Kept {
		if k.Held && k.Chunk.EpochId == w1.Id {
			held++
		}
	}
	if held != 2 {
		t.Fatalf("made beside two holds with %d held neighbours (%+v)", held, last.Kept)
	}
	lantern.keep = false
	now = turnAfter(now)
	w3 := wickNow(t, s, c, world, now)
	if lantern.asked != 2 || len(lantern.released) != 1 || lantern.released[0].CX != -3 || lantern.released[0].CY != 1 || lantern.released[0].Epoch != w1.Id {
		t.Fatalf("asked %d, released %+v", lantern.asked, lantern.released)
	}
	inTx(t, s, func(tx *sql.Tx) {
		if m, err := c.Chunk(ctx, tx, world, w3.Id, 0, -3, 1); err != nil || m.EpochId != w3.Id {
			t.Fatalf("the lapsed chunk didn't turn: %v", err)
		}
		if h, err := c.HoldAt(ctx, tx, world, -3, 2); err != nil || h == nil || h.Epoch != w1.Id {
			t.Fatalf("a kind with no holder lost its hold: %+v %v", h, err)
		}
	})
	// A turning on, the other hold still pins the first wick; the second
	// goes.
	now = turnAfter(now)
	wickNow(t, s, c, world, now)
	if n := countRows(t, s, "SELECT count(*) FROM wild_epochs WHERE id=?", w1.Id); n != 1 {
		t.Fatal("cleanup took a pinned epoch")
	}
	if n := countRows(t, s, "SELECT count(*) FROM wild_epochs WHERE id=?", w2.Id); n != 0 {
		t.Fatal("cleanup kept an unpinned ended wick")
	}
}

// A released hold of a kind with no registered Holder has no Released to
// send its placed pieces home, so it keeps: its chunk and ground stay over
// the turning (roadmap rule 3). Once a Holder for the kind is registered,
// the release takes effect at the next turning, through its Released.
func TestReleasedHoldWithNoHolderKeeps(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	now := int64(1795000000)
	c := NewChunks(func() time.Time { return time.Unix(now, 0) }, fakegen.New())
	const world = "world-a"
	w1 := wickNow(t, s, c, world, now)
	inTx(t, s, func(tx *sql.Tx) {
		if _, err := c.Hold(ctx, tx, world, -3, 1, "lot-lantern", "1", now); err != nil {
			t.Fatal(err)
		}
		if err := worldchange.Put(ctx, tx, worldchange.Row{Key: groundRow(world, w1.Id, -3, 1), Kind: "ground", State: []byte(`{}`)}, now); err != nil {
			t.Fatal(err)
		}
		if ok, err := c.Release(ctx, tx, world, -3, 1, "lot-lantern", "1", now); !ok || err != nil {
			t.Fatalf("release: %v %v", ok, err)
		}
	})
	for turning := 1; turning <= 2; turning++ {
		now = turnAfter(now)
		wickNow(t, s, c, world, now)
		inTx(t, s, func(tx *sql.Tx) {
			if h, err := c.HoldAt(ctx, tx, world, -3, 1); err != nil || h == nil || h.Released == nil {
				t.Fatalf("turning %d: a released hold with no holder went: %+v %v", turning, h, err)
			}
			if _, err := c.Chunk(ctx, tx, world, w1.Id, 0, -3, 1); err != nil {
				t.Fatalf("turning %d: held chunk: %v", turning, err)
			}
			if r, err := worldchange.Get(ctx, tx, groundRow(world, w1.Id, -3, 1), "ground", now); err != nil || r == nil {
				t.Fatalf("turning %d: the held chunk's ground went: %v", turning, err)
			}
		})
	}
	lantern := &testHolder{keep: true}
	c.Holders = map[string]Holder{"lot-lantern": lantern}
	now = turnAfter(now)
	wickNow(t, s, c, world, now)
	if lantern.asked != 0 || len(lantern.released) != 1 || lantern.released[0].Epoch != w1.Id {
		t.Fatalf("asked %d, released %+v", lantern.asked, lantern.released)
	}
	if n := countRows(t, s, "SELECT count(*) FROM holds"); n != 0 {
		t.Fatal("the release didn't take effect once a holder was registered")
	}
}

// A held chunk whose blob has gone fails loudly rather than being made
// again; and a hold asked for before the turning but locked after it is
// refused, since the next wick's chunks may not mirror it.
func TestHeldChunkNeverRemade(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	now := int64(1795000000)
	c := NewChunks(func() time.Time { return time.Unix(now, 0) }, fakegen.New())
	const world = "world-a"
	w1 := wickNow(t, s, c, world, now)
	inTx(t, s, func(tx *sql.Tx) {
		late := chunks.WithReadClock(ctx, func() time.Time { return time.Unix(int64(w1.EndsAt.Value)+1, 0) })
		if _, err := c.Hold(late, tx, world, -3, 2, "lot-lantern", "1", now); !errors.Is(err, chunks.ErrEpochEnded) {
			t.Fatalf("held across the turning: %v", err)
		}
		if _, err := c.Hold(ctx, tx, world, -3, 1, "lot-lantern", "1", now); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM wilds_chunks WHERE epoch_id=? AND cx=-3 AND cy=1", w1.Id); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Chunk(ctx, tx, world, w1.Id, 0, -3, 1); !errors.Is(err, ErrHeldBlobMissing) {
			t.Fatalf("a held chunk with no blob: %v", err)
		}
	})
	if n := countRows(t, s, "SELECT count(*) FROM holds WHERE cy=2"); n != 0 {
		t.Fatal("a hold across the turning was stored")
	}
}

// Only a generated wick chunk inside the frontier can be held, by one
// holder at a time; the same holder holding again answers its hold.
func TestHoldRefusals(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	now := int64(1795000000)
	c := NewChunks(func() time.Time { return time.Unix(now, 0) }, fakegen.New())
	wickNow(t, s, c, "world-a", now)
	inTx(t, s, func(tx *sql.Tx) {
		for _, at := range [][2]int32{{0, -1}, {0, -4}, {-2, 1}, {0, 2}, {4097, 0}} { // the Tangle, the Whitequiet, a lot, the town, past the border
			if _, err := c.Hold(ctx, tx, "world-a", at[0], at[1], "lot-lantern", "1", now); !errors.Is(err, ErrNotHoldable) {
				t.Fatalf("held %v: %v", at, err)
			}
		}
		if _, err := c.Hold(ctx, tx, "world-a", -3, 1, "", "1", now); !errors.Is(err, ErrNotHoldable) {
			t.Fatalf("held with no holder kind: %v", err)
		}
		first, err := c.Hold(ctx, tx, "world-a", -3, 1, "lot-lantern", "1", now)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = c.Hold(ctx, tx, "world-a", -3, 1, "lot-lantern", "2", now); !errors.Is(err, ErrHeld) {
			t.Fatalf("a second holder: %v", err)
		}
		if _, err = c.Release(ctx, tx, "world-a", -3, 1, "lot-lantern", "1", now); err != nil {
			t.Fatal(err)
		}
		again, err := c.Hold(ctx, tx, "world-a", -3, 1, "lot-lantern", "1", now+5)
		if err != nil || again.Epoch != first.Epoch || again.Since != first.Since || again.Released != nil {
			t.Fatalf("holding again: %+v %v", again, err)
		}
	})
}

// Migration 038 (lasting geography) ends the wick as a turning would: its
// epoch, terrain and world changes go and its fallen lamps are archived;
// the still epoch, its chunks and its changes stay.
func TestLastingGeography038EndsOnlyTheWick(t *testing.T) {
	path := filepath.Join(t.TempDir(), "landform.sqlite")
	old := newUpgradeFixture(t, path, "037_one_town.sql", nil)
	_, err := old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Alice','w',1,1);
 INSERT INTO wild_epochs VALUES('wick','w','wick','seed',3,'t:1:9',1,9),('still','w','still','seed',3,'0',1,NULL);
 INSERT INTO wilds_chunks VALUES('wick',0,-3,1,3,x'00',1),('still',0,0,-1,3,x'00',1);
 INSERT INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at) VALUES
 ('w','hearthwick',0,'-3:1','wick','ground','ground','{}',1),('w','hearthwick',0,'0:-1','still','ground','ground','{}',1);
 INSERT INTO lanterns(id,epoch,world_id,owner_id,x,y,lit_by,at,lit_at) VALUES('fallen','wick','w','alice',-40,99,NULL,12,NULL);
 UPDATE player_place SET last_wick_epoch='wick' WHERE account_id='alice';`)
	if err != nil {
		t.Fatal(err)
	}
	old.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for q, want := range map[string]int{
		"SELECT count(*) FROM wild_epochs WHERE id='still'":                                                     1,
		"SELECT count(*) FROM wilds_chunks WHERE epoch_id='still'":                                              1,
		"SELECT count(*) FROM world_changes WHERE epoch='still'":                                                1,
		"SELECT count(*) FROM wild_epochs WHERE kind='wick'":                                                    0,
		"SELECT count(*) FROM wilds_chunks WHERE epoch_id='wick'":                                               0,
		"SELECT count(*) FROM world_changes WHERE epoch='wick'":                                                 0,
		"SELECT count(*) FROM one_town_lantern_archive WHERE id='fallen' AND epoch='wick' AND owner_id='alice'": 1,
		"SELECT count(*) FROM player_place WHERE last_wick_epoch='wick'":                                        0,
	} {
		if n := countRows(t, s, q); n != want {
			t.Fatalf("%s: %d, want %d", q, n, want)
		}
	}
}
