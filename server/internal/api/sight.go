package api

// Sight (0.14, docs/planning/wide-world/synthesis.md): with no frontier,
// the chunk and near reads answer only for land round the reader, so nobody
// crawls the world through the API. A read past it is `beyond-sight`.
//
// The reader's trusted place is their saved one: the last report or
// operation's `where`, as the server kept it. In the Wilds that is the
// chunk they stand in; anywhere else (a room, the cottage) it is chunk 0,0,
// the gate, which the map reads round. Reports come about every 10 seconds
// (src/lib/api/reports.ts), and a rider covers about 4.6 chunks in that,
// so the saved chunk trails the hero by up to sightLag chunks: a near read
// may centre that far from it, and a chunk read may ask that far plus the
// near window's radius. Fixed footprints' chunks come from content and
// held chunks are the world's lasting land, so both read from anywhere.

import (
	"context"
	"database/sql"

	"glimway/content"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
)

// sightLag: how many chunks the saved place may trail the hero.
const sightLag = 6

// sightChunks: how far from the trusted chunk a chunk read may ask.
const sightChunks = sightLag + NearRadius

// trustedChunk is the chunk sight is measured from.
func trustedChunk(s store.Snapshot) (int, int) {
	if s.State.Area != outdoorsArea {
		return 0, 0
	}
	return wilds.ChunkOf(wilds.TileOfPixel(s.State.Position.X, s.State.Position.Y))
}

// withinSight: chunk (cx, cy) lies within r chunks (Chebyshev) of the
// reader's trusted chunk.
func withinSight(s store.Snapshot, cx, cy, r int) bool {
	tx, ty := trustedChunk(s)
	return max(abs(cx-tx), abs(cy-ty)) <= r
}

// chunkInSight: a chunk read of (cx, cy) is answered: a fixed footprint's,
// a held chunk of the reader's world, or one within sightChunks.
func chunkInSight(ctx context.Context, tx *sql.Tx, s store.Snapshot, cx, cy int) (bool, error) {
	if location.SourceOf(cx, cy).Kind == location.SourceFixed || withinSight(s, cx, cy, sightChunks) {
		return true, nil
	}
	var n int
	err := tx.QueryRowContext(ctx, "SELECT count(*) FROM holds WHERE world_id=? AND realm=? AND layer=0 AND cx=? AND cy=?", s.WorldID, content.WildsRules.GetRealm(), cx, cy).Scan(&n)
	return n > 0, err
}
