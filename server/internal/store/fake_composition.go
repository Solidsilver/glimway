package store

import (
	"context"
	"database/sql"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
)

// FakeState keeps the caller's transaction observable in tests. Callbacks can
// run real SQL or inject failures without taking ownership of commit/rollback.
type FakeState struct {
	LoadFunc        func(context.Context, *sql.Tx, string) (Snapshot, error)
	PersistFunc     func(context.Context, *sql.Tx, *Snapshot, int64) error
	PlayerStateFunc func(context.Context, *sql.Tx, Snapshot) (*contract.PlayerState, error)
}

func (f FakeState) Load(ctx context.Context, tx *sql.Tx, id string) (Snapshot, error) {
	if f.LoadFunc != nil {
		return f.LoadFunc(ctx, tx, id)
	}
	return Load(ctx, tx, id)
}
func (f FakeState) Persist(ctx context.Context, tx *sql.Tx, s *Snapshot, now int64) error {
	if f.PersistFunc != nil {
		return f.PersistFunc(ctx, tx, s, now)
	}
	return Persist(ctx, tx, s, now)
}
func (f FakeState) PlayerState(ctx context.Context, tx *sql.Tx, s Snapshot) (*contract.PlayerState, error) {
	if f.PlayerStateFunc != nil {
		v, e := f.PlayerStateFunc(ctx, tx, s)
		if e != nil {
			return nil, e
		}
		return proto.Clone(v).(*contract.PlayerState), nil
	}
	return PlayerState(ctx, tx, s)
}
