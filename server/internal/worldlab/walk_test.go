package worldlab

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"testing"

	"glimway/server/internal/wilds"
)

func TestTerrainWalkWorkerServesBothStrategies(t *testing.T) {
	l := testLab(t)
	w := post(t, l, WalkPath, map[string]any{"seed": "map", "epoch": DefaultEpoch})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var walk TerrainWalk
	if err := json.Unmarshal(w.Body.Bytes(), &walk); err != nil {
		t.Fatal(err)
	}
	n := walk.W * walk.H
	if len(walk.PropKinds) == 0 || walk.Recipe != WalkRecipe || n != 15*13*576 || len(walk.Tops) != n || len(walk.Ground) != n || len(walk.Prop) != n || len(walk.Biome) != n || len(walk.Region) != n {
		t.Fatalf("bad planes: %d×%d", walk.W, walk.H)
	}
	t.Logf("timings %v, %d bytes", walk.Timings, w.Body.Len())
	for name, s := range walk.Strategies {
		if len(s.Kind) != n || len(s.Edges) != n*8 || len(s.Face) != n*3 || len(s.Flags) != n {
			t.Fatalf("%s: bad planes", name)
		}
		c := s.Certificate
		t.Logf("%s: ramps %d, components %d, stranded %d/%d tiles, anchors %d/%d, exits %d/%d", name, s.Ramps, c.Components, c.StrandedComponents, c.StrandedTiles, c.AnchorsReached, c.Anchors, c.HeldExitsKept, c.HeldExits)
		stranded := 0
		for _, f := range s.Flags {
			if f&4 != 0 {
				stranded++
			}
		}
		if stranded != c.StrandedTiles {
			t.Fatalf("%s: stranded flags %d, certificate %d", name, stranded, c.StrandedTiles)
		}
	}
	r, c := walk.Strategies["region"].Certificate, walk.Strategies["chunk"].Certificate
	if r.StrandedTiles != 0 || r.AnchorsReached != r.Anchors || r.HeldExitsKept != r.HeldExits {
		t.Fatal("region plan failed its certificate on the walk window")
	}
	if c.StrandedTiles == 0 {
		t.Fatal("per-chunk repair strands nothing here: update the notes' finding")
	}
	names := map[string]bool{}
	for _, s := range walk.Spots {
		names[s.Name] = true
		if s.X < 0 || s.Y < 0 || s.X >= walk.W || s.Y >= walk.H {
			t.Fatalf("spot %s outside", s.Name)
		}
	}
	for _, want := range []string{"home", "ramp", "whitequiet", "stranded"} {
		if !names[want] {
			t.Fatalf("no %s spot: %v", want, walk.Spots)
		}
	}
	// Every biome lane B made shows somewhere in the window.
	for _, b := range []string{"hearthwick-woods@1", "tops@1", "whitequiet@1"} {
		found := false
		for _, name := range walk.Biomes {
			found = found || name == b
		}
		if !found {
			t.Fatalf("no %s in the window: %v", b, walk.Biomes)
		}
	}
	// A second ask is the cache's.
	if again := post(t, l, WalkPath, map[string]any{"seed": "map", "epoch": DefaultEpoch}); again.Header().Get("X-Worldlab-Cache") != "hit" {
		t.Fatal("walk not cached")
	}
}

func TestTerrainWalkRefusesOtherWork(t *testing.T) {
	l := testLab(t)
	for _, body := range []map[string]any{
		{"seed": "map", "rules": "{}"},
		{"seed": "map", "terrain": "region"},
		{"seed": ""},
		{"seed": "map", "epoch": "nope"},
	} {
		if w := post(t, l, WalkPath, body); w.Code != 400 {
			t.Fatalf("%v: %d", body, w.Code)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := RenderWalk(ctx, Options{Walk: true, Seed: "map", Epoch: DefaultEpoch}); err == nil {
		t.Fatal("ignored a cancelled walk")
	}
}

// The edges on the wire are the plan's, and ramps never carry cover.
func TestTerrainWalkPlanesMatchPlan(t *testing.T) {
	o := Options{Walk: true, Seed: "map", Epoch: DefaultEpoch, Workers: 1, View: "region", Scale: 1}
	walk, err := RenderWalk(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	p, err := wilds.NewTerrainWindow(wilds.TerrainWorld{Seed: "map"}, wilds.TerrainWalkSpec(), "chunk")
	if err != nil {
		t.Fatal(err)
	}
	s := walk.Strategies["chunk"]
	for i, tile := range p.Tiles {
		for d := 0; d < 4; d++ {
			if int16(binary.LittleEndian.Uint16(s.Edges[i*8+d*2:])) != tile.Edges[d] {
				t.Fatalf("edge %d of tile %d", d, i)
			}
		}
		if s.Kind[i] != tile.Kind || s.Top[i] != tile.Top {
			t.Fatalf("tile %d", i)
		}
		for _, st := range walk.Strategies {
			if st.Kind[i] == wilds.TerrainRamp && (walk.Prop[i] != 0 || walk.Water[i] != 0) {
				t.Fatalf("cover on a ramp at %d", i)
			}
		}
	}
}
