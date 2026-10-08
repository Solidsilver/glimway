package wilds

import "slices"

// The woods of generator v2: dense iron-oak woods with winding, uneven
// paths, for both regions (the Whitequiet is the same woods, wilder). The
// ideas are those of src/lib/wilds/tangle.ts; the arithmetic is integer.
//
// Layout, in order:
//  1. Exit throats (a 3-wide mouth, three tiles deep), the spawn, and a
//     clearing around every entity (wider for camps and points of interest,
//     trodden bare around a camp's fire) and every story site (a reed site
//     behind its still pool).
//  2. Paths: from a jittered hub, each exit and then each entity and site is
//     routed to the nearest path already laid (Dijkstra over a noisy cost
//     field, so they wind and join into forks). Trunks to exits are 2–3
//     wide and bend once; branches to entities are 2 wide.
//  3. Side glades off the paths (a tight-ringed stump, a dead snag carrying
//     turncaps, a mossy boulder, a ring of turncaps).
//  4. Drift cues: spur paths that run into the woods and end at a tree, and
//     stretches of the old road swallowed by the woods on either side.
//  5. Everything unopened is woods (solid), dressed with trees, thickets,
//     stumps, logs and boulders; cairns stand beside forks; path edges get
//     ferns, grass, flowers, roots and turncaps (which lean toward home).
//  6. A safety pass opens the cheapest way to anything still cut off.
//
// Readability rules: entities and sites keep a decor-free surround, exit
// throats and the spawn stay bare, paths are never narrower than two tiles
// except spurs, blocking pieces stand only on solid tiles, and any blocking
// piece whose art overhangs a walkable tile is flagged so it fades when
// someone walks beneath it.

// Ground is a ground id; GroundIDs names it (the TERRAIN key in
// src/lib/tile.ts, which the ground art reads).
type Ground uint8

const (
	GroundWoods   Ground = iota // under the trees: dark loam, moss and leaf litter
	GroundMoss                  // walkable moss in clearings and glades
	GroundVerge                 // walkable verge beside a path's trodden line
	GroundPath                  // the trodden line of a path
	GroundTrodden               // bare, trodden earth around camps
	GroundRoad                  // broken cobbles of the old road
	GroundWater                 // still water (a backwater of the Wend): solid
)

// GroundIDs are the palette names of the ground ids, by value.
var GroundIDs = [...]string{"grass_b", "grass_a", "path_b", "path_a", "dirt", "cobble_moss", "water_a"}

func (g Ground) String() string { return GroundIDs[g] }

// groundRank: a carve only ever raises a tile's ground (moss never paints
// over a path).
var groundRank = [...]int{0, 10, 15, 20, 30, 40, 50}

// DecorKind is a kind of decor piece; DecorKinds names it (src/lib/wilds
// types.ts DecorKind, which the art reads).
type DecorKind uint8

const (
	DecorOak DecorKind = iota
	DecorPine
	DecorBirch
	DecorIronOak
	DecorSnag
	DecorThicket
	DecorStump
	DecorRingStump
	DecorLog
	DecorBoulder
	DecorCairn
	DecorFern
	DecorGrass
	DecorFlowers
	DecorTurncaps
	DecorReeds
	DecorRoots
	DecorLitter
	DecorPebbles
)

// DecorKinds are the decor kind names, by value.
var DecorKinds = [...]string{
	"oak", "pine", "birch", "iron-oak", "snag", "thicket", "stump", "ring-stump", "log", "boulder",
	"cairn", "fern", "grass", "flowers", "turncaps", "reeds", "roots", "litter", "pebbles",
}

func (k DecorKind) String() string { return DecorKinds[k] }

// DecorArt is a kind's art footprint in px (width centred on the anchor,
// height above it). Blocking pieces only stand on solid tiles; flat ones are
// ground decals drawn under everything.
type DecorArt struct {
	W, H     int
	Blocking bool
	Flat     bool
}

// DecorArts is the footprint of each kind (src/lib/wilds/tangle.ts DECOR_ART).
var DecorArts = [...]DecorArt{
	DecorOak:       {30, 32, true, false},
	DecorPine:      {22, 36, true, false},
	DecorBirch:     {22, 32, true, false},
	DecorIronOak:   {40, 42, true, false},
	DecorSnag:      {18, 28, true, false},
	DecorThicket:   {24, 18, true, false},
	DecorStump:     {18, 14, true, false},
	DecorRingStump: {22, 14, true, false},
	DecorLog:       {32, 13, true, false},
	DecorBoulder:   {20, 15, true, false},
	DecorCairn:     {14, 21, true, false},
	DecorFern:      {15, 11, false, false},
	DecorGrass:     {11, 9, false, false},
	DecorFlowers:   {11, 7, false, false},
	DecorTurncaps:  {13, 9, false, false},
	DecorReeds:     {14, 15, false, false},
	DecorRoots:     {16, 12, false, true},
	DecorLitter:    {14, 9, false, true},
	DecorPebbles:   {11, 7, false, true},
}

// Decor is one piece of dressing. The art stands on its tile's bottom edge,
// centred, nudged by (OX, OY) px. Variant is 0–7 (the art seeds from it);
// Flip mirrors it (turncaps: lean east); Overhang marks a blocking piece
// whose art reaches over a walkable tile.
type Decor struct {
	Kind     DecorKind `json:"kind"`
	TX       int       `json:"tx"`
	TY       int       `json:"ty"`
	OX       int       `json:"ox"`
	OY       int       `json:"oy"`
	Variant  int       `json:"variant"`
	Flip     bool      `json:"flip"`
	Overhang bool      `json:"overhang"`
}

const tilePx = 16

type woodsInput struct {
	size     int
	seed     uint32
	exits    []Exit
	entities []Entity
	spawn    Tile
	home     Tile // where turncaps lean, in chunk-local tiles (may lie outside)
	sites    []Site
	outer    bool // the deep drift: wilder woods, more drift cues
}

type woods struct {
	woodsInput
	S                int
	rng              *Rng
	wind, jag, brush noise

	walk    []bool
	ground  []Ground
	bare    []bool // tiles decor leaves bare: throats, the spawn, entity and site surrounds
	blocked []bool // still pools: nothing may open them
	pools   []Tile // the pool tiles, in the order laid
	network []bool
	forks   []Tile
	core    []Tile // every tile a route's centre line passed
	throats []Tile // where each exit's throat meets the woods
	points  []Tile // entities and sites

	special   []Decor // pieces placed before the general woods pass
	specialAt []bool
	undergrow []Decor

	solid []bool
	decor []Decor
	taken []bool
}

func newWoods(in woodsInput) *woods {
	S := in.size
	w := &woods{
		woodsInput: in,
		S:          S,
		rng:        NewRng(in.seed),
		wind:       noise{in.seed},
		jag:        noise{in.seed ^ 0x5bd1e995},
		brush:      noise{in.seed ^ 0x2545f491},
		walk:       make([]bool, S*S),
		ground:     make([]Ground, S*S),
		bare:       make([]bool, S*S),
		blocked:    make([]bool, S*S),
		network:    make([]bool, S*S),
		specialAt:  make([]bool, S*S),
		taken:      make([]bool, S*S),
	}
	for _, e := range in.entities {
		w.points = append(w.points, Tile{e.TX, e.TY})
	}
	for _, s := range in.sites {
		w.points = append(w.points, Tile{s.TX, s.TY})
	}
	return w
}

func (w *woods) at(x, y int) int         { return y*w.S + x }
func (w *woods) inBounds(x, y int) bool  { return x >= 0 && y >= 0 && x < w.S && y < w.S }
func (w *woods) interior(x, y int) bool  { return x >= 1 && y >= 1 && x <= w.S-2 && y <= w.S-2 }
func (w *woods) isWalk(x, y int) bool    { return w.inBounds(x, y) && w.walk[w.at(x, y)] }
func (w *woods) isBlocked(x, y int) bool { return w.inBounds(x, y) && w.blocked[w.at(x, y)] }
func (w *woods) isBare(x, y int) bool    { return w.inBounds(x, y) && w.bare[w.at(x, y)] }
func (w *woods) setBare(x, y int)        { w.mark(w.bare, x, y) }
func (w *woods) mark(grid []bool, x, y int) {
	if w.inBounds(x, y) {
		grid[w.at(x, y)] = true
	}
}

func (w *woods) exitTile(x, y int) bool {
	for _, e := range w.exits {
		if e.contains(x, y) {
			return true
		}
	}
	return false
}

func (w *woods) openable(x, y int) bool {
	return w.inBounds(x, y) && !w.blocked[w.at(x, y)] && (w.interior(x, y) || w.exitTile(x, y))
}

func (w *woods) carve(x, y int, g Ground) {
	if !w.openable(x, y) {
		return
	}
	i := w.at(x, y)
	w.walk[i] = true
	if groundRank[g] > groundRank[w.ground[i]] {
		w.ground[i] = g
	}
}

func (w *woods) nearPoint(x, y, r int) bool {
	for _, p := range w.points {
		if cheb(p.TX-x, p.TY-y) <= r {
			return true
		}
	}
	return false
}

func (w *woods) nearThroat(x, y, r int) bool {
	for _, t := range w.throats {
		if cheb(t.TX-x, t.TY-y) <= r {
			return true
		}
	}
	return false
}

// faces is true for a tile beside a walkable one (4-neighbourhood).
func (w *woods) faces(x, y int) bool {
	for _, d := range dirs4 {
		if w.isWalk(x+d[0], y+d[1]) {
			return true
		}
	}
	return false
}

// nearWalk is true when any tile of the 3×3 around (x, y) is walkable.
func (w *woods) nearWalk(x, y int) bool {
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if w.isWalk(x+dx, y+dy) {
				return true
			}
		}
	}
	return false
}

// jitter256 is a noise field mapped to ±amp/2 tiles, in 1/256 tile.
func jitter256(n noise, x, y, amp256 int) int { return (n.at(x, y) - noiseMid) * amp256 >> 16 }

// lay runs every step and leaves ground, solid and decor.
func (w *woods) lay() {
	w.openFixed()
	w.layPaths()
	w.addGlades()
	w.addSpurs()
	w.addRoads()
	w.dress()
	w.ensureReach()
	// Back to front, the order the art draws in.
	slices.SortStableFunc(w.decor, func(a, b Decor) int {
		if a.TY != b.TY {
			return a.TY - b.TY
		}
		return a.TX - b.TX
	})
}

// ---------------------------------------------------------- 1. fixed openings

func (w *woods) openFixed() {
	S := w.S
	for _, e := range w.exits {
		horiz := e.Dir == North || e.Dir == South
		for d := 0; d < 3; d++ {
			for k := 0; k < 3; k++ {
				var x, y int
				if horiz {
					x = e.TX + k
					y = d
					if e.Dir == South {
						y = S - 1 - d
					}
				} else {
					y = e.TY + k
					x = d
					if e.Dir == East {
						x = S - 1 - d
					}
				}
				g := GroundVerge
				if k == 1 {
					g = GroundPath
				}
				w.carve(x, y, g)
				w.setBare(x, y)
			}
		}
		switch e.Dir {
		case North:
			w.throats = append(w.throats, Tile{e.TX + 1, 2})
		case South:
			w.throats = append(w.throats, Tile{e.TX + 1, S - 3})
		case West:
			w.throats = append(w.throats, Tile{2, e.TY + 1})
		default:
			w.throats = append(w.throats, Tile{S - 3, e.TY + 1})
		}
	}
	sp := w.spawn
	for y := sp.TY - 1; y <= sp.TY+1; y++ {
		for x := sp.TX - 1; x <= sp.TX+1; x++ {
			g := GroundVerge
			if x == sp.TX {
				g = GroundPath
			}
			w.carve(x, y, g)
			w.setBare(x, y)
		}
	}

	// Entity clearings: a guaranteed core (3×3; camps and points of
	// interest 5×5) inside a ragged blob.
	for _, en := range w.entities {
		camp := en.Kind == kindCamp
		radius, core := 486, 1 // 1.9 tiles
		switch en.Kind {
		case kindCamp:
			radius, core = 717, 2 // 2.8
		case kindPOI:
			radius, core = 614, 2 // 2.4
		}
		reach := (radius+fp-1)/fp + 1
		for y := en.TY - reach; y <= en.TY+reach; y++ {
			for x := en.TX - reach; x <= en.TX+reach; x++ {
				c := cheb(x-en.TX, y-en.TY)
				d := hypot256(x-en.TX, y-en.TY) + jitter256(w.jag, x*205, y*205, 410)
				if c > core && d > radius {
					continue
				}
				inner := 1
				if d < 2*fp {
					inner = 2
				}
				g := GroundMoss
				if camp && c <= inner {
					g = GroundTrodden
				}
				w.carve(x, y, g)
			}
		}
		// The camp's fire sits a tile west of its pack.
		west := 1
		if camp {
			west = 2
		}
		for y := en.TY - 1; y <= en.TY+1; y++ {
			for x := en.TX - west; x <= en.TX+1; x++ {
				w.setBare(x, y)
			}
		}
	}

	// Story-site clearings (5×5 core), each reed site behind its still pool.
	for _, s := range w.sites {
		if s.Kind == SiteReeds {
			for y := s.TY - 2; y <= s.TY-1; y++ {
				for x := s.TX - 1; x <= s.TX+1; x++ {
					if !w.interior(x, y) {
						continue
					}
					i := w.at(x, y)
					w.blocked[i] = true
					w.walk[i] = false
					w.ground[i] = GroundWater
					w.pools = append(w.pools, Tile{x, y})
				}
			}
		}
		for y := s.TY - 4; y <= s.TY+4; y++ {
			for x := s.TX - 4; x <= s.TX+4; x++ {
				c := cheb(x-s.TX, y-s.TY)
				d := hypot256(x-s.TX, y-s.TY) + jitter256(w.jag, x*205+7*fp, y*205, 410)
				if c > 2 && d > 666 { // 2.6 tiles
					continue
				}
				g := GroundMoss
				if s.Kind == SiteEcho && c <= 1 {
					g = GroundTrodden
				}
				w.carve(x, y, g)
			}
		}
		for y := s.TY - 2; y <= s.TY+1; y++ {
			for x := s.TX - 2; x <= s.TX+2; x++ {
				w.setBare(x, y)
			}
		}
	}
}

// ---------------------------------------------------------- 2. paths

func (w *woods) stepCost(x, y int) int {
	if !w.openable(x, y) {
		return -1
	}
	if w.walk[w.at(x, y)] {
		return 70
	}
	n := int64(w.wind.at(x*71, y*71)) // a cost field on a 3.6-tile lattice
	c := 100 + int(900*n*n>>32)
	if x == 1 || y == 1 || x == w.S-2 || y == w.S-2 {
		c += 400
	}
	return c
}

func (w *woods) route(from Tile, goal func(x, y int) bool) []Tile {
	return cheapest(w.S, from, w.stepCost, goal)
}

func (w *woods) onNetwork(x, y int) bool { return w.network[w.at(x, y)] }

func (w *woods) layPaths() {
	S, rng := w.S, w.rng
	hub := Tile{clamp(S/2-4+rng.NextInt(8), 5, S-6), clamp(S/2-4+rng.NextInt(8), 5, S-6)}
	// Never in (or touching) a still pool: the hub must be openable ground.
	fits := func(t Tile) bool {
		if w.isBlocked(t.TX, t.TY) {
			return false
		}
		for _, d := range dirs4 {
			if w.isBlocked(t.TX+d[0], t.TY+d[1]) {
				return false
			}
		}
		return true
	}
	if !fits(hub) {
		best, bestD := hub, -1
		for y := 5; y <= S-6; y++ {
			for x := 5; x <= S-6; x++ {
				d := (x-hub.TX)*(x-hub.TX) + (y-hub.TY)*(y-hub.TY)
				if fits(Tile{x, y}) && (bestD < 0 || d < bestD) {
					best, bestD = Tile{x, y}, d
				}
			}
		}
		hub = best
	}
	w.carve(hub.TX, hub.TY, GroundPath)
	w.network[w.at(hub.TX, hub.TY)] = true
	for _, d := range dirs4 {
		w.carve(hub.TX+d[0], hub.TY+d[1], GroundVerge)
		w.mark(w.network, hub.TX+d[0], hub.TY+d[1])
	}
	w.forks = append(w.forks, hub)

	byHub := func(list []Tile) []Tile {
		out := append([]Tile(nil), list...)
		slices.SortStableFunc(out, func(a, b Tile) int {
			return (a.TX-hub.TX)*(a.TX-hub.TX) + (a.TY-hub.TY)*(a.TY-hub.TY) - (b.TX-hub.TX)*(b.TX-hub.TX) - (b.TY-hub.TY)*(b.TY-hub.TY)
		})
		return out
	}
	for _, t := range byHub(w.throats) {
		w.layOne(t, true)
	}
	for _, t := range byHub(w.points) {
		w.layOne(t, false)
	}
}

func (w *woods) layOne(from Tile, trunk bool) {
	S, rng := w.S, w.rng
	line := w.route(from, w.onNetwork)
	// Trunks bend: a detour through a point pushed off the straight line.
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
			clamp(mid.TX-divRound(ay*push*fp, l), 2, S-3),
			clamp(mid.TY+divRound(ax*push*fp, l), 2, S-3),
		}
		// Only through open ground, and only if the detour really arrives.
		if w.openable(via.TX, via.TY) {
			first := w.route(from, func(x, y int) bool { return x == via.TX && y == via.TY })
			if end := first[len(first)-1]; end == via {
				line = append(first[:len(first)-1], w.route(via, w.onNetwork)...)
			}
		}
	}
	if len(line) > 2 {
		w.forks = append(w.forks, line[len(line)-1])
	}
	for _, t := range line {
		w.network[w.at(t.TX, t.TY)] = true
		w.core = append(w.core, t)
		// An uneven brush: 2×2 nudged by noise, widening to 3×3 along trunks.
		wide := trunk && w.brush.at(t.TX*179, t.TY*179) > 29491 // 0.45
		x0, y0, span := t.TX-1, t.TY-1, 3
		if !wide {
			span = 2
			x0, y0 = t.TX, t.TY
			if w.brush.at(t.TX*333+9*fp, t.TY*333) < noiseMid {
				x0--
			}
			if w.brush.at(t.TX*333, t.TY*333+9*fp) < noiseMid {
				y0--
			}
		}
		for y := y0; y < y0+span; y++ {
			for x := x0; x < x0+span; x++ {
				w.carve(x, y, GroundVerge)
			}
		}
		w.carve(t.TX, t.TY, GroundPath)
	}
}

func (w *woods) pickCore() Tile      { return w.core[w.rng.NextInt(len(w.core))] }
func (w *woods) pickDir() [2]int     { return dirs4[w.rng.NextInt(4)] }
func (w *woods) leanHome(x int) bool { return w.home.TX > x }

func (w *woods) spot(kind DecorKind, x, y, ox, oy int, flip bool) Decor {
	return Decor{Kind: kind, TX: x, TY: y, OX: ox, OY: oy, Variant: w.rng.NextInt(8), Flip: flip}
}

func (w *woods) addSpecial(d Decor) {
	w.special = append(w.special, d)
	w.specialAt[w.at(d.TX, d.TY)] = true
}

// ---------------------------------------------------------- 3. side glades

func (w *woods) addGlades() {
	S, rng := w.S, w.rng
	if len(w.core) == 0 {
		return
	}
	features := [...]DecorKind{DecorRingStump, DecorSnag, DecorBoulder, DecorTurncaps}
	glades := 1
	if rng.Chance(600) {
		glades++
	}
	ringStumps := 0
	for g, tries := 0, 0; g < glades && tries < 60; tries++ {
		c := w.pickCore()
		d := w.pickDir()
		ctr := Tile{c.TX + d[0]*3, c.TY + d[1]*3}
		if ctr.TX < 2 || ctr.TY < 2 || ctr.TX > S-3 || ctr.TY > S-3 {
			continue
		}
		fresh := true
		for y := ctr.TY - 1; y <= ctr.TY+1 && fresh; y++ {
			for x := ctr.TX - 1; x <= ctr.TX+1 && fresh; x++ {
				if w.isWalk(x, y) || w.isBlocked(x, y) {
					fresh = false
				}
			}
		}
		if !fresh || w.nearPoint(ctr.TX, ctr.TY, 3) || w.nearThroat(ctr.TX, ctr.TY, 3) {
			continue
		}
		// The way in, then the ragged ring around the glade's centre.
		w.carve(c.TX+d[0], c.TY+d[1], GroundMoss)
		w.carve(c.TX+d[0]*2, c.TY+d[1]*2, GroundMoss)
		for y := ctr.TY - 2; y <= ctr.TY+2; y++ {
			for x := ctr.TX - 2; x <= ctr.TX+2; x++ {
				if cheb(x-ctr.TX, y-ctr.TY) <= 1 || hypot256(x-ctr.TX, y-ctr.TY)+jitter256(w.jag, x*230+3*fp, y*230, 358) <= 486 {
					w.carve(x, y, GroundMoss)
				}
			}
		}
		feature := features[rng.NextInt(len(features))]
		if feature == DecorRingStump && ringStumps > 0 {
			feature = DecorBoulder
		}
		if feature == DecorTurncaps {
			// A ring of caps on open moss, all leaning the same way.
			for _, r := range [...][2]int{{-1, -1}, {1, -1}, {-1, 1}, {1, 1}, {0, 0}} {
				x, y := ctr.TX+r[0], ctr.TY+r[1]
				w.undergrow = append(w.undergrow, w.spot(DecorTurncaps, x, y, rng.Spread(2), -rng.NextInt(4), w.leanHome(x)))
			}
		} else {
			w.walk[w.at(ctr.TX, ctr.TY)] = false
			w.addSpecial(w.spot(feature, ctr.TX, ctr.TY, 0, -1, false))
			if feature == DecorRingStump {
				ringStumps++
			}
			// Turncaps gather on the dead wood.
			if feature != DecorBoulder {
				for _, r := range [...][2]int{{1, 0}, {-1, 1}} {
					x, y := ctr.TX+r[0], ctr.TY+r[1]
					w.undergrow = append(w.undergrow, w.spot(DecorTurncaps, x, y, -r[0]*4, -2, w.leanHome(x)))
				}
			}
		}
		for y := ctr.TY - 1; y <= ctr.TY+1; y++ {
			for x := ctr.TX - 1; x <= ctr.TX+1; x++ {
				w.setBare(x, y)
			}
		}
		g++
	}
}

// ---------------------------------------------------------- 4. drift cues

// addSpurs: a path into the woods that ends at a tree standing on it. The
// outer drift leaves several.
func (w *woods) addSpurs() {
	rng := w.rng
	if len(w.core) == 0 {
		return
	}
	spurs := 0
	if w.outer {
		spurs = 2
		if rng.Coin() {
			spurs++
		}
	} else if rng.Chance(800) {
		spurs = 1
	}
	for n := 0; n < spurs; n++ {
		for tries := 0; tries < 80; tries++ {
			c := w.pickCore()
			d := w.pickDir()
			length := rng.Between(3, 5)
			end := Tile{c.TX + d[0]*(length+1), c.TY + d[1]*(length+1)}
			if !w.interior(end.TX, end.TY) || w.nearPoint(c.TX, c.TY, 3) || w.nearThroat(c.TX, c.TY, 3) {
				continue
			}
			ok := true
			for k := 1; k <= length+1 && ok; k++ {
				x, y := c.TX+d[0]*k, c.TY+d[1]*k
				if !w.interior(x, y) || w.isBlocked(x, y) || (k > 1 && w.isWalk(x, y)) {
					ok = false
				}
				// Woods on both sides past the first step, so it reads as its own lane.
				if ok && k > 1 && (w.isWalk(x+d[1], y+d[0]) || w.isWalk(x-d[1], y-d[0])) {
					ok = false
				}
				if ok && w.nearPoint(x, y, 2) {
					ok = false
				}
			}
			if !ok {
				continue
			}
			for k := 1; k <= length; k++ {
				w.carve(c.TX+d[0]*k, c.TY+d[1]*k, GroundPath)
			}
			// The path runs on under the tree (and a tile beyond, into the woods).
			w.ground[w.at(end.TX, end.TY)] = GroundPath
			if bx, by := end.TX+d[0], end.TY+d[1]; w.interior(bx, by) && !w.isWalk(bx, by) && !w.isBlocked(bx, by) {
				w.ground[w.at(bx, by)] = GroundPath
			}
			kind := DecorOak
			if rng.Coin() {
				kind = DecorIronOak
			}
			w.addSpecial(w.spot(kind, end.TX, end.TY, 0, -1, false))
			break
		}
	}
}

// addRoads: a straight two-wide run of the old road's cobbles, cut off by
// the woods. Out in the drift it lies in broken pieces.
func (w *woods) addRoads() {
	S, rng := w.S, w.rng
	roads := 0
	if w.outer {
		roads = 2
	} else if rng.Chance(600) {
		roads = 1
	}
	for n := 0; n < roads; n++ {
		for tries := 0; tries < 40; tries++ {
			horiz := rng.Coin()
			length := rng.Between(6, 10)
			along0 := 1 + rng.NextInt(S-length-2)
			across := 3 + rng.NextInt(S-7)
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
				i := w.at(t.TX, t.TY)
				if w.walk[i] {
					open = true
				} else {
					shut = true
				}
				if w.bare[i] || w.blocked[i] || w.specialAt[i] {
					clear = false
				}
			}
			if !open || !shut || !clear {
				continue
			}
			for _, t := range tiles {
				w.ground[w.at(t.TX, t.TY)] = GroundRoad
			}
			break
		}
	}
}

// ---------------------------------------------------------- 5. dressing

// overhangs: does the piece's art reach at least 3 px into a walkable tile?
func (w *woods) overhangs(d Decor) bool {
	a := DecorArts[d.Kind]
	x0 := d.TX*tilePx + tilePx/2 + d.OX - a.W/2
	y1 := (d.TY+1)*tilePx + d.OY
	y0 := y1 - a.H
	for ty := floorDiv(y0, tilePx); ty <= floorDiv(y1-1, tilePx); ty++ {
		for tx := floorDiv(x0, tilePx); tx <= floorDiv(x0+a.W-1, tilePx); tx++ {
			if !w.isWalk(tx, ty) {
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

func (w *woods) place(d Decor) {
	d.Overhang = DecorArts[d.Kind].Blocking && w.overhangs(d)
	w.decor = append(w.decor, d)
}

func (w *woods) take(x, y int) { w.taken[w.at(x, y)] = true }

func (w *woods) tree(x, y int, edge, underPath bool) Decor {
	rng := w.rng
	r := rng.NextInt(1000)
	ox := rng.Spread(4)
	oy := -rng.NextInt(5)
	if edge {
		ox = rng.Spread(2)
		oy = -rng.NextInt(3)
	}
	if underPath {
		oy = rng.NextInt(3)
	}
	if r < 140 && !edge {
		big := w.spot(DecorIronOak, x, y, ox, oy, rng.Coin())
		if !w.overhangs(big) {
			return big
		}
	}
	// The outer drift is paler and stranger: birch and dead wood among the oaks.
	kind := DecorOak
	switch {
	case w.outer && r < 300:
		kind = DecorBirch
	case w.outer && r < 440:
		kind = DecorPine
	case w.outer && r < 500 && !edge:
		kind = DecorSnag
	case !w.outer && r < 360:
		kind = DecorPine
	case !w.outer && r < 430:
		kind = DecorBirch
	}
	return w.spot(kind, x, y, ox, oy, rng.Coin())
}

func (w *woods) dress() {
	S, rng := w.S, w.rng
	w.solid = make([]bool, S*S)
	for i, open := range w.walk {
		w.solid[i] = !open
	}
	copy(w.taken, w.blocked)

	// Cairns beside forks: on a woods tile that faces the path.
	cairns := 0
	for _, f := range w.forks {
		if cairns >= 2 {
			break
		}
		if w.nearThroat(f.TX, f.TY, 2) || w.nearPoint(f.TX, f.TY, 1) {
			continue
		}
		best, bestD := Tile{}, -1
		for y := f.TY - 2; y <= f.TY+2; y++ {
			for x := f.TX - 2; x <= f.TX+2; x++ {
				if !w.interior(x, y) || w.isWalk(x, y) || w.isBlocked(x, y) || w.specialAt[w.at(x, y)] || !w.faces(x, y) {
					continue
				}
				d := hypot256(x-f.TX, y-f.TY) + rng.NextInt(77)
				if bestD < 0 || d < bestD {
					best, bestD = Tile{x, y}, d
				}
			}
		}
		if bestD < 0 {
			continue
		}
		w.addSpecial(w.spot(DecorCairn, best.TX, best.TY, 0, -1, false))
		cairns++
	}
	for _, d := range w.special {
		w.place(d)
		w.take(d.TX, d.TY)
	}

	// Fallen logs: two woods tiles side by side, facing the path.
	logs := 0
	for y := 1; y < S-1 && logs < 2; y++ {
		for x := 1; x < S-2 && logs < 2; x++ {
			if w.isWalk(x, y) || w.isWalk(x+1, y) || w.taken[w.at(x, y)] || w.taken[w.at(x+1, y)] {
				continue
			}
			if !(w.isWalk(x, y+1) && w.isWalk(x+1, y+1)) && !(w.isWalk(x, y-1) && w.isWalk(x+1, y-1)) {
				continue
			}
			if !rng.Chance(100) {
				continue
			}
			w.place(w.spot(DecorLog, x, y, 8, -1, rng.Coin()))
			w.take(x, y)
			w.take(x+1, y)
			logs++
		}
	}

	// Reeds stand round the still pools (and in their shallows).
	for _, p := range w.pools {
		for _, o := range [...][2]int{{-5, 1}, {5, -6}} {
			if rng.Chance(700) {
				w.undergrow = append(w.undergrow, w.spot(DecorReeds, p.TX, p.TY, o[0]+rng.Spread(2), o[1], rng.Coin()))
			}
		}
	}

	for y := 0; y < S; y++ {
		for x := 0; x < S; x++ {
			if w.isWalk(x, y) || w.taken[w.at(x, y)] {
				continue
			}
			edge := w.faces(x, y)
			// Woods right below a path: keep the canopy off the path where we can.
			underPath := w.isWalk(x, y-1)
			r := rng.NextInt(1000)
			if edge {
				pick := func(onPath, otherwise int) int {
					if underPath {
						return onPath
					}
					return otherwise
				}
				switch {
				case r < pick(300, 100):
					w.place(w.spot(DecorThicket, x, y, rng.Spread(2), 0, rng.Coin()))
				case r < pick(360, 140):
					w.place(w.spot(DecorBoulder, x, y, rng.Spread(2), -1, rng.Coin()))
				case r < pick(420, 180):
					w.place(w.spot(DecorStump, x, y, rng.Spread(2), -2, rng.Coin()))
				// Drift-stone and dead birches stand about in the outer Wilds.
				case w.outer && r < pick(500, 280):
					kind := DecorBoulder
					if rng.Coin() {
						kind = DecorSnag
					}
					w.place(w.spot(kind, x, y, rng.Spread(2), -1, rng.Coin()))
				default:
					w.place(w.tree(x, y, true, underPath))
				}
				// Undergrowth at the foot of the woods, in front of the trunks.
				if w.isWalk(x, y+1) && !w.isBare(x, y+1) && rng.Chance(450) {
					kind := DecorGrass
					if rng.Chance(600) {
						kind = DecorFern
					}
					w.undergrow = append(w.undergrow, w.spot(kind, x, y, rng.Spread(4), 2, rng.Coin()))
				}
			} else {
				switch {
				case r < 80:
					w.place(w.spot(DecorThicket, x, y, rng.Spread(3), -rng.NextInt(4), rng.Coin()))
				case r < 130:
					w.place(w.spot(DecorFern, x, y, rng.Spread(3), -rng.NextInt(5), rng.Coin()))
				case r < 380 && !w.nearWalk(x, y):
					// Deep in the woods the crowns close overhead on their own:
					// thinner planting keeps the canopy whole with fewer sprites.
					continue
				default:
					w.place(w.tree(x, y, false, false))
				}
			}
			w.take(x, y)
		}
	}

	// Walk-through undergrowth along the edges; decals on the open ground.
	rooted := make([]bool, S*S)
	for _, d := range w.decor {
		if d.Kind == DecorOak || d.Kind == DecorIronOak {
			rooted[w.at(d.TX, d.TY)] = true
		}
	}
	isRooted := func(x, y int) bool { return w.inBounds(x, y) && rooted[w.at(x, y)] }
	for y := 1; y < S-1; y++ {
		for x := 1; x < S-1; x++ {
			if !w.isWalk(x, y) || w.isBare(x, y) {
				continue
			}
			var woodsDirs [][2]int
			for _, d := range dirs4 {
				if !w.isWalk(x+d[0], y+d[1]) {
					woodsDirs = append(woodsDirs, d)
				}
			}
			r := rng.NextInt(1000)
			g := w.ground[w.at(x, y)]
			switch {
			case len(woodsDirs) > 0:
				d := woodsDirs[rng.NextInt(len(woodsDirs))]
				ox := d[0]*5 + rng.Spread(1)
				oy := edgeOY(d[1], -rng.NextInt(5))
				switch {
				case r < 380:
					w.undergrow = append(w.undergrow, w.spot(DecorFern, x, y, ox, oy, rng.Coin()))
				case r < 560:
					w.undergrow = append(w.undergrow, w.spot(DecorGrass, x, y, ox, oy, rng.Coin()))
				case r < 620:
					w.undergrow = append(w.undergrow, w.spot(DecorTurncaps, x, y, ox, oy, w.leanHome(x)))
				case r < 660:
					w.undergrow = append(w.undergrow, w.spot(DecorFlowers, x, y, ox, oy, rng.Coin()))
				}
				// A second tuft against another side now and then.
				if len(woodsDirs) > 1 && rng.Chance(300) {
					e := woodsDirs[0]
					if e == d {
						e = woodsDirs[1]
					}
					kind := DecorGrass
					if rng.Coin() {
						kind = DecorFern
					}
					w.undergrow = append(w.undergrow, w.spot(kind, x, y, e[0]*5, edgeOY(e[1], -2), rng.Coin()))
				}
				// Roots crossing the path from an oak beside it.
				for _, rd := range dirs4 {
					if !isRooted(x+rd[0], y+rd[1]) {
						continue
					}
					if rng.Chance(350) {
						oy := 0
						if rd[1] < 0 {
							oy = -2
						}
						w.undergrow = append(w.undergrow, w.spot(DecorRoots, x, y, rd[0]*3, oy, rd[0] > 0))
					}
					break
				}
			case g == GroundPath || g == GroundVerge || g == GroundRoad:
				if r < 60 {
					w.undergrow = append(w.undergrow, w.spot(DecorPebbles, x, y, rng.Spread(4), -rng.NextInt(9), rng.Coin()))
				} else if r < 140 {
					w.undergrow = append(w.undergrow, w.spot(DecorLitter, x, y, rng.Spread(4), -rng.NextInt(9), rng.Coin()))
				}
			case r < 140:
				w.undergrow = append(w.undergrow, w.spot(DecorGrass, x, y, rng.Spread(4), -rng.NextInt(7), rng.Coin()))
			case r < 210:
				w.undergrow = append(w.undergrow, w.spot(DecorFlowers, x, y, rng.Spread(4), -rng.NextInt(7), rng.Coin()))
			case r < 260:
				w.undergrow = append(w.undergrow, w.spot(DecorLitter, x, y, rng.Spread(4), -rng.NextInt(7), rng.Coin()))
			}
		}
	}
	for _, d := range w.undergrow {
		w.place(d)
	}
}

// edgeOY: a tuft against the woods to the north tucks up under the trees,
// one to the south sits on the tile's foot, one to the side keeps `side`.
func edgeOY(dy, side int) int {
	switch {
	case dy < 0:
		return -7
	case dy > 0:
		return 1
	}
	return side
}

// ---------------------------------------------------------- 6. safety

// ensureReach opens the cheapest way (fewest woods tiles, never a pool) from
// the spawn to every exit tile, entity and site still cut off. The rules
// above keep this to a no-op in practice; the invariants test it holds.
func (w *woods) ensureReach() {
	S := w.S
	var targets []Tile
	for _, e := range w.exits {
		for y := e.TY; y < e.TY+e.TH; y++ {
			for x := e.TX; x < e.TX+e.TW; x++ {
				targets = append(targets, Tile{x, y})
			}
		}
	}
	targets = append(targets, w.points...)
	opened := false
	for range len(targets) + 1 {
		reach := w.reachable()
		var stuck *Tile
		for i := range targets {
			if !reach[w.at(targets[i].TX, targets[i].TY)] {
				stuck = &targets[i]
				break
			}
		}
		if stuck == nil {
			break
		}
		step := func(x, y int) int {
			i := w.at(x, y)
			switch {
			case w.blocked[i] || (!w.interior(x, y) && !w.exitTile(x, y)):
				return -1
			case w.solid[i]:
				return 10
			}
			return 1
		}
		line := cheapest(S, *stuck, step, func(x, y int) bool { return reach[w.at(x, y)] })
		for _, t := range line {
			i := w.at(t.TX, t.TY)
			if !w.solid[i] {
				continue
			}
			w.solid[i] = false
			w.walk[i] = true
			w.ground[i] = GroundPath
			opened = true
		}
		if len(line) == 1 && !reach[w.at(stuck.TX, stuck.TY)] {
			i := w.at(stuck.TX, stuck.TY)
			w.solid[i], w.walk[i] = false, true // a lone target with no way at all: at least stand on it
			opened = true
		}
	}
	if !opened {
		return
	}
	// Opened tiles drop their blocking pieces; overhangs are re-read.
	kept := w.decor[:0]
	for _, d := range w.decor {
		if DecorArts[d.Kind].Blocking && !w.solid[w.at(d.TX, d.TY)] {
			continue
		}
		d.Overhang = DecorArts[d.Kind].Blocking && w.overhangs(d)
		kept = append(kept, d)
	}
	w.decor = kept
}

func (w *woods) reachable() []bool {
	seen := make([]bool, w.S*w.S)
	start := w.at(w.spawn.TX, w.spawn.TY)
	if w.solid[start] {
		return seen
	}
	seen[start] = true
	queue := []Tile{w.spawn}
	for len(queue) > 0 {
		t := queue[0]
		queue = queue[1:]
		for _, d := range dirs4 {
			x, y := t.TX+d[0], t.TY+d[1]
			if !w.inBounds(x, y) {
				continue
			}
			i := w.at(x, y)
			if w.solid[i] || seen[i] {
				continue
			}
			seen[i] = true
			queue = append(queue, Tile{x, y})
		}
	}
	return seen
}
