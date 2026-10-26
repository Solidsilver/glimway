package wilds

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"os/exec"
	"reflect"
	"slices"
	"testing"
)

func checkSlopeRangeAccess(t *testing.T, p *SlopePlan, seed string, hx, hy int) {
	t.Helper()
	c := p.Certificate(hx, hy)
	if c.Home < 0 || c.StrandedTiles != 0 {
		for i, g := range p.Ground {
			if g.Kind == SlopeGround && c.Labels[i] != c.Home && !g.Unreachable {
				t.Log("stranded", p.X+i%p.W, p.Y+i/p.W)
				break
			}
		}
		t.Fatalf("%s: missing home or stranded ground: %d components / %d tiles", seed, c.StrandedComponents, c.StrandedTiles)
	}
	sampler, _ := NewSlopeSamplerRecipe(seed, SlopeRecipeV2)
	for _, r := range p.Ranges {
		rr := sampler.rangeV2(r.X, r.Y)
		route := p.Route(r.PassEnds[0], r.PassEnds[1], func(x, y int) bool { a, _ := rr.local(x, y); return math.Abs(a-rr.notch) > 2 })
		detour := p.Route(r.PassEnds[0], r.PassEnds[1], func(x, y int) bool {
			a, b := rr.local(x, y)
			return math.Abs(a-rr.notch) < 66 && math.Abs(b-rr.axis(rr.notch)) < 26
		})
		if len(route) == 0 || len(detour) <= len(route) {
			t.Fatalf("%s %s: no pass/end travel choice (%d/%d)", seed, r.ID, len(route), len(detour))
		}
		// A clear cardinal neighbour on all sides supplies width for the hero,
		// in addition to exact matching-edge connectivity along the route.
		for _, pt := range route {
			for d := range 4 {
				i := p.Index(pt[0]+terrainDX[d], pt[1]+terrainDY[d])
				if !p.Walkable(i) || c.Labels[i] != c.Home {
					t.Fatal("pass lacks clearance", seed, r.ID, pt)
				}
			}
		}
		spire := p.Index(r.Spire[0], r.Spire[1])
		if !p.Walkable(spire) || !p.Ground[spire].Unreachable || c.Labels[spire] == c.Home {
			t.Fatal("spire must be deliberately isolated", seed, r.ID, r.Spire, p.Tile(spire), slopeHomeDistance(r.Spire[0], r.Spire[1]))
		}
	}
	kinds := [4]int{}
	for i, g := range p.Ground {
		kinds[g.Kind]++
		if g.Kind == SlopeGround && SlopeGradientSquared(p.Tile(i).Corners) > SlopeWalkLimit*SlopeWalkLimit {
			t.Fatal("ordinary floor exceeds the shared corner gradient", seed, i)
		}
		for _, h := range p.Tile(i).Corners {
			if h > 15*SlopeHeightUnit {
				t.Fatal("height exceeds 15 without clipping", seed, h)
			}
		}
	}
	for k, n := range kinds {
		if n == 0 {
			t.Fatal("missing terrain kind", seed, k)
		}
	}
}

func TestSlopeRangesCountry(t *testing.T) {
	for _, seed := range []string{"map", "slopes-17", "slopes-991"} {
		t.Run(seed, func(t *testing.T) {
			p, err := NewSlopePlanRecipe(context.Background(), seed, SlopeRecipeV2, -576, -576, 1152, 1152)
			if err != nil {
				t.Fatal(err)
			}
			checkSlopeRangeAccess(t, p, seed, 12, 30)
			if c := p.Certificate(12, 30); c.IntentionalComponents != 4 {
				t.Fatal("missing isolated summits", c.IntentionalComponents)
			}
			// Existing held/backland fixtures around the town remain the same flat
			// geometry as @1 and all their walkable tiles reach the actual home.
			c := p.Certificate(12, 30)
			old := NewSlopeSampler(seed)
			for _, xy := range [][2]int{{-3, 1}, {-3, 2}, {3, 1}, {-2, 0}, {2, 0}} {
				for y := xy[1] * 24; y < (xy[1]+1)*24; y++ {
					for x := xy[0] * 24; x < (xy[0]+1)*24; x++ {
						i := p.Index(x, y)
						if p.Tile(i) != old.Tile(x, y) || c.Labels[i] != c.Home {
							t.Fatal("home held fixture changed or lost access", seed, x, y)
						}
					}
				}
			}
			for i := range p.Ground {
				x, y := p.X+i%p.W, p.Y+i/p.W
				if slopeHomeDistance(x, y) <= 23 && (p.Tile(i).Corners != [4]uint16{} || c.Labels[i] != c.Home) {
					t.Fatal("protected flat footprint lost home access", x, y)
				}
			}
		})
	}
}

func TestSlopeRangesOwnerAccess(t *testing.T) {
	for n := 0; n < 16; n++ {
		seed := fmt.Sprintf("range-property-%d", n)
		ox, oy := n%5-2, n%7-3
		p, err := NewSlopePlanRecipe(context.Background(), seed, SlopeRecipeV2, ox*576, oy*576, 576, 576)
		if err != nil {
			t.Fatal(err)
		}
		checkSlopeRangeAccess(t, p, seed, ox*576+2, oy*576+2)
		// Complete owner rims are transit corridors, not walls between plans.
		for j := range 576 {
			for _, i := range []int{j, 575*576 + j, j * 576, j*576 + 575} {
				if !p.Walkable(i) || p.Ground[i].Discontinuity != 0 || p.Ground[i].Unreachable {
					t.Fatal("owner rim is not open transit ground", seed, i)
				}
			}
		}
	}
}

func slopeRangeChunks(t *testing.T, reverse bool) [][]byte {
	t.Helper()
	coords := [][2]int{{-25, -25}, {-24, -24}, {-1, -1}, {0, 0}, {24, 24}, {-173, 229}}
	// Include both sides of actual spires, scarps and four-chunk junctions.
	s, _ := NewSlopeSamplerRecipe("map", SlopeRecipeV2)
	for _, owner := range [][2]int{{-1, -1}, {0, -1}, {-1, 0}, {0, 0}} {
		r := s.owner(owner[0]*576+288, owner[1]*576+288)
		coords = append(coords, [2]int{floorDiv(r.Spire[0], 24), floorDiv(r.Spire[1], 24)}, [2]int{floorDiv(r.Outcrop[0], 24), floorDiv(r.Outcrop[1], 24)})
	}
	order := rand.New(rand.NewPCG(71, 991)).Perm(len(coords))
	if reverse {
		slices.Reverse(order)
	}
	out := make([][]byte, len(coords))
	for _, n := range order {
		xy := coords[n]
		x, y := xy[0]*24, xy[1]*24
		f, err := s.Surface(context.Background(), x, y, 24, 24)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := EncodeSlopeChunk(f)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := DecodeSlopeChunk(raw)
		if err != nil || !reflect.DeepEqual(f, decoded) {
			t.Fatal("codec changed surface", xy, err)
		}
		fresh, _ := NewSlopeSamplerRecipe("map", SlopeRecipeV2)
		for yy := 24; yy >= 0; yy-- {
			for xx := 24; xx >= 0; xx-- {
				if f.Corners[yy*25+xx] != fresh.Corner(x+xx, y+yy) {
					t.Fatal("sample order changed a corner", xy)
				}
			}
		}
		for yy := range 24 {
			for xx := range 24 {
				if f.Tile(yy*24+xx) != fresh.Tile(x+xx, y+yy) {
					t.Fatal("sampling changed metadata", xy)
				}
			}
		}
		east, _ := fresh.Surface(context.Background(), x+24, y, 24, 24)
		south, _ := fresh.Surface(context.Background(), x, y+24, 24, 24)
		for i := range 24 {
			a, b := f.Tile(i*24+23), east.Tile(i*24)
			c, d := f.Tile(23*24+i), south.Tile(i)
			if a.Corners[1] != b.Corners[0] || a.Corners[2] != b.Corners[3] || c.Corners[3] != d.Corners[0] || c.Corners[2] != d.Corners[1] || (a.Discontinuity>>1&1) != (b.Discontinuity>>3&1) || (c.Discontinuity>>2&1) != (d.Discontinuity&1) {
				t.Fatal("corner/flag seam mismatch", xy, i)
			}
		}
		out[n] = raw
	}
	return out
}

func TestSlopeRangesDeterminism(t *testing.T) {
	if !reflect.DeepEqual(slopeRangeChunks(t, false), slopeRangeChunks(t, true)) {
		t.Fatal("shuffled chunk order changed geometry")
	}
	if _, err := NewSlopeSamplerRecipe("map", "unknown"); err == nil {
		t.Fatal("unknown recipe accepted")
	}
	a, _ := NewSlopeSamplerRecipe("map", SlopeRecipe)
	if !reflect.DeepEqual(a.Tile(-300, 320), NewSlopeSampler("map").Tile(-300, 320)) {
		t.Fatal("explicit @1 changed")
	}
}

func TestSlopeRangesColdProcesses(t *testing.T) {
	if os.Getenv("GLIMWAY_SLOPE_PROBE") == "1" {
		fmt.Printf("%x", sha256.Sum256(bytes.Join(slopeRangeChunks(t, true), nil)))
		return
	}
	want := fmt.Sprintf("%x", sha256.Sum256(bytes.Join(slopeRangeChunks(t, false), nil)))
	for range 2 {
		cmd := exec.Command(os.Args[0], "-test.run=^TestSlopeRangesColdProcesses$")
		cmd.Env = append(os.Environ(), "GLIMWAY_SLOPE_PROBE=1")
		raw, err := cmd.CombinedOutput()
		if err != nil || !bytes.HasPrefix(raw, []byte(want)) {
			t.Fatalf("cold/warm process mismatch: %s (%v)", raw, err)
		}
	}
}
