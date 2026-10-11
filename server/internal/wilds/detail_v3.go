package wilds

import (
	"slices"
)

// Pass 6, detail (open-map.md 2.2): woods_v2's passes, fed the base instead
// of exits. Inside a chunk's two edge tiles (which are its base, never
// edited) it opens clearings round places, sites and entities, lays paths
// from the woods' mouths and every point to the routes (or a hub), adds
// glades, spurs and stretches of old road in the woods, makes sure every
// open edge tile and every point reaches the rest, and dresses it all by
// each tile's land (content decor weights).
//
// Readability rules as v2: entities, sites and places keep a decor-free
// surround; blocking pieces stand only on solid tiles; a blocking piece
// whose art reaches over a walkable tile is flagged to fade.

const band = 2 // a chunk's edge tiles each side, decided by the base alone

type detail struct {
	S                int
	rng              *Rng
	wind, jag, brush noise
	outer            bool
	home             Tile // where turncaps lean, in local tiles

	base    []baseTile
	walk    []bool
	ground  []Ground
	land    []int8
	bare    []bool
	blocked []bool // water, pools, landmarks, lamp stones: nothing opens them
	network []bool
	forks   []Tile
	core    []Tile
	throats []Tile
	points  []Tile // what must be reachable: entities, walkable sites, place fronts

	special   []Decor
	specialAt []bool
	undergrow []Decor

	solid []bool
	decor []Decor
	taken []bool
}

func newDetail(S int, seed uint32, base []baseTile, outer bool, home Tile) *detail {
	d := &detail{
		S: S, rng: NewRng(seed), outer: outer, home: home,
		wind: noise{seed}, jag: noise{seed ^ 0x5bd1e995}, brush: noise{seed ^ 0x2545f491},
		base: base, walk: make([]bool, S*S), ground: make([]Ground, S*S), land: make([]int8, S*S),
		bare: make([]bool, S*S), blocked: make([]bool, S*S), network: make([]bool, S*S),
		specialAt: make([]bool, S*S), taken: make([]bool, S*S),
	}
	for i, t := range base {
		d.walk[i], d.ground[i], d.land[i] = t.walk, t.ground, t.land
		if t.kind == bWater || (!t.walk && groundSurface[t.ground] == "water") {
			d.blocked[i] = true
		}
	}
	return d
}

func (d *detail) at(x, y int) int        { return y*d.S + x }
func (d *detail) inBounds(x, y int) bool { return x >= 0 && y >= 0 && x < d.S && y < d.S }
func (d *detail) interior(x, y int) bool {
	return x >= band && y >= band && x < d.S-band && y < d.S-band
}
func (d *detail) isWalk(x, y int) bool    { return d.inBounds(x, y) && d.walk[d.at(x, y)] }
func (d *detail) isBlocked(x, y int) bool { return d.inBounds(x, y) && d.blocked[d.at(x, y)] }
func (d *detail) isBare(x, y int) bool    { return d.inBounds(x, y) && d.bare[d.at(x, y)] }
func (d *detail) setBare(x, y int) {
	if d.inBounds(x, y) {
		d.bare[d.at(x, y)] = true
	}
}
func (d *detail) openable(x, y int) bool {
	return d.interior(x, y) && !d.blocked[d.at(x, y)]
}
func (d *detail) lg(x, y int) landGrounds { return landGround[d.landAt(x, y)] }
func (d *detail) landAt(x, y int) int {
	if l := d.land[d.at(x, y)]; l >= 0 {
		return int(l)
	}
	return 0
}
func (d *detail) woodsAt(x, y int) bool {
	return landData(d.landAt(x, y)).GetThicketPermille() >= 1000
}

// carve opens an interior tile and raises its ground (never lowers it).
func (d *detail) carve(x, y int, g Ground) {
	if !d.openable(x, y) {
		return
	}
	i := d.at(x, y)
	d.walk[i] = true
	if groundSurface[d.ground[i]] == "land" && groundRank[g] > groundRank[d.ground[i]] {
		d.ground[i] = g
	}
}

func (d *detail) nearPoint(x, y, r int) bool {
	for _, p := range d.points {
		if cheb(p.TX-x, p.TY-y) <= r {
			return true
		}
	}
	return false
}

func (d *detail) nearThroat(x, y, r int) bool {
	for _, t := range d.throats {
		if cheb(t.TX-x, t.TY-y) <= r {
			return true
		}
	}
	return false
}

func (d *detail) faces(x, y int) bool {
	for _, dir := range dirs4 {
		if d.isWalk(x+dir[0], y+dir[1]) {
			return true
		}
	}
	return false
}

func (d *detail) nearWalk(x, y int) bool {
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if d.isWalk(x+dx, y+dy) {
				return true
			}
		}
	}
	return false
}

// wetNear: water (or a ford) within r tiles.
func (d *detail) wetNear(x, y, r int) bool {
	for yy := y - r; yy <= y+r; yy++ {
		for xx := x - r; xx <= x+r; xx++ {
			if d.inBounds(xx, yy) {
				k := d.base[d.at(xx, yy)].kind
				if k == bWater || k == bFord || d.blocked[d.at(xx, yy)] {
					return true
				}
			}
		}
	}
	return false
}

// dryReach marks the tiles joined to the chunk's open edge tiles without
// crossing water: anything placed must stand there, or nobody could walk to
// it.
func (d *detail) dryReach() []bool {
	S := d.S
	seen := make([]bool, S*S)
	var queue []Tile
	for y := 0; y < S; y++ {
		for x := 0; x < S; x++ {
			if d.interior(x, y) || !d.walk[d.at(x, y)] {
				continue
			}
			seen[d.at(x, y)] = true
			queue = append(queue, Tile{x, y})
		}
	}
	for len(queue) > 0 {
		t := queue[0]
		queue = queue[1:]
		for _, dir := range dirs4 {
			x, y := t.TX+dir[0], t.TY+dir[1]
			if !d.inBounds(x, y) {
				continue
			}
			i := d.at(x, y)
			if seen[i] || d.blocked[i] || (!d.interior(x, y) && !d.walk[i]) {
				continue
			}
			seen[i] = true
			queue = append(queue, Tile{x, y})
		}
	}
	return seen
}

// ---------------------------------------------------------- clearings

// clearPlace opens a place's clearing and stands its landmark at the middle.
func (d *detail) clearPlace(p *Place) {
	cx, cy := p.TX, p.TY
	r := p.clearing
	for y := cy - r - 1; y <= cy+r+1; y++ {
		for x := cx - r - 1; x <= cx+r+1; x++ {
			c := cheb(x-cx, y-cy)
			dd := hypot256(x-cx, y-cy) + jitter256(d.jag, x*205+11*fp, y*205, 410)
			if c > r-1 && dd > r*fp {
				continue
			}
			d.carve(x, y, d.lg(x, y).open)
		}
	}
	i := d.at(cx, cy)
	d.walk[i] = false
	d.blocked[i] = true
	d.addSpecial(Decor{Kind: decorID(p.Landmark), TX: cx, TY: cy, Variant: d.rng.NextInt(8)})
	for y := cy - 1; y <= cy+2; y++ {
		for x := cx - 1; x <= cx+1; x++ {
			d.setBare(x, y)
		}
	}
	d.points = append(d.points, Tile{cx, cy + 2})
}

// clearEntity: v2's entity clearings (a guaranteed core inside a ragged
// blob, trodden bare round a camp's fire).
func (d *detail) clearEntity(en Entity) {
	camp := en.Kind == kindCamp
	radius, coreR := 486, 1
	switch en.Kind {
	case kindCamp:
		radius, coreR = 717, 2
	case kindPOI:
		radius, coreR = 614, 2
	}
	reach := (radius+fp-1)/fp + 1
	for y := en.TY - reach; y <= en.TY+reach; y++ {
		for x := en.TX - reach; x <= en.TX+reach; x++ {
			c := cheb(x-en.TX, y-en.TY)
			dd := hypot256(x-en.TX, y-en.TY) + jitter256(d.jag, x*205, y*205, 410)
			if c > coreR && dd > radius {
				continue
			}
			inner := 1
			if dd < 2*fp {
				inner = 2
			}
			g := d.lg(x, y).open
			if camp && c <= inner {
				g = d.lg(x, y).trodden
			}
			d.carve(x, y, g)
		}
	}
	west := 1
	if camp {
		west = 2
	}
	for y := en.TY - 1; y <= en.TY+1; y++ {
		for x := en.TX - west; x <= en.TX+1; x++ {
			d.setBare(x, y)
		}
	}
}

// clearSite: v2's story-site clearings, a reed site behind its still pool;
// a lamp stone stands solid with a little open ground round it.
func (d *detail) clearSite(s Site) {
	if s.Kind == SiteLampStone {
		i := d.at(s.TX, s.TY)
		d.walk[i] = false
		d.blocked[i] = true
		d.taken[i] = true
		for y := s.TY - 1; y <= s.TY+1; y++ {
			for x := s.TX - 1; x <= s.TX+1; x++ {
				if x != s.TX || y != s.TY {
					d.carve(x, y, d.lg(x, y).open)
					d.setBare(x, y)
				}
			}
		}
		return
	}
	if s.Kind == SiteReeds {
		for y := s.TY - 2; y <= s.TY-1; y++ {
			for x := s.TX - 1; x <= s.TX+1; x++ {
				if !d.interior(x, y) {
					continue
				}
				i := d.at(x, y)
				d.blocked[i] = true
				d.walk[i] = false
				d.ground[i] = GroundWater
			}
		}
	}
	for y := s.TY - 4; y <= s.TY+4; y++ {
		for x := s.TX - 4; x <= s.TX+4; x++ {
			c := cheb(x-s.TX, y-s.TY)
			dd := hypot256(x-s.TX, y-s.TY) + jitter256(d.jag, x*205+7*fp, y*205, 410)
			if c > 2 && dd > 666 {
				continue
			}
			g := d.lg(x, y).open
			if s.Kind == SiteEcho && c <= 1 {
				g = d.lg(x, y).trodden
			}
			d.carve(x, y, g)
		}
	}
	for y := s.TY - 2; y <= s.TY+1; y++ {
		for x := s.TX - 2; x <= s.TX+2; x++ {
			d.setBare(x, y)
		}
	}
	if s.Kind != SiteRumour {
		d.points = append(d.points, Tile{s.TX, s.TY})
	}
}

// mouths: where the woods' open edge tiles meet the interior. Each run of
// open tiles one in from an edge, with woods behind it, gets its mouth
// opened two deep and a throat for a trunk path.
func (d *detail) mouths() {
	S := d.S
	// Each edge: along x (north, south) or y (west, east), and the row or
	// column one in from it.
	for _, e := range [4][2]int{{0, 1}, {0, S - 2}, {1, 1}, {1, S - 2}} {
		alongX, depth := e[0] == 0, e[1]
		inward := 1
		if depth == S-2 {
			inward = -1
		}
		run := []int{}
		flush := func() {
			if len(run) == 0 {
				return
			}
			mid := run[len(run)/2]
			x, y := mid, depth+2*inward
			if !alongX {
				x, y = depth+2*inward, mid
			}
			if d.woodsAt(x, y) {
				for _, a := range run {
					for k := 1; k <= 2; k++ {
						xx, yy := a, depth+k*inward
						if !alongX {
							xx, yy = depth+k*inward, a
						}
						g := d.lg(xx, yy).verge
						if a == mid {
							g = d.lg(xx, yy).path
						}
						d.carve(xx, yy, g)
					}
				}
				d.throats = append(d.throats, Tile{x, y})
			}
			run = run[:0]
		}
		for a := band; a < S-band; a++ {
			x, y := a, depth
			if !alongX {
				x, y = depth, a
			}
			if d.walk[d.at(x, y)] {
				run = append(run, a)
				continue
			}
			flush()
		}
		flush()
	}
}

// ---------------------------------------------------------- paths

func (d *detail) stepCost(x, y int) int {
	i := d.at(x, y)
	if d.blocked[i] {
		return -1
	}
	if !d.interior(x, y) {
		if d.walk[i] {
			return 70
		}
		return -1
	}
	if d.walk[i] {
		return 70
	}
	n := int64(d.wind.at(x*71, y*71))
	c := 100 + int(900*n*n>>32)
	if x == band || y == band || x == d.S-1-band || y == d.S-1-band {
		c += 400
	}
	return c
}

func (d *detail) onNetwork(x, y int) bool { return d.network[d.at(x, y)] }

// layPaths: the interior's route, road and opening tiles are the network
// (else a hub); each throat, then each point, is routed to it.
func (d *detail) layPaths(dry []bool) {
	S, rng := d.S, d.rng
	any := false
	for y := band; y < S-band; y++ {
		for x := band; x < S-band; x++ {
			switch d.base[d.at(x, y)].kind {
			case bRoute, bRoad, bOpening, bFord, bGap:
				d.network[d.at(x, y)] = true
				any = true
			}
		}
	}
	hub := Tile{clamp(S/2-4+rng.NextInt(8), 5, S-6), clamp(S/2-4+rng.NextInt(8), 5, S-6)}
	if !any {
		fits := func(t Tile) bool {
			if !d.openable(t.TX, t.TY) || !dry[d.at(t.TX, t.TY)] {
				return false
			}
			for _, dir := range dirs4 {
				if d.isBlocked(t.TX+dir[0], t.TY+dir[1]) {
					return false
				}
			}
			return true
		}
		if !fits(hub) {
			best, bestD := hub, -1
			for y := 5; y <= S-6; y++ {
				for x := 5; x <= S-6; x++ {
					dd := (x-hub.TX)*(x-hub.TX) + (y-hub.TY)*(y-hub.TY)
					if fits(Tile{x, y}) && (bestD < 0 || dd < bestD) {
						best, bestD = Tile{x, y}, dd
					}
				}
			}
			if bestD < 0 {
				return
			}
			hub = best
		}
		d.carve(hub.TX, hub.TY, d.lg(hub.TX, hub.TY).path)
		d.network[d.at(hub.TX, hub.TY)] = true
		for _, dir := range dirs4 {
			x, y := hub.TX+dir[0], hub.TY+dir[1]
			d.carve(x, y, d.lg(x, y).verge)
			if d.isWalk(x, y) {
				d.network[d.at(x, y)] = true
			}
		}
		d.forks = append(d.forks, hub)
	}
	byHub := func(list []Tile) []Tile {
		out := append([]Tile(nil), list...)
		slices.SortStableFunc(out, func(a, b Tile) int {
			return (a.TX-hub.TX)*(a.TX-hub.TX) + (a.TY-hub.TY)*(a.TY-hub.TY) - (b.TX-hub.TX)*(b.TX-hub.TX) - (b.TY-hub.TY)*(b.TY-hub.TY)
		})
		return out
	}
	for _, t := range byHub(d.throats) {
		d.layOne(t, true)
	}
	for _, t := range byHub(d.points) {
		d.layOne(t, false)
	}
}

func (d *detail) layOne(from Tile, trunk bool) {
	S, rng := d.S, d.rng
	if !d.woodsAt(from.TX, from.TY) {
		return // open land needs no path: the routes are trodden enough
	}
	line := cheapest(S, from, d.stepCost, d.onNetwork)
	if end := line[len(line)-1]; !d.onNetwork(end.TX, end.TY) {
		return // across water from the network: ensureReach joins it to its own side
	}
	if trunk && len(line) > 6 {
		mid := line[len(line)*rng.Between(35, 65)/100]
		join := line[len(line)-1]
		ax, ay := join.TX-from.TX, join.TY-from.TY
		l := max(hypot256(ax, ay), fp)
		push := rng.Between(3, 5)
		if rng.Coin() {
			push = -push
		}
		via := Tile{
			clamp(mid.TX-divRound(ay*push*fp, l), band+1, S-band-2),
			clamp(mid.TY+divRound(ax*push*fp, l), band+1, S-band-2),
		}
		if d.openable(via.TX, via.TY) {
			first := cheapest(S, from, d.stepCost, func(x, y int) bool { return x == via.TX && y == via.TY })
			if end := first[len(first)-1]; end == via {
				rest := cheapest(S, via, d.stepCost, d.onNetwork)
				if e := rest[len(rest)-1]; d.onNetwork(e.TX, e.TY) {
					line = append(first[:len(first)-1], rest...)
				}
			}
		}
	}
	if len(line) > 2 {
		d.forks = append(d.forks, line[len(line)-1])
	}
	for _, t := range line {
		d.network[d.at(t.TX, t.TY)] = true
		if !d.interior(t.TX, t.TY) {
			continue
		}
		d.core = append(d.core, t)
		wide := trunk && d.brush.at(t.TX*179, t.TY*179) > 29491
		x0, y0, span := t.TX-1, t.TY-1, 3
		if !wide {
			span = 2
			x0, y0 = t.TX, t.TY
			if d.brush.at(t.TX*333+9*fp, t.TY*333) < noiseMid {
				x0--
			}
			if d.brush.at(t.TX*333, t.TY*333+9*fp) < noiseMid {
				y0--
			}
		}
		for y := y0; y < y0+span; y++ {
			for x := x0; x < x0+span; x++ {
				if d.inBounds(x, y) {
					d.carve(x, y, d.lg(x, y).verge)
				}
			}
		}
		d.carve(t.TX, t.TY, d.lg(t.TX, t.TY).path)
	}
}

func (d *detail) pickCore() Tile      { return d.core[d.rng.NextInt(len(d.core))] }
func (d *detail) pickDir() [2]int     { return dirs4[d.rng.NextInt(4)] }
func (d *detail) leanHome(x int) bool { return d.home.TX > x }

func (d *detail) spot(kind DecorKind, x, y, ox, oy int, flip bool) Decor {
	return Decor{Kind: kind, TX: x, TY: y, OX: ox, OY: oy, Variant: d.rng.NextInt(8), Flip: flip}
}

func (d *detail) addSpecial(dec Decor) {
	d.special = append(d.special, dec)
	d.specialAt[d.at(dec.TX, dec.TY)] = true
}

// ---------------------------------------------------------- woods features

// fresh: a 3×3 of unopened, unblocked woods around (x, y).
func (d *detail) fresh(x, y int) bool {
	for yy := y - 1; yy <= y+1; yy++ {
		for xx := x - 1; xx <= x+1; xx++ {
			if !d.interior(xx, yy) || d.isWalk(xx, yy) || d.isBlocked(xx, yy) || !d.woodsAt(xx, yy) {
				return false
			}
		}
	}
	return true
}

func (d *detail) addGlades() {
	rng := d.rng
	if len(d.core) == 0 {
		return
	}
	features := [...]DecorKind{DecorRingStump, DecorSnag, DecorBoulder, DecorTurncaps}
	glades := 1
	if rng.Chance(600) {
		glades++
	}
	ringStumps := 0
	for g, tries := 0, 0; g < glades && tries < 60; tries++ {
		c := d.pickCore()
		dir := d.pickDir()
		ctr := Tile{c.TX + dir[0]*3, c.TY + dir[1]*3}
		if !d.fresh(ctr.TX, ctr.TY) || d.nearPoint(ctr.TX, ctr.TY, 3) || d.nearThroat(ctr.TX, ctr.TY, 3) {
			continue
		}
		d.carve(c.TX+dir[0], c.TY+dir[1], d.lg(c.TX, c.TY).open)
		d.carve(c.TX+dir[0]*2, c.TY+dir[1]*2, d.lg(c.TX, c.TY).open)
		for y := ctr.TY - 2; y <= ctr.TY+2; y++ {
			for x := ctr.TX - 2; x <= ctr.TX+2; x++ {
				if cheb(x-ctr.TX, y-ctr.TY) <= 1 || hypot256(x-ctr.TX, y-ctr.TY)+jitter256(d.jag, x*230+3*fp, y*230, 358) <= 486 {
					d.carve(x, y, d.lg(x, y).open)
				}
			}
		}
		feature := features[rng.NextInt(len(features))]
		if feature == DecorRingStump && ringStumps > 0 {
			feature = DecorBoulder
		}
		if feature == DecorTurncaps {
			for _, r := range [...][2]int{{-1, -1}, {1, -1}, {-1, 1}, {1, 1}, {0, 0}} {
				x, y := ctr.TX+r[0], ctr.TY+r[1]
				d.undergrow = append(d.undergrow, d.spot(DecorTurncaps, x, y, rng.Spread(2), -rng.NextInt(4), d.leanHome(x)))
			}
		} else {
			d.walk[d.at(ctr.TX, ctr.TY)] = false
			d.addSpecial(d.spot(feature, ctr.TX, ctr.TY, 0, -1, false))
			if feature == DecorRingStump {
				ringStumps++
			}
			if feature != DecorBoulder {
				for _, r := range [...][2]int{{1, 0}, {-1, 1}} {
					x, y := ctr.TX+r[0], ctr.TY+r[1]
					d.undergrow = append(d.undergrow, d.spot(DecorTurncaps, x, y, -r[0]*4, -2, d.leanHome(x)))
				}
			}
		}
		for y := ctr.TY - 1; y <= ctr.TY+1; y++ {
			for x := ctr.TX - 1; x <= ctr.TX+1; x++ {
				d.setBare(x, y)
			}
		}
		g++
	}
}

// addSpurs: a path into the woods that ends at a tree standing on it.
func (d *detail) addSpurs() {
	rng := d.rng
	if len(d.core) == 0 {
		return
	}
	spurs := 0
	if d.outer {
		spurs = 1
		if rng.Coin() {
			spurs++
		}
	} else if rng.Chance(800) {
		spurs = 1
	}
	for n := 0; n < spurs; n++ {
		for tries := 0; tries < 80; tries++ {
			c := d.pickCore()
			dir := d.pickDir()
			length := rng.Between(3, 5)
			end := Tile{c.TX + dir[0]*(length+1), c.TY + dir[1]*(length+1)}
			if !d.interior(end.TX, end.TY) || d.nearPoint(c.TX, c.TY, 3) || d.nearThroat(c.TX, c.TY, 3) {
				continue
			}
			ok := true
			for k := 1; k <= length+1 && ok; k++ {
				x, y := c.TX+dir[0]*k, c.TY+dir[1]*k
				if !d.interior(x, y) || d.isBlocked(x, y) || !d.woodsAt(x, y) || (k > 1 && d.isWalk(x, y)) {
					ok = false
				}
				if ok && k > 1 && (d.isWalk(x+dir[1], y+dir[0]) || d.isWalk(x-dir[1], y-dir[0])) {
					ok = false
				}
				if ok && d.nearPoint(x, y, 2) {
					ok = false
				}
			}
			if !ok {
				continue
			}
			for k := 1; k <= length; k++ {
				x, y := c.TX+dir[0]*k, c.TY+dir[1]*k
				d.carve(x, y, d.lg(x, y).path)
			}
			d.ground[d.at(end.TX, end.TY)] = d.lg(end.TX, end.TY).path
			if bx, by := end.TX+dir[0], end.TY+dir[1]; d.interior(bx, by) && !d.isWalk(bx, by) && !d.isBlocked(bx, by) {
				d.ground[d.at(bx, by)] = d.lg(bx, by).path
			}
			kind := DecorOak
			if rng.Coin() {
				kind = DecorIronOak
			}
			d.addSpecial(d.spot(kind, end.TX, end.TY, 0, -1, false))
			break
		}
	}
}

// addOldRoads: a straight two-wide run of the old road's cobbles, cut off
// by the woods.
func (d *detail) addOldRoads() {
	S, rng := d.S, d.rng
	roads := 0
	if d.outer {
		if rng.Chance(500) {
			roads = 1
		}
	} else if rng.Chance(600) {
		roads = 1
	}
	for n := 0; n < roads; n++ {
		for tries := 0; tries < 40; tries++ {
			horiz := rng.Coin()
			length := rng.Between(6, 10)
			along0 := band + rng.NextInt(S-length-2*band)
			across := band + 1 + rng.NextInt(S-2*band-3)
			var tiles []Tile
			for a := along0; a < along0+length; a++ {
				for b := across; b < across+2; b++ {
					if horiz {
						tiles = append(tiles, Tile{a, b})
					} else {
						tiles = append(tiles, Tile{b, a})
					}
				}
			}
			open, shut, clear := false, false, true
			for _, t := range tiles {
				i := d.at(t.TX, t.TY)
				if !d.interior(t.TX, t.TY) || !d.woodsAt(t.TX, t.TY) || groundSurface[d.ground[i]] != "land" {
					clear = false
					break
				}
				if d.walk[i] {
					open = true
				} else {
					shut = true
				}
				if d.bare[i] || d.blocked[i] || d.specialAt[i] {
					clear = false
				}
			}
			if !open || !shut || !clear {
				continue
			}
			for _, t := range tiles {
				d.ground[d.at(t.TX, t.TY)] = GroundRoad
			}
			break
		}
	}
}

// ---------------------------------------------------------- reach

// ensureReach joins every open edge tile and every point to the rest of its
// side of any water, opening the cheapest way through solid interior tiles
// (never a blocked one, never an edge tile).
func (d *detail) ensureReach() {
	S := d.S
	var targets []Tile
	for y := 0; y < S; y++ {
		for x := 0; x < S; x++ {
			if !d.interior(x, y) && d.walk[d.at(x, y)] {
				targets = append(targets, Tile{x, y})
			}
		}
	}
	for _, p := range d.points {
		targets = append(targets, p)
	}
	reached := make([]bool, S*S)
	flood := func(from Tile) {
		i := d.at(from.TX, from.TY)
		if reached[i] || !d.walk[i] {
			return
		}
		reached[i] = true
		queue := []Tile{from}
		for len(queue) > 0 {
			t := queue[0]
			queue = queue[1:]
			for _, dir := range dirs4 {
				x, y := t.TX+dir[0], t.TY+dir[1]
				if !d.inBounds(x, y) {
					continue
				}
				j := d.at(x, y)
				if reached[j] || !d.walk[j] {
					continue
				}
				reached[j] = true
				queue = append(queue, Tile{x, y})
			}
		}
	}
	step := func(x, y int) int {
		i := d.at(x, y)
		switch {
		case d.blocked[i]:
			return -1
		case d.walk[i]:
			return 1
		case !d.interior(x, y):
			return -1
		}
		return 10
	}
	rooted := false
	for _, t := range targets {
		i := d.at(t.TX, t.TY)
		if reached[i] {
			continue
		}
		if !rooted {
			if !d.walk[i] {
				if !d.openable(t.TX, t.TY) {
					continue
				}
				d.walk[i] = true
			}
			flood(t)
			rooted = true
			continue
		}
		line := cheapest(S, t, step, func(x, y int) bool { return reached[d.at(x, y)] })
		end := line[len(line)-1]
		if !reached[d.at(end.TX, end.TY)] {
			// Nothing reached on this side of the water: it starts its own.
			if !d.walk[i] && d.openable(t.TX, t.TY) {
				d.walk[i] = true
			}
			flood(t)
			continue
		}
		for _, p := range line {
			j := d.at(p.TX, p.TY)
			if !d.walk[j] {
				d.walk[j] = true
				if groundSurface[d.ground[j]] == "land" {
					d.ground[j] = d.lg(p.TX, p.TY).path
				}
			}
		}
		flood(t)
	}
}

// ---------------------------------------------------------- dressing

// decorPick draws a decor kind from a land's weights, among the kinds keep
// accepts.
func (d *detail) decorPick(land int, keep func(k DecorKind, a DecorArt) bool) (DecorKind, bool) {
	var kinds []DecorKind
	var weights []int
	for _, w := range landData(land).GetDecor() {
		k := decorID(w.GetId())
		if landmarkKinds[k] || !keep(k, DecorArts[k]) {
			continue
		}
		kinds = append(kinds, k)
		weights = append(weights, int(w.GetWeight()))
	}
	if len(kinds) == 0 {
		return 0, false
	}
	return kinds[weighted(d.rng, weights)], true
}

// landmarkKinds are the place kinds' landmarks: never scattered as dressing,
// so a landmark always means a place.
var landmarkKinds = func() map[DecorKind]bool {
	out := map[DecorKind]bool{}
	for _, k := range contentRules().PlaceKinds {
		out[decorID(k.GetLandmark())] = true
	}
	return out
}()

func tall(a DecorArt) bool { return a.Blocking && a.H >= 28 }
func low(a DecorArt) bool  { return a.Blocking && a.H < 28 }

func (d *detail) overhangs(dec Decor) bool {
	a := DecorArts[dec.Kind]
	x0 := dec.TX*tilePx + tilePx/2 + dec.OX - a.W/2
	y1 := (dec.TY+1)*tilePx + dec.OY
	y0 := y1 - a.H
	for ty := floorDiv(y0, tilePx); ty <= floorDiv(y1-1, tilePx); ty++ {
		for tx := floorDiv(x0, tilePx); tx <= floorDiv(x0+a.W-1, tilePx); tx++ {
			if !d.isWalk(tx, ty) {
				continue
			}
			ix := min(x0+a.W, tx*tilePx+tilePx) - max(x0, tx*tilePx)
			iy := min(y1, ty*tilePx+tilePx) - max(y0, ty*tilePx)
			if ix >= 3 && iy >= 3 {
				return true
			}
		}
	}
	return false
}

func (d *detail) place(dec Decor) {
	dec.Overhang = DecorArts[dec.Kind].Blocking && d.overhangs(dec)
	d.decor = append(d.decor, dec)
}

func (d *detail) take(x, y int) { d.taken[d.at(x, y)] = true }

// tree is a tall piece for a woods tile: the land's weights, iron-oaks only
// where their crown won't hang over a path, more snags out in the drift.
func (d *detail) tree(x, y int, edge, underPath bool) Decor {
	rng := d.rng
	ox, oy := rng.Spread(4), -rng.NextInt(5)
	if edge {
		ox, oy = rng.Spread(2), -rng.NextInt(3)
	}
	if underPath {
		oy = rng.NextInt(3)
	}
	kind, ok := d.decorPick(d.landAt(x, y), func(_ DecorKind, a DecorArt) bool { return tall(a) })
	if !ok {
		kind = DecorOak
	}
	if d.outer && !edge && rng.Chance(120) {
		kind = DecorSnag
	}
	dec := d.spot(kind, x, y, ox, oy, rng.Coin())
	if kind == DecorIronOak && (edge || d.overhangs(dec)) {
		dec.Kind = DecorOak
	}
	return dec
}

func (d *detail) dress() {
	S, rng := d.S, d.rng
	d.solid = make([]bool, S*S)
	for i, open := range d.walk {
		d.solid[i] = !open
	}
	copy(d.taken, d.blocked)

	// Cairns beside forks, in the woods.
	cairns := 0
	for _, f := range d.forks {
		if cairns >= 2 {
			break
		}
		if d.nearThroat(f.TX, f.TY, 2) || d.nearPoint(f.TX, f.TY, 1) {
			continue
		}
		best, bestD := Tile{}, -1
		for y := f.TY - 2; y <= f.TY+2; y++ {
			for x := f.TX - 2; x <= f.TX+2; x++ {
				if !d.interior(x, y) || d.isWalk(x, y) || d.isBlocked(x, y) || d.specialAt[d.at(x, y)] || !d.faces(x, y) || !d.woodsAt(x, y) {
					continue
				}
				dd := hypot256(x-f.TX, y-f.TY) + rng.NextInt(77)
				if bestD < 0 || dd < bestD {
					best, bestD = Tile{x, y}, dd
				}
			}
		}
		if bestD < 0 {
			continue
		}
		d.addSpecial(d.spot(DecorCairn, best.TX, best.TY, 0, -1, false))
		cairns++
	}
	for _, dec := range d.special {
		d.place(dec)
		d.take(dec.TX, dec.TY)
	}

	// Fallen logs: two woods tiles side by side, facing the path.
	logs := 0
	for y := 1; y < S-1 && logs < 2; y++ {
		for x := 1; x < S-2 && logs < 2; x++ {
			if d.isWalk(x, y) || d.isWalk(x+1, y) || d.taken[d.at(x, y)] || d.taken[d.at(x+1, y)] || !d.woodsAt(x, y) || !d.woodsAt(x+1, y) {
				continue
			}
			if !(d.isWalk(x, y+1) && d.isWalk(x+1, y+1)) && !(d.isWalk(x, y-1) && d.isWalk(x+1, y-1)) {
				continue
			}
			if !rng.Chance(100) {
				continue
			}
			d.place(d.spot(DecorLog, x, y, 8, -1, rng.Coin()))
			d.take(x, y)
			d.take(x+1, y)
			logs++
		}
	}

	for y := 0; y < S; y++ {
		for x := 0; x < S; x++ {
			i := d.at(x, y)
			if d.walk[i] || d.taken[i] {
				continue
			}
			land := d.landAt(x, y)
			edge := d.faces(x, y)
			underPath := d.isWalk(x, y-1)
			if !d.woodsAt(x, y) {
				// A meadow's thicket stand or stone.
				if k, ok := d.decorPick(land, func(_ DecorKind, a DecorArt) bool { return low(a) }); ok {
					d.place(d.spot(k, x, y, rng.Spread(2), -rng.NextInt(2), rng.Coin()))
				}
				d.take(x, y)
				continue
			}
			r := rng.NextInt(1000)
			if edge {
				lowPick := 400
				if !underPath {
					lowPick = 180
				}
				if r < lowPick {
					if k, ok := d.decorPick(land, func(k DecorKind, a DecorArt) bool { return low(a) && k != DecorLog }); ok {
						d.place(d.spot(k, x, y, rng.Spread(2), -rng.NextInt(3), rng.Coin()))
					} else {
						d.place(d.tree(x, y, true, underPath))
					}
				} else {
					d.place(d.tree(x, y, true, underPath))
				}
				if d.isWalk(x, y+1) && !d.isBare(x, y+1) && rng.Chance(450) {
					if k, ok := d.decorPick(land, func(_ DecorKind, a DecorArt) bool { return !a.Blocking && !a.Flat }); ok {
						d.undergrow = append(d.undergrow, d.spot(k, x, y, rng.Spread(4), 2, d.flipFor(k, x)))
					}
				}
			} else {
				switch {
				case r < 80:
					d.place(d.spot(DecorThicket, x, y, rng.Spread(3), -rng.NextInt(4), rng.Coin()))
				case r < 380 && !d.nearWalk(x, y):
					continue // the crowns close overhead on their own
				default:
					d.place(d.tree(x, y, false, false))
				}
			}
			d.take(x, y)
		}
	}

	// Undergrowth along the woods' edges; tufts and decals on open ground.
	rooted := make([]bool, S*S)
	for _, dec := range d.decor {
		if dec.Kind == DecorOak || dec.Kind == DecorIronOak {
			rooted[d.at(dec.TX, dec.TY)] = true
		}
	}
	isRooted := func(x, y int) bool { return d.inBounds(x, y) && rooted[d.at(x, y)] }
	for y := 0; y < S; y++ {
		for x := 0; x < S; x++ {
			if !d.isWalk(x, y) || d.isBare(x, y) {
				continue
			}
			i := d.at(x, y)
			land := d.landAt(x, y)
			g := d.ground[i]
			surface := groundSurface[g]
			r := rng.NextInt(1000)
			switch {
			case surface == "ford" || surface == "water":
				continue
			case g == groundRiverBank:
				if r < 90 {
					d.undergrow = append(d.undergrow, d.spot(decorID("bank-stones"), x, y, rng.Spread(4), -rng.NextInt(6), rng.Coin()))
				}
				continue
			case surface == "road":
				if r < 50 {
					d.undergrow = append(d.undergrow, d.spot(DecorPebbles, x, y, rng.Spread(4), -rng.NextInt(9), rng.Coin()))
				}
				continue
			}
			var woodsDirs [][2]int
			for _, dir := range dirs4 {
				if xx, yy := x+dir[0], y+dir[1]; d.inBounds(xx, yy) && !d.isWalk(xx, yy) && d.woodsAt(xx, yy) && !d.isBlocked(xx, yy) {
					woodsDirs = append(woodsDirs, dir)
				}
			}
			trodden := g == landGround[land].path || g == landGround[land].verge && landGround[land].verge != landGround[land].floor
			switch {
			case len(woodsDirs) > 0:
				dir := woodsDirs[rng.NextInt(len(woodsDirs))]
				ox := dir[0]*5 + rng.Spread(1)
				oy := edgeOY(dir[1], -rng.NextInt(5))
				if r < 660 {
					if k, ok := d.decorPick(d.landAt(x+dir[0], y+dir[1]), func(_ DecorKind, a DecorArt) bool { return !a.Blocking && !a.Flat }); ok {
						d.undergrow = append(d.undergrow, d.spot(k, x, y, ox, oy, d.flipFor(k, x)))
					}
				}
				for _, rd := range dirs4 {
					if !isRooted(x+rd[0], y+rd[1]) {
						continue
					}
					if rng.Chance(350) {
						oy := 0
						if rd[1] < 0 {
							oy = -2
						}
						d.undergrow = append(d.undergrow, d.spot(DecorRoots, x, y, rd[0]*3, oy, rd[0] > 0))
					}
					break
				}
			case trodden:
				if r < 140 {
					if k, ok := d.decorPick(land, func(_ DecorKind, a DecorArt) bool { return a.Flat }); ok {
						d.undergrow = append(d.undergrow, d.spot(k, x, y, rng.Spread(4), -rng.NextInt(9), rng.Coin()))
					}
				}
			default:
				// Open ground: a meadow's grass and flowers grow thick, a
				// clearing's moss thinner.
				density := 260
				if !d.woodsAt(x, y) {
					density = 420
				}
				if r < density {
					if k, ok := d.decorPick(land, func(_ DecorKind, a DecorArt) bool { return !a.Blocking }); ok {
						d.undergrow = append(d.undergrow, d.spot(k, x, y, rng.Spread(4), -rng.NextInt(7), d.flipFor(k, x)))
					}
				}
			}
		}
	}
	for _, dec := range d.undergrow {
		d.place(dec)
	}
	slices.SortStableFunc(d.decor, func(a, b Decor) int {
		if a.TY != b.TY {
			return a.TY - b.TY
		}
		return a.TX - b.TX
	})
}

// flipFor: turncaps lean toward home; anything else flips by chance.
func (d *detail) flipFor(k DecorKind, x int) bool {
	if k == DecorTurncaps {
		return d.leanHome(x)
	}
	return d.rng.Coin()
}
