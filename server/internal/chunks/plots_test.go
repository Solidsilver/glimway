package chunks

import (
	"bytes"
	"fmt"
	"glimway/content"
	"glimway/server/internal/land"
	"google.golang.org/protobuf/proto"
	"os"
	"testing"
)

func TestPlotChunks(t *testing.T) {
	seen := map[string]bool{}
	for seed := 0; seed < 10; seed++ {
		for gate := 0; gate < 8; gate++ {
			world := fmt.Sprintf("plot-world-%d", seed)
			c := Plot(world, gate)
			if err := Validate(c); err != nil {
				t.Fatal(err)
			}
			if !proto.Equal(c, Plot(world, gate)) {
				t.Fatal("nondeterministic plot")
			}
			ox, oy := LotOrigin(gate)
			if int(c.Cx)*24 != ox || int(c.Cy)*24 != oy {
				t.Fatal("origin")
			}
			if !seen[c.EpochId] {
				seen[c.EpochId] = true
			} else {
				t.Fatal("shared epoch")
			}
			base := Fixed(FixedEpoch("homestead-lots", PlotRevision), c.Cx, c.Cy)
			solid := func(c []byte, x, y int) bool { return c[(y*24+x)/8]&(1<<uint((y*24+x)%8)) != 0 }
			for y := 0; y < 24; y++ {
				for x := 0; x < 24; x++ {
					if x < 3 || x > 20 || y == 0 || y >= 19 || gate < 2 && y == 1 {
						if solid(c.Solid, x, y) != solid(base.Solid, x, y) {
							t.Fatalf("public seam changed %d/%d,%d", gate, x, y)
						}
					}
				}
			}
			for y := 3; y <= 8; y++ {
				for x := 8; x <= 15; x++ {
					if solid(c.Solid, x, y) {
						t.Fatal("blocked site")
					}
				}
			}
			for y := 9; y <= 19; y++ {
				for x := 11; x <= 12; x++ {
					if solid(c.Solid, x, y) {
						t.Fatal("blocked entrance")
					}
				}
			}
			l := land.Generate(land.Seed(world, gate, content.HomeRules.Land), content.HomeRules.Land)
			if l.Width != 24 || l.Height != 24 {
				t.Fatal("size")
			}
		}
	}
	if proto.Equal(Plot("world-a", 0), Plot("world-b", 0)) {
		t.Fatal("world identity shared")
	}
	if Plot("world", 8) != nil || Plot("", 0) != nil {
		t.Fatal("bad world/lot accepted")
	}
}

func TestPlotClientFixtures(t *testing.T) {
	for gate := 0; gate < 8; gate++ {
		c := Plot("fixture-world", gate)
		b, err := proto.MarshalOptions{Deterministic: true}.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		path := fmt.Sprintf("../../../tests/fixtures/plot-%d.bin", gate)
		if os.Getenv("UPDATE_CLIENT_FIXTURES") == "1" {
			if err = os.WriteFile(path, b, 0644); err != nil {
				t.Fatal(err)
			}
		}
		old, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(old, b) {
			t.Fatalf("stale %s", path)
		}
	}
}

func TestPlotGeometryMatchesAuthoredContent(t *testing.T) {
	var found bool
	for _, f := range content.PlacesRules.GetFixed() {
		if f.GetId() != "homestead-lots" {
			continue
		}
		found = true
		if f.GetRevision() != PlotRevision || f.GetOrigin().GetTx() != -72 || f.GetOrigin().GetTy() != 24 || f.GetWidth() != 2 || f.GetHeight() != 4 {
			t.Fatal("update versioned plot geometry with content", f)
		}
	}
	if !found {
		t.Fatal("missing lots footprint")
	}
	// Pin every mirrored outer band, including ground as well as collision.
	// Internal horizontal seams between lots are not mirrored by generated land.
	for gate := 0; gate < 8; gate++ {
		c := Plot("seam-check", gate)
		b := Fixed(FixedEpoch("homestead-lots", PlotRevision), c.Cx, c.Cy)
		for y := 0; y < 24; y++ {
			for x := 0; x < 24; x++ {
				if !(x < 2 || x >= 22 || y >= 22 || gate < 2 && y < 2) {
					continue
				}
				i := y*24 + x
				shift := uint(4 * (i % 2))
				if c.Palette[(c.Ground[i/2]>>shift)&15] != b.Palette[(b.Ground[i/2]>>shift)&15] || (c.Solid[i/8]>>uint(i%8))&1 != (b.Solid[i/8]>>uint(i%8))&1 {
					t.Fatalf("mirrored seam %d %d,%d", gate, x, y)
				}
			}
		}
	}
}

func TestPlotRearJoinsMatchVisibleBoundaries(t *testing.T) {
	for gate := 0; gate < 8; gate++ {
		c := Plot("rear-edge", gate)
		solid := func(c []byte, x, y int) bool { return c[(y*24+x)/8]&(1<<uint((y*24+x)%8)) != 0 }
		for x := 3; x <= 20; x++ {
			if gate < 2 {
				// The outer pair backs onto visible woods, not a cross-lane.
				if !solid(c.Solid, x, 0) || !solid(c.Solid, x, 1) {
					t.Fatalf("outer wooded seam opened at lot %d x%d", gate, x)
				}
				continue
			}
			north := Plot("rear-edge", gate-2)
			for _, y := range []int{0, 1} {
				if solid(c.Solid, x, y) {
					t.Fatalf("invisible rear wall at lot %d %d,%d", gate, x, y)
				}
			}
			for _, y := range []int{22, 23} {
				if solid(north.Solid, x, y) {
					t.Fatalf("blocked cross-lane above lot %d %d,%d", gate, x, y)
				}
			}
		}
	}
}
