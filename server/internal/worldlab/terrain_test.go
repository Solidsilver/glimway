package worldlab

import (
	"context"
	"encoding/json"
	"testing"
)

func TestTerrainLabWorkerAndShuffledOrder(t *testing.T) {
	l := testLab(t)
	body := map[string]any{"view": "region", "terrain": "chunk", "seed": "terrain-17", "epoch": DefaultEpoch, "rect": [4]int{12, 2, 13, 3}, "scale": 3, "overlays": "reach"}
	w := post(t, l, "render", body)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var a Result
	if err := json.Unmarshal(w.Body.Bytes(), &a); err != nil {
		t.Fatal(err)
	}
	if a.Stats.Terrain == nil || a.Stats.Terrain.Strategies["region"].Certificate.StrandedTiles != 0 || a.Stats.Terrain.Strategies["chunk"].Certificate.StrandedTiles == 0 {
		t.Fatal("missing exact comparison")
	}
	o := testOptions("region")
	o.Terrain = "chunk"
	o.Seed = "terrain-17"
	o.TerrainOrder = 97
	b, err := Render(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	for strategy, first := range a.Stats.Terrain.Strategies {
		second := b.Stats.Terrain.Strategies[strategy]
		if first.Digest != second.Digest || first.SeamMismatches != 0 || second.SeamMismatches != 0 || first.SeamEdgeMismatches != 0 || second.SeamEdgeMismatches != 0 || second.SeamEdgesCompared != 14016 {
			t.Fatalf("%s differs by process, crop or shuffle", strategy)
		}
	}
}

func TestTerrainValidationAndCancellation(t *testing.T) {
	for _, mutate := range []func(*Options){func(o *Options) { o.Terrain = "bad" }, func(o *Options) { o.View = "atlas" }, func(o *Options) { o.Inspect = &[2]int{} }, func(o *Options) { o.TerrainSamples = 21 }} {
		o := testOptions("region")
		o.Terrain = "region"
		mutate(&o)
		if Validate(o) == nil {
			t.Fatal("accepted invalid terrain request")
		}
	}
	o := testOptions("region")
	o.Terrain = "region"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Render(ctx, o); err == nil {
		t.Fatal("ignored cancelled preview")
	}
}
