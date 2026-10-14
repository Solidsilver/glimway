// Package chunkstest supplies stored chunk and epoch fixtures.
package chunkstest

import (
	"context"
	"database/sql"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
	"sync"
)

type Key struct {
	World, Epoch  string
	Layer, CX, CY int32
}

// Fake returns copies so a caller cannot change the geometry of a later read.
type Fake struct {
	mu     sync.Mutex
	Chunks map[Key]*contract.WorldChunk
	Errors map[Key]error
	Calls  []Key
}

func (f *Fake) Chunk(ctx context.Context, _ *sql.Tx, world, epoch string, layer, cx, cy int32) (*contract.WorldChunk, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	key := Key{world, epoch, layer, cx, cy}
	f.Calls = append(f.Calls, key)
	if err := f.Errors[key]; err != nil {
		return nil, err
	}
	chunk := f.Chunks[key]
	if chunk == nil {
		return nil, sql.ErrNoRows
	}
	return proto.Clone(chunk).(*contract.WorldChunk), nil
}

type EpochKey struct{ World, Kind string }
type FakeEpochs struct {
	Values      map[EpochKey]*contract.WildsEpoch
	CurrentFunc func(context.Context, *sql.Tx, string, string, int64) (*contract.WildsEpoch, error)
	CreateFunc  func(context.Context, *sql.Tx, string, string, int64) (*contract.WildsEpoch, error)
}

func (f FakeEpochs) Create(ctx context.Context, tx *sql.Tx, world, kind string, now int64) (*contract.WildsEpoch, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.CreateFunc != nil {
		return f.CreateFunc(ctx, tx, world, kind, now)
	}
	v := f.Values[EpochKey{world, kind}]
	if v == nil {
		return nil, chunks.ErrUnavailable
	}
	return proto.Clone(v).(*contract.WildsEpoch), nil
}

func (f FakeEpochs) Current(ctx context.Context, tx *sql.Tx, world, kind string, now int64) (*contract.WildsEpoch, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.CurrentFunc != nil {
		return f.CurrentFunc(ctx, tx, world, kind, now)
	}
	v := f.Values[EpochKey{world, kind}]
	if v == nil {
		return nil, sql.ErrNoRows
	}
	if v.EndsAt != nil && v.EndsAt.Value <= float64(now) {
		return nil, chunks.ErrEpochEnded
	}
	return proto.Clone(v).(*contract.WildsEpoch), nil
}
