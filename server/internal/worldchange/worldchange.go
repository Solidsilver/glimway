// Package worldchange is the shared world-changes table (docs/design/crafts.md
// 5.4; plan.md, "Shared foundations"): one row per world entity whose state
// outlives a request — the mill pond's fish stock in 0.5, generated water and
// chunk changes later. The state is the ProtoJSON of its kind's message.
//
// Time is worked out, never ticked: no row means untouched, reads ignore a
// row whose ends_at has passed, and nothing reaps expired rows on a timer.
// Reads and writes are given the clock; they never take it themselves.
package worldchange

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// Key is where a shared entity lives: a curated place (realm = the area id,
// chunk and epoch empty) or a generated realm's chunk (which turns, and
// carries its epoch).
type Key struct {
	WorldID string
	Realm   string
	Layer   int
	Chunk   string
	Epoch   string
	Entity  string
}

// Row is one world change: the kind's state message as ProtoJSON, who
// changed it last, and the turn it expires at (nil: never — a curated
// water's stock row never turns).
type Row struct {
	Key
	Kind      string
	State     []byte
	ChangedAt int64
	ChangedBy string
	EndsAt    *int64
}

// Queryer is the caller's reader: *sql.DB or the transaction it is working in.
type Queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Execer is the caller's writer: *sql.DB or the transaction the write
// belongs to (Put is always part of a larger transaction).
type Execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

const selectSQL = `SELECT kind, state, changed_at, changed_by, ends_at FROM world_changes
 WHERE world_id=? AND realm=? AND layer=? AND chunk=? AND epoch=? AND entity=?`

// Get reads one row of one kind. A row of another kind at the same key is a
// caller's bug — its state is another message's ProtoJSON — so it is an
// error, never a row. A row whose ends_at has passed reads as absent: an
// expired change is what the world would be without it, and it is left
// where it lies (nothing cleans up on a timer). An absent row is (nil, nil).
func Get(ctx context.Context, q Queryer, key Key, kind string, now int64) (*Row, error) {
	var (
		row       Row
		changedBy sql.NullString
		endsAt    sql.NullInt64
	)
	err := q.QueryRowContext(ctx, selectSQL,
		key.WorldID, key.Realm, key.Layer, key.Chunk, key.Epoch, key.Entity,
	).Scan(&row.Kind, &row.State, &row.ChangedAt, &changedBy, &endsAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	row.Key = key
	row.ChangedBy = changedBy.String
	if row.Kind != kind {
		return nil, fmt.Errorf("worldchange: %s is %q, not %q", key.Entity, row.Kind, kind)
	}
	if endsAt.Valid {
		end := endsAt.Int64
		row.EndsAt = &end
		if end <= now {
			return nil, nil
		}
	}
	return &row, nil
}

// Put writes one row in the caller's transaction: the first write of an
// entity's change, or the recovered state after one (the caller stores the
// recovered value and the time together). changed_at is the write's clock.
func Put(ctx context.Context, e Execer, row Row, now int64) error {
	_, err := e.ExecContext(ctx, `INSERT INTO world_changes
 (world_id, realm, layer, chunk, epoch, entity, kind, state, changed_at, changed_by, ends_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(world_id, realm, layer, chunk, epoch, entity) DO UPDATE SET
  kind=excluded.kind, state=excluded.state, changed_at=excluded.changed_at,
  changed_by=excluded.changed_by, ends_at=excluded.ends_at`,
		row.WorldID, row.Realm, row.Layer, row.Chunk, row.Epoch, row.Entity,
		row.Kind, row.State, now, nullIfEmpty(row.ChangedBy), row.EndsAt)
	return err
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
