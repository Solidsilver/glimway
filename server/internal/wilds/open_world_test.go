package wilds

import (
	"testing"
)

// The world border (0.14): content's, the same on every side, and the
// chunks on it are made like any other.
func TestBorder(t *testing.T) {
	b := BorderChunks()
	if b != 4096 {
		t.Fatalf("border %d chunks", b)
	}
	for _, c := range [][2]int{{0, 0}, {b, b}, {-b, -b}, {b, -b}, {-b, b}, {0, b}, {-b, 7}} {
		if !InsideBorder(c[0], c[1]) {
			t.Errorf("%v is past the border", c)
		}
	}
	for _, c := range [][2]int{{b + 1, 0}, {0, -b - 1}, {-b - 1, b}, {b, b + 1}} {
		if InsideBorder(c[0], c[1]) {
			t.Errorf("%v is inside the border", c)
		}
	}
	if x0, y0, x1, y1 := BorderRect(); x0 != -b || y0 != -b || x1 != b || y1 != b {
		t.Fatal("border rect", x0, y0, x1, y1)
	}
}

// Walking any way (0.14): land far out in every direction is ordinary land,
// as varied as home's. Before, every chunk south of the frontier's south
// limit came out solid thicket with nothing in it, because the places and
// routes passes stopped there. Each site is a 4×4 block: no chunk all
// solid, a fair share of open ground, and things to find.
func TestFarLandIsOrdinary(t *testing.T) {
	b := BorderChunks()
	sites := map[string][2]int{
		"just south":        {-2, 8},
		"south":             {0, 20},
		"far south":         {3, 300},
		"south border":      {-1, b - 3},
		"east":              {40, -2},
		"far east":          {1500, 4},
		"east border":       {b - 3, -b + 6},
		"west":              {-40, 3},
		"far west":          {-1500, -9},
		"west border":       {-b, b - 3},
		"north":             {0, -40},
		"far north":         {-6, -1500},
		"north-west border": {-b, -b},
	}
	for _, seed := range []string{"open-world", "v3-0"} {
		e := WickEpoch(seed, "t:1795000000:1796209600")
		for name, at := range sites {
			open, tiles, entities := 0, 0, 0
			for dy := 0; dy < 4; dy++ {
				for dx := 0; dx < 4; dx++ {
					cx, cy := at[0]+dx, at[1]+dy
					if !InsideBorder(cx, cy) {
						t.Fatalf("%s: %d,%d is past the border", name, cx, cy)
					}
					if FootprintAt(cx, cy) != nil || FixedFootprintAt(cx, cy) != nil {
						continue
					}
					ch, err := GenerateV3(e, cx, cy, nil)
					if err != nil {
						t.Fatalf("%s %d,%d: %v", name, cx, cy, err)
					}
					o := 0
					for _, s := range ch.Solid {
						if !s {
							o++
						}
					}
					if o == 0 {
						t.Errorf("%s %s: chunk %d,%d is all solid", seed, name, cx, cy)
					}
					open, tiles, entities = open+o, tiles+len(ch.Solid), entities+len(ch.Entities)
				}
			}
			if share := float64(open) / float64(tiles); share < 0.35 {
				t.Errorf("%s %s: only %.0f%% open", seed, name, 100*share)
			}
			if entities == 0 {
				t.Errorf("%s %s: nothing to find", seed, name)
			}
		}
	}
}

// The lasting landform has its own version (0.14): a new generator version
// (living detail) leaves every river and ridge where it was, while the
// living detail's hashes turn with it.
func TestLandformVersionSplit(t *testing.T) {
	a := WickEpoch("split", "t:1795000000:1796209600")
	b := a
	b.GeneratorVersion = a.GeneratorVersion + 1
	for _, pass := range []string{"wend", "wend-width", "wend-tail", "lands", "lantern-road"} {
		if a.landform(pass, 3, -4) != b.landform(pass, 3, -4) {
			t.Errorf("landform %s moved with the generator version", pass)
		}
	}
	if a.hash("place", 3, -4) == b.hash("place", 3, -4) || ChunkSeed(a, 3, -4) == ChunkSeed(b, 3, -4) {
		t.Error("the living detail didn't turn with the generator version")
	}
	// Still and wick epochs and every season share it too.
	s := StillEpoch("split")
	c := WickEpoch("split", "t:1796209600:1797419200")
	if a.landform("wend") != s.landform("wend") || a.landform("wend") != c.landform("wend") {
		t.Error("landform differs between epochs")
	}
	if landformHash("split", "wend") != Hash("split", LandformV1, "landform", "wend") {
		t.Error("landform hash isn't keyed by LandformV1")
	}
	if LandformV1 != 1 {
		t.Fatal("LandformV1 is frozen at 1")
	}
}
