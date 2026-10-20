package store

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"glimway/server/internal/chunks/fakegen"
	contract "glimway/server/internal/gen/glimway/v1"
)

// A wick's growth is its stored chunks, their bytes and the farthest out,
// far chunks included (0.14: no frontier keeps them near).
func TestWickGrowthMeasuresStoredChunks(t *testing.T) {
	s := chunkStore(t)
	ctx := context.Background()
	now := int64(1795000000)
	c := NewChunks(func() time.Time { return time.Unix(now, 0) }, fakegen.New())
	var wick *contract.WildsEpoch
	inTx(t, s, func(tx *sql.Tx) {
		var err error
		if wick, err = c.Create(ctx, tx, "world-a", EpochWick, now); err != nil {
			t.Fatal(err)
		}
		for _, at := range [][2]int32{{3, -6}, {-1200, 40}, {5, 2500}} {
			if _, err = c.Chunk(ctx, tx, "world-a", wick.Id, 0, at[0], at[1]); err != nil {
				t.Fatal(at, err)
			}
		}
		g, err := wickGrowth(ctx, tx, wick.Id)
		if err != nil {
			t.Fatal(err)
		}
		if g.Chunks != 3 || g.Bytes <= 0 || g.Farthest != 2500 {
			t.Fatalf("growth %+v", g)
		}
		if err = logWickGrowth(ctx, tx, "world-a", wick); err != nil {
			t.Fatal(err)
		}
	})
}
