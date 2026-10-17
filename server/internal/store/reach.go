package store

// A world's reach (lamps.md 2.2) is the static frontier and the slack around
// its held keys; package frontier keeps each world's, and this file keeps it
// matching the holds table. Holds change in two places only: Hold takes one
// (a camp or lot lantern set) and judgeHolds lets them go at the turning; a
// release keeps its chunk, so its reach, until then. Each tells frontier the
// world's keys as its transaction now sees them. That is right once the
// transaction commits; if it rolls back instead, the next transaction to
// read the world's current epoch (Current, which nearly every request does)
// reads the keys again. The store has one connection, so a transaction
// other than the one that set them means that one has ended.

import (
	"context"
	"database/sql"
	"sync"

	"glimway/content"
	"glimway/server/internal/frontier"
	"glimway/server/internal/rules"
)

var (
	reachMu sync.Mutex
	// reachBy: the transaction that last set a world's keys, until
	// another transaction confirms them.
	reachBy = map[string]*sql.Tx{}
)

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

// syncReach tells frontier the world's held keys as tx sees them, after tx
// took or let go a hold.
func syncReach(ctx context.Context, tx *sql.Tx, world string) error {
	keys, err := heldKeys(ctx, tx, world)
	if err != nil {
		return err
	}
	reachMu.Lock()
	defer reachMu.Unlock()
	frontier.Set(world, keys)
	reachBy[world] = tx
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
