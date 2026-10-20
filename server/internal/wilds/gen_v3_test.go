package wilds

import (
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"regexp"
	"slices"
	"strings"
	"testing"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
)

// The open map's generator (open-map.md section 4).

// wickSeason is the wick season containing unix (the same as v2's outer
// season).
func wickSeason(unix int64) string { return outerSeason(unix) }

// v3Worlds are the seeds and wicks the invariant tests walk.
func v3Worlds(n int) [][2]string {
	var out [][2]string
	for i := range n {
		out = append(out, [2]string{fmt.Sprintf("v3-%d", i), wickSeason(1790000000 + int64(i)*86400*9)})
	}
	return out
}

// epochFor is the epoch a chunk of a world is made in.
func epochFor(seed, season string, cx, cy int) Epoch {
	if EpochKindAt(cx, cy) == EpochStill {
		return StillEpoch(seed)
	}
	return WickEpoch(seed, season)
}

// frontierList is every chunk of the 0.8 frontier, row by row.
func frontierList() [][2]int {
	minCx, minCy, maxCx, maxCy := homeRect()
	var out [][2]int
	for cy := minCy; cy <= maxCy; cy++ {
		for cx := minCx; cx <= maxCx; cx++ {
			if insideHome(cx, cy) && FixedFootprintAt(cx, cy) == nil {
				out = append(out, [2]int{cx, cy})
			}
		}
	}
	return out
}

// frontierMap is a whole frontier, its chunks laid side by side.
type frontierMap struct {
	seed, season string
	x0, y0, W, H int
	walk         []bool
	ground       []Ground
	chunks       map[[2]int]Chunk
}

func buildFrontier(t testing.TB, seed, season string) *frontierMap {
	return buildFrontierKept(t, seed, season, "")
}

// buildFrontierKept is buildFrontier with the Tangle stored from another
// seed's still epoch (keptSeed, when set), passed to every wick chunk
// beside it as its kept neighbours: every seam then differs from what v3
// would make itself.
func buildFrontierKept(t testing.TB, seed, season, keptSeed string) *frontierMap {
	stored := map[[2]int]Chunk{}
	if keptSeed != "" {
		for _, c := range frontierList() {
			if EpochKindAt(c[0], c[1]) == EpochStill {
				stored[c] = mustV3(t, keptSeed, season, c[0], c[1])
			}
		}
	}
	return buildFrontierStored(t, seed, season, stored, false)
}

// buildFrontierStored lays out a frontier whose stored chunks stand as
// given, each passed to the chunks made beside it as a kept neighbour
// (held: as a held one).
func buildFrontierStored(t testing.TB, seed, season string, stored map[[2]int]Chunk, held bool) *frontierMap {
	t.Helper()
	S := chunkSize()
	minCx, minCy, maxCx, maxCy := homeRect()
	m := &frontierMap{seed: seed, season: season, x0: minCx * S, y0: minCy * S, W: (maxCx - minCx + 1) * S, H: (maxCy - minCy + 1) * S, chunks: map[[2]int]Chunk{}}
	m.walk = make([]bool, m.W*m.H)
	m.ground = make([]Ground, m.W*m.H)
	for _, c := range frontierList() {
		var ch Chunk
		if k, ok := stored[c]; ok {
			ch = k
		} else {
			var kept []Kept
			for _, d := range seamOrder {
				if k, ok := stored[[2]int{c[0] + d[0], c[1] + d[1]}]; ok {
					kept = append(kept, Kept{c[0] + d[0], c[1] + d[1], ToProto(k, epochID), held})
				}
			}
			var err error
			if ch, err = GenerateV3(epochFor(seed, season, c[0], c[1]), c[0], c[1], kept); err != nil {
				t.Fatal(err)
			}
		}
		m.chunks[c] = ch
		for i := range ch.Ground {
			tx, ty := c[0]*S+i%S, c[1]*S+i/S
			j := (ty-m.y0)*m.W + tx - m.x0
			m.walk[j], m.ground[j] = !ch.Solid[i], ch.Ground[i]
		}
	}
	for cy := minCy; cy <= maxCy; cy++ {
		for cx := minCx; cx <= maxCx; cx++ {
			if p := FixedFootprintAt(cx, cy); p != nil {
				for ly := range S {
					for lx := range S {
						tx, ty := cx*S+lx, cy*S+ly
						j := m.i(tx, ty)
						m.walk[j], m.ground[j] = fixedTile(p, tx, ty)
					}
				}
			}
		}
	}

	return m
}

func (m *frontierMap) in(tx, ty int) bool {
	return tx >= m.x0 && ty >= m.y0 && tx < m.x0+m.W && ty < m.y0+m.H
}
func (m *frontierMap) i(tx, ty int) int { return (ty-m.y0)*m.W + tx - m.x0 }
func (m *frontierMap) walkable(tx, ty int) bool {
	return m.in(tx, ty) && m.walk[m.i(tx, ty)]
}

// reach floods walkable tiles from (tx, ty).
func (m *frontierMap) reach(tx, ty int) []bool {
	seen := make([]bool, m.W*m.H)
	if !m.walkable(tx, ty) {
		return seen
	}
	seen[m.i(tx, ty)] = true
	q := [][2]int{{tx, ty}}
	for len(q) > 0 {
		p := q[0]
		q = q[1:]
		for _, d := range dirs4 {
			x, y := p[0]+d[0], p[1]+d[1]
			if m.walkable(x, y) && !seen[m.i(x, y)] {
				seen[m.i(x, y)] = true
				q = append(q, [2]int{x, y})
			}
		}
	}
	return seen
}

// ---------------------------------------------------------------- refusals

func TestV3Refusals(t *testing.T) {
	if _, err := GenerateV3(WickEpoch("s", wickSeason(1795000000)), 0, 2, nil); !errors.Is(err, ErrWrongEpoch) {
		t.Fatalf("fixed coordinate generated: %v", err)
	}
	if _, err := GenerateV3(Epoch{"s", EpochWick, 2, wickSeason(1795000000)}, 3, -3, nil); !errors.Is(err, ErrGeneratorUnavailable) {
		t.Fatalf("v2 epoch: %v", err)
	}
	if _, err := GenerateV3(StillEpoch("s"), 3, -3, nil); !errors.Is(err, ErrWrongEpoch) {
		t.Fatalf("a ring chunk in the still epoch: %v", err)
	}
	if _, err := GenerateV3(WickEpoch("s", wickSeason(1795000000)), 0, -1, nil); !errors.Is(err, ErrWrongEpoch) {
		t.Fatalf("a Tangle chunk in a wick epoch: %v", err)
	}
	for _, e := range []Epoch{
		{"s", "held", 3, "0"}, {"s", EpochStill, 3, "t:1:2"}, {"s", EpochWick, 3, "0"}, {"s", EpochWick, 3, "t:9:3"},
	} {
		if _, err := GenerateV3(e, 3, -3, nil); err == nil {
			t.Fatalf("%+v accepted", e)
		}
	}
	if _, ok := Rumour(StillEpoch("s")); ok {
		t.Fatal("a still epoch has a rumour")
	}
	if _, ok := PlaceAt(WickEpoch("s", wickSeason(1795000000)), 0, 0); ok {
		t.Fatal("the Tangle's cell has a place")
	}
}

// ---------------------------------------------------------------- determinism

// TestV3Determinism: one world (with its caches) serving a whole frontier
// in any order makes every chunk exactly as a fresh world does; a new wick
// turns the Beyond but not the Tangle; the seed changes the Tangle.
func TestV3Determinism(t *testing.T) {
	for _, ws := range v3Worlds(6) {
		seed, season := ws[0], ws[1]
		list := frontierList()
		fresh := map[[2]int]string{}
		for _, c := range list {
			fresh[c] = chunkHash(mustV3(t, seed, season, c[0], c[1]))
		}
		for k := range 3 {
			shared := map[string]*world{EpochWick: newWorld(WickEpoch(seed, season)), EpochStill: newWorld(StillEpoch(seed))}
			order := slices.Clone(list)
			rand.New(rand.NewPCG(uint64(k), 9)).Shuffle(len(order), func(i, j int) { order[i], order[j] = order[j], order[i] })
			for _, c := range order {
				ch, err := shared[EpochKindAt(c[0], c[1])].chunk(c[0], c[1], nil)
				if err != nil {
					t.Fatal(err)
				}
				if chunkHash(ch) != fresh[c] {
					t.Fatalf("%s: chunk %v differs made by a shared world in order %d", seed, c, k)
				}
			}
		}
		other := wickSeason(1795000000 + 86400*15)
		for _, c := range list {
			h := chunkHash(mustV3(t, seed, other, c[0], c[1]))
			if EpochKindAt(c[0], c[1]) == EpochStill {
				if h != fresh[c] {
					t.Fatalf("the Tangle's chunk %v turned", c)
				}
			} else if h == fresh[c] && season != other {
				t.Fatalf("chunk %v didn't turn at the wick", c)
			}
		}
	}
	a := mustV3(t, "oak-7", wickSeason(1795000000), 0, -1)
	if chunkHash(mustV3(t, "oak-8", wickSeason(1795000000), 0, -1)) == chunkHash(a) {
		t.Fatal("the world seed didn't change the Tangle")
	}
}

// ---------------------------------------------------------------- edges

// TestV3EdgeAgreement: for every chunk of the frontier and each neighbour
// (outside the frontier too), the two edge tiles each side that one chunk
// computes for the other are exactly what the other makes; and a chunk's own
// edge tiles are its base, untouched by detail.
func TestV3EdgeAgreement(t *testing.T) {
	S := chunkSize()
	for _, ws := range v3Worlds(6) {
		seed, season := ws[0], ws[1]
		made := map[[2]int]Chunk{}
		get := func(cx, cy int) Chunk {
			if c, ok := made[[2]int{cx, cy}]; ok {
				return c
			}
			if p := FixedFootprintAt(cx, cy); p != nil {
				c := Chunk{Ground: make([]Ground, S*S), Solid: make([]bool, S*S)}
				for i := range c.Ground {
					walk, g := fixedTile(p, cx*S+i%S, cy*S+i/S)
					c.Ground[i], c.Solid[i] = g, !walk
				}
				return c
			}

			c := mustV3(t, seed, season, cx, cy)
			made[[2]int{cx, cy}] = c
			return c
		}
		for _, c := range frontierList() {
			cx, cy := c[0], c[1]
			w := newWorld(epochFor(seed, season, cx, cy))
			view := w.fill(cx*S-band, cy*S-band, cx*S+S-1+band, cy*S+S-1+band, nil)
			V := S + 2*band
			for vy := 0; vy < V; vy++ {
				for vx := 0; vx < V; vx++ {
					tx, ty := cx*S-band+vx, cy*S-band+vy
					nx, ny := FloorDiv(tx, S), FloorDiv(ty, S)
					lx, ly := tx-nx*S, ty-ny*S
					if (nx == cx && ny == cy) && lx >= band && ly >= band && lx < S-band && ly < S-band {
						continue // interior: detail's
					}
					if EpochKindAt(cx, cy) == EpochStill && EpochKindAt(nx, ny) != EpochStill {
						continue // the kept side never predicts the newer one
					}
					other := get(nx, ny)
					v := view[vy*V+vx]
					i := ly*S + lx
					if v.walk == other.Solid[i] || v.ground != other.Ground[i] {
						t.Fatalf("%s: chunk %d,%d sees tile %d,%d of %d,%d as walk %v %s; it is walk %v %s",
							seed, cx, cy, lx, ly, nx, ny, v.walk, v.ground, !other.Solid[i], other.Ground[i])
					}
				}
			}
		}
	}
}

// ---------------------------------------------------------------- reach

// TestV3Reach: from the Commons gate, every walkable tile of the frontier
// is reached, but for tiles whose open ground leads only off the frontier;
// landmarks and lamp stones are solid and stand clear; every route over the
// Wend has a ford.
func TestV3Reach(t *testing.T) {
	S := chunkSize()
	for _, ws := range v3Worlds(40) {
		seed, season := ws[0], ws[1]
		m := buildFrontier(t, seed, season)
		m.mustReachAll(t)
		for c, ch := range m.chunks {
			for _, s := range ch.Sites {
				if s.Kind == SiteLampStone && !ch.Solid[s.TY*S+s.TX] {
					t.Fatalf("%s: lamp stone %s isn't solid", seed, s.ID)
				}
			}
			for _, p := range ch.Places {
				if !ch.Solid[p.TY*S+p.TX] || ch.Solid[(p.TY+2)*S+p.TX] {
					t.Fatalf("%s: %s's landmark isn't solid or its front is shut (chunk %v)", seed, p.ID, c)
				}
			}
		}
		w := newWorld(WickEpoch(seed, season))
		for _, r := range frontierRoutes(w) {
			for i := 0; i+1 < len(r.pts); i++ {
				a, b := r.pts[i], r.pts[i+1]
				n := max(isqrt((b.x-a.x)*(b.x-a.x)+(b.y-a.y)*(b.y-a.y))/fp, 1)
				for k := 0; k <= n; k++ {
					tx, ty := pt{a.x + (b.x-a.x)*k/n, a.y + (b.y-a.y)*k/n}.tile()
					if !m.in(tx, ty) || EpochKindAt(FloorDiv(tx, S), FloorDiv(ty, S)) == EpochStill {
						continue
					}
					if g := m.ground[m.i(tx, ty)]; g == groundRiverWater {
						t.Fatalf("%s: a route runs over water at %d,%d (no ford)", seed, tx, ty)
					}
				}
			}
		}
	}
}

// mustReachAll floods from the gate and fails on any walkable tile left
// out, unless its piece of open ground touches the frontier's outer edge
// (it leads off the frontier, where the drift stops a walker).
func (m *frontierMap) mustReachAll(t *testing.T) {
	t.Helper()
	gx, gy := gateTile()
	seen := m.reach(gx, gy)
	for i, open := range m.walk {
		if !open || seen[i] {
			continue
		}
		// Flood the piece left out.
		piece := []int{i}
		seen[i] = true
		off := false
		for k := 0; k < len(piece); k++ {
			j := piece[k]
			x, y := j%m.W, j/m.W
			if frontierExitTile(m.x0+x, m.y0+y) {
				off = true
			}
			for _, d := range dirs4 {
				nx, ny := x+d[0], y+d[1]
				if nx < 0 || ny < 0 || nx >= m.W || ny >= m.H {
					continue
				}
				n := ny*m.W + nx
				if m.walk[n] && !seen[n] {
					seen[n] = true
					piece = append(piece, n)
				}
			}
		}
		if !off {
			tx, ty := m.x0+i%m.W, m.y0+i/m.W
			t.Fatalf("%s %s: %d walkable tiles at %d,%d (chunk %d,%d) can't be reached from the gate",
				m.seed, m.season, len(piece), tx, ty, FloorDiv(tx, chunkSize()), FloorDiv(ty, chunkSize()))
		}
	}
}

// frontierRoutes are the wick world's routes in the frontier.
func frontierRoutes(w *world) []*line {
	minCx, minCy, maxCx, maxCy := homeRect()
	x0, y0 := CellOf(minCx, minCy)
	x1, y1 := CellOf(maxCx, maxCy)
	var out []*line
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			for _, r := range w.cellLinks(x, y) {
				if !slices.Contains(out, r.line) {
					out = append(out, r.line)
				}
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- seams

// TestV3Seams: beside the Tangle, a wick chunk's two edge tiles copy the
// kept chunk's facing two (open where open, solid where solid; corners
// across the corner), with no water there. With the Tangle stored from
// another seed (so every seam differs from what v3 would make), on every
// edge and corner of it, the wick side copies the stored edge, and the whole
// frontier still reaches the gate.
func TestV3Seams(t *testing.T) {
	S := chunkSize()
	tangle := Footprint("tangle")
	for i, ws := range v3Worlds(10) {
		seed, season := ws[0], ws[1]
		keptSeed := ""
		if i%2 == 1 {
			keptSeed = seed + "-other"
		}
		m := buildFrontierKept(t, seed, season, keptSeed)
		w := newWorld(WickEpoch(seed, season))
		copied := 0
		for c, ch := range m.chunks {
			if EpochKindAt(c[0], c[1]) != EpochWick || FootprintDistance(tangle, c[0], c[1]) != 1 {
				continue
			}
			for i := range ch.Ground {
				tx, ty := c[0]*S+i%S, c[1]*S+i/S
				mx, my, ok := w.seamMirror(tx, ty)
				if !ok {
					continue
				}
				if m.walk[m.i(tx, ty)] != m.walk[m.i(mx, my)] {
					t.Fatalf("%s (kept %q): tile %d,%d doesn't copy the Tangle's %d,%d", seed, keptSeed, tx, ty, mx, my)
				}
				if s := groundSurface[ch.Ground[i]]; s == "water" || s == "ford" {
					t.Fatalf("%s: water on the Tangle's seam at %d,%d", seed, tx, ty)
				}
				copied++
			}
		}
		if copied < 3*3*S*band {
			t.Fatalf("%s: only %d seam tiles", seed, copied)
		}
		m.mustReachAll(t)
	}
}

// ---------------------------------------------------------------- the Wend

// TestV3Wend: the river comes in from the north or the west, leaves at the
// south limit's row no further east than leavesMaxCx, never touches the
// Tangle, keeps to the Whitequiet's west column, and is 2 to 4 tiles wide.
func TestV3Wend(t *testing.T) {
	S := chunkSize()
	data := contentRules().GetRiver()
	_, minCy, maxCx, maxCy := homeRect()
	tangle, wq := Footprint("tangle"), Footprint("whitequiet")
	for _, ws := range v3Worlds(60) {
		seed, season := ws[0], ws[1]
		m := buildFrontier(t, seed, season)
		w := newWorld(WickEpoch(seed, season))
		wet := func(tx, ty int) bool {
			g := m.ground[m.i(tx, ty)]
			if g != groundRiverWater && g != groundRiverFord {
				return false
			}
			d, half, _ := w.river.line.nearest(tileCentre(tx, ty), nil)
			return d <= int64(half+fp)*int64(half+fp) // not a reed pool
		}
		north, west, south := false, false, false
		for ty := m.y0; ty < m.y0+m.H; ty++ {
			for tx := m.x0; tx < m.x0+m.W; tx++ {
				if !wet(tx, ty) {
					continue
				}
				cx, cy := FloorDiv(tx, S), FloorDiv(ty, S)
				if FootprintDistance(tangle, cx, cy) == 0 {
					t.Fatalf("%s: river in the Tangle at %d,%d", seed, tx, ty)
				}
				if FootprintDistance(wq, cx, cy) == 0 && cx != int(wq.GetCx()) {
					t.Fatalf("%s: river past the Whitequiet's west column at %d,%d", seed, tx, ty)
				}
				north = north || ty == minCy*S
				west = west || !insideHome(FloorDiv(tx-1, S), FloorDiv(ty, S))
				if ty == (maxCy+1)*S-1 {
					south = true
					if cx > int(data.GetLeavesMaxCx()) {
						t.Fatalf("%s: the river leaves at cx %d", seed, cx)
					}
				}
			}
		}
		if !(north || west) || !south {
			t.Fatalf("%s: the river doesn't cross the frontier (north %v west %v south %v)", seed, north, west, south)
		}
		// The line itself: well clear of the Tangle's box, and north of the
		// Tangle no further east than the Whitequiet's west column.
		tb := footprintBox(tangle)
		wqEast := int(wq.GetCx())*S + S // the first tile east of its west column
		line := w.river.line
		for i, p := range line.pts {
			tx, ty := p.tile()
			if ty < minCy*S-S || ty > (maxCy+1)*S {
				continue
			}
			dx := max(tb.x0-p.x, p.x-tb.x1, 0)
			dy := max(tb.y0-p.y, p.y-tb.y1, 0)
			if d := isqrt(dx*dx+dy*dy) / fp; d < riverMargin-2 {
				t.Fatalf("%s: the Wend's centre comes %d tiles from the Tangle at %d,%d", seed, d, tx, ty)
			}
			if (p.x+line.half[i])/fp >= wqEast {
				t.Fatalf("%s: the Wend's water reaches past the Whitequiet's west column at %d,%d", seed, tx, ty)
			}
		}
		// Width, measured across the water at each point of the line: the
		// line's own width, and within minWidth..maxWidth.
		for i := 1; i+1 < len(line.pts); i++ {
			p := line.pts[i]
			tx, ty := p.tile()
			if tx < m.x0+S || ty < m.y0+S || tx >= m.x0+m.W-S || ty >= m.y0+m.H-S || !wet(tx, ty) {
				continue
			}
			// The narrowest chord through the point, over 16 ways (a bend
			// tilts the true crossing).
			across := 1 << 30
			for a := 0; a < 16; a++ {
				ux, uy := int(1000*math.Cos(float64(a)*math.Pi/16)), int(1000*math.Sin(float64(a)*math.Pi/16))
				chord := 0
				for _, sd := range []int{1, -1} {
					k := 1
					for ; k < 12*4; k++ {
						q := pt{p.x + sd*ux*k*fp/4/1000, p.y + sd*uy*k*fp/4/1000}
						if qx, qy := q.tile(); !wet(qx, qy) {
							break
						}
					}
					chord += k
				}
				across = min(across, chord)
			}
			width := across * 100 / 4 // hundredths of a tile
			lo, hi := 1<<30, 0
			for k := max(i-2, 0); k <= min(i+2, len(line.pts)-1); k++ {
				lo, hi = min(lo, line.half[k]*2*100/fp), max(hi, line.half[k]*2*100/fp)
			}
			if width < lo-150 || width > hi+200 || width < int(data.GetMinWidth())*100-150 || width > int(data.GetMaxWidth())*100+200 {
				t.Fatalf("%s: the Wend is %d.%02d tiles wide at %d,%d (its line says %d.%02d to %d.%02d)", seed, width/100, width%100, tx, ty, lo/100, lo%100, hi/100, hi%100)
			}
		}
		_ = maxCx
	}
}

// ---------------------------------------------------------------- the road

// TestV3Road: the Lantern Road is the same line in every wick of a world,
// starts at the Whitequiet's lantern-road opening, runs north then bends
// east, and carries a lamp stone every second chunk along it, with fixed
// ids.
func TestV3Road(t *testing.T) {
	S := chunkSize()
	for i := range 20 {
		seed := fmt.Sprint("road-", i)
		a := buildFrontier(t, seed, wickSeason(1795000000))
		b := buildFrontier(t, seed, wickSeason(1795000000+86400*15))
		for j := range a.ground {
			if (a.ground[j] == groundPaving) != (b.ground[j] == groundPaving) {
				t.Fatalf("%s: the road moved between wicks", seed)
			}
		}
		lamps := func(m *frontierMap) map[string]Site {
			out := map[string]Site{}
			for _, ch := range m.chunks {
				for _, s := range ch.Sites {
					if s.Kind == SiteLampStone {
						out[s.ID] = s
					}
				}
			}
			return out
		}
		la, lb := lamps(a), lamps(b)
		if len(la) == 0 || fmt.Sprint(la) != fmt.Sprint(lb) {
			t.Fatalf("%s: lamp stones %v then %v", seed, la, lb)
		}
		// Spaced along the road's length: one every lampStoneEvery chunks,
		// never more than 3 chunks of road apart, and in the frontier each
		// where the road says.
		r := newRoad(seed)
		every := int(contentRules().GetRoad().GetLampStoneEvery()) * S * fp
		if len(r.marks) < roadReachChunks*S*fp/every-2 {
			t.Fatalf("%s: %d lamp stones along %d chunks of road", seed, len(r.marks), roadReachChunks)
		}
		for k := 1; k < len(r.marks); k++ {
			if gap := r.marks[k].along - r.marks[k-1].along; gap > 3*S*fp {
				t.Fatalf("%s: %d.%d chunks of road between lamp stones %d and %d", seed, gap/(S*fp), gap*10/(S*fp)%10, k-1, k)
			}
		}
		inside := 0
		for _, mk := range r.marks {
			if !insideHome(mk.chunk[0], mk.chunk[1]) {
				continue
			}
			inside++
			s, ok := la[lampStoneID(mk.chunk[0], mk.chunk[1])]
			if !ok || s.TX != mk.tile.TX || s.TY != mk.tile.TY {
				t.Fatalf("%s: lamp stone in %v missing or moved", seed, mk.chunk)
			}
		}
		if inside != len(la) || inside < 3 {
			t.Fatalf("%s: %d lamp stones laid in the frontier, %d made", seed, inside, len(la))
		}
		// Out of the opening: paving just north of it; then east at the top.
		var ox, oy int
		for _, o := range Footprint("whitequiet").GetOpenings() {
			if o.GetId() == "lantern-road" {
				ox, oy = openingMiddle(o)
			}
		}
		if a.ground[a.i(ox, oy-3)] != groundPaving {
			t.Fatalf("%s: no paving north of the lantern-road opening", seed)
		}
		// The frontier's east edge on the road's own rows: the reach is
		// clipped at its corners, so it lies short of the frontier rectangle
		// (whose east edge the lot column sets, further south).
		minCx, _, maxCx, _ := homeRect()
		east := false
		for ty := a.y0; ty < oy-S; ty++ {
			for cx := maxCx; cx >= minCx; cx-- {
				if insideHome(cx, floorDiv(ty, S)) {
					east = east || a.ground[a.i((cx+1)*S-1, ty)] == groundPaving
					break
				}
			}
		}
		if !east {
			t.Fatalf("%s: the road doesn't run east past the frontier", seed)
		}
	}
}

// ---------------------------------------------------------------- lands

// TestV3LandGuarantees (decisions 15 to 17, over 500 seeds): patch sizes
// follow the table within tolerance and never pass the cap; along any
// straight walk the land around you changes within the cap; the Wend and
// some meadow lie in the first ring past the Whitequiet.
func TestV3LandGuarantees(t *testing.T) {
	seeds := 500
	if testing.Short() {
		seeds = 60
	}
	S := chunkSize()
	sizes := contentRules().GetLandSizes()
	capChunks := int(sizes.GetCapChunks())
	L := int(sizes.GetLandCellChunks())
	var across []int // per point, sqrt(area) in chunks ×10
	meadow := landIndex(contentRules().GetRiver().GetLeanLand())
	for s := range seeds {
		e := WickEpoch(fmt.Sprint("land-", s), wickSeason(1790000000+int64(s)*86400*9))
		w := newWorld(e)
		// Patch sizes: the field's points of the middle 3×3 land cells,
		// areas sampled at half-chunk steps over the 7×7 around them (no
		// point owns a tile further than half the cap away).
		area := map[[2]int]int{}
		step := S / 2
		for ty := -2 * L * S; ty < 5*L*S; ty += step {
			for tx := -2 * L * S; tx < 5*L*S; tx += step {
				pts := w.landPointsNear(tileBox(tx, ty, tx, ty))
				if q := pts[w.fieldOwner(tx, ty, pts)]; q.lx >= 0 && q.lx < 3 && q.ly >= 0 && q.ly < 3 {
					area[[2]int{q.lx, q.ly}]++
				}
			}
		}
		for ly := 0; ly < 3; ly++ {
			for lx := 0; lx < 3; lx++ {
				a := area[[2]int{lx, ly}] // in quarters of a chunk
				across = append(across, isqrt(a*100/4))
			}
		}
		// Straight walks: from points across a wide window, any way, the
		// land within a chunk either side changes within the cap.
		walkChanges(t, w, s, capChunks)
		// The first ring: the Wend and some meadow.
		river, mead := false, false
		for _, c := range frontierList() {
			if FootprintAt(c[0], c[1]) != nil {
				continue
			}
			river = river || w.river.crossesChunk(c[0], c[1])
			for k := 0; k < 4 && !mead; k++ {
				mead = w.landOne(c[0]*S+6+12*(k%2), c[1]*S+6+12*(k/2)) == meadow
			}
		}
		if !river || !mead {
			t.Fatalf("seed %d: first ring river %v meadow %v", s, river, mead)
		}
	}
	slices.Sort(across)
	n := len(across)
	under2, over12 := 0, 0
	for _, a := range across {
		if a < 20 {
			under2++
		}
		if a > 120 {
			over12++
		}
	}
	median := across[n/2]
	t.Logf("patches: %d, median %d.%d chunks across, %d%% under 2, %d%% over 12, widest %d.%d",
		n, median/10, median%10, under2*100/n, over12*100/n, across[n-1]/10, across[n-1]%10)
	// The design's numbers (decision 16, open-map.md 2.2): a median about 5
	// chunks across, about 1 in 10 under 2, about 1 in 20 over 12.
	if median < 40 || median > 60 {
		t.Errorf("median patch %d/10 chunks across, want about 5", median)
	}
	if under2*100/n < 5 || under2*100/n > 18 {
		t.Errorf("%d%% of patches under 2 chunks, want about 10%%", under2*100/n)
	}
	if over12*100/n < 2 || over12*100/n > 8 {
		t.Errorf("%d%% of patches over 12 chunks, want about 5%%", over12*100/n)
	}
	if across[n-1] > capChunks*10 {
		t.Errorf("a patch %d/10 chunks across, past the cap", across[n-1])
	}
}

// walkChanges walks straight lines and fails if the land a walker sees
// (the line and a chunk either side of it) stays one land for longer than
// the cap.
func walkChanges(t *testing.T, w *world, seed, capChunks int) {
	t.Helper()
	S := chunkSize()
	rng := NewRng(uint32(seed) + 99)
	limit := capChunks * S
	for k := 0; k < 6; k++ {
		sx, sy := rng.Between(-60*S, 60*S), rng.Between(-60*S, 60*S)
		a := rng.NextInt(3600) // tenths of a degree
		dx, dy := int(1000*math.Cos(float64(a)*math.Pi/1800)), int(1000*math.Sin(float64(a)*math.Pi/1800))
		start := w.landOne(sx, sy)
		changed := false
		for along := 0; along <= limit && !changed; along += 3 {
			for _, side := range []int{-S, -S / 2, 0, S / 2, S} {
				x := sx + (dx*along-dy*side)/1000
				y := sy + (dy*along+dx*side)/1000
				if w.landOne(x, y) != start {
					changed = true
					break
				}
			}
		}
		if !changed {
			t.Fatalf("seed %d: from %d,%d heading %d.%d° the land stays %s for %d chunks", seed, sx, sy, a/10, a%10, landName(start), capChunks)
		}
	}
}

// ---------------------------------------------------------------- places, rumour

// TestV3PlacesAndRumour: the frontier's nine cells hold the two footprints
// and seven places, each with its landmark (solid, the place's mark in its
// chunk); one rumour per wick, in a new cell, its find in front of the
// landmark; "past the river" exactly when the Wend divides the gate from
// the place; the words built from it hold no digit.
func TestV3PlacesAndRumour(t *testing.T) {
	S := chunkSize()
	digits := regexp.MustCompile(`[0-9]`)
	picked := map[string]bool{}
	rings := map[int]bool{}
	past := 0
	for seedIndex, ws := range v3Worlds(40) {
		seed, season := ws[0], ws[1]
		e := WickEpoch(seed, season)
		m := buildFrontier(t, seed, season)
		w := newWorld(e)
		places := w.rumourPlaces()
		// Pinned per seed, independent of the enumeration/filter implementation.
		// Hearthwick 2's 5×4 block makes cells (1, 1) and (1, 2) footprint
		// cells and moves home a chunk east. 0.14 (the landform's own version,
		// places no longer kept north of home's south row) dropped about two a seed.
		counts := [...]int{10, 10, 11, 11, 10, 9, 10, 14, 10, 8, 10, 13, 11, 13, 10, 14, 11, 10, 10, 11, 7, 10, 11, 9, 12, 8, 9, 12, 12, 11, 10, 8, 11, 7, 9, 11, 11, 10, 9, 9}
		expected := counts[seedIndex]
		if len(places) != expected {
			t.Fatalf("%s: %d rumour places; want %d", seed, len(places), expected)
		}
		for _, p := range places {
			if FixedFootprintAt(p.CX, p.CY) != nil || !insideHome(p.CX, p.CY) {
				t.Fatal("rumour place is not generated frontier ground")
			}
			ch := m.chunks[[2]int{p.CX, p.CY}]
			if FootprintCell(p.CellX, p.CellY) {
				t.Fatalf("%s: place %s in a footprint's cell", seed, p.ID)
			}
			if !slices.Contains(ch.Places, PlaceMark{p.ID, p.Kind, p.TX, p.TY}) {
				t.Fatalf("%s: chunk %d,%d doesn't carry %s", seed, p.CX, p.CY, p.ID)
			}
			found := false
			for _, d := range ch.Decor {
				found = found || (d.TX == p.TX && d.TY == p.TY && d.Kind.String() == p.Landmark)
			}
			if !found || !ch.Solid[p.TY*S+p.TX] {
				t.Fatalf("%s: %s has no solid %s landmark", seed, p.ID, p.Landmark)
			}
			if got, ok := PlaceAt(e, p.CellX, p.CellY); !ok || got.ID != p.ID || got.TX != p.TX {
				t.Fatalf("%s: PlaceAt disagrees for %s", seed, p.ID)
			}
		}
		r, ok := Rumour(e)
		if !ok {
			t.Fatalf("%s: no rumour", seed)
		}
		picked[r.Place.Kind] = true
		rings[r.Ring] = true
		if r.Ring != clamp(NearestFootprint(r.Place.CX, r.Place.CY), 1, 3) {
			t.Fatalf("%s: rumour ring %d for chunk %d,%d", seed, r.Ring, r.Place.CX, r.Place.CY)
		}
		ch := m.chunks[[2]int{r.Place.CX, r.Place.CY}]
		n := 0
		for _, s := range ch.Sites {
			if s.Kind == SiteRumour {
				n++
				if s.ID != r.Site || s.TX != r.SiteTX || s.TY != r.SiteTY || ch.Solid[s.TY*S+s.TX] || s.ID != fmt.Sprintf("rumour:%d:%d", r.Place.CX, r.Place.CY) {
					t.Fatalf("%s: rumour site %+v, pick %+v", seed, s, r)
				}
			}
		}
		total := 0
		for _, c := range m.chunks {
			for _, s := range c.Sites {
				if s.Kind == SiteRumour {
					total++
				}
			}
		}
		if n != 1 || total != 1 {
			t.Fatalf("%s: %d rumour sites in its chunk, %d in all", seed, n, total)
		}
		// The Wend divides the frontier: flood the land with water and fords
		// as walls, and see whether the gate and the place share a side.
		side := m.sides()
		gx, gy := gateTile()
		lx, ly := r.Place.tile()
		if a, b := side[m.i(gx, gy)], side[m.i(lx, ly+2)]; (a != b) != r.PastRiver || a == 0 || b == 0 {
			t.Fatalf("%s: past the river %v, sides %d and %d", seed, r.PastRiver, a, b)
		}
		if r.PastRiver {
			past++
		}
		if text := rumourText(r); digits.MatchString(text) || strings.Contains(text, "{") {
			t.Fatalf("%s: rumour %q", seed, text)
		}
	}
	if len(picked) < 3 || past == 0 || len(rings) != 3 {
		t.Fatalf("rumours too alike: kinds %v, rings %v, %d past the river", picked, rings, past)
	}
}

// sides labels the frontier's land by which side of the Wend it's on (water
// and fords are walls; solid ground is not).
func (m *frontierMap) sides() []int {
	label := make([]int, m.W*m.H)
	next := 0
	for i := range label {
		if !insideHome(FloorDiv(m.x0+i%m.W, chunkSize()), FloorDiv(m.y0+i/m.W, chunkSize())) || label[i] != 0 || m.ground[i] == groundRiverWater || m.ground[i] == groundRiverFord {
			continue
		}
		next++
		label[i] = next
		q := []int{i}
		for len(q) > 0 {
			j := q[0]
			q = q[1:]
			for _, d := range dirs4 {
				x, y := j%m.W+d[0], j/m.W+d[1]
				if x < 0 || y < 0 || x >= m.W || y >= m.H {
					continue
				}
				k := y*m.W + x
				if !insideHome(FloorDiv(m.x0+x, chunkSize()), FloorDiv(m.y0+y, chunkSize())) || label[k] != 0 || m.ground[k] == groundRiverWater || m.ground[k] == groundRiverFord {
					continue
				}
				label[k] = next
				q = append(q, k)
			}
		}
	}
	return label
}

// rumourText builds Elara's line from content's phrase tables.
func rumourText(r RumourPick) string {
	data := contentRules().GetRumour()
	text := data.GetTemplate()
	for _, l := range data.GetLandmarks() {
		if l.GetDecor() == r.Place.Landmark {
			text = strings.ReplaceAll(text, "{landmark}", l.GetPhrase())
		}
	}
	for _, c := range data.GetCompass() {
		if c.GetDir() == r.Compass {
			text = strings.ReplaceAll(text, "{compass}", c.GetPhrase())
		}
	}
	river := ""
	if r.PastRiver {
		river = data.GetPastRiver()
	}
	text = strings.ReplaceAll(text, "{river}", river)
	best := data.GetDistance()[0]
	for _, d := range data.GetDistance() {
		if int(d.GetRing()) <= r.Ring && d.GetRing() >= best.GetRing() {
			best = d
		}
	}
	return strings.ReplaceAll(text, "{distance}", best.GetPhrase())
}

func TestCompass(t *testing.T) {
	for _, c := range []struct {
		dx, dy int
		want   string
	}{{0, -5, "n"}, {5, -5, "ne"}, {5, 0, "e"}, {5, 5, "se"}, {0, 5, "s"}, {-5, 5, "sw"}, {-5, 0, "w"}, {-5, -5, "nw"}, {1, -10, "n"}, {-3, -10, "n"}, {-5, -10, "nw"}, {0, 0, "n"}} {
		if got := compass(c.dx, c.dy); got != c.want {
			t.Errorf("compass(%d,%d) = %s, want %s", c.dx, c.dy, got, c.want)
		}
	}
}

// ---------------------------------------------------------------- glimpse

// TestV3Glimpse: for the chunks just past the frontier, Glimpse (and the
// batch Glimpses) names the land and river the chunk has when it's made
// later (0.9's check). The land is checked two ways besides Chunk.Land:
// against the base a fresh world fills for the chunk (another path through
// the lands pass), and, where the made chunk's centre is plain floor,
// against the floor's own land.
func TestV3Glimpse(t *testing.T) {
	S := chunkSize()
	floorLand := map[Ground]int{}
	for i, g := range landGround {
		floorLand[g.floor] = i
	}
	minCx, minCy, maxCx, maxCy := homeRect()
	for _, ws := range v3Worlds(8) {
		seed, season := ws[0], ws[1]
		e := WickEpoch(seed, season)
		var outside [][2]int
		for cy := minCy - 2; cy <= maxCy; cy++ {
			for cx := minCx - 2; cx <= maxCx+2; cx++ {
				if !insideHome(cx, cy) {
					outside = append(outside, [2]int{cx, cy})
				}
			}
		}
		batch := Glimpses(e, outside)
		rivers, floors := 0, 0
		for k, c := range outside {
			cx, cy := c[0], c[1]
			land, river := Glimpse(e, cx, cy)
			if batch[k].Land != land || batch[k].River != river {
				t.Fatalf("%s %v: Glimpses %+v, Glimpse %s %v", seed, c, batch[k], land, river)
			}
			ch, err := GenerateV3(e, cx, cy, nil)
			if err != nil {
				t.Fatal(err)
			}
			wet := false
			for _, g := range ch.Ground {
				wet = wet || g == groundRiverWater || g == groundRiverFord
			}
			if land != ch.Land || river != wet {
				t.Fatalf("%s %d,%d: glimpse %s %v, chunk %s %v", seed, cx, cy, land, river, ch.Land, wet)
			}
			mid := (S/2)*S + S/2
			base := newWorld(e).fill(cx*S, cy*S, cx*S+S-1, cy*S+S-1, nil)
			if landName(int(base[mid].land)) != land {
				t.Fatalf("%s %d,%d: glimpse %s, the base's centre %s", seed, cx, cy, land, landName(int(base[mid].land)))
			}
			if l, ok := floorLand[ch.Ground[mid]]; ok {
				floors++
				if landName(l) != land {
					t.Fatalf("%s %d,%d: glimpse %s, the centre's floor is %s's", seed, cx, cy, land, landName(l))
				}
			}
			if river {
				rivers++
			}
		}
		if rivers == 0 || floors == 0 {
			t.Fatalf("%s: river glimpses %d, floor checks %d", seed, rivers, floors)
		}
	}
}

// ---------------------------------------------------------------- the chunk

// TestV3ChunkShape: ids, tiers, kinds, the footprints' fixed sites and
// dealt sites, the proto round trip.
func TestV3ChunkShape(t *testing.T) {
	S := chunkSize()
	id := regexp.MustCompile(`^(camp|node|chest|poi):(-?\d+):(-?\d+):\d+$`)
	for _, ws := range v3Worlds(10) {
		seed, season := ws[0], ws[1]
		m := buildFrontier(t, seed, season)
		siteIDs := map[string]bool{}
		for c, ch := range m.chunks {
			if ch.Tier != Tier(c[0], c[1]) || ch.GeneratorVersion != GeneratorV3 {
				t.Fatalf("%s %v: identity %d %d", seed, c, ch.Tier, ch.GeneratorVersion)
			}
			want := "outer"
			if p := FootprintAt(c[0], c[1]); p != nil {
				want = p.GetLook()
			}
			if ch.Look != want || (ch.Mark == "") != (EpochKindAt(c[0], c[1]) == EpochStill) {
				t.Fatalf("%s %v: look %q mark %q", seed, c, ch.Look, ch.Mark)
			}
			t2 := content.WildsRules.Tiers[ch.Tier-1]
			for _, e := range ch.Entities {
				mm := id.FindStringSubmatch(e.ID)
				if mm == nil || mm[2] != fmt.Sprint(c[0]) || mm[3] != fmt.Sprint(c[1]) || mm[1] != e.Kind {
					t.Fatalf("%s: entity id %s in %v", seed, e.ID, c)
				}
				if e.Kind == kindChest && (e.Tier < int(t2.GetChestMin()) || e.Tier > int(t2.GetChestMax())) {
					t.Fatalf("%s: chest tier %d in a tier %d chunk", seed, e.Tier, ch.Tier)
				}
				if ch.Solid[e.TY*S+e.TX] {
					t.Fatalf("%s: entity %s on a solid tile", seed, e.ID)
				}
			}
			for _, s := range ch.Sites {
				if siteIDs[s.ID] {
					t.Fatalf("%s: site %s twice", seed, s.ID)
				}
				siteIDs[s.ID] = true
			}
			// Proto round trip.
			b, err := proto.Marshal(ToProto(ch, epochID))
			if err != nil {
				t.Fatal(err)
			}
			var pm contract.WorldChunk
			if err := proto.Unmarshal(b, &pm); err != nil {
				t.Fatal(err)
			}
			if int(pm.Tier) != ch.Tier || pm.Land != ch.Land || len(pm.Places) != len(ch.Places) || pm.GeneratorVersion != 3 {
				t.Fatalf("%s %v: proto identity", seed, c)
			}
			for i := range ch.Ground {
				g := pm.Ground[i/2] >> (4 * (i % 2)) & 15
				if pm.Palette[g] != ch.Ground[i].String() || Walkable(&pm, i%S, i/S) == ch.Solid[i] {
					t.Fatalf("cell %d differs", i)
				}
			}
			for _, s := range pm.Sites {
				if s.Kind == contract.SiteKind_SITE_KIND_UNSPECIFIED {
					t.Fatalf("%s: site %s has no wire kind", seed, s.Id)
				}
			}
		}
		for _, want := range []string{"plank", "given", "echo:0", "echo:1", "echo:2", "cairn", "nest", "reeds"} {
			if !siteIDs[want] {
				t.Fatalf("%s: no %s site", seed, want)
			}
		}
		// The fixed sites stand where content puts them.
		for _, p := range content.WildsRules.Places {
			for _, s := range p.GetSites() {
				ch := m.chunks[[2]int{int(s.GetCx()), int(s.GetCy())}]
				if !slices.ContainsFunc(ch.Sites, func(x Site) bool { return x.ID == s.GetId() && x.TX == int(s.GetTx()) && x.TY == int(s.GetTy()) }) {
					t.Fatalf("%s: %s isn't at its fixed tile", seed, s.GetId())
				}
			}
		}
		// echo:0 is in the Whitequiet's east column.
		wq := Footprint("whitequiet")
		for c, ch := range m.chunks {
			for _, s := range ch.Sites {
				if s.ID == "echo:0" && c[0] != int(wq.GetCx()+wq.GetWidth())-1 {
					t.Fatalf("%s: echo:0 in column %d", seed, c[0])
				}
			}
		}
	}
}

// TestV3Loot: v3 loot is deterministic, and a table's own trinket chance
// (the rumour's) applies.
func TestV3Loot(t *testing.T) {
	e := WickEpoch("loot", wickSeason(1795000000))
	a, err := RollTableLoot(e, "rumour", "rumour:1:-7", 0)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := RollTableLoot(e, "rumour", "rumour:1:-7", 0)
	if fmt.Sprint(a) != fmt.Sprint(b) {
		t.Fatal("rumour loot isn't deterministic")
	}
	trinkets, own := 0, 0
	for i := range 2000 {
		d, _ := RollTableLoot(e, "rumour", fmt.Sprint("r", i), 0)
		if d.Trinket != nil {
			own++
		}
		d2, _ := RollEntityLoot(e, Entity{ID: fmt.Sprint("c", i), Kind: kindChest, Tier: 3}, 0)
		if d2.Trinket != nil {
			trinkets++
		}
	}
	if own < 450 || own > 750 || trinkets > 300 {
		t.Fatalf("trinkets: rumour %d/2000 (30%%), chest %d/2000 (9%%)", own, trinkets)
	}
	if _, err := RollTableLoot(e, "nope", "x", 0); err == nil {
		t.Fatal("unknown table accepted")
	}
	if _, err := RollTableLoot(e, "rumour", "x", -1); err == nil {
		t.Fatal("negative cycle accepted")
	}
}

// The frontier bounds movement; its southern edge has no artificial wall.
func TestV3SouthLimit(t *testing.T) {
	S := chunkSize()
	for _, ws := range v3Worlds(10) {
		m := buildFrontier(t, ws[0], ws[1])
		open := 0
		for tx := -6 * S; tx < 2*S; tx++ {
			if m.walkable(tx, 8*S-1) {
				open++
			}
		}
		if open == 0 {
			t.Fatalf("%s: artificial south wall", ws[0])
		}
	}
}

// TestV3EdgeTilesFollowField: among the edge tiles, open land is where the
// land field puts it (a border crosses a chunk edge at its natural place),
// but for the few tiles shut because they'd be shut in; and every tile shut
// that way really had no way in: neither the tile inside it nor, across the
// edge, a facing pair of open tiles.
func TestV3EdgeTilesFollowField(t *testing.T) {
	S := chunkSize()
	open, shut := 0, 0
	for _, ws := range v3Worlds(20) {
		seed, season := ws[0], ws[1]
		for _, c := range frontierList() {
			e := epochFor(seed, season, c[0], c[1])
			w := newWorld(e)
			x0, y0 := c[0]*S, c[1]*S
			const pad = band + 3
			raw := w.fillRaw(x0-pad, y0-pad, x0+S-1+pad, y0+S-1+pad, &keptReader{w: w.still(), made: map[[2]int][]baseTile{}})
			rW := S + 2*pad
			at := func(tx, ty int) baseTile { return raw[(ty-y0+pad)*rW+tx-x0+pad] }
			final := w.fill(x0, y0, x0+S-1, y0+S-1, nil)
			for i, f := range final {
				tx, ty := x0+i%S, y0+i/S
				r := at(tx, ty)
				if r.kind != bField || !inBand(tx, ty) || !r.walk {
					continue
				}
				open++
				if f.walk {
					continue
				}
				shut++
				lx, ly := i%S, i/S
				corner := (lx < band || lx >= S-band) && (ly < band || ly >= S-band)
				if corner || (lx != 0 && ly != 0 && lx != S-1 && ly != S-1) {
					continue // a corner block's flood, or one in from the edge (never shut)
				}
				ox, oy := 0, 0
				switch {
				case lx == 0:
					ox = -1
				case lx == S-1:
					ox = 1
				case ly == 0:
					oy = -1
				default:
					oy = 1
				}
				if at(tx-ox, ty-oy).walk || (EpochKindAt(c[0]+ox, c[1]+oy) == e.Kind && at(tx+ox, ty+oy).walk && at(tx+2*ox, ty+2*oy).walk) {
					t.Fatalf("%s: edge tile %d,%d shut though it had a way in", seed, tx, ty)
				}
			}
		}
	}
	t.Logf("edge tiles the field leaves open: %d, shut as shut in: %d (%d.%d%%)", open, shut, shut*100/open, shut*1000/open%10)
	if shut*100 > open {
		t.Fatalf("%d of %d open edge tiles shut: the edge rule overrides the field", shut, open)
	}
}

// The block's exits (hearthwick-2.md §1) must join the dry route network on
// both banks of the Wend, across the kept 5×4 block and its partial cells:
// the Tangle Arch, the South Gate, both Lot Row lane ends, both wildgates
// and a lot's open back on each side.
func TestV3TownReach(t *testing.T) {
	S := chunkSize()
	x0, _, _, _ := homeRect()
	reach := homeReach
	for _, f := range content.PlacesRules.GetFixed() {
		if fx0, _, _, _ := content.FixedChunks(f); f.GetId() == "lots-west" && x0 > fx0-reach {
			t.Fatalf("frontier starts at cx %d, fewer than %d chunks west of the lots", x0, reach)
		}
	}
	starts := [][2]int{{2, 23}, {2, 26}, {12, 119}, {-23, 119}, {46, 119}, {-48, 71}, {71, 72}, {-48, 30}, {71, 100}}
	for _, ws := range v3Worlds(10) {
		m := buildFrontier(t, ws[0], ws[1])
		w := newWorld(WickEpoch(ws[0], ws[1]))
		for _, r := range frontierRoutes(w) {
			for i := 0; i+1 < len(r.pts); i++ {
				for _, f := range content.PlacesRules.GetFixed() {
					if segMeetsBox(r.pts[i], r.pts[i+1], fixedBox(f)) {
						t.Fatalf("%s: route cuts %s", ws[0], f.GetId())
					}
				}
			}
		}

		for _, f := range content.PlacesRules.GetFixed() {
			fx0, fy0, fx1, fy1 := content.FixedChunks(f)
			for cy := fy0; cy <= fy1; cy++ {
				for cx := fx0; cx <= fx1; cx++ {
					if w.river.crossesChunk(cx, cy) {
						t.Fatalf("%s: Wend enters fixed chunk %d,%d", ws[0], cx, cy)
					}
				}
			}
		}
		// Nor its water or banks the soft band and feather beside the lots.
		for k := range seams().soft {
			if m.in(k[0], k[1]) {
				if g := m.ground[m.i(k[0], k[1])]; g == groundRiverWater || g == groundRiverFord || g == groundRiverBank {
					t.Fatalf("%s: the Wend at %d,%d, beside the block", ws[0], k[0], k[1])
				}
			}
		}
		for _, p := range starts {
			seen := m.reach(p[0], p[1])
			for _, q := range starts {
				if !seen[m.i(q[0], q[1])] {
					t.Fatalf("%s: gate %v cannot reach %v", ws[0], p, q)
				}
			}
			// Every generated cell's landmark front is reachable from each gate.
			for _, ch := range m.chunks {
				for range ch.Places {
					cellX, cellY := CellOf(ch.CX, ch.CY)
					place := w.place(cellX, cellY)
					if place == nil {
						continue
					}
					tx, ty := place.front()
					if m.in(tx, ty) && insideHome(FloorDiv(tx, S), FloorDiv(ty, S)) && !seen[m.i(tx, ty)] {
						t.Fatalf("%s: %v cannot reach cell %d,%d front %d,%d", ws[0], p, cellX, cellY, tx, ty)
					}
				}
			}
		}
	}
}

// A stepped frontier exit is a tile on the facing edge, not an entire chunk
// neighbouring a missing chunk. Whole connected components may lead to drift.
func frontierExitTile(tx, ty int) bool {
	S := chunkSize()
	if !insideHome(FloorDiv(tx, S), FloorDiv(ty, S)) {
		return false
	}
	for _, d := range dirs4 {
		if !insideHome(FloorDiv(tx+d[0], S), FloorDiv(ty+d[1], S)) {
			return true
		}
	}
	return false
}
func TestFrontierExitRequiresFacingTile(t *testing.T) {
	for _, c := range []struct {
		x, y int
		exit bool
	}{
		// Chunk (-5, -2), the frontier's north-west step: three chunks from
		// the west lot column (cx -2), four from the Whitequiet's.
		{-108, -48, true}, {-108, -47, false}, {-108, -36, false}, {-120, -36, true}, {-121, -36, false},
	} {
		if got := frontierExitTile(c.x, c.y); got != c.exit {
			t.Fatalf("%d,%d exit %v", c.x, c.y, got)
		}
	}
}
func TestTownInternalPortsHaveNoGeneratedRoute(t *testing.T) {
	for _, c := range []struct {
		id     string
		dx, dy int
	}{{"hearthwick", -1, 0}, {"hearthwick", 1, 0}, {"lots-west", 1, 0}, {"lots-east", -1, 0}} {
		var p *content.FixedPlace
		for _, f := range content.PlacesRules.GetFixed() {
			if f.GetId() == c.id {
				p = f
			}
		}
		if p == nil {
			t.Fatal("no fixed place", c.id)
		}
		if ends := fixedPorts(p, c.dx, c.dy); len(ends) != 0 {
			t.Fatal("internal fixed join created generated route", c.id, c.dx)
		}
	}
}

// The block's public mouths (hearthwick-2.md §1) each get a port: its end
// one tile outside an open fixed edge tile, on generated wick ground, and
// its waypoint further out the same way.
func TestFixedPortsAtTheMouths(t *testing.T) {
	S := chunkSize()
	want := map[string][][2]int{
		"hearthwick": {{12, 119}, {-23, 119}, {46, 119}}, // the South Gate, the Lot Row lane ends
		// The footpaths between lots 0/2 and 4/6, and the wildgate between 2/4: each between its two rows, on the lower's edge.
		"lots-west": {{-48, 48}, {-48, 72}, {-48, 96}},
		"lots-east": {{71, 48}, {71, 72}, {71, 96}},
	}
	for _, f := range content.PlacesRules.GetFixed() {
		var got [][2]int
		for _, d := range dirs4 {
			for _, e := range fixedPorts(f, d[0], d[1]) {
				tx, ty := e.end.tile()
				fx, fy := tx-d[0], ty-d[1]
				if FixedFootprintAt(floorDiv(fx, S), floorDiv(fy, S)) != f || FixedFootprintAt(floorDiv(tx, S), floorDiv(ty, S)) != nil || EpochKindAt(floorDiv(tx, S), floorDiv(ty, S)) != EpochWick {
					t.Fatalf("%s port %d,%d doesn't stand just outside it on wick ground", f.GetId(), tx, ty)
				}
				if walk, _ := fixedTile(f, fx, fy); !walk {
					t.Fatalf("%s port %d,%d faces a wall", f.GetId(), tx, ty)
				}
				wx, wy := e.way.tile()
				if (wx-tx)*d[0] < 8 && (wy-ty)*d[1] < 8 {
					t.Fatalf("%s port %d,%d: waypoint %d,%d isn't out ahead", f.GetId(), tx, ty, wx, wy)
				}
				got = append(got, [2]int{fx, fy})
			}
		}
		if fmt.Sprint(got) != fmt.Sprint(want[f.GetId()]) {
			t.Fatalf("%s mouths %v, want %v", f.GetId(), got, want[f.GetId()])
		}
	}
}
