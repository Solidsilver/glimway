// Package portstest supplies transaction-aware fixtures for server ports.
package portstest

import (
	"context"
	"database/sql"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/ports"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/proto"
)

// Fakes use the same signatures and transaction as production. Callbacks can
// assert reads/grants share the transaction; returned messages are cloned.
type FakeStory struct {
	Assign func(context.Context, *sql.Tx, store.Snapshot, ports.EchoInput) ([]*contract.EchoAssignment, error)
	Check  func(context.Context, *sql.Tx, store.Snapshot, ports.PaperInput) (bool, error)
	Give   func(context.Context, *sql.Tx, *store.Snapshot, string, int64) (ports.Grant, error)
}

func (f FakeStory) Echoes(ctx context.Context, tx *sql.Tx, snapshot store.Snapshot, in ports.EchoInput) ([]*contract.EchoAssignment, error) {
	if f.Assign == nil {
		return []*contract.EchoAssignment{}, nil
	}
	return f.Assign(ctx, tx, snapshot, in)
}
func (f FakeStory) Eligible(ctx context.Context, tx *sql.Tx, s store.Snapshot, in ports.PaperInput) (bool, error) {
	if f.Check == nil {
		return false, nil
	}
	return f.Check(ctx, tx, s, in)
}
func (f FakeStory) Grant(ctx context.Context, tx *sql.Tx, s *store.Snapshot, paper string, now int64) (ports.Grant, error) {
	if f.Give == nil {
		return ports.Grant{}, nil
	}
	return f.Give(ctx, tx, s, paper, now)
}

type FakePlacement struct {
	Put func(context.Context, *sql.Tx, *store.Snapshot, *contract.Where, int64) error
}

func (f FakePlacement) Record(ctx context.Context, tx *sql.Tx, s *store.Snapshot, w *contract.Where, now int64) error {
	if f.Put == nil {
		s.State.Area = w.Area
		s.State.Position.X = w.X
		s.State.Position.Y = w.Y
		return nil
	}
	return f.Put(ctx, tx, s, w, now)
}

type LandKey struct {
	World string
	Gate  int32
}
type FakeLand struct {
	Views map[LandKey]*contract.HomesteadLand
	Err   error
}

func (f FakeLand) Land(ctx context.Context, _ *sql.Tx, world string, gate int32) (*contract.HomesteadLand, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.Err != nil {
		return nil, f.Err
	}
	v := f.Views[LandKey{world, gate}]
	if v == nil {
		return nil, sql.ErrNoRows
	}
	return proto.Clone(v).(*contract.HomesteadLand), nil
}

type FakeLanterns struct {
	Put    func(context.Context, *sql.Tx, *store.Snapshot, *contract.WildsEpoch, *contract.Where, int64) (ports.FallLantern, error)
	Result ports.FallLantern
	Err    error
}

func (f FakeLanterns) PlaceFallen(ctx context.Context, tx *sql.Tx, snapshot *store.Snapshot, epoch *contract.WildsEpoch, where *contract.Where, now int64) (ports.FallLantern, error) {
	if err := ctx.Err(); err != nil {
		return ports.FallLantern{}, err
	}
	if f.Put != nil {
		return f.Put(ctx, tx, snapshot, epoch, where, now)
	}
	return f.Result, f.Err
}
