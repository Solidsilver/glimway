package wilds

import (
	"slices"

	contract "glimway/server/internal/gen/glimway/v1"
)

// The base: every tile's walkability and ground from the passes above the
// chunk alone (lands, the Wend, the road, routes, gaps, the footprints'
// openings, a seam's kept edge), a pure function of the epoch and the
// world tile. A chunk's two edge tiles each side are exactly its base and
// detail never edits them, so both neighbours of an edge compute the same
// four tiles (open-map.md 2.2, "Edges"). Inside them, detail opens
// clearings and paths and dresses everything.
//
// What decides a tile, first match wins:
//  1. Another epoch's chunk (kept): its own tile. Beside one, within two
//     tiles of it: a mirror of its edge (the seam, 2.3), open where it's
//     open, solid where it's solid; water there becomes bank.
//  2. A footprint's fixed opening (the gate, the crossing, the road's).
//  3. The Wend's water: a ford within fordWidth/2 of a route, else water.
//  4. The Lantern Road's paving and verge.
//  5. A route (or an extra ford's path): its trodden line and verge.
//  6. The Wend's bank.
//  7. An edge gap, in the two edge tiles each side.
//  8. The land's floor: solid where its thicketPermille says (woods: all),
//     else open, by the world-coordinate land field, edge tiles included.
//     Among the edge tiles, open land that would be shut in is shut
//     (edgeOpen), so neither chunk is left with open ground it may not
//     carve to.
//
// Then the south limit's last two rows are shut, but for the gate and a
// kept edge: nothing lies south of it.

type baseKind uint8

const (
	bField baseKind = iota
	bKept
	bSeam
	bOpening
	bWater
	bFord
	bRoad
	bRoute
	bBank
	bGap
)

type baseTile struct {
	walk   bool
	ground Ground
	land   int8
	kind   baseKind
}

// keptReader reads kept chunks' tiles: from the stored chunk when the
// caller passed it, else as generator v3 makes it (its band is its base).
type keptReader struct {
	w      *world // the kept epoch's world
	stored map[[2]int]*contract.WorldChunk
	made   map[[2]int][]baseTile
}

var groundByTerrain = func() map[string]Ground {
	out := map[string]Ground{}
	for i, t := range GroundIDs {
		out[t] = Ground(i)
	}
	return out
}()

func (k *keptReader) tile(tx, ty int) (bool, Ground) {
	S := chunkSize()
	c := [2]int{floorDiv(tx, S), floorDiv(ty, S)}
	lx, ly := tx-c[0]*S, ty-c[1]*S
	if m := k.stored[c]; m != nil && int(m.Size) == S && len(m.Ground) == S*S/2 && len(m.Solid) == S*S/8 {
		i := ly*S + lx
		g := Ground(0)
		if p := int(m.Ground[i/2] >> (4 * (i % 2)) & 15); p < len(m.Palette) {
			if v, ok := groundByTerrain[m.Palette[p]]; ok {
				g = v
			}
		}
		return Walkable(m, lx, ly), g
	}
	tiles, ok := k.made[c]
	if !ok {
		tiles = k.w.fill(c[0]*S, c[1]*S, c[0]*S+S-1, c[1]*S+S-1, nil)
		k.made[c] = tiles
	}
	t := tiles[ly*S+lx]
	return t.walk, t.ground
}

// openingTiles are the footprints' fixed openings: the opening's tiles on
// its edge and two more inward, in this epoch kind's footprints.
func openingTiles(kind string) map[[2]int]Ground {
	out := map[[2]int]Ground{}
	for _, p := range contentRules().Places {
		if p.GetEpochKind() != kind {
			continue
		}
		g := landGround[landIndex(p.GetLand())]
		for _, o := range p.GetOpenings() {
			dx, dy := sideStep(o.GetEdge())
			for k := 0; k < int(o.GetWidth()); k++ {
				ex, ey := edgeTile(int(o.GetCx()), int(o.GetCy()), dx, dy, int(o.GetOffset())+k)
				gr := g.verge
				if k == int(o.GetWidth())/2 {
					gr = g.path
				}
				for d := 0; d < 3; d++ {
					out[[2]int{ex - dx*d, ey - dy*d}] = gr
				}
			}
		}
	}
	return out
}

// fill computes the base of the tiles x0..x1, y0..y1 (inclusive), row-major:
// the raw base over the area and a margin, then the edge rule for open land
// among the edge tiles, then the south limit shut.
func (w *world) fill(x0, y0, x1, y1 int, kept *keptReader) []baseTile {
	S := chunkSize()
	if kept == nil {
		kept = &keptReader{w: w.still(), made: map[[2]int][]baseTile{}}
	}
	const pad = band + 3 // a corner block's ring, and the ring's own columns
	rx0, ry0 := x0-pad, y0-pad
	rW := x1 - x0 + 1 + 2*pad
	raw := w.fillRaw(rx0, ry0, x1+pad, y1+pad, kept)
	at := func(tx, ty int) baseTile { return raw[(ty-ry0)*rW+tx-rx0] }
	W := x1 - x0 + 1
	out := make([]baseTile, W*(y1-y0+1))
	corners := map[[2]int][]bool{}
	for ty := y0; ty <= y1; ty++ {
		for tx := x0; tx <= x1; tx++ {
			t := at(tx, ty)
			if t.kind == bField && inBand(tx, ty) {
				t.walk = w.edgeOpen(tx, ty, at, corners)
				if t.walk && landData(max(int(t.land), 0)).GetThicketPermille() >= 1000 {
					t.ground = landGround[max(int(t.land), 0)].open
				} else if !t.walk {
					t.ground = landGround[max(int(t.land), 0)].floor
				}
			}
			out[(ty-y0)*W+tx-x0] = t
		}
	}
	// Nothing lies south of the south limit: the limit's last two rows are
	// shut (but for the gate and a kept edge), as the frontier is there.
	south := int(contentRules().GetFrontier().GetSouthLimit())
	for ty := max(y0, (south+1)*S-band); ty <= min(y1, (south+1)*S-1); ty++ {
		for tx := x0; tx <= x1; tx++ {
			t := &out[(ty-y0)*W+tx-x0]
			if t.kind == bKept || t.kind == bSeam || t.kind == bOpening || t.kind == bWater || !t.walk {
				continue
			}
			t.walk, t.kind = false, bField
			t.ground = landGround[max(int(t.land), 0)].floor
		}
	}
	return out
}

// fillRaw is the base of x0..x1, y0..y1 with open land as the land's own
// field gives it everywhere, edge tiles included.
func (w *world) fillRaw(x0, y0, x1, y1 int, kept *keptReader) []baseTile {
	S := chunkSize()
	W := x1 - x0 + 1
	out := make([]baseTile, W*(y1-y0+1))
	area := tileBox(x0, y0, x1, y1)
	openings := openingTiles(w.e.Kind)

	// Every tile's patch over the area and a margin (a hem looks hemTiles
	// round, the edge columns a tile further), then each tile's land.
	m := hemTiles + 1
	gx0, gy0, gW := x0-m, y0-m, W+2*m
	grid := box{x0 - m, y0 - m, x1 + m, y1 + m}
	gridBox := tileBox(grid.x0, grid.y0, grid.x1, grid.y1)
	pts := w.landPointsNear(gridBox)
	var riverSegs []int
	if w.river != nil {
		riverSegs = w.river.line.segs(gridBox, riverLeanReach())
	}
	riverAt := func(p pt) (int64, int) {
		if len(riverSegs) > 0 {
			if d, h, ok := w.river.line.nearest(p, riverSegs); ok {
				return d, h
			}
		}
		return -1, 0
	}
	type patch struct {
		o owner
		l int
	}
	patches := make([]patch, gW*(grid.y1-grid.y0+1))
	for ty := grid.y0; ty <= grid.y1; ty++ {
		for tx := grid.x0; tx <= grid.x1; tx++ {
			d, _ := riverAt(tileCentre(tx, ty))
			o, l := w.patchAt(tx, ty, pts, d)
			patches[(ty-gy0)*gW+tx-gx0] = patch{o, l}
		}
	}
	landAt := func(tx, ty int) int {
		return w.landFrom(tx, ty, func(x, y int) (owner, int) {
			p := patches[(y-gy0)*gW+x-gx0]
			return p.o, p.l
		})
	}
	roadSegs := w.road.line.segs(area, 0)
	// Routes of the cells under the area.
	var routes []*line
	cxa, cya := CellOf(floorDiv(x0, S), floorDiv(y0, S))
	cxb, cyb := CellOf(floorDiv(x1, S), floorDiv(y1, S))
	for cy := cya; cy <= cyb; cy++ {
		for cx := cxa; cx <= cxb; cx++ {
			for _, r := range w.cellLinks(cx, cy) {
				if !slices.Contains(routes, r.line) && len(r.line.segs(area, 0)) > 0 {
					routes = append(routes, r.line)
				}
			}
		}
	}
	routeSegs := make([][]int, len(routes))
	for i, r := range routes {
		routeSegs[i] = r.segs(area, routeVerge)
	}
	fordHalf := int64(contentRules().GetRiver().GetFordWidth()) * fp / 2

	for ty := y0; ty <= y1; ty++ {
		for tx := x0; tx <= x1; tx++ {
			t := &out[(ty-y0)*W+tx-x0]
			cx, cy := floorDiv(tx, S), floorDiv(ty, S)
			if EpochKindAt(cx, cy) != w.e.Kind {
				if !w.wick {
					// The kept side can't know a newer epoch's land: left
					// solid and unknown (only tests look this far).
					t.kind, t.land = bKept, -1
					continue
				}
				t.walk, t.ground = kept.tile(tx, ty)
				t.kind = bKept
				t.land = int8(landIndex(footprintLand(cx, cy)))
				continue
			}
			p := tileCentre(tx, ty)
			riverD, riverHalf := riverAt(p)
			land := landAt(tx, ty)
			t.land = int8(land)
			lg := landGround[land]
			wet := riverD >= 0 && riverD <= int64(riverHalf)*int64(riverHalf)
			banked := riverD >= 0 && riverD <= int64(riverHalf+bankWidth)*int64(riverHalf+bankWidth)

			if mx, my, ok := w.seamMirror(tx, ty); ok {
				walk, g := kept.tile(mx, my)
				t.walk, t.ground, t.kind = walk, g, bSeam
				if walk && (wet || banked || groundSurface[g] == "water" || groundSurface[g] == "ford") {
					t.ground = groundRiverBank
				}
				continue
			}
			if g, ok := openings[[2]int{tx, ty}]; ok {
				t.walk, t.ground, t.kind = true, g, bOpening
				continue
			}
			routeD := int64(-1)
			for i, r := range routes {
				if d, _, ok := r.nearest(p, routeSegs[i]); ok && (routeD < 0 || d < routeD) {
					routeD = d
				}
			}
			if wet {
				if routeD >= 0 && routeD <= fordHalf*fordHalf {
					t.walk, t.ground, t.kind = true, groundRiverFord, bFord
				} else {
					t.walk, t.ground, t.kind = false, groundRiverWater, bWater
				}
				continue
			}
			if len(roadSegs) > 0 {
				if d, _, ok := w.road.line.nearest(p, roadSegs); ok {
					h := int64(w.road.half)
					if d <= h*h {
						t.walk, t.ground, t.kind = true, groundPaving, bRoad
						continue
					}
					if d <= (h+fp)*(h+fp) {
						t.walk, t.ground, t.kind = true, groundRoadVerge, bRoad
						continue
					}
				}
			}
			if routeD >= 0 && routeD <= routeVerge*routeVerge {
				t.walk, t.kind = true, bRoute
				t.ground = lg.verge
				if routeD <= routePath*routePath {
					t.ground = lg.path
				}
				continue
			}
			if banked {
				t.walk, t.ground, t.kind = true, groundRiverBank, bBank
				continue
			}
			if g, ok := w.gapAt(tx, ty, lg); ok {
				t.walk, t.ground, t.kind = true, g, bGap
				continue
			}
			t.kind = bField
			t.ground = lg.floor
			t.walk = !w.thicketAt(tx, ty, int(landData(land).GetThicketPermille()))
		}
	}
	return out
}

// footprintLand is the footprint's land at a chunk, or "".
func footprintLand(cx, cy int) string {
	if p := FootprintAt(cx, cy); p != nil {
		return p.GetLand()
	}
	return ""
}

// thicketAt: is the land's floor solid here? Clumped, so a meadow's
// thickets stand in small stands rather than single tiles.
func (w *world) thicketAt(tx, ty, permille int) bool {
	if permille >= 1000 {
		return true
	}
	if permille <= 0 {
		return false
	}
	v := (w.thicket.at(tx*fp/3, ty*fp/3)*1000>>16 + int(Hash(w.e.WorldSeed, "thicket", tx, ty)%1000)) / 2
	return v < permille
}

// inBand: is the tile one of its chunk's edge tiles?
func inBand(tx, ty int) bool {
	S := chunkSize()
	lx, ly := tx-floorDiv(tx, S)*S, ty-floorDiv(ty, S)*S
	return lx < band || ly < band || lx >= S-band || ly >= S-band
}

// edgeOpen decides open land among the edge tiles from the raw base (at),
// so a border between lands crosses a chunk edge where the field puts it,
// ragged as anywhere, and still no open edge tile is shut in where neither
// chunk may carve:
//   - one tile in from the edge, the field's own answer: its inner
//     neighbour is the chunk's to carve;
//   - on the edge, open only if the tile inside it is open, or the facing
//     tile across the edge and the one inside that are (a kept chunk across
//     is never relied on: its side was decided without this one);
//   - in a 4×4 block where four chunks meet, open land the field gives,
//     kept where it joins something open round the block (or open ground in
//     it that isn't field: a route, a gap, a seam), and shut where it
//     doesn't.
//
// Everything it reads is world-coordinate, so both neighbours agree.
func (w *world) edgeOpen(tx, ty int, at func(tx, ty int) baseTile, corners map[[2]int][]bool) bool {
	S := chunkSize()
	cx, cy := floorDiv(tx, S), floorDiv(ty, S)
	lx, ly := tx-cx*S, ty-cy*S
	edgeX := lx < band || lx >= S-band
	edgeY := ly < band || ly >= S-band
	if edgeX && edgeY {
		vx, vy := cx*S, cy*S
		if lx >= S-band {
			vx += S
		}
		if ly >= S-band {
			vy += S
		}
		open, ok := corners[[2]int{vx, vy}]
		if !ok {
			open = w.cornerBlock(vx, vy, at)
			corners[[2]int{vx, vy}] = open
		}
		return open[(ty-vy+band)*2*band+tx-vx+band]
	}
	return w.columnOpen(tx, ty, at)
}

// columnOpen is edgeOpen for an edge tile outside the corner blocks (it
// reads only its own column across the edge).
func (w *world) columnOpen(tx, ty int, at func(tx, ty int) baseTile) bool {
	S := chunkSize()
	t := at(tx, ty)
	if t.kind != bField {
		return t.walk
	}
	if !t.walk {
		return false
	}
	cx, cy := floorDiv(tx, S), floorDiv(ty, S)
	lx, ly := tx-cx*S, ty-cy*S
	var ox, oy int // outward
	switch {
	case lx == 0:
		ox = -1
	case lx == S-1:
		ox = 1
	case ly == 0:
		oy = -1
	case ly == S-1:
		oy = 1
	default:
		return true // one in from the edge
	}
	if at(tx-ox, ty-oy).walk {
		return true
	}
	if EpochKindAt(cx+ox, cy+oy) != w.e.Kind {
		return false
	}
	return at(tx+ox, ty+oy).walk && at(tx+2*ox, ty+2*oy).walk
}

// cornerBlock decides the 4×4 block of edge tiles round the corner where
// chunks meet at tile (vx, vy) (the first tile east and south of the
// meeting point): row-major from (vx-band, vy-band), true for open.
func (w *world) cornerBlock(vx, vy int, at func(tx, ty int) baseTile) []bool {
	const n = 2 * band
	open := make([]bool, n*n)
	cand := make([]bool, n*n)
	var queue []int
	for i := range open {
		t := at(vx-band+i%n, vy-band+i/n)
		switch {
		case t.kind != bField && t.walk:
			open[i] = true
			queue = append(queue, i)
		case t.kind == bField && t.walk:
			cand[i] = true
		}
	}
	// Open edge tiles round the block (all outside the corner blocks).
	for i := range cand {
		if !cand[i] || open[i] {
			continue
		}
		x, y := vx-band+i%n, vy-band+i/n
		for _, d := range dirs4 {
			nx, ny := x+d[0], y+d[1]
			if nx >= vx-band && nx < vx+band && ny >= vy-band && ny < vy+band {
				continue
			}
			if w.columnOpen(nx, ny, at) {
				open[i] = true
				queue = append(queue, i)
				break
			}
		}
	}
	for len(queue) > 0 {
		i := queue[0]
		queue = queue[1:]
		for _, d := range dirs4 {
			x, y := i%n+d[0], i/n+d[1]
			if x < 0 || y < 0 || x >= n || y >= n {
				continue
			}
			if j := y*n + x; cand[j] && !open[j] {
				open[j] = true
				queue = append(queue, j)
			}
		}
	}
	return open
}

// gapAt: is the tile in an edge gap (its chunk's two edge tiles)?
func (w *world) gapAt(tx, ty int, lg landGrounds) (Ground, bool) {
	S := chunkSize()
	cx, cy := floorDiv(tx, S), floorDiv(ty, S)
	lx, ly := tx-cx*S, ty-cy*S
	try := func(k gapKey, along int) (Ground, bool) {
		o := w.gapOffset(k)
		if o < 0 || along < o || along >= o+gapWidth {
			return 0, false
		}
		if along == o+gapWidth/2 {
			return lg.path, true
		}
		return lg.verge, true
	}
	if lx <= 1 {
		if g, ok := try(edgeKey(cx, cy, -1, 0), ly); ok {
			return g, true
		}
	}
	if lx >= S-2 {
		if g, ok := try(edgeKey(cx, cy, 1, 0), ly); ok {
			return g, true
		}
	}
	if ly <= 1 {
		if g, ok := try(edgeKey(cx, cy, 0, -1), lx); ok {
			return g, true
		}
	}
	if ly >= S-2 {
		if g, ok := try(edgeKey(cx, cy, 0, 1), lx); ok {
			return g, true
		}
	}
	return 0, false
}

// seamOrder: the four sides first, then the corners.
var seamOrder = [8][2]int{{0, -1}, {1, 0}, {0, 1}, {-1, 0}, {1, -1}, {1, 1}, {-1, 1}, {-1, -1}}

// seamMirror: within two tiles of a chunk of another epoch kind, the kept
// tile this one mirrors (across the shared edge, or the shared corner).
func (w *world) seamMirror(tx, ty int) (int, int, bool) {
	if !w.wick {
		return 0, 0, false // only the newer side copies
	}
	S := chunkSize()
	cx, cy := floorDiv(tx, S), floorDiv(ty, S)
	lx, ly := tx-cx*S, ty-cy*S
	for _, d := range seamOrder {
		if EpochKindAt(cx+d[0], cy+d[1]) == w.e.Kind {
			continue
		}
		mx, my := tx, ty
		switch {
		case d[0] > 0 && lx >= S-2:
			mx = (cx+1)*S + (S - 1 - lx)
		case d[0] < 0 && lx <= 1:
			mx = cx*S - 1 - lx
		case d[0] != 0:
			continue
		}
		switch {
		case d[1] > 0 && ly >= S-2:
			my = (cy+1)*S + (S - 1 - ly)
		case d[1] < 0 && ly <= 1:
			my = cy*S - 1 - ly
		case d[1] != 0:
			continue
		}
		return mx, my, true
	}
	return 0, 0, false
}
