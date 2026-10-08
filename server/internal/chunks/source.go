// Package chunks defines the stored terrain seam used by gathering and the Wilds.
package chunks

import (
	"context"
	"database/sql"
	"errors"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
	"sync"
)

var ErrUnavailable = errors.New("chunk source unavailable")
var ErrEpochEnded = errors.New("epoch ended")

// Source reads only stored geometry in the caller's transaction. Implementations
// check world ownership and epoch lifetime; cx/cy are signed for the open map.
type ChunkSource interface {
	Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*contract.WildsChunk, error)
}

type Unavailable struct{}

func (Unavailable) Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*contract.WildsChunk, error) {
	return nil, ErrUnavailable
}

type Key struct {
	World, Epoch  string
	Layer, CX, CY int32
}

// Fake returns copies so a caller cannot change the geometry of a later read.
type Fake struct {
	mu     sync.Mutex
	Chunks map[Key]*contract.WildsChunk
	Errors map[Key]error
	Calls  []Key
}

func (f *Fake) Chunk(ctx context.Context, _ *sql.Tx, world, epoch string, layer, cx, cy int32) (*contract.WildsChunk, error) {
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
	return proto.Clone(chunk).(*contract.WildsChunk), nil
}

// EpochComposition lets D create an epoch and all its chunks in the same tx.
// The read route must call this only when the current epoch does not exist.
// now is Unix seconds. Current never creates, returning sql.ErrNoRows if absent
// and ErrEpochEnded when the stored current-generation epoch has ended.
type EpochComposition interface {
	Current(ctx context.Context, tx *sql.Tx, world, region string, now int64) (*contract.WildsEpoch, error)
	Create(ctx context.Context, tx *sql.Tx, world, region string, now int64) (*contract.WildsEpoch, error)
}
