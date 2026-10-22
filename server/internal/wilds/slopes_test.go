package wilds

import (
	"bytes"
	"context"
	"math/rand/v2"
	"slices"
	"testing"
)

func TestSlopesCountry(t *testing.T) {
	for _, seed := range []string{"map", "slopes-17", "slopes-991"} {
		t.Run(seed, func(t *testing.T) {
			p, err := NewSlopePlan(context.Background(), seed, -576, -576, 1152, 1152)
			if err != nil {
				t.Fatal(err)
			}
			c := p.Certificate(12, 30)
			kinds := [4]int{}
			maxHeight := uint16(0)
			for _, tile := range p.Tiles {
				kinds[tile.Kind]++
				if tile.Kind == SlopeGround && SlopeGradientSquared(tile.Corners) > SlopeWalkLimit*SlopeWalkLimit {
					t.Fatal("walkable tile exceeds the shared gradient limit")
				}
				for _, q := range tile.Corners {
					maxHeight = max(maxHeight, q)
					if q > 15*256 {
						t.Fatal("country exceeds the starting height range")
					}
				}
			}
			if maxHeight != 15*256 || kinds[SlopeSteep] == 0 || kinds[SlopeCrag] == 0 || kinds[SlopeCliff] == 0 {
				t.Fatal("missing tall spires or distinct rock kinds", kinds, maxHeight)
			}
			if c.IntentionalComponents != 4 || c.IntentionalTiles == 0 {
				t.Fatal("missing deliberate summit components", c.IntentionalComponents)
			}
			t.Logf("certificate: %+v", struct{ Components, Home, Stranded, Intentional int }{c.Components, c.HomeTiles, c.StrandedTiles, c.IntentionalTiles})
			if c.Home < 0 || c.StrandedTiles > 0 {
				t.Errorf("unintended enclosures: %d components, %d tiles", c.StrandedComponents, c.StrandedTiles)
				n := 0
				for i, tile := range p.Tiles {
					if tile.Kind == SlopeGround && c.Labels[i] != c.Home && !tile.Unreachable {
						if n < 12 {
							t.Logf("stranded %d,%d %v", p.X+i%p.W, p.Y+i/p.W, tile)
						}
						n++
					}
				}
			}
			for _, r := range p.Ranges {
				a, b := [2]int{r.PassX, r.Y - 104}, [2]int{r.PassX, r.Y + 104}
				route := p.Route(a, b, func(x, y int) bool { return x < r.PassX-1 || x > r.PassX+1 })
				detour := p.Route(a, b, func(x, y int) bool { return abs(x-r.PassX) < 64 && abs(y-r.Y) < 24 })
				t.Logf("%s pass=%d detour=%d", r.ID, len(route), len(detour))
				if len(route) == 0 || len(detour) == 0 {
					t.Errorf("range lacks pass/end route: %s", r.ID)
				}
				if len(detour) <= len(route) {
					t.Fatal("range makes no travel choice")
				}
				for y := a[1]; y <= b[1]; y++ {
					for x := r.PassX - 1; x <= r.PassX+1; x++ {
						i := p.Index(x, y)
						if p.Tiles[i].Kind != SlopeGround || c.Labels[i] != c.Home {
							t.Fatal("pass is not three tiles wide and home-connected", r.ID, x, y)
						}
					}
				}
				spire := p.Index(r.Spire[0], r.Spire[1])
				if spire < 0 || !p.Tiles[spire].Unreachable || c.Labels[spire] == c.Home {
					t.Errorf("spire must be unreachable: %s", r.ID)
				}
			}
		})
	}
}

func slopeTestChunk(seed string, cx, cy int, reverse bool) []SlopeTile {
	s := NewSlopeSampler(seed)
	tiles := make([]SlopeTile, 576)
	for n := 0; n < 576; n++ {
		i := n
		if reverse {
			i = 575 - n
		}
		tiles[i] = s.Tile(cx*24+i%24, cy*24+i/24)
	}
	return tiles
}

func TestSlopesDeterminismNegativeCoordinatesAndSeams(t *testing.T) {
	coords := [][2]int{{-25, -25}, {-24, -24}, {-13, -12}, {-1, -1}, {0, 0}, {6, 2}, {11, 12}, {16, 17}, {23, 23}, {24, 24}, {-173, 229}}
	order := rand.New(rand.NewPCG(71, 991)).Perm(len(coords))
	for _, n := range order {
		xy := coords[n]
		a := slopeTestChunk("map", xy[0], xy[1], false)
		b := slopeTestChunk("map", xy[0], xy[1], true)
		if !slices.Equal(a, b) {
			t.Fatal("sample order changes geometry", xy)
		}
		raw, err := EncodeSlopeChunk(a)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := DecodeSlopeChunk(raw)
		if err != nil || !slices.Equal(a, decoded) {
			t.Fatal("encoded geometry changed", xy, err)
		}
		east := slopeTestChunk("map", xy[0]+1, xy[1], true)
		south := slopeTestChunk("map", xy[0], xy[1]+1, false)
		for i := 0; i < 24; i++ {
			l, r := decoded[i*24+23].Corners, east[i*24].Corners
			if l[1] != r[0] || l[2] != r[3] {
				t.Fatal("E/W seam", xy, i)
			}
			u, d := decoded[23*24+i].Corners, south[i].Corners
			if u[3] != d[0] || u[2] != d[1] {
				t.Fatal("N/S seam", xy, i)
			}
		}
	}
	// A corner cut through a chunk seam must equal independent chunk output,
	// including face metadata (not merely the geometric heights).
	p, err := NewSlopePlan(context.Background(), "map", 144, -456, 48, 48)
	if err != nil {
		t.Fatal(err)
	}
	for cy := -19; cy <= -18; cy++ {
		for cx := 6; cx <= 7; cx++ {
			tiles := slopeTestChunk("map", cx, cy, true)
			for i, tile := range tiles {
				if tile != p.Tiles[p.Index(cx*24+i%24, cy*24+i/24)] {
					t.Fatal("chunk clipping changed a scarp face")
				}
			}
		}
	}
}

func TestSlopesCodecRejectsCorruption(t *testing.T) {
	tiles := slopeTestChunk("map", 6, -19, false)
	raw, err := EncodeSlopeChunk(tiles)
	if err != nil {
		t.Fatal(err)
	}
	for n := 0; n < len(raw); n++ {
		if _, err := DecodeSlopeChunk(raw[:n]); err == nil {
			t.Fatalf("accepted truncation at %d", n)
		}
	}
	bad := bytes.Clone(raw)
	bad[2]++
	if _, err := DecodeSlopeChunk(bad); err == nil {
		t.Fatal("accepted unknown version")
	}
	if _, err := DecodeSlopeChunk(append(bytes.Clone(raw), 0)); err == nil {
		t.Fatal("accepted trailing bytes")
	}
	bad = bytes.Clone(raw)
	bad[4+937] |= 0xf0
	if _, err := DecodeSlopeChunk(bad); err == nil {
		t.Fatal("accepted nonzero padding")
	}
	cracked := slices.Clone(tiles)
	cracked[0].Corners[1]++
	if _, err := EncodeSlopeChunk(cracked); err == nil {
		t.Fatal("encoded a corner crack")
	}
	for i := range tiles {
		tiles[i] = SlopeTile{Corners: [4]uint16{4096, 4096, 4096, 4096}}
	}
	if _, err := EncodeSlopeChunk(tiles); err == nil {
		t.Fatal("silently clamped wider heights")
	}
}

func TestSlopesSouthFacesAndHomeApron(t *testing.T) {
	for levels := 1; levels <= 15; levels++ {
		top := uint16(levels * 256)
		for row := -1; row <= levels*3; row++ {
			tile := ResolveSlopeSouthFace(SlopeTile{}, row, top, 0)
			want := row >= 0 && row < levels*3
			if (tile.Kind == SlopeCliff) != want {
				t.Fatal("south face footprint", levels, row)
			}
			if want && (int(tile.FaceRows) != levels*3 || int(tile.FaceRow) != row || tile.FaceTop != top) {
				t.Fatal("wrong exact face span")
			}
		}
	}
	flat := SlopeTile{Corners: [4]uint16{512, 512, 512, 512}}
	if ResolveSlopeSouthFace(flat, 0, 256, 0).Kind == SlopeCliff {
		t.Fatal("face overwrote a higher surface")
	}
	s := NewSlopeSampler("map")
	for y := -80; y <= 100; y++ {
		for x := -80; x <= 100; x++ {
			if homeFlatTileDist(x, y) <= 24 {
				tile := s.Tile(x, y)
				if tile.Kind != SlopeGround || tile.Corners != [4]uint16{} {
					t.Fatal("home apron is not flat", x, y, tile)
				}
			}
		}
	}
	// The outcrop's northern approach is a slope, its south edge a scarp.
	r := SlopeRangeAt("map", 0, -1)
	for y := r.Outcrop[1] - 60; y < r.Outcrop[1]-2; y++ {
		if s.Tile(r.Outcrop[0], y).Kind != SlopeGround {
			t.Fatal("outcrop lacks a gentle approach")
		}
	}
	if s.Tile(r.Outcrop[0], r.Outcrop[1]).Kind != SlopeCliff {
		t.Fatal("outcrop lacks an intentional scarp")
	}
	for x := r.Outcrop[0] + 40; x < r.Outcrop[0]+120; x++ {
		if s.Tile(x, r.Outcrop[1]).Kind == SlopeCliff {
			t.Fatal("ordinary downhill field acquired a scarp outside its intentional mask")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewSlopePlan(ctx, "map", 0, 0, 24, 24); err == nil {
		t.Fatal("cancelled plan sampled the field")
	}
	if _, err := NewSlopePlan(context.Background(), "map", 0, 0, 2400001, 1); err == nil {
		t.Fatal("unbounded allocation")
	}
}
