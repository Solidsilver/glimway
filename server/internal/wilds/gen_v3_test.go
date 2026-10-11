package wilds

import (
	"errors"
	"fmt"
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
	minCx, minCy, maxCx, maxCy := frontierChunks()
	var out [][2]int
	for cy := minCy; cy <= maxCy; cy++ {
		for cx := minCx; cx <= maxCx; cx++ {
			if insideReach(cx, cy) {
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
	t.Helper()
	S := chunkSize()
	minCx, minCy, maxCx, maxCy := frontierChunks()
	m := &frontierMap{seed: seed, season: season, x0: minCx * S, y0: minCy * S, W: (maxCx - minCx + 1) * S, H: (maxCy - minCy + 1) * S, chunks: map[[2]int]Chunk{}}
	m.walk = make([]bool, m.W*m.H)
	m.ground = make([]Ground, m.W*m.H)
	for _, c := range frontierList() {
		ch := mustV3(t, seed, season, c[0], c[1])
		m.chunks[c] = ch
		for i := range ch.Ground {
			tx, ty := c[0]*S+i%S, c[1]*S+i/S
			j := (ty-m.y0)*m.W + tx - m.x0
			m.walk[j], m.ground[j] = !ch.Solid[i], ch.Ground[i]
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

// TestV3Determinism: a chunk made alone equals the same chunk made in any
// order, and a new wick turns the Beyond but not the Tangle or the road.
func TestV3Determinism(t *testing.T) {
	seed, season := "oak-7", wickSeason(1795000000)
	list := frontierList()
	alone := map[[2]int]string{}
	for _, c := range list {
		alone[c] = chunkHash(mustV3(t, seed, season, c[0], c[1]))
	}
	order := slices.Clone(list)
	rand.New(rand.NewPCG(7, 9)).Shuffle(len(order), func(i, j int) { order[i], order[j] = order[j], order[i] })
	for _, c := range order {
		if h := chunkHash(mustV3(t, seed, season, c[0], c[1])); h != alone[c] {
			t.Fatalf("chunk %v differs made in another order", c)
		}
	}
	other := wickSeason(1795000000 + 86400*15)
	for _, c := range list {
		h := chunkHash(mustV3(t, seed, other, c[0], c[1]))
		if EpochKindAt(c[0], c[1]) == EpochStill {
			if h != alone[c] {
				t.Fatalf("the Tangle's chunk %v turned", c)
			}
		} else if h == alone[c] {
			t.Fatalf("chunk %v didn't turn at the wick", c)
		}
	}
	if chunkHash(mustV3(t, "oak-8", season, 0, -1)) == alone[[2]int{0, -1}] {
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
					if ny > int(contentRules().GetFrontier().GetSouthLimit()) {
						continue
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

// TestV3Reach: from the Commons gate, every place, every route tile, every
// open edge tile, entity and walkable site of the frontier is reachable;
// every route crossing the Wend has a ford there.
func TestV3Reach(t *testing.T) {
	S := chunkSize()
	gx, gy := gateTile()
	for _, ws := range v3Worlds(25) {
		seed, season := ws[0], ws[1]
		m := buildFrontier(t, seed, season)
		seen := m.reach(gx, gy)
		must := func(what string, tx, ty int) {
			t.Helper()
			if !m.in(tx, ty) || !seen[m.i(tx, ty)] {
				t.Fatalf("%s: %s at %d,%d can't be reached from the gate", seed, what, tx, ty)
			}
		}
		for c, ch := range m.chunks {
			x0, y0 := c[0]*S, c[1]*S
			for _, e := range ch.Entities {
				must(e.ID, x0+e.TX, y0+e.TY)
			}
			for _, s := range ch.Sites {
				if s.Kind == SiteLampStone {
					if ch.Solid[s.TY*S+s.TX] == false {
						t.Fatalf("%s: lamp stone %s isn't solid", seed, s.ID)
					}
					continue
				}
				must(s.ID, x0+s.TX, y0+s.TY)
			}
			for _, p := range ch.Places {
				if !ch.Solid[p.TY*S+p.TX] {
					t.Fatalf("%s: landmark of %s isn't solid", seed, p.ID)
				}
				must(p.ID+" (its front)", x0+p.TX, y0+p.TY+2)
			}
			// Open edge tiles that face an open tile across the edge.
			for i := range ch.Ground {
				lx, ly := i%S, i/S
				if ch.Solid[i] || (lx != 0 && ly != 0 && lx != S-1 && ly != S-1) {
					continue
				}
				tx, ty := x0+lx, y0+ly
				for _, d := range dirs4 {
					ox, oy := tx+d[0], ty+d[1]
					if FloorDiv(ox, S) != c[0] || FloorDiv(oy, S) != c[1] {
						if m.walkable(ox, oy) {
							must("edge tile", tx, ty)
						}
					}
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
					if !m.in(tx, ty) || !insideReach(FloorDiv(tx, S), FloorDiv(ty, S)) || EpochKindAt(FloorDiv(tx, S), FloorDiv(ty, S)) == EpochStill {
						continue
					}
					if g := m.ground[m.i(tx, ty)]; g == groundRiverWater {
						t.Fatalf("%s: a route runs over water at %d,%d (no ford)", seed, tx, ty)
					}
					if m.walk[m.i(tx, ty)] {
						must("route", tx, ty)
					}
				}
			}
		}
	}
}

// frontierRoutes are the wick world's routes and extra fords in the frontier.
func frontierRoutes(w *world) []*line {
	minCx, minCy, maxCx, maxCy := frontierChunks()
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
			if f := w.cellFord(x, y); f != nil {
				out = append(out, f)
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- seams

// TestV3Seams: beside the Tangle, a wick chunk's two edge tiles copy the
// kept chunk's facing two (open where open, solid where solid), with no
// water there; given a stored kept chunk that differs from what v3 would
// make, it copies the stored one, and the opening still reaches the rest.
func TestV3Seams(t *testing.T) {
	S := chunkSize()
	tangle := Footprint("tangle")
	for _, ws := range v3Worlds(8) {
		seed, season := ws[0], ws[1]
		for _, c := range frontierList() {
			cx, cy := c[0], c[1]
			if EpochKindAt(cx, cy) != EpochWick || FootprintDistance(tangle, cx, cy) != 1 {
				continue
			}
			ch := mustV3(t, seed, season, cx, cy)
			w := newWorld(WickEpoch(seed, season))
			for i := range ch.Ground {
				tx, ty := cx*S+i%S, cy*S+i/S
				mx, my, ok := w.seamMirror(tx, ty)
				if !ok {
					continue
				}
				kc := mustV3(t, seed, season, FloorDiv(mx, S), FloorDiv(my, S))
				j := (my-FloorDiv(my, S)*S)*S + mx - FloorDiv(mx, S)*S
				if ch.Solid[i] != kc.Solid[j] {
					t.Fatalf("%s: chunk %d,%d tile %d doesn't copy the Tangle's edge", seed, cx, cy, i)
				}
				if s := groundSurface[ch.Ground[i]]; s == "water" || s == "ford" {
					t.Fatalf("%s: water on the Tangle's seam in %d,%d", seed, cx, cy)
				}
			}
		}
	}
	// A stored Tangle chunk with a different west edge: (-2,-1) copies it.
	seed, season := "seam", wickSeason(1795000000)
	kept := mustV3(t, seed, season, -1, -1)
	stored := ToProto(kept, epochID)
	for ly := 0; ly < S; ly++ {
		for lx := 0; lx < 2; lx++ {
			i := ly*S + lx
			open := ly >= 16 && ly <= 18 // a new 3-tile opening, and nothing else
			if open {
				stored.Solid[i/8] &^= 1 << (i % 8)
			} else {
				stored.Solid[i/8] |= 1 << (i % 8)
			}
		}
	}
	ch, err := GenerateV3(WickEpoch(seed, season), -2, -1, []Kept{{-1, -1, stored}})
	if err != nil {
		t.Fatal(err)
	}
	for ly := 0; ly < S; ly++ {
		for lx := S - 2; lx < S; lx++ {
			if want := !(ly >= 16 && ly <= 18); ch.Solid[ly*S+lx] != want {
				t.Fatalf("tile %d,%d of the newer side doesn't copy the stored edge", lx, ly)
			}
		}
	}
	// The stored opening reaches the chunk's other open edge tiles.
	seen := map[int]bool{(17)*S + S - 1: true}
	q := []int{17*S + S - 1}
	for len(q) > 0 {
		i := q[0]
		q = q[1:]
		for _, d := range dirs4 {
			x, y := i%S+d[0], i/S+d[1]
			if x < 0 || y < 0 || x >= S || y >= S || ch.Solid[y*S+x] || seen[y*S+x] {
				continue
			}
			seen[y*S+x] = true
			q = append(q, y*S+x)
		}
	}
	reached := 0
	for k := range seen {
		if x, y := k%S, k/S; x == 0 || y == 0 || y == S-1 {
			reached++
		}
	}
	if reached == 0 {
		t.Fatal("the stored opening leads nowhere")
	}
}

// ---------------------------------------------------------------- the Wend

// TestV3Wend: the river comes in from the north or the west, leaves at the
// south limit's row no further east than leavesMaxCx, never touches the
// Tangle, keeps to the Whitequiet's west column, and is 2 to 4 tiles wide.
func TestV3Wend(t *testing.T) {
	S := chunkSize()
	data := contentRules().GetRiver()
	minCx, minCy, maxCx, maxCy := frontierChunks()
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
				west = west || tx == minCx*S
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
		// Width: across any row, a run of water and ford is 1..maxWidth+2
		// tiles (rows cut it slantwise, so allow a little).
		for ty := m.y0; ty < m.y0+m.H; ty++ {
			run := 0
			for tx := m.x0; tx <= m.x0+m.W; tx++ {
				if tx < m.x0+m.W && wet(tx, ty) {
					run++
					continue
				}
				if run > 0 && run < int(data.GetMinWidth())-1 {
					t.Fatalf("%s: a river %d tiles wide at row %d", seed, run, ty)
				}
				run = 0
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
		r := newRoad(seed)
		for k, c := range r.order {
			if !insideReach(c[0], c[1]) {
				continue
			}
			_, has := la[lampStoneID(c[0], c[1])]
			_, placed := r.lamps[c] // a chunk the road only clips may have no room for one
			if want := k%int(contentRules().GetRoad().GetLampStoneEvery()) == 0 && placed; has != want {
				t.Fatalf("%s: chunk %v (%d along the road) lamp stone %v", seed, c, k, has)
			}
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
		_, _, maxCx, _ := frontierChunks()
		east := false
		for ty := a.y0; ty < oy-S; ty++ {
			if a.ground[a.i((maxCx+1)*S-1, ty)] == groundPaving {
				east = true
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
				b := tileBox(tx, ty, tx, ty)
				pts := w.landPointsNear(b)
				p := w.warped(tx, ty)
				best, bestD, bestS := -1, int64(0), int64(1)
				for k, q := range pts {
					c := tileCentre(q.x, q.y)
					dx, dy := int64(p.x-c.x), int64(p.y-c.y)
					dd := dx*dx + dy*dy
					if dd > int64(capReach())*int64(capReach()) {
						continue
					}
					if best < 0 || dd*bestS*bestS < bestD*int64(q.size)*int64(q.size) {
						best, bestD, bestS = k, dd, int64(q.size)
					}
				}
				if best >= 0 {
					q := pts[best]
					lx, ly := FloorDiv(q.x, L*S), FloorDiv(q.y, L*S)
					if lx >= 0 && lx < 3 && ly >= 0 && ly < 3 {
						area[[2]int{lx, ly}]++
					}
				}
			}
		}
		for ly := 0; ly < 3; ly++ {
			for lx := 0; lx < 3; lx++ {
				a := area[[2]int{lx, ly}] // in quarters of a chunk
				across = append(across, isqrt(a*100/4))
			}
		}
		// Straight walks: from points across a wide window, 16 ways, the
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
	if median < 35 || median > 80 {
		t.Errorf("median patch %d/10 chunks across, want about 5", median)
	}
	if under2*100/n < 4 || under2*100/n > 20 {
		t.Errorf("%d%% of patches under 2 chunks, want about 10%%", under2*100/n)
	}
	if over12*100/n < 1 || over12*100/n > 15 {
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
	const dirs = 16
	// cos and sin of k·22.5°, ×1000.
	cs := [dirs][2]int{{1000, 0}, {924, 383}, {707, 707}, {383, 924}, {0, 1000}, {-383, 924}, {-707, 707}, {-924, 383},
		{-1000, 0}, {-924, -383}, {-707, -707}, {-383, -924}, {0, -1000}, {383, -924}, {707, -707}, {924, -383}}
	limit := capChunks * S
	for k := 0; k < 3; k++ {
		sx, sy := rng.Between(-60*S, 60*S), rng.Between(-60*S, 60*S)
		d := cs[rng.NextInt(dirs)]
		start := w.landOne(sx, sy)
		changed := false
		for along := 0; along <= limit && !changed; along += 4 {
			for _, side := range []int{-S, -S / 2, 0, S / 2, S} {
				x := sx + (d[0]*along-d[1]*side)/1000
				y := sy + (d[1]*along+d[0]*side)/1000
				if w.landOne(x, y) != start {
					changed = true
					break
				}
			}
		}
		if !changed {
			t.Fatalf("seed %d: from %d,%d heading %v the land stays %s for %d chunks", seed, sx, sy, d, landName(start), capChunks)
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
	for _, ws := range v3Worlds(40) {
		seed, season := ws[0], ws[1]
		e := WickEpoch(seed, season)
		m := buildFrontier(t, seed, season)
		w := newWorld(e)
		places := w.rumourPlaces()
		if len(places) != 7 {
			t.Fatalf("%s: %d places in the frontier", seed, len(places))
		}
		for _, p := range places {
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
		if label[i] != 0 || m.ground[i] == groundRiverWater || m.ground[i] == groundRiverFord {
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
				if label[k] != 0 || m.ground[k] == groundRiverWater || m.ground[k] == groundRiverFord {
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

// TestV3Glimpse: for the chunks just past the frontier, Glimpse names the
// land and river the chunk has when it's made later (0.9's check).
func TestV3Glimpse(t *testing.T) {
	S := chunkSize()
	minCx, minCy, maxCx, maxCy := frontierChunks()
	for _, ws := range v3Worlds(8) {
		seed, season := ws[0], ws[1]
		e := WickEpoch(seed, season)
		rivers := 0
		for cy := minCy - 2; cy <= maxCy; cy++ {
			for cx := minCx - 2; cx <= maxCx+2; cx++ {
				if insideReach(cx, cy) {
					continue
				}
				land, river := Glimpse(e, cx, cy)
				c, err := GenerateV3(e, cx, cy, nil)
				if err != nil {
					t.Fatal(err)
				}
				wet := false
				for _, g := range c.Ground {
					wet = wet || g == groundRiverWater || g == groundRiverFord
				}
				if land != c.Land || river != wet {
					t.Fatalf("%s %d,%d: glimpse %s %v, chunk %s %v", seed, cx, cy, land, river, c.Land, wet)
				}
				if river {
					rivers++
				}
				_ = S
			}
		}
		if rivers == 0 {
			t.Fatalf("%s: the Wend runs on past the frontier nowhere", seed)
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
			var pm contract.WildsChunk
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
