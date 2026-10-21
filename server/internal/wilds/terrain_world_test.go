package wilds

import (
	"reflect"
	"testing"
)

// The walk lab's tops (TerrainWorld) are a pure function of seed and world
// tile: the same on every call, in every order, at negative coordinates.
func TestTerrainWorldTopsPure(t *testing.T) {
	f := TerrainWorld{Seed: "map"}
	other := TerrainWorld{Seed: "map-2"}
	counts := [4]int{}
	differs := 0
	for y := -300; y < 120; y += 7 {
		for x := -200; x < 320; x += 5 {
			z := f.Top(x, y)
			if z > 3 {
				t.Fatalf("top %d at %d,%d", z, x, y)
			}
			if f.Top(x, y) != z || (TerrainWorld{Seed: "map"}).Top(x, y) != z {
				t.Fatal("not deterministic")
			}
			counts[z]++
			if other.Top(x, y) != z {
				differs++
			}
		}
	}
	for z, n := range counts {
		if n == 0 {
			t.Fatalf("no level %d near home: %v", z, counts)
		}
	}
	if differs == 0 {
		t.Fatal("the seed changes nothing")
	}
}

// Near home (call 7): Town and the Tangle and a chunk round them stay flat
// at level 0; the shoulders 3–6 chunks out rise to 1; further out the Tops
// climb to 3.
func TestTerrainWorldNearHome(t *testing.T) {
	f := TerrainWorld{Seed: "map"}
	S := chunkSize()
	ring := map[int][4]int{}
	for y := -12 * S; y < 6*S; y += 3 {
		for x := -8 * S; x < 14*S; x += 3 {
			d := homeFlatTileDist(x, y)
			z := f.Top(x, y)
			if d <= S && z != 0 {
				t.Fatalf("raised ground at %d,%d, %d tiles from home", x, y, d)
			}
			c := ring[min(d/(3*S), 3)]
			c[z]++
			ring[min(d/(3*S), 3)] = c
		}
	}
	if ring[1][1] == 0 || ring[1][3] > ring[1][1] {
		t.Fatalf("3–6 chunks out should be mostly low shoulders: %v", ring[1])
	}
	if ring[2][3]+ring[3][3] == 0 {
		t.Fatalf("no level-3 Tops past 6 chunks: %v %v", ring[2], ring[3])
	}
}

// The stencil sees world tiles: a chunk solved alone (its own field cache,
// structural samples only) is the window's chunk, including chunks at
// negative coordinates and every seam, so the window assembles nothing a
// chunk couldn't.
func TestTerrainWindowSeamsAndChunksAlone(t *testing.T) {
	f := TerrainWorld{Seed: "map"}
	s := TerrainWindowSpec{CX0: -4, CY0: -3, CW: 4, CH: 3}
	s.Anchors = []TerrainAnchor{{"home", -4*24 + 1, -3*24 + 1}}
	p, x0, y0, err := terrainWindowBase(f, s)
	if err != nil {
		t.Fatal(err)
	}
	if x0 != -96 || y0 != -72 {
		t.Fatal("window origin", x0, y0)
	}
	for cy := 0; cy < s.CH; cy++ {
		for cx := 0; cx < s.CW; cx++ {
			wx0, wy0 := x0+cx*24, y0+cy*24
			local := cacheTerrain(f, wx0, wy0, 24, 24)
			for y := 0; y < 24; y++ {
				for x := 0; x < 24; x++ {
					if got, want := TerrainLocal(local, wx0+x, wy0+y), p.Tiles[(cy*24+y)*p.W+cx*24+x]; got != want {
						t.Fatalf("chunk %d,%d tile %d,%d: alone %+v, window %+v", cx, cy, x, y, got, want)
					}
				}
			}
		}
	}
	// Across every seam the two sides' edges agree wherever both are open
	// at the same height, and a south face never crosses a lip it shouldn't:
	// Step is symmetric.
	for i := range p.Tiles {
		for d := 0; d < 4; d++ {
			if j := p.Step(i, d); j >= 0 && p.Step(j, (d+2)%4) != i {
				t.Fatalf("asymmetric step %d→%d", i, j)
			}
		}
	}
}

// Both strategies on the walk window: the region plan certifies, per-chunk
// repair keeps the held exits' tiles but strands the held chunks (their
// landings sit in neighbours' rims). Deterministic, so the lab's numbers
// are the notes' numbers.
func TestTerrainWalkWindowStrategies(t *testing.T) {
	f := TerrainWorld{Seed: "map"}
	spec := TerrainWalkSpec()
	region, err := NewTerrainWindow(f, spec, "region")
	if err != nil {
		t.Fatal(err)
	}
	chunk, err := NewTerrainWindow(f, spec, "chunk")
	if err != nil {
		t.Fatal(err)
	}
	r, c := region.Certificate(), chunk.Certificate()
	t.Logf("region: ramps %d, stranded %d/%d, anchors %d/%d, exits %d/%d", region.Ramps, r.StrandedComponents, r.StrandedTiles, r.AnchorsReached, r.Anchors, r.HeldExitsKept, r.HeldExits)
	t.Logf("chunk: ramps %d, stranded %d/%d, anchors %d/%d, exits %d/%d", chunk.Ramps, c.StrandedComponents, c.StrandedTiles, c.AnchorsReached, c.Anchors, c.HeldExitsKept, c.HeldExits)
	if r.StrandedTiles != 0 || r.AnchorsReached != r.Anchors || r.HeldExitsKept != r.HeldExits || r.HeldExits != 288 {
		t.Fatal("the region plan must certify the walk window")
	}
	if c.StrandedTiles == 0 || c.AnchorsReached == c.Anchors {
		t.Fatal("per-chunk repair no longer strands the held chunks: update the notes")
	}
	// The held chunks' middles are stranded under per-chunk repair.
	for _, a := range chunk.Anchors {
		i := a.Y*chunk.W + a.X
		if len(a.Name) > 5 && a.Name[:5] == "held-" && c.Labels[i] == c.Home {
			t.Fatalf("%s reached home under per-chunk repair", a.Name)
		}
	}
	// Ramps: the region plan's are few, per-chunk repair's many, and every
	// ramp tile is a slope of at most a quarter level a tile.
	if region.Ramps == 0 || chunk.Ramps <= region.Ramps {
		t.Fatalf("ramps region %d, chunk %d", region.Ramps, chunk.Ramps)
	}
	for _, p := range []*TerrainWindowPlan{region, chunk} {
		for _, tile := range p.Tiles {
			if tile.Kind != TerrainRamp {
				continue
			}
			lo, hi := int16(32767), int16(-1)
			for _, q := range tile.Edges {
				if q >= 0 {
					lo, hi = min(lo, q), max(hi, q)
				}
			}
			if hi-lo > 64 {
				t.Fatalf("%s ramp tile climbs %d/256 in a tile", p.Strategy, hi-lo)
			}
		}
	}
	again, _ := NewTerrainWindow(f, spec, "region")
	if !reflect.DeepEqual(again.Tiles, region.Tiles) {
		t.Fatal("region plan not deterministic")
	}
	// Each chunk of the per-chunk plan encodes and decodes exactly, at the spike's sizes.
	for cy := 0; cy < spec.CH; cy++ {
		for cx := 0; cx < spec.CW; cx++ {
			tiles, _ := chunk.Chunk(cx, cy)
			raw := EncodeTerrainHeight(tiles)
			back, err := DecodeTerrainHeight(raw)
			if err != nil || !reflect.DeepEqual(back, tiles) {
				t.Fatalf("chunk %d,%d codec: %v", cx, cy, err)
			}
		}
	}
}

func TestTerrainWindowRejectsBadFixtures(t *testing.T) {
	f := TerrainWorld{Seed: "map"}
	if _, _, _, err := terrainWindowBase(f, TerrainWindowSpec{CW: 30, CH: 30}); err == nil {
		t.Fatal("accepted a 900-chunk window")
	}
	if _, _, _, err := terrainWindowBase(f, TerrainWindowSpec{CW: 2, CH: 2, Held: [][2]int{{5, 5}}}); err == nil {
		t.Fatal("accepted a held chunk outside the window")
	}
	if _, err := NewTerrainWindow(f, TerrainWindowSpec{CW: 1, CH: 1, Anchors: []TerrainAnchor{{"home", 1, 1}}}, "other"); err == nil {
		t.Fatal("accepted an unknown strategy")
	}
}
