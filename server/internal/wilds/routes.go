package wilds

import "glimway/content"

// Pass 5, routes (open-map.md 2.2). Every two side-by-side cells are joined
// by a route: place to place, or a place to a footprint's port on the side
// facing it. A route is a seeded midpoint-displaced polyline between its
// two ends, kept inside its two cells (with a margin), so a tile's routes
// are only its own cell's four links, and any chunk computes them the same.
//
// Ports. The Whitequiet is made in the same wick epoch as the land around
// it, so a route runs a few tiles into it (on its north side, into the
// lantern-road opening). The Tangle is kept (still epoch): a route ends just
// outside it at its edge gap on that side, which the wick chunk there copies
// across the seam; it stays out of the Tangle's chunks everywhere else.
//
// Edge gaps. So that every chunk joins its four neighbours whatever the
// routes do, every chunk edge has one gap: a 3-tile opening through the two
// edge tiles each side, at an offset hashed from the epoch and the edge,
// moved clear of the river's water. Both chunks of an edge compute it the
// same; at a seam the kept side's gap is the one that stands.

const (
	routeMargin = 6 * fp // a route keeps this far inside its two cells
	routePath   = 205    // fp from the centre line: the trodden line
	routeVerge  = 435    // ... and its verge
	keptMargin  = 6 * fp // a route keeps this far from a kept footprint
	gapWidth    = 3
	gapLo       = 4 // an edge gap keeps clear of the chunk's corners
)

type route struct {
	line *line
}

// cellLinks are the routes of a cell's four sides.
func (w *world) cellLinks(x, y int) []*route {
	var out []*route
	for _, d := range dirs4 {
		if r := w.routeBetween([2]int{x, y}, [2]int{x + d[0], y + d[1]}); r != nil {
			out = append(out, r)
		}
	}
	return out
}

// routeBetween is the route joining two side-by-side cells, or nil.
func (w *world) routeBetween(a, b [2]int) *route {
	if !w.wick {
		return nil
	}
	if b[0] < a[0] || (b[0] == a[0] && b[1] < a[1]) {
		a, b = b, a
	}
	key := [4]int{a[0], a[1], b[0], b[1]}
	if r, ok := w.routes[key]; ok {
		return r
	}
	w.routes[key] = nil
	if FootprintCell(a[0], a[1]) && FootprintCell(b[0], b[1]) {
		return nil // the footprints meet at their own opening
	}
	pa, wa, okA := w.routeEnd(a, b)
	pb, wb, okB := w.routeEnd(b, a)
	if !okA || !okB {
		return nil
	}
	inside := cellBox(a[0], a[1])
	cb := cellBox(b[0], b[1])
	inside = box{min(inside.x0, cb.x0), min(inside.y0, cb.y0), max(inside.x1, cb.x1), max(inside.y1, cb.y1)}.grow(-routeMargin)
	kept := w.keptBoxes()
	fix := func(p pt) pt {
		p.x, p.y = clamp(p.x, inside.x0, inside.x1), clamp(p.y, inside.y0, inside.y1)
		for _, k := range kept {
			p = pushOut(p, k.grow(keptMargin))
		}
		return p
	}
	rng := NewRng(w.e.hash("route", a[0], a[1], b[0], b[1]))
	mid := displace(wa, wb, 3, 300, rng, fix)
	pts := append([]pt{pa}, mid...)
	pts = append(pts, pb)
	pts = dedupe(pts)
	// Round any kept footprint's corner the route still cuts.
	for pass := 0; pass < 3; pass++ {
		cut := false
		for i := 0; i+1 < len(pts) && !cut; i++ {
			for _, k := range kept {
				if segMeetsBox(pts[i], pts[i+1], k) {
					c := nearestCorner(k.grow(keptMargin), pt{(pts[i].x + pts[i+1].x) / 2, (pts[i].y + pts[i+1].y) / 2})
					pts = append(pts[:i+1], append([]pt{c}, pts[i+1:]...)...)
					cut = true
					break
				}
			}
		}
		if !cut {
			break
		}
	}
	r := &route{line: newLine(pts, nil)}
	r.line.boxes = nil
	for i := 0; i+1 < len(pts); i++ {
		r.line.boxes = append(r.line.boxes, segBox(pts[i], pts[i+1]).grow(routeVerge))
	}
	w.routes[key] = r
	return r
}

// routeEnd is where a route leaves cell c toward cell to: the end itself
// and the waypoint its bends start from.
func (w *world) routeEnd(c, to [2]int) (end, way pt, ok bool) {
	if p := w.place(c[0], c[1]); p != nil {
		x, y := p.front()
		e := tileCentre(x, y)
		return e, e, true
	}
	if !FootprintCell(c[0], c[1]) {
		return pt{}, pt{}, false
	}
	cx0, cy0 := cellChunk0(c[0], c[1])
	n := int(contentRules().GetCells().GetCellChunks())
	for _, f := range content.PlacesRules.GetFixed() {
		x0, y0, x1, y1 := content.FixedChunks(f)
		if cx0 > x1 || cx0+n-1 < x0 || cy0 > y1 || cy0+n-1 < y0 {
			continue
		}
		end, way, ok = w.fixedPort(f, to[0]-c[0], to[1]-c[1])
		if !ok {
			return pt{}, pt{}, false
		}
		tx, ty := end.tile()
		px, py := CellOf(floorDiv(tx-(to[0]-c[0]), chunkSize()), floorDiv(ty-(to[1]-c[1]), chunkSize()))
		// A partially occupied cell owns only the mouths on its own fixed tiles.
		if px != c[0] || py != c[1] {
			return pt{}, pt{}, false
		}
		return end, way, true
	}
	foot := FootprintAt(cx0, cy0)
	if foot == nil {
		return pt{}, pt{}, false
	}
	return w.port(foot, to[0]-c[0], to[1]-c[1])
}

// fixedPort joins an authored road/spine mouth to the generated network.
// Ends stand just outside fixed ground; waypoints keep the bends away from
// its collision. Internal town/lot joins need no generated route.
func (w *world) fixedPort(p *content.FixedPlace, dx, dy int) (end, way pt, ok bool) {
	var x, y int
	switch p.GetId() {
	case "hearthwick":
		switch {
		case dx > 0:
			x, y = 47, 59
		case dx < 0:
			return pt{}, pt{}, false
		case dy > 0:
			x, y = 9, 95
		default:
			x, y = 2, 24
		}
	case "homestead-lots":
		switch {
		case dx < 0:
			x, y = -72, 69
		case dx > 0:
			return pt{}, pt{}, false
		case dy > 0:
			x, y = -49, 119
		default:
			x, y = -49, 24
		}
	default:
		return pt{}, pt{}, false
	}
	return tileCentre(x+dx, y+dy), tileCentre(x+dx*10, y+dy*10), true
}

// port is a footprint's end of a route leaving it by side (dx, dy).
func (w *world) port(p *content.WildsPlace, dx, dy int) (end, way pt, ok bool) {
	S := chunkSize()
	x0, y0 := int(p.GetCx()), int(p.GetCy())
	pw, ph := int(p.GetWidth()), int(p.GetHeight())
	// The chunk in the middle of that side, and the one beyond it.
	cx, cy := x0+pw/2, y0+ph/2
	switch {
	case dx > 0:
		cx = x0 + pw - 1
	case dx < 0:
		cx = x0
	case dy > 0:
		cy = y0 + ph - 1
	default:
		cy = y0
	}
	if dy > int(contentRules().GetFrontier().GetSouthLimit())-cy {
		return pt{}, pt{}, false // nothing south of the limit
	}
	if p.GetEpochKind() == w.e.Kind {
		// Same epoch: a few tiles inside, at the side's opening if it has
		// one, else at a hashed offset.
		for _, o := range p.GetOpenings() {
			if int(o.GetCx()) == cx && int(o.GetCy()) == cy && o.GetEdge() == sideName(dx, dy) {
				mx, my := openingMiddle(o)
				return tileCentre(mx-dx*4, my-dy*4), tileCentre(mx+dx*8, my+dy*8), true
			}
		}
		off := gapLo + int(w.e.hash("port", p.GetId(), dx, dy)%uint32(S-2*gapLo))
		mx, my := edgeTile(cx, cy, dx, dy, off)
		return tileCentre(mx-dx*4, my-dy*4), tileCentre(mx+dx*8, my+dy*8), true
	}
	if w.e.Kind != EpochWick {
		return pt{}, pt{}, false
	}
	// A kept footprint: just outside its gap on that side.
	off := w.still().gapOffset(edgeKey(cx, cy, dx, dy))
	if off < 0 {
		off = S/2 - 1
	}
	mx, my := edgeTile(cx, cy, dx, dy, off+gapWidth/2)
	return tileCentre(mx+dx, my+dy), tileCentre(mx+dx*10, my+dy*10), true
}

// edgeTile is the tile of chunk (cx, cy) on its side (dx, dy) at offset
// along it.
func edgeTile(cx, cy, dx, dy, off int) (int, int) {
	S := chunkSize()
	switch {
	case dx > 0:
		return cx*S + S - 1, cy*S + off
	case dx < 0:
		return cx * S, cy*S + off
	case dy > 0:
		return cx*S + off, cy*S + S - 1
	default:
		return cx*S + off, cy * S
	}
}

func sideName(dx, dy int) string {
	switch {
	case dx > 0:
		return "east"
	case dx < 0:
		return "west"
	case dy > 0:
		return "south"
	}
	return "north"
}

// keptBoxes are the footprints of another epoch kind than this world's (a
// wick world's view of the Tangle).
func (w *world) keptBoxes() []box {
	var out []box
	for _, p := range contentRules().Places {
		if p.GetEpochKind() != w.e.Kind {
			out = append(out, footprintBox(p))
		}
	}
	for _, p := range content.PlacesRules.GetFixed() {
		out = append(out, fixedBox(p))
	}
	return out
}

// pushOut moves a point inside b to b's nearest side.
func pushOut(p pt, b box) pt {
	if !b.has(p) {
		return p
	}
	l, r, t, u := p.x-b.x0, b.x1-p.x, p.y-b.y0, b.y1-p.y
	switch min(l, r, t, u) {
	case l:
		p.x = b.x0 - 1
	case r:
		p.x = b.x1 + 1
	case t:
		p.y = b.y0 - 1
	default:
		p.y = b.y1 + 1
	}
	return p
}

func nearestCorner(b box, p pt) pt {
	x, y := b.x0-1, b.y0-1
	if p.x-b.x0 > b.x1-p.x {
		x = b.x1 + 1
	}
	if p.y-b.y0 > b.y1-p.y {
		y = b.y1 + 1
	}
	return pt{x, y}
}

// segMeetsBox: does any point of ab (sampled every half tile) lie in b?
func segMeetsBox(a, b pt, k box) bool {
	if !segBox(a, b).meets(k) {
		return false
	}
	dx, dy := b.x-a.x, b.y-a.y
	n := max(isqrt(dx*dx+dy*dy)/(fp/2), 1)
	for i := 0; i <= n; i++ {
		if k.has(pt{a.x + dx*i/n, a.y + dy*i/n}) {
			return true
		}
	}
	return false
}

func dedupe(pts []pt) []pt {
	out := pts[:1]
	for _, p := range pts[1:] {
		if p != out[len(out)-1] {
			out = append(out, p)
		}
	}
	return out
}

// ---------------------------------------------------------------- gaps

// gapKey names a chunk edge: vertical, the edge east of (cx, cy); else the
// edge south of it.
type gapKey struct {
	vertical bool
	cx, cy   int
}

// edgeKey is the key of chunk (cx, cy)'s side (dx, dy).
func edgeKey(cx, cy, dx, dy int) gapKey {
	switch {
	case dx > 0:
		return gapKey{true, cx, cy}
	case dx < 0:
		return gapKey{true, cx - 1, cy}
	case dy > 0:
		return gapKey{false, cx, cy}
	}
	return gapKey{false, cx, cy - 1}
}

// gapOffset is where the edge's 3-tile gap starts along it, or -1 for none.
func (w *world) gapOffset(k gapKey) int {
	if o, ok := w.gaps[k]; ok {
		return o
	}
	o := w.findGap(k)
	w.gaps[k] = o
	return o
}

func (w *world) findGap(k gapKey) int {
	S := chunkSize()
	ax, ay, bx, by := k.cx, k.cy, k.cx, k.cy+1
	if k.vertical {
		bx, by = k.cx+1, k.cy
	}
	if by > int(contentRules().GetFrontier().GetSouthLimit()) || FixedFootprintAt(ax, ay) != nil || FixedFootprintAt(bx, by) != nil {
		return -1
	}
	// An edge with a footprint's fixed opening needs no gap.
	for _, p := range contentRules().Places {
		for _, o := range p.GetOpenings() {
			dx, dy := sideStep(o.GetEdge())
			if edgeKey(int(o.GetCx()), int(o.GetCy()), dx, dy) == k {
				return -1
			}
		}
	}
	lo, hi := gapLo, S-gapLo-gapWidth
	start := int(w.e.hash("gap", boolInt(k.vertical), k.cx, k.cy) % uint32(hi-lo+1))
	for i := 0; i <= hi-lo; i++ {
		off := lo + (start+i)%(hi-lo+1)
		if w.gapDry(k, ax, ay, bx, by, off) {
			return off
		}
	}
	return -1
}

// gapDry: no tile of the gap (two deep each side) is water or within a tile
// of it.
func (w *world) gapDry(k gapKey, ax, ay, bx, by, off int) bool {
	if w.river == nil {
		return true
	}
	S := chunkSize()
	for along := off; along < off+gapWidth; along++ {
		for depth := -2; depth < 2; depth++ {
			var tx, ty int
			if k.vertical {
				tx, ty = bx*S+depth, ay*S+along
			} else {
				tx, ty = ax*S+along, by*S+depth
			}
			d, half, _ := w.river.line.nearest(tileCentre(tx, ty), nil)
			r := int64(half + fp)
			if d <= r*r {
				return false
			}
		}
	}
	return true
}

func sideStep(edge string) (int, int) {
	switch edge {
	case "east":
		return 1, 0
	case "west":
		return -1, 0
	case "south":
		return 0, 1
	}
	return 0, -1
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
