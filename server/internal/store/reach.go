package store

// A world's reach (lamps.md 2.2) is the static frontier and the slack around
// its held keys; package frontier keeps each world's, and this file keeps it
// matching the holds table. Holds change in two places only: Hold takes one
// (a camp or lot lantern set) and judgeHolds lets them go at the turning; a
// release keeps its chunk, so its reach, until then. Each stages the world's
// keys as its transaction now sees them (frontier.Stage): that transaction
// reads its own reach from then on, and nobody else does. The store's
// connection publishes what was staged when the transaction commits and
// drops it when it rolls back (reachDriver); a rollback to a savepoint
// stages the keys again (RefreshReach). As a backstop, the next transaction
// reads again the keys of a world another transaction set (ConfirmReach,
// and confirmReach before a world's epoch is read): the store has one
// connection, so that transaction has ended, however it ended.

import (
	"context"
	"database/sql"
	"slices"
	"sync"

	"glimway/content"
	"glimway/server/internal/frontier"
	"glimway/server/internal/rules"

	"modernc.org/sqlite"
)

var (
	reachMu sync.Mutex
	// reachBy: the transaction that last set a world's keys, until
	// another transaction confirms them.
	reachBy = map[string]*sql.Tx{}
)

// reachDriver is SQLite with the hooks that end a transaction's staged
// reach. A commit hook runs as the commit starts; if the commit then fails,
// SQLite rolls back and the next transaction's ConfirmReach reads the keys
// again.
const reachDriver = "sqlite-glimway"

func init() {
	d := &sqlite.Driver{}
	d.RegisterConnectionHook(func(c sqlite.ExecQuerierContext, _ string) error {
		h := c.(sqlite.HookRegisterer)
		h.RegisterCommitHook(func() int32 { frontier.Publish(); return 0 })
		h.RegisterRollbackHook(frontier.Discard)
		return nil
	})
	sql.Register(reachDriver, d)
}

// heldKeys are the world's held chunks.
func heldKeys(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, world string) ([][2]int, error) {
	rows, err := q.QueryContext(ctx, "SELECT cx,cy FROM holds WHERE world_id=? AND realm=? AND layer=0", world, content.WildsRules.GetRealm())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][2]int
	for rows.Next() {
		var k [2]int
		if err = rows.Scan(&k[0], &k[1]); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// syncReach stages the world's held keys as tx sees them, after tx took or
// let go a hold.
func syncReach(ctx context.Context, tx *sql.Tx, world string) error {
	keys, err := heldKeys(ctx, tx, world)
	if err != nil {
		return err
	}
	reachMu.Lock()
	defer reachMu.Unlock()
	frontier.Stage(world, keys)
	reachBy[world] = tx
	return nil
}

// RefreshReach stages again the keys of every world tx set, after tx rolled
// back to a savepoint: the holds it took or let go since may be undone.
func RefreshReach(ctx context.Context, tx *sql.Tx) error {
	reachMu.Lock()
	var worlds []string
	for w, by := range reachBy {
		if by == tx {
			worlds = append(worlds, w)
		}
	}
	reachMu.Unlock()
	for _, w := range worlds {
		if err := syncReach(ctx, tx, w); err != nil {
			return err
		}
	}
	return nil
}

// ConfirmReach confirms every world's keys another transaction set; a
// request runs it as it begins, before any boundary check.
func ConfirmReach(ctx context.Context, tx *sql.Tx) error {
	reachMu.Lock()
	var worlds []string
	for w, by := range reachBy {
		if by != tx {
			worlds = append(worlds, w)
		}
	}
	reachMu.Unlock()
	slices.Sort(worlds)
	for _, w := range worlds {
		if err := confirmReach(ctx, tx, w); err != nil {
			return err
		}
	}
	return nil
}

// confirmReach reads the world's keys again when another transaction set
// them last: it has ended, and may have rolled back.
func confirmReach(ctx context.Context, tx *sql.Tx, world string) error {
	reachMu.Lock()
	by, ok := reachBy[world]
	reachMu.Unlock()
	if !ok || by == tx {
		return nil
	}
	keys, err := heldKeys(ctx, tx, world)
	if err != nil {
		return err
	}
	reachMu.Lock()
	defer reachMu.Unlock()
	if reachBy[world] == by {
		frontier.Set(world, keys)
		delete(reachBy, world)
	}
	return nil
}

// loadReach reads every world's held keys as the store opens.
func loadReach(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, "SELECT DISTINCT world_id FROM holds")
	if err != nil {
		return err
	}
	var worlds []string
	for rows.Next() {
		var w string
		if err = rows.Scan(&w); err != nil {
			rows.Close()
			return err
		}
		worlds = append(worlds, w)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	reachMu.Lock()
	defer reachMu.Unlock()
	frontier.Reset()
	clear(reachBy)
	for _, w := range worlds {
		keys, err := heldKeys(ctx, db, w)
		if err != nil {
			return err
		}
		frontier.Set(w, keys)
	}
	return nil
}

// MovePlace saves a place the world chose for the player (the reach left
// where they stood, api/frontier_reach.go). It takes a new version and sets
// the place at it, so older reports from where they stood are dropped and
// the client follows.
func MovePlace(ctx context.Context, tx *sql.Tx, s *Snapshot, area string, x, y float64) error {
	if err := BumpVersion(ctx, tx, s); err != nil {
		return err
	}
	s.State.Area, s.State.Position = area, rules.Position{X: x, Y: y}
	_, err := tx.ExecContext(ctx, "UPDATE player_place SET area=?,x=?,y=?,place_set_version=? WHERE account_id=?", area, x, y, s.Version, s.AccountID)
	return err
}
