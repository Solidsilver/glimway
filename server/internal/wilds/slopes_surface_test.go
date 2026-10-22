package wilds

import (
	"bytes"
	"context"
	"reflect"
	"testing"
)

func TestSlopesOverrideGridOwnershipAndCollision(t *testing.T) {
	s := &SlopeSurface{W: 48, H: 24, Corners: make([]uint16, 49*25), Ground: make([]SlopeGroundData, 48*24)}
	i := 12*48 + 23
	s.Overrides = []SlopeCornerOverride{{Tile: i, Corners: [4]uint16{256, 256, 256, 256}}}
	s.Ground[i].Discontinuity = 15
	s.Ground[i].Unreachable = true
	for d := 0; d < 4; d++ {
		j := i + terrainDX[d] + terrainDY[d]*s.W
		s.Ground[j].Discontinuity |= 1 << ((d + 2) % 4)
	}
	p := &SlopePlan{X: -24, Y: -24, SlopeSurface: s}
	for d := 0; d < 4; d++ {
		if p.Step(i, d) >= 0 {
			t.Fatal("intentional drop opened a movement edge")
		}
	}
	c := p.Certificate(-24, -24)
	if c.StrandedTiles != 0 || c.IntentionalTiles != 1 {
		t.Fatal("override changed home access", c.StrandedTiles, c.IntentionalTiles)
	}
	for _, q := range s.Corners {
		if q != 0 {
			t.Fatal("override mutated the canonical grid")
		}
	}
	left, err := s.Clip(0, 0, 24, 24)
	if err != nil {
		t.Fatal(err)
	}
	right, err := s.Clip(24, 0, 24, 24)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []*SlopeSurface{left, right} {
		raw, err := EncodeSlopeChunk(f)
		if err != nil {
			t.Fatal(err)
		}
		back, err := DecodeSlopeChunk(raw)
		if err != nil || !reflect.DeepEqual(f, back) {
			t.Fatal("override or border flags lost in round trip", err)
		}
	}
	if len(left.Overrides) != 1 || left.Overrides[0].Tile != 12*24+23 || len(right.Overrides) != 0 {
		t.Fatal("override escaped its tile's owning chunk")
	}
	for y := 0; y <= 24; y++ {
		if left.Corners[y*25+24] != right.Corners[y*25] {
			t.Fatal("override changed a shared border corner")
		}
	}
	if left.Ground[12*24+23].Discontinuity&(1<<1) == 0 || right.Ground[12*24].Discontinuity&(1<<3) == 0 {
		t.Fatal("border discontinuity did not survive clipping")
	}
	for _, tc := range []struct{ x, y, cx, cy int }{{-24, -24, -1, -1}, {-1, -1, -1, -1}, {0, 0, 0, 0}, {24, -24, 1, -1}} {
		cx, cy := SlopeCornerOwner(tc.x, tc.y)
		if cx != tc.cx || cy != tc.cy {
			t.Fatal("corner ownership", tc, cx, cy)
		}
	}
	// Explicit flags keep a drop shut even where both corner pairs match.
	matching := &SlopeSurface{W: 2, H: 1, Corners: make([]uint16, 6), Ground: make([]SlopeGroundData, 2)}
	matching.Ground[0].Discontinuity = 1 << 1
	matching.Ground[1].Discontinuity = 1 << 3
	p = &SlopePlan{SlopeSurface: matching}
	if p.Step(0, 1) >= 0 || p.Step(1, 3) >= 0 {
		t.Fatal("matching heights overrode an explicit discontinuity")
	}
	// Resolved overrides, rather than the smooth grid, drive the corner rule.
	matching.Overrides = []SlopeCornerOverride{{Tile: 0, Corners: [4]uint16{0, 0, 64, 0}}}
	if matching.Walkable(0) {
		t.Fatal("collision ignored the override's steep corner")
	}
}

func TestSlopesOverrideValidationAndFlagCorruption(t *testing.T) {
	good := &SlopeSurface{W: 3, H: 1, Corners: make([]uint16, 8), Ground: make([]SlopeGroundData, 3), Overrides: []SlopeCornerOverride{{Tile: 1, Corners: [4]uint16{256, 256, 256, 256}}}}
	good.Ground[0].Discontinuity = 1 << 1
	good.Ground[1].Discontinuity = (1 << 1) | (1 << 3)
	good.Ground[2].Discontinuity = 1 << 3
	raw, err := EncodeSlopeChunk(good)
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*SlopeSurface){
		func(f *SlopeSurface) { f.Overrides = append(f.Overrides, f.Overrides[0]) },
		func(f *SlopeSurface) { f.Overrides[0].Tile = -1 },
		func(f *SlopeSurface) { f.Overrides[0].Tile = 3 },
		func(f *SlopeSurface) { f.Overrides[0].Corners = [4]uint16{} },
		func(f *SlopeSurface) { f.Ground[0].Discontinuity = 0 },
		func(f *SlopeSurface) { f.Ground[1].Discontinuity = 0 },
	} {
		f, err := DecodeSlopeChunk(raw)
		if err != nil {
			t.Fatal(err)
		}
		mutate(f)
		if _, err := EncodeSlopeChunk(f); err == nil {
			t.Fatal("accepted malformed override/discontinuity")
		}
	}
	// A uniform 3x1 envelope has its flag-plane mask after header(6),
	// uniform Uint16(2), and packed kinds(1). Cliff and reserved flags reject.
	for _, mask := range []byte{2, 0x80} {
		bad := bytes.Clone(raw)
		bad[9] |= mask
		if _, err := DecodeSlopeChunk(bad); err == nil {
			t.Fatal("accepted inconsistent or unknown cliff flags")
		}
	}
}

func TestSlopesGridHaloMatchesIndependentSampling(t *testing.T) {
	// Scarp lips, owner boundaries, and negative four-chunk junctions.
	for _, xy := range [][2]int{{-576, -576}, {-24, -24}, {144, -456}, {384, 408}} {
		sampler := NewSlopeSampler("map")
		f, err := sampler.Surface(context.Background(), xy[0], xy[1], 24, 24)
		if err != nil {
			t.Fatal(err)
		}
		fresh := NewSlopeSampler("map")
		for y := 24; y >= 0; y-- {
			for x := 24; x >= 0; x-- {
				if f.Corners[y*25+x] != fresh.Corner(xy[0]+x, xy[1]+y) {
					t.Fatal("corner depends on crop, owner, halo or sample order")
				}
			}
		}
		for y := 0; y < 24; y++ {
			for x := 0; x < 24; x++ {
				if f.Tile(y*24+x) != fresh.Tile(xy[0]+x, xy[1]+y) {
					t.Fatal("metadata halo changes a border tile")
				}
			}
		}
	}
}
