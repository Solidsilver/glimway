package store

// A world's reach (lamps.md 2.2) is the static frontier and the slack around
// its held keys; package frontier keeps each world's, and this file keeps it
// matching the holds table. Holds change in two places only: Hold takes one
// (a camp or lot lantern set) and judgeHolds lets them go at the turning; a
// release keeps its chunk, so its reach, until then. Each stages the world's
// keys as its transaction now sees them (frontier.Stage): that transaction
// reads its own reach from then on, and nobody else does. The store's
// driver publishes what was staged once the transaction's commit has
// succeeded, and drops it when the transaction rolls back or its commit
// fails (reachTx); a rollback to a savepoint stages the keys again
// (RefreshReach). The store has one connection, so the staged reach is the
// open transaction's, and the next can't begin before it is published.

import (
	"context"
	"database/sql"
	"database/sql/driver"

	"glimway/content"
	"glimway/server/internal/frontier"
	"glimway/server/internal/rules"

	"modernc.org/sqlite"
)

// reachDriverName is SQLite whose transactions end their staged reach.
const reachDriverName = "sqlite-glimway"

func init() { sql.Register(reachDriverName, reachDriver{&sqlite.Driver{}}) }

type reachDriver struct{ sqlite *sqlite.Driver }

// sqliteConn is what database/sql uses of a SQLite connection.
type sqliteConn interface {
	driver.Conn
	driver.ConnBeginTx
	driver.ConnPrepareContext
	driver.ExecerContext
	driver.QueryerContext
	driver.Pinger
	driver.SessionResetter
	driver.Validator
}

func (d reachDriver) Open(name string) (driver.Conn, error) {
	c, err := d.sqlite.Open(name)
	if err != nil {
		return nil, err
	}
	return reachConn{c.(sqliteConn)}, nil
}

type reachConn struct{ sqliteConn }

func (c reachConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c reachConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	t, err := c.sqliteConn.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return reachTx{t}, nil
}

// reachTx publishes its staged reach after its commit succeeds, before
// database/sql hands the connection on; otherwise it drops it.
type reachTx struct{ driver.Tx }

func (t reachTx) Commit() error {
	if err := t.Tx.Commit(); err != nil {
		frontier.Discard()
		return err
	}
	frontier.Publish()
	return nil
}

func (t reachTx) Rollback() error {
	defer frontier.Discard()
	return t.Tx.Rollback()
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
	frontier.Stage(world, keys)
	return nil
}

// RefreshReach stages again the keys of every world tx staged, after tx
// rolled back to a savepoint: the holds it took or let go since may be
// undone.
func RefreshReach(ctx context.Context, tx *sql.Tx) error {
	for _, w := range frontier.Staged() {
		if err := syncReach(ctx, tx, w); err != nil {
			return err
		}
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
	frontier.Reset()
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
// the client follows (it is a move: place_moved_version).
func MovePlace(ctx context.Context, tx *sql.Tx, s *Snapshot, area string, x, y float64) error {
	if err := BumpVersion(ctx, tx, s); err != nil {
		return err
	}
	s.State.Area, s.State.Position = area, rules.Position{X: x, Y: y}
	_, err := tx.ExecContext(ctx, "UPDATE player_place SET area=?,x=?,y=?,place_set_version=?,place_moved_version=? WHERE account_id=?", area, x, y, s.Version, s.Version, s.AccountID)
	return err
}
