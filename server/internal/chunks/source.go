// Package chunks defines the stored terrain seam used by gathering and the Wilds.
package chunks

import (
	"context"
	"database/sql"
	"errors"
	contract "glimway/server/internal/gen/glimway/v1"
)

var ErrUnavailable = errors.New("chunk source unavailable")
var ErrEpochEnded = errors.New("epoch ended")

// Source reads only stored geometry in the caller's transaction. Implementations
// check world ownership and epoch lifetime; cx/cy are signed for the open map.
type ChunkSource interface {
	Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*contract.WildsChunk, error)
}

// EpochComposition reads and makes a world's epochs by kind (open-map.md
// 2.3): "still" (one a world, never ends: the Tangle) and "wick" (one a
// world a wick: everything else). now is Unix seconds. Current never
// creates, returning sql.ErrNoRows if absent and ErrEpochEnded when the
// stored current-generation epoch has ended; Create makes the kind's epoch
// for now (a racing Create that lost answers the winner's).
type EpochComposition interface {
	Current(ctx context.Context, tx *sql.Tx, world, kind string, now int64) (*contract.WildsEpoch, error)
	Create(ctx context.Context, tx *sql.Tx, world, kind string, now int64) (*contract.WildsEpoch, error)
}

// Epoch is the kind's current epoch, made when there is none current.
func Epoch(ctx context.Context, tx *sql.Tx, e EpochComposition, world, kind string, now int64) (*contract.WildsEpoch, error) {
	v, err := e.Current(ctx, tx, world, kind, now)
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, ErrEpochEnded) {
		v, err = e.Create(ctx, tx, world, kind, now)
	}
	return v, err
}
