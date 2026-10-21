package wilds

import (
	"reflect"
	"testing"
)

type terrainStepFields struct{ lip, hi, lo int }

func (f terrainStepFields) Top(x, y int) uint8 {
	if y <= f.lip {
		return uint8(f.hi)
	}
	return uint8(f.lo)
}
func TestTerrainLocalSouthFace(t *testing.T) {
	for _, lip := range []int{-25, -1, 0, 21, 23, 47} {
		for hi := 1; hi <= 3; hi++ {
			for lo := 0; lo < hi; lo++ {
				f := terrainStepFields{lip, hi, lo}
				rows := (hi - lo) * 3
				for d := 0; d <= rows+1; d++ {
					tile := TerrainLocal(f, 0, lip+d)
					if d > 0 && d <= rows {
						if tile.Kind != TerrainFace || int(tile.FaceRow) != d-1 || int(tile.FaceRows) != rows || int(tile.FaceTop) != hi {
							t.Fatalf("lip %d delta %d row %d: %+v", lip, hi-lo, d, tile)
						}
					} else if tile.Kind != TerrainFlat {
						t.Fatal("face exceeds footprint")
					}
				}
			}
		}
	}
}

func TestTerrainSpikeCertificateAndCodec(t *testing.T) {
	for _, strategy := range []string{"region", "chunk"} {
		p, err := NewTerrainSpike(TerrainRidge{Seed: 17}, strategy)
		if err != nil {
			t.Fatal(err)
		}
		c := p.Certificate()
		t.Logf("%s ramps %d certificate %+v", strategy, p.Ramps, struct{ C, S, T, H, A int }{c.Components, c.StrandedComponents, c.StrandedTiles, c.HeldExitsKept, c.AnchorsReached})
		if strategy == "region" && (c.StrandedTiles != 0 || c.HeldExitsKept != 288 || c.AnchorsReached != 5) {
			t.Fatal("mandatory certificate failed")
		}
		if strategy == "chunk" && c.StrandedTiles == 0 {
			t.Fatal("corner-bowl counterexample disappeared")
		}
		for cy := 0; cy < 8; cy++ {
			for cx := 0; cx < 20; cx++ {
				tiles, _ := p.Chunk(cx, cy)
				raw := EncodeTerrainHeight(tiles)
				decoded, e := DecodeTerrainHeight(raw)
				if e != nil {
					t.Fatalf("%s chunk %d,%d: %v", strategy, cx, cy, e)
				}
				if !reflect.DeepEqual(tiles, decoded) {
					t.Fatal("lossy geometry")
				}
				if len(raw) > 5700 {
					t.Fatalf("height leaves insufficient whole-chunk budget: %d", len(raw))
				}
			}
		}
	}
}

type terrainBoundedFields struct {
	t    *testing.T
	x, y int
	seed uint32
}

func (f terrainBoundedFields) Top(x, y int) uint8 {
	if x != f.x || y < f.y-12 || y > f.y+3 {
		f.t.Fatalf("stencil escaped bound at %d,%d from %d,%d", x, y, f.x, f.y)
	}
	return uint8(Hash(x, y, int(f.seed)) % 4)
}
func TestTerrainStencilBound(t *testing.T) {
	for seed := uint32(0); seed < 300; seed++ {
		TerrainLocal(terrainBoundedFields{t, -24, -1, seed}, -24, -1)
	}
}

func TestTerrainAllRidgeVariants(t *testing.T) {
	for seed := uint32(0); seed < 11; seed++ {
		region, err := NewTerrainSpike(TerrainRidge{Seed: seed}, "region")
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		local, err := NewTerrainSpike(TerrainRidge{Seed: seed}, "chunk")
		if err != nil {
			t.Fatal(err)
		}
		control, err := NewTerrainSpike(TerrainRidge{Seed: seed, WithoutCornerBowl: true}, "chunk")
		if err != nil {
			t.Fatal(err)
		}
		r, c := region.Certificate(), local.Certificate()
		t.Logf("fieldSeed=%d regionStranded=%d chunkComponents=%d chunkStranded=%d chunkAnchors=%d/%d ramps=%d/%d controlStranded=%d", seed, r.StrandedTiles, c.StrandedComponents, c.StrandedTiles, c.AnchorsReached, c.Anchors, region.Ramps, local.Ramps, control.Certificate().StrandedTiles)
		if r.StrandedTiles != 0 || r.HeldExitsKept != r.HeldExits || c.HeldExitsKept != c.HeldExits {
			t.Fatal("held constraint lost")
		}
	}
}

func TestTerrainLongRampAcrossSeamAndFootBox(t *testing.T) {
	p := &TerrainPlan{W: 48, H: 24, Tiles: make([]TerrainTile, 48*24)}
	for i := range p.Tiles {
		p.Tiles[i] = terrainFlat(3)
	}
	for y := 10; y <= 11; y++ {
		p.Tiles[y*48+18] = terrainFlat(0)
	}
	p.carveRamp(terrainRampSpec{18, 10, 1, 12, 0, 768})
	for x := 18; x < 31; x++ {
		i := 10*48 + x
		if p.Step(i, 1) != i+1 {
			t.Fatalf("broken long ramp at %d", x)
		}
		for px := 0; px <= 16; px++ {
			if !p.TerrainFits(i, float64(x*16+8+px), 170, 5, 4) {
				t.Fatalf("hero cannot sweep ramp edge %d pixel %d", x, px)
			}
		}
	}
	a, _ := p.Chunk(0, 0)
	b, _ := p.Chunk(1, 0)
	ad, e := DecodeTerrainHeight(EncodeTerrainHeight(a))
	if e != nil {
		t.Fatal(e)
	}
	bd, e := DecodeTerrainHeight(EncodeTerrainHeight(b))
	if e != nil {
		t.Fatal(e)
	}
	if ad[10*24+23].Edges[1] != bd[10*24].Edges[3] {
		t.Fatal("fractional seam differs")
	}
	// Style never changes connectivity. Adjacent lanes join, outer sides shut.
	i := 10*48 + 24
	p.Tiles[i].Built = !p.Tiles[i].Built
	if p.Step(i, 1) != i+1 || p.Step(i, 2) != i+48 || p.Step(i, 0) >= 0 {
		t.Fatal("style or side-edge topology changed")
	}
	// Matching solid bits alone cannot cross a rim or an unavailable tile.
	if p.TerrainFits(0, -1, 10, 5, 4) || p.Step(10*48+17, 1) >= 0 {
		t.Fatal("walked across unavailable or mismatched edge")
	}
}

func TestTerrainCodecRejectsMalformed(t *testing.T) {
	tiles := make([]TerrainTile, 576)
	for i := range tiles {
		tiles[i] = terrainFlat(0)
	}
	raw := EncodeTerrainHeight(tiles)
	for _, bad := range [][]byte{nil, raw[:289], append(append([]byte{}, raw...), 0), append(append([]byte{}, raw...), 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0)} {
		if _, err := DecodeTerrainHeight(bad); err == nil {
			t.Fatal("accepted malformed heights")
		}
	}
}
