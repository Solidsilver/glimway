//go:build linux

package store

import (
	"context"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"glimway/server/internal/frontier"
	"glimway/server/internal/wildsgen"
)

// A hold whose commit fails publishes no reach (step-back S1, Sol's
// cross-review): the WAL may not grow past its size, so the commit's write
// fails with an I/O error; nothing is held, and neither view has the slack.
func TestFailedCommitPublishesNoReach(t *testing.T) {
	t.Cleanup(frontier.Reset)
	path := filepath.Join(t.TempDir(), "iofail.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	const world = "world-a"
	if _, err = s.DB.Exec("INSERT INTO worlds(id,owner_id,seed,created_at) VALUES(?,?,?,0)", world, "owner", "seed"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := int64(1795000000)
	c := NewChunks(func() time.Time { return time.Unix(now, 0) }, wildsgen.V3{})
	c.Holders = map[string]Holder{"way-lamp": &testHolder{keep: true}}
	const ex = 2
	ey := northEdge(t, ex)
	wickNow(t, s, c, world, now)
	if _, err = s.DB.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		t.Fatal(err)
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = c.Hold(ctx, tx, world, ex, int32(ey), "way-lamp", "lamp", now); err != nil {
		t.Fatal(err)
	}
	if !frontier.Inside(world, ex, ey-1) {
		t.Fatal("not pushed out in its own transaction")
	}
	wal, err := os.Stat(path + "-wal")
	if err != nil {
		t.Fatal(err)
	}
	var saved syscall.Rlimit
	if err = syscall.Getrlimit(syscall.RLIMIT_FSIZE, &saved); err != nil {
		t.Fatal(err)
	}
	limit := saved
	limit.Cur = uint64(wal.Size())
	signal.Ignore(syscall.SIGXFSZ)
	defer signal.Reset(syscall.SIGXFSZ)
	if err = syscall.Setrlimit(syscall.RLIMIT_FSIZE, &limit); err != nil {
		t.Fatal(err)
	}
	commitErr := tx.Commit()
	if err = syscall.Setrlimit(syscall.RLIMIT_FSIZE, &saved); err != nil {
		t.Fatal(err)
	}
	if commitErr == nil {
		t.Fatal("the commit didn't fail")
	}
	var n int
	if err = s.DB.QueryRow("SELECT count(*) FROM holds WHERE world_id=?", world).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 || frontier.Inside(world, ex, ey-1) || frontier.InsidePublished(world, ex, ey-1) {
		t.Fatalf("after the failed commit (%v): %d holds, reach %v, published %v", commitErr, n, frontier.Inside(world, ex, ey-1), frontier.InsidePublished(world, ex, ey-1))
	}
}
