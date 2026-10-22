package worldlab

import (
	"context"
	"encoding/json"
	"math"
	"testing"
)

func TestSlopesLabBudgetsAndWorker(t *testing.T) {
	l := testLab(t)
	w := post(t, l, "render", map[string]any{"view": "region", "slopes": "routes", "seed": "map", "epoch": DefaultEpoch, "rect": [4]int{6, 8, 18, 16}, "scale": 1})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var r Result
	if err := json.Unmarshal(w.Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	m := r.Stats.Slopes
	if len(r.PNG) == 0 || m == nil || m.Certificate.StrandedTiles != 0 || len(m.Ranges) != 4 || len(m.Tunnels) != 4 {
		t.Fatal("missing certificate, views or candidates")
	}
	if m.MaxRise > 0.25 || m.HeightRange[1] != 15 {
		t.Fatal("shared contract changed")
	}
	if m.AllWholeBytes.Max >= 6144 || 6144-m.AllWholeBytes.Max < 3000 {
		t.Fatal("terrain leaves too little dressing space", m.AllWholeBytes)
	}
	for name, b := range m.Budgets {
		t.Logf("%s: height %d, bare whole %d bytes; warm p95 %.3f ms", name, b.HeightBytes, b.BareWholeBytes, b.WarmMS.P95)
		if b.WarmMS.P95 > 5 {
			t.Errorf("%s warm generation+encoding exceeded 5 ms p95: %.3f", name, b.WarmMS.P95)
		}
		if b.DressingHeadroom < 3000 {
			t.Error("insufficient dressing headroom", name)
		}
	}
	for biome, kinds := range m.BiomeKinds {
		sum := 0.
		for _, share := range kinds {
			sum += share
		}
		if math.Abs(sum-1) > 1e-9 {
			t.Fatal("incomplete biome shares", biome, sum)
		}
	}
	for _, rng := range m.Ranges {
		if rng.PassSteps != 208 || rng.ExtraSteps <= 0 || rng.PassMaxGradient > 0.25 {
			t.Fatal("range missing a safe pass or meaningful detour", rng.ID)
		}
		for _, route := range []struct {
			points [][2]int
			steps  int
		}{{rng.PassWaypoints, rng.PassSteps}, {rng.EndWaypoints, rng.EndSteps}} {
			steps := 0
			for i := 1; i < len(route.points); i++ {
				a, b := route.points[i-1], route.points[i]
				if a[0] != b[0] && a[1] != b[1] {
					t.Fatal("waypoints cut a diagonal shortcut")
				}
				steps += absInt(a[0]-b[0]) + absInt(a[1]-b[1])
			}
			if steps != route.steps {
				t.Fatal("compressed route changed measured walking distance")
			}
		}
	}
}

func TestSlopesLabValidationAndCancellation(t *testing.T) {
	for _, change := range []func(*Options){
		func(o *Options) { o.Rect[0] = -25 }, func(o *Options) { o.Rect[2] = 24 }, func(o *Options) { o.View = "chunk" }, func(o *Options) { o.Slopes = "bad" }, func(o *Options) { o.Inspect = &[2]int{} }, func(o *Options) { o.Terrain = "region" }, func(o *Options) { o.Field = "upland" }, func(o *Options) { o.Overlays = "reach" }, func(o *Options) { o.Walk = true }, func(o *Options) { o.Signatures = true }, func(o *Options) { o.Raw = []byte("{}") }, func(o *Options) { o.Rect = [4]int{-24, -24, 23, 23}; o.Scale = 4 },
	} {
		o := testOptions("region")
		o.Slopes = "height"
		change(&o)
		if Validate(o) == nil {
			t.Fatal("accepted invalid slopes request", o)
		}
	}
	o := testOptions("region")
	o.Slopes = "height"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Render(ctx, o); err == nil {
		t.Fatal("ignored cancelled slopes request")
	}
}
