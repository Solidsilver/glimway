package wilds

// Pass 2, lands (open-map.md 2.2, decisions 15 to 17). The world is cut
// into land cells of landCellChunks square; each holds one seeded point
// with a land kind (drawn by content weight, leaning by direction from the
// gate) and a size in chunks across (drawn from the landSizes bands). A
// tile belongs to the point with the least distance/size among those within
// half the cap, measured from the tile's position warped by a little
// world-coordinate noise, so borders are soft and no patch is wider than
// the cap. Land within river.leanChunks of the Wend leans to the river's
// land (decision 17's lean of the Wend and its meadow into the first ring).
//
// Breaks. With two lands, drawn patches of one kind join into runs far
// longer than the cap (and no colouring of a map of patches can stop that),
// so decision 17's "whichever way you walk, the land changes within the
// cap" needs a rule of its own: thin wavy breaks every breakSpacing chunks
// each way, where the land turns to the other kind (a ride through woods,
// a belt of trees across meadow). Any straight walk of the cap's length
// crosses a break, and crossing one always changes the land around you.
//
// The footprints keep their own land (the Tangle and the Whitequiet are
// woods) whatever the fields say.

import "glimway/content"

const (
	breakSpacingChunks = 11 // 11·√2 plus a break's width stays under the cap of 20
	breakHalfWidth     = 6  // tiles each side of a break's centre line
	breakWarp          = 18 // tiles a break's centre line wanders
)

// landPoint is one land cell's seeded point: its world tile, size in chunks
// and land (content index).
type landPoint struct {
	x, y, size, land int
}

func landCellTiles() int { return int(contentRules().GetLandSizes().GetLandCellChunks()) * chunkSize() }

// landPoint is the point of land cell (lx, ly).
func (w *world) landPoint(lx, ly int) landPoint {
	if p, ok := w.landPts[[2]int{lx, ly}]; ok {
		return p
	}
	data := contentRules()
	L := landCellTiles()
	rng := NewRng(w.e.hash("land", lx, ly))
	p := landPoint{x: lx*L + L*rng.Between(150, 850)/1000, y: ly*L + L*rng.Between(150, 850)/1000}
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
	grown := b.grow(reach + landWarpMax())
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

// capReach is half the cap, in fp: no point owns a tile further away.
func capReach() int {
	return int(contentRules().GetLandSizes().GetCapChunks()) * chunkSize() * fp / 2
}

// landWarp: how far a tile's position wanders before its land is read, a
// coarse warp (borders curl) and a fine one (borders fray). In fp.
func landWarpAmp() int {
	return int(contentRules().GetLandSizes().GetBorderNoisePermille()) * chunkSize() * 2 * fp / 1000
}
func landWarpMax() int { return landWarpAmp() + 3*fp/2 }

func (w *world) warped(tx, ty int) pt {
	amp := landWarpAmp()
	p := tileCentre(tx, ty)
	p.x += (w.warpX.at(tx*fp/12, ty*fp/12)-noiseMid)*amp>>16 + (w.dither.at(tx*fp/3, ty*fp/3)-noiseMid)*3*fp/2>>16
	p.y += (w.warpY.at(tx*fp/12, ty*fp/12)-noiseMid)*amp>>16 + (w.dither.at(tx*fp/3+97*fp, ty*fp/3)-noiseMid)*3*fp/2>>16
	return p
}

// fieldLand is the land the points give a tile (before the river's lean,
// the breaks and the footprints).
func (w *world) fieldLand(tx, ty int, pts []landPoint) int {
	p := w.warped(tx, ty)
	reach := int64(capReach())
	best, bestD, bestS := -1, int64(0), int64(1)
	near, nearD := 0, int64(-1)
	for _, q := range pts {
		c := tileCentre(q.x, q.y)
		dx, dy := int64(p.x-c.x), int64(p.y-c.y)
		d := dx*dx + dy*dy
		if nearD < 0 || d < nearD {
			near, nearD = q.land, d
		}
		if d > reach*reach {
			continue
		}
		s := int64(q.size)
		if best < 0 || d*bestS*bestS < bestD*s*s {
			best, bestD, bestS = q.land, d, s
		}
	}
	if best < 0 {
		return near // nothing within reach (can't happen with the window): the nearest
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

// inBreak is true on a break's tiles (vertical breaks XOR horizontal ones,
// so where two cross the land is the field's again).
func (w *world) inBreak(tx, ty int) bool {
	return w.onBreak(tx, ty, w.breakX, "x") != w.onBreak(ty, tx, w.breakY, "y")
}

// onBreak: is `along` within a break line of its axis at `across`?
func (w *world) onBreak(along, across int, n noise, axis string) bool {
	D := breakSpacingChunks * chunkSize()
	phase := int(w.e.hash("break-phase", axis) % uint32(D))
	k0 := floorDiv(along-phase, D)
	for k := k0; k <= k0+1; k++ {
		c := k*D + phase + (n.at(k*5*fp+37, across*fp/36)-noiseMid)*2*breakWarp>>16
		if abs(along-c) <= breakHalfWidth {
			return true
		}
	}
	return false
}

// landAt is a tile's land (content index), every rule applied. riverD2 is
// the tile's squared distance to the Wend's centre line (-1: no river).
func (w *world) landAt(tx, ty int, pts []landPoint, riverD2 int64) int {
	S := chunkSize()
	if p := FootprintAt(floorDiv(tx, S), floorDiv(ty, S)); p != nil {
		return landIndex(p.GetLand())
	}
	l := w.fieldLand(tx, ty, pts)
	if w.riverLean(tx, ty, riverD2) && riverLeanLand >= 0 {
		l = riverLeanLand
	}
	if w.inBreak(tx, ty) {
		l = (l + 1) % len(contentRules().Lands)
	}
	return l
}

// landOne is landAt for a lone tile (it finds its own points and river
// distance).
func (w *world) landOne(tx, ty int) int {
	b := tileBox(tx, ty, tx, ty)
	return w.landAt(tx, ty, w.landPointsNear(b), w.riverD2(tileCentre(tx, ty)))
}

// riverD2 is a point's squared distance to the Wend's centre line, or -1.
func (w *world) riverD2(p pt) int64 {
	if w.river == nil {
		return -1
	}
	d, _, _ := w.river.line.nearest(p, nil)
	return d
}

// landName is a content land's id.
func landName(i int) string { return contentRules().Lands[i].GetId() }

func landData(i int) *content.WildsLand { return contentRules().Lands[i] }
