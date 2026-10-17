package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"glimway/server/internal/frontier"
	"glimway/server/internal/wilds"
	"glimway/server/internal/wildsgen"
)

// northEdge is the static frontier's northmost chunk in column cx.
func northEdge(t *testing.T, cx int) int {
	t.Helper()
	for cy := -64; cy < 8; cy++ {
		if wilds.InsideReach(cx, cy) {
			return cy
		}
	}
	t.Fatal("no frontier in column", cx)
	return 0
}

// A world's reach follows its holds (lamps.md 2.2): a hold on the frontier's
// edge pushes it out three chunks, now; a hold in that slack pushes it on,
// one past it is refused; a hold taken in a transaction that rolls back is
// forgotten by the next read of the wick; a lapse at the turning takes its
// slack back; a store opening reads every world's reach again.
func TestHeldReachFollowsHolds(t *testing.T) {
	t.Cleanup(frontier.Reset)
	path := filepath.Join(t.TempDir(), "reach.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []string{"world-a", "world-b"} {
		if _, err = s.DB.Exec("INSERT INTO worlds(id,owner_id,seed,created_at) VALUES(?,?,?,0)", w, "owner", "seed-"+w); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	now := int64(1795000000)
	c := NewChunks(func() time.Time { return time.Unix(now, 0) }, wildsgen.V3{})
	camp := &testHolder{keep: true}
	c.Holders = map[string]Holder{"way-lamp": camp}
	const world = "world-a"
	const ex = 2
	ey := northEdge(t, ex)
	wickNow(t, s, c, world, now)
	hold := func(cy int) error {
		var err error
		inTx(t, s, func(tx *sql.Tx) {
			_, err = c.Hold(ctx, tx, world, ex, int32(cy), "way-lamp", "lamp"+strconv.Itoa(cy), now)
		})
		return err
	}
	if frontier.Inside(world, ex, ey-1) {
		t.Fatal("past the edge before a camp")
	}
	if err = hold(ey - 1); !errors.Is(err, ErrNotHoldable) {
		t.Fatalf("held past the frontier: %v", err)
	}
	if err = hold(ey); err != nil {
		t.Fatal(err)
	}
	for d := 1; d <= 3; d++ {
		if !frontier.Inside(world, ex, ey-d) {
			t.Fatalf("%d out isn't in reach", d)
		}
	}
	if frontier.Inside(world, ex, ey-4) || frontier.Inside("world-b", ex, ey-1) {
		t.Fatal("past the slack, or in another world")
	}
	// Past the slack is refused; in it, a camp pushes on, and its chunk is made.
	if err = hold(ey - 4); !errors.Is(err, ErrNotHoldable) {
		t.Fatalf("held past the slack: %v", err)
	}
	if err = hold(ey - 3); err != nil {
		t.Fatal(err)
	}
	if !frontier.Inside(world, ex, ey-6) || frontier.Inside(world, ex, ey-7) {
		t.Fatal("the second camp's slack")
	}
	// Rolled back: the next read of the wick forgets it.
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.Hold(ctx, tx, world, ex, int32(ey-6), "way-lamp", "lamp-gone", now); err != nil {
		t.Fatal(err)
	}
	if !frontier.Inside(world, ex, ey-9) {
		t.Fatal("not pushed out inside its own transaction")
	}
	tx.Rollback()
	wickNow(t, s, c, world, now)
	if frontier.Inside(world, ex, ey-9) {
		t.Fatal("a rolled-back hold kept its reach")
	}
	// A store opening reads it all again.
	frontier.Reset()
	s.Close()
	if s, err = Open(path); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if !frontier.Inside(world, ex, ey-6) || frontier.Inside(world, ex, ey-7) {
		t.Fatal("not read again on opening")
	}
	// The turning: the camps lapse, and their slack goes with them.
	camp.keep = false
	now = turnAfter(now)
	wickNow(t, s, c, world, now)
	if len(camp.released) != 2 || frontier.Inside(world, ex, ey-1) || frontier.Held(world) != nil {
		t.Fatalf("after the lapse: released %d", len(camp.released))
	}
}
