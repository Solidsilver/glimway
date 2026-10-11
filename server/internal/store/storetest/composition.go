package storetest

import (
	"context"
	"database/sql"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/proto"
	"time"
)

// FakeState keeps the caller's transaction observable in tests. Callbacks can
// run real SQL or inject failures without taking ownership of commit/rollback.
type FakeState struct {
	LoadFunc        func(context.Context, *sql.Tx, string) (store.Snapshot, error)
	PersistFunc     func(context.Context, *sql.Tx, *store.Snapshot, int64) error
	PlayerStateFunc func(context.Context, *sql.Tx, store.Snapshot, time.Time) (*contract.PlayerState, error)
}

func (f FakeState) Load(ctx context.Context, tx *sql.Tx, id string) (store.Snapshot, error) {
	if f.LoadFunc != nil {
		return f.LoadFunc(ctx, tx, id)
	}
	return store.Load(ctx, tx, id)
}
func (f FakeState) Persist(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	if f.PersistFunc != nil {
		return f.PersistFunc(ctx, tx, s, now)
	}
	return store.Persist(ctx, tx, s, now)
}
func (f FakeState) PlayerState(ctx context.Context, tx *sql.Tx, s store.Snapshot, now time.Time) (*contract.PlayerState, error) {
	if f.PlayerStateFunc != nil {
		v, e := f.PlayerStateFunc(ctx, tx, s, now)
		if e != nil {
			return nil, e
		}
		return proto.Clone(v).(*contract.PlayerState), nil
	}
	return store.PlayerState(ctx, tx, s)
}
