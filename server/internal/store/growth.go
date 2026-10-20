package store

// Storage growth (0.14): with the world open to the border, chunks are
// still stored when first read (Sol's answer §1 explains why regenerating
// them waits), so each turning logs what the wick that ended stored: how
// many chunks, their bytes, and how far out the farthest lay. Far walkers
// show up here before they show up on the disk.

import (
	"context"
	"database/sql"
	"log"

	contract "glimway/server/internal/gen/glimway/v1"
)

// WickGrowth is what one wick epoch stored.
type WickGrowth struct {
	Chunks, Bytes int64
	// Farthest is the largest |cx| or |cy| of a stored chunk.
	Farthest int64
}

// wickGrowth measures a wick epoch's stored chunks.
func wickGrowth(ctx context.Context, tx *sql.Tx, epoch string) (WickGrowth, error) {
	var g WickGrowth
	err := tx.QueryRowContext(ctx, "SELECT count(*),coalesce(sum(length(blob)),0),coalesce(max(max(abs(cx),abs(cy))),0) FROM wilds_chunks WHERE epoch_id=?", epoch).Scan(&g.Chunks, &g.Bytes, &g.Farthest)
	return g, err
}

// logWickGrowth logs, at a turning, what the wick that ended stored, and
// the world's stored chunks in all.
func logWickGrowth(ctx context.Context, tx *sql.Tx, world string, ended *contract.WildsEpoch) error {
	if ended == nil {
		return nil
	}
	g, err := wickGrowth(ctx, tx, ended.Id)
	if err != nil {
		return err
	}
	var all, bytes int64
	if err = tx.QueryRowContext(ctx, "SELECT count(*),coalesce(sum(length(c.blob)),0) FROM wilds_chunks c JOIN wild_epochs e ON e.id=c.epoch_id WHERE e.world_id=?", world).Scan(&all, &bytes); err != nil {
		return err
	}
	log.Printf("turning: world %s wick %s stored %d chunks, %d bytes, farthest %d chunks out; the world holds %d chunks, %d bytes", world, ended.Id, g.Chunks, g.Bytes, g.Farthest, all, bytes)
	return nil
}
