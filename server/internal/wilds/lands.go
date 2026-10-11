package wilds

// Pass 2, lands (open-map.md 2.2, decisions 15 to 17). The world is cut
// into land cells of landCellChunks square; each holds one seeded point
// with a land kind (drawn by content weight, leaning by direction from the
// gate) and a size in chunks across (drawn from the landSizes bands). A
// tile belongs to the point with the least distance/size, measured from the
// tile's position warped by a little world-coordinate noise so borders curl
// and fray, among the points close enough that no patch is wider than the
// cap. Land within river.leanChunks of the Wend leans to the river's land
// (decision 17's lean of the Wend and its meadow into the first ring).
//
// Hems (decision 17: "whichever way you walk, the land changes within the
// cap"). Where two patches of one land meet, a hem of another land runs
// along their shared border: a ride between two woods, a line of trees
// between two meadows. A patch is never wider than the cap, and leaving one
// always crosses a change of land (the next patch's, or a hem), so any
// straight walk of the cap's length meets one. A hem follows the patches'
// own borders, so it makes no pattern of its own, and it works for any
// number of lands (two patches of one land, whichever). Whether a tile is
// hem is read from the owners of the tiles round it (hemOffsets), so it is
// the same from any chunk. The footprints count as patches of their own
// land: woods round the Tangle and the Whitequiet get a hem too.
//
// Islands. A point of islandChunks or less takes the other land from its
// biggest neighbour, so very small patches are clearings and copses, not
// more of the same ringed by a hem.

import "glimway/content"

// A tile is hem when a tile hemRadii away from it (eight ways, out to its
// own radius) belongs to another patch of the same land. The radius
// wanders along a border between the smallest and hemTiles, so a hem
// narrows and widens but never closes.
const hemTiles = 6

var hemRadii = []int{2, 4, hemTiles}

var hemOffsets = func() [][][2]int {
	var out [][][2]int
	for _, r := range hemRadii {
		d := r * 707 / 1000
		out = append(out, [][2]int{{r, 0}, {d, d}, {0, r}, {-d, d}, {-r, 0}, {-d, -d}, {0, -r}, {d, -d}})
	}
	return out
}()

// islandChunks: a point this small takes the other land from its biggest
// neighbour's, so a small patch is a clearing in the woods or a copse in the
// meadow (decision 16's very small patches) rather than more of the same.
const islandChunks = 3

// landPoint is one land cell's seeded point: its cell, world tile, size in
// chunks and land (content index).
type landPoint struct {
	lx, ly, x, y, size, land int
}

// owner names a patch: a land point by its cell, or a footprint (fp set,
// lx its index in content places).
type owner struct {
	lx, ly int
	fp     bool
}

func landCellTiles() int { return int(contentRules().GetLandSizes().GetLandCellChunks()) * chunkSize() }

// landPoint is the point of land cell (lx, ly), its land settled: a small
// point takes the other land from its biggest neighbour's drawn land (the
// eight cells round it; ties to the first in row order).
func (w *world) landPoint(lx, ly int) landPoint {
	if p, ok := w.landFinal[[2]int{lx, ly}]; ok {
		return p
	}
	p := w.drawnPoint(lx, ly)
	if p.size <= islandChunks {
		var big landPoint
		for dy := -1; dy <= 1; dy++ {
			for dx := -1; dx <= 1; dx++ {
				if q := w.drawnPoint(lx+dx, ly+dy); (dx != 0 || dy != 0) && q.size > big.size {
					big = q
				}
			}
		}
		if big.size > islandChunks {
			p.land = hemLand(big.land)
		}
	}
	w.landFinal[[2]int{lx, ly}] = p
	return p
}

// drawnPoint is the point of land cell (lx, ly) as drawn.
func (w *world) drawnPoint(lx, ly int) landPoint {
	if p, ok := w.landPts[[2]int{lx, ly}]; ok {
		return p
	}
	data := contentRules()
	L := landCellTiles()
	rng := NewRng(w.e.hash("land", lx, ly))
	p := landPoint{lx: lx, ly: ly, x: lx*L + L*rng.Between(200, 800)/1000, y: ly*L + L*rng.Between(200, 800)/1000}
	sizes := data.GetLandSizes()
	var bw []int
	for _, b := range sizes.GetBands() {
		bw = append(bw, int(b.GetWeight()))
	}
	band := sizes.GetBands()[weighted(rng, bw)]
	p.size = min(rng.Between(int(band.GetMinChunks()), int(band.GetMaxChunks())), int(sizes.GetCapChunks()))
	// Each land's weight, leaning by direction: a point lying the way a
	// land leans (from the gate) weighs up to lean.permille more, one lying
	// the other way that much less.
	gx, gy := gateTile()
	vx, vy := p.x-gx, p.y-gy
	vl := isqrt(vx*vx + vy*vy)
	var lw []int
	for _, l := range data.Lands {
		wt := int(l.GetWeight()) * 1000
		if ln := l.GetLean(); ln != nil && vl > 0 && (ln.GetDx() != 0 || ln.GetDy() != 0) {
			dx, dy := int(ln.GetDx()), int(ln.GetDy())
			cos := (dx*vx + dy*vy) * 1000 / (isqrt(dx*dx+dy*dy) * vl)
			wt = wt * (1000 + int(ln.GetPermille())*cos/1000) / 1000
		}
		lw = append(lw, max(wt, 1))
	}
	p.land = weighted(rng, lw)
	w.landPts[[2]int{lx, ly}] = p
	return p
}

// landPointsNear lists the points that can own a tile of b: those within
// half the cap of it, from the land cells of the window around it.
func (w *world) landPointsNear(b box) []landPoint {
	L := landCellTiles()
	reach := capReach()
	half := int(contentRules().GetLandSizes().GetWindowCells()) / 2
	x0, y0 := floorDiv(b.x0/fp, L), floorDiv(b.y0/fp, L)
	x1, y1 := floorDiv(b.x1/fp, L), floorDiv(b.y1/fp, L)
	grown := b.grow(reach + landWarpMax() + hemTiles*fp)
	var out []landPoint
	for ly := y0 - half; ly <= y1+half; ly++ {
		for lx := x0 - half; lx <= x1+half; lx++ {
			p := w.landPoint(lx, ly)
			if grown.has(tileCentre(p.x, p.y)) {
				out = append(out, p)
			}
		}
	}
	return out
}

// capReach is how far (fp, in warped positions) a point owns tiles: half
// the cap less the warp each side, so no patch is wider than the cap.
func capReach() int {
	return int(contentRules().GetLandSizes().GetCapChunks())*chunkSize()*fp/2 - 2*landWarpMax()
}

// landWarp: how far a tile's position wanders before its land is read, a
// coarse warp (borders curl, up to amp/2 each way) and a fine one (borders
// fray, up to 3/4 tile). In fp.
func landWarpAmp() int {
	return int(contentRules().GetLandSizes().GetBorderNoisePermille()) * chunkSize() * 2 * fp / 1000
}
func landWarpMax() int { return landWarpAmp()/2 + 3*fp/4 + 1 }

func (w *world) warped(tx, ty int) pt {
	amp := landWarpAmp()
	p := tileCentre(tx, ty)
	p.x += (w.warpX.at(tx*fp/12, ty*fp/12)-noiseMid)*amp>>16 + (w.dither.at(tx*fp/3, ty*fp/3)-noiseMid)*3*fp/2>>16
	p.y += (w.warpY.at(tx*fp/12, ty*fp/12)-noiseMid)*amp>>16 + (w.dither.at(tx*fp/3+97*fp, ty*fp/3)-noiseMid)*3*fp/2>>16
	return p
}

// fieldOwner is the point that owns a tile (an index into pts): the least
// distance/size within reach, or the nearest if none is (which the window
// and the jitter rule out).
func (w *world) fieldOwner(tx, ty int, pts []landPoint) int {
	p := w.warped(tx, ty)
	reach := int64(capReach())
	best, bestD, bestS := -1, int64(0), int64(1)
	near, nearD := 0, int64(-1)
	for i, q := range pts {
		c := tileCentre(q.x, q.y)
		dx, dy := int64(p.x-c.x), int64(p.y-c.y)
		d := dx*dx + dy*dy
		if nearD < 0 || d < nearD {
			near, nearD = i, d
		}
		if d > reach*reach {
			continue
		}
		s := int64(q.size)
		if best < 0 || d*bestS*bestS < bestD*s*s {
			best, bestD, bestS = i, d, s
		}
	}
	if best < 0 {
		return near
	}
	return best
}

// patchAt is a tile's patch and the land it gives there (the river's pull
// applied; a footprint's own land in a footprint).
func (w *world) patchAt(tx, ty int, pts []landPoint, riverD2 int64) (owner, int) {
	S := chunkSize()
	cx, cy := floorDiv(tx, S), floorDiv(ty, S)
	for i, p := range contentRules().Places {
		if FootprintDistance(p, cx, cy) == 0 {
			return owner{lx: i, fp: true}, landIndex(p.GetLand())
		}
	}
	q := pts[w.fieldOwner(tx, ty, pts)]
	l := q.land
	if riverLeanLand >= 0 && w.riverLean(tx, ty, riverD2) {
		l = riverLeanLand
	}
	return owner{lx: q.lx, ly: q.ly}, l
}

// hemLand is the land a hem between two patches of land l takes: the
// heaviest other land.
func hemLand(l int) int {
	best := -1
	for i, d := range contentRules().Lands {
		if i != l && (best < 0 || d.GetWeight() > contentRules().Lands[best].GetWeight()) {
			best = i
		}
	}
	if best < 0 {
		return l
	}
	return best
}

// riverLean is true where the Wend pulls the land to its own (riverD2 is
// the tile's squared distance to the river's centre line, -1 for none). The
// pull is strongest at the water and fades to nothing at leanChunks, in
// noisy patches, so the river runs through meadow with woods coming down
// to it here and there.
func (w *world) riverLean(tx, ty int, riverD2 int64) bool {
	r := int(contentRules().GetRiver().GetLeanChunks()) * chunkSize() * fp
	if riverD2 < 0 || r <= 0 || riverD2 >= int64(r)*int64(r) {
		return false
	}
	pull := (r - isqrt64(riverD2)) * 1300 / r
	return w.warpX.at(tx*fp/10+51*fp, ty*fp/10)*1000>>16 < pull
}

var riverLeanLand = landIndex(contentRules().GetRiver().GetLeanLand())

// landFrom is a tile's land given how to read any tile's patch: a
// footprint's own land inside it; else its patch's land, or a hem where a
// tile within its hem radius lies in another patch of the same land.
func (w *world) landFrom(tx, ty int, patch func(tx, ty int) (owner, int)) int {
	o, l := patch(tx, ty)
	if o.fp {
		return l
	}
	reach := w.hemRadius(tx, ty)
	for k, r := range hemRadii {
		if r > reach {
			break
		}
		for _, d := range hemOffsets[k] {
			if o2, l2 := patch(tx+d[0], ty+d[1]); o2 != o && l2 == l {
				return hemLand(l)
			}
		}
	}
	return l
}

// hemRadius is how far a hem reaches at a tile: one of hemRadii, by a
// noise field a few chunks across.
func (w *world) hemRadius(tx, ty int) int {
	v := w.warpY.at(tx*fp/40+33*fp, ty*fp/40)
	return hemRadii[v*len(hemRadii)>>16]
}

// landOne is a lone tile's land, every rule applied.
func (w *world) landOne(tx, ty int) int {
	pts := w.landPointsNear(tileBox(tx, ty, tx, ty))
	return w.landFrom(tx, ty, func(x, y int) (owner, int) {
		return w.patchAt(x, y, pts, w.riverD2Near(tileCentre(x, y)))
	})
}

// riverLeanReach is the furthest from the Wend's centre (fp) its pull or
// its water and bank reach.
func riverLeanReach() int {
	return int(contentRules().GetRiver().GetLeanChunks())*chunkSize()*fp + 8*fp
}

// riverD2Near is a point's squared distance to the Wend's centre line when
// it is within riverLeanReach, else -1 (as fill reads it).
func (w *world) riverD2Near(p pt) int64 {
	if w.river == nil {
		return -1
	}
	segs := w.river.line.segs(box{p.x, p.y, p.x, p.y}, riverLeanReach())
	if len(segs) == 0 {
		return -1
	}
	d, _, _ := w.river.line.nearest(p, segs)
	return d
}

// landName is a content land's id.
func landName(i int) string { return contentRules().Lands[i].GetId() }

func landData(i int) *content.WildsLand { return contentRules().Lands[i] }
