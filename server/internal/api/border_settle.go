package api

// A saved place past the world border (0.14). Nothing lets anyone walk
// there, so only a save from before the border, or content that narrowed
// it, can leave one. Whoever stood there is moved, never stuck past the
// border, and nothing they carry changes: their saved place goes to the
// nearest open ground inside it (settleBorder, in maintainState, so every
// read and answer sees it), the client follows as it does any place the
// world moved, and with no open ground near they go where the turncap would
// take them.

import (
	"context"
	"database/sql"
	"errors"
	"slices"

	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
)

// settleSearch is how many chunks out from the border's nearest chunk to
// look for open ground.
const settleSearch = 2

// settleTries bounds how many candidate chunks are read for open ground.
const settleTries = 8

// settleBorder moves a saved Wilds place whose chunk is past the world
// border. True when it moved.
func (a *Server) settleBorder(ctx context.Context, tx *sql.Tx, s store.Snapshot, now int64) (bool, error) {
	if s.WorldID == "" || s.State.Area != outdoorsArea {
		return false, nil
	}
	tx0, ty0 := wilds.TileOfPixel(s.State.Position.X, s.State.Position.Y)
	if cx, cy := wilds.ChunkOf(tx0, ty0); location.OnGrid(cx, cy) {
		return false, nil
	}
	area, x, y, err := a.borderLanding(ctx, tx, s.WorldID, tx0, ty0, now)
	if err != nil {
		return false, err
	}
	if err = store.MovePlace(ctx, tx, &s, area, x, y); err != nil {
		return false, err
	}
	if area == outdoorsArea {
		err = creditVisit(ctx, tx, s.WorldID, x, y, now)
	}
	return true, err
}

// borderLanding is where a player stranded at world tile (tx0, ty0) lands:
// the centre of the nearest open tile of a generated chunk inside the
// border, else the turncap's anchor.
func (a *Server) borderLanding(ctx context.Context, tx *sql.Tx, world string, tx0, ty0 int, now int64) (string, float64, float64, error) {
	S := chunkSize()
	x0, y0, x1, y1 := wilds.BorderRect()
	pcx, pcy := wilds.ChunkOf(tx0, ty0)
	pcx, pcy = min(max(pcx, x0), x1), min(max(pcy, y0), y1)
	// Candidate chunks inside, by how near their nearest tile is.
	type cand struct{ cx, cy, d int }
	var cands []cand
	for cy := pcy - settleSearch; cy <= pcy+settleSearch; cy++ {
		for cx := pcx - settleSearch; cx <= pcx+settleSearch; cx++ {
			if location.SourceOf(cx, cy).Kind != location.SourceGenerated || !wilds.InsideBorder(cx, cy) {
				continue
			}
			dx := max(cx*S-tx0, tx0-(cx*S+S-1), 0)
			dy := max(cy*S-ty0, ty0-(cy*S+S-1), 0)
			cands = append(cands, cand{cx, cy, dx*dx + dy*dy})
		}
	}
	slices.SortStableFunc(cands, func(a, b cand) int { return a.d - b.d })
	for i, c := range cands {
		if i == settleTries {
			break
		}
		o, err := a.openGroundIn(ctx, tx, world, c.cx, c.cy, nil, now)
		// A chunk that can't be read now (no generator, the epoch ending)
		// is passed over: the turncap's anchor is always there.
		var refused *failure
		if errors.As(err, &refused) {
			continue
		}
		if err != nil {
			return "", 0, 0, err
		}
		if lx, ly, ok, err := o.nearest(ctx, tx, tx0-c.cx*S, ty0-c.cy*S); err != nil {
			return "", 0, 0, err
		} else if ok {
			wx, wy := (c.cx*S+lx)*wildsTileSize+wildsTileSize/2, (c.cy*S+ly)*wildsTileSize+wildsTileSize/2
			return outdoorsArea, float64(wx), float64(wy), nil
		}
	}
	_, use := wayHome(travelHome)
	if use == nil {
		return "", 0, 0, errors.New("world border: no turncap to fall back on")
	}
	space, x, y, ok := location.Anchor(use.GetTarget())
	if !ok {
		return "", 0, 0, errors.New("world border: the turncap's anchor " + use.GetTarget() + " doesn't resolve")
	}
	return string(space), x, y, nil
}

// nearest is the open tile nearest chunk-local (lx, ly), which may lie
// outside the chunk; ties go north then west.
func (o *openGround) nearest(ctx context.Context, tx *sql.Tx, lx, ly int) (int, int, bool, error) {
	S := chunkSize()
	tiles := make([][2]int, 0, S*S)
	for y := range S {
		for x := range S {
			tiles = append(tiles, [2]int{x, y})
		}
	}
	dist := func(t [2]int) int { return (t[0]-lx)*(t[0]-lx) + (t[1]-ly)*(t[1]-ly) }
	slices.SortStableFunc(tiles, func(a, b [2]int) int { return dist(a) - dist(b) })
	for _, t := range tiles {
		if ok, err := o.open(ctx, tx, t[0], t[1]); err != nil || ok {
			return t[0], t[1], ok, err
		}
	}
	return 0, 0, false, nil
}
