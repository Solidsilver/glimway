package worldlab

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"glimway/server/internal/wilds"
)

func TestRegionsOverlaysAndFieldHeatmaps(t *testing.T) {
	base := Options{
		View:    "atlas",
		Seed:    "map",
		Epoch:   DefaultEpoch,
		Rect:    [4]int{-36, -36, 35, 35},
		Scale:   2,
		Workers: 2,
	}
	plain, err := Render(context.Background(), base)
	if err != nil {
		t.Fatal(err)
	}
	if len(plain.Stats.BiomeShare) == 0 || plain.Stats.RegionCount < 4 || plain.Stats.PinManifest == nil || len(plain.Stats.PinManifest.Pins) < 4 {
		t.Fatalf("missing region/biome stats on atlas render: %+v", plain.Stats)
	}
	if len(plain.Stats.FirstBiomeChunkDist) == 0 {
		t.Fatalf("missing FirstBiomeChunkDist: %+v", plain.Stats)
	}
	for _, ov := range []string{"regions", "biomes", "blend", "pins", "regions,biomes,blend,pins"} {
		o := base
		o.Overlays = ov
		out, err := Render(context.Background(), o)
		if err != nil {
			t.Fatalf("overlay %s: %v", ov, err)
		}
		if bytes.Equal(plain.PNG, out.PNG) {
			t.Fatalf("overlay %s did not alter the rendered atlas PNG", ov)
		}
	}
	for _, field := range wilds.FieldNames {
		o := base
		o.Field = field
		out, err := Render(context.Background(), o)
		if err != nil {
			t.Fatalf("field %s: %v", field, err)
		}
		if bytes.Equal(plain.PNG, out.PNG) {
			t.Fatalf("field heatmap %s did not alter atlas PNG", field)
		}
		if out.Stats.Field == nil || out.Stats.Field.Field != field || out.Stats.Field.Max <= out.Stats.Field.Min {
			t.Fatalf("field stats for %s: %+v", field, out.Stats.Field)
		}
	}

	// Region tile view with overlays and field heatmap.
	regBase := Options{
		View:    "region",
		Seed:    "map",
		Epoch:   DefaultEpoch,
		Rect:    [4]int{-18, -18, -10, -10},
		Scale:   1,
		Workers: 2,
	}
	regPlain, err := Render(context.Background(), regBase)
	if err != nil {
		t.Fatal(err)
	}
	regOverlay := regBase
	regOverlay.Overlays = "regions,biomes,blend,pins"
	regOut, err := Render(context.Background(), regOverlay)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(regPlain.PNG, regOut.PNG) {
		t.Fatal("region view overlays did not change PNG")
	}

	regField := regBase
	regField.Field = "upland"
	regFieldOut, err := Render(context.Background(), regField)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(regPlain.PNG, regFieldOut.PNG) || regFieldOut.Stats.Field == nil || regFieldOut.Stats.Field.Field != "upland" {
		t.Fatalf("region upland heatmap failed: %+v", regFieldOut.Stats.Field)
	}

	badField := regBase
	badField.Field = "unknown-field"
	if err := Validate(badField); err == nil {
		t.Fatal("Validate accepted unknown field name")
	}
}

func TestLabHoverAndTileRegionFields(t *testing.T) {
	l := testLab(t)

	// State includes fields and region overlays.
	w := httptest.NewRecorder()
	l.ServeHTTP(w, httptest.NewRequest(http.MethodGet, Prefix+"state", nil))
	var st struct {
		Overlays []string `json:"overlays"`
		Fields   []string `json:"fields"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil || w.Code != 200 {
		t.Fatal(w.Code, err)
	}
	if len(st.Fields) != 5 {
		t.Fatalf("expected 5 fields in state, got %v", st.Fields)
	}

	// Hover endpoint returns region, biome@version and field values.
	hw := post(t, l, "hover", map[string]any{"seed": "map", "at": []int{-500, -500}})
	if hw.Code != 200 {
		t.Fatalf("hover failed: %d %s", hw.Code, hw.Body.String())
	}
	var hov TileHover
	if err := json.Unmarshal(hw.Body.Bytes(), &hov); err != nil {
		t.Fatal(err)
	}
	if hov.Region == "" || hov.Biome == "" || hov.RegionBiome == "" {
		t.Fatalf("hover missing region/biome: %+v", hov)
	}
	if hov.Fields.Upland < 0 || hov.Fields.Upland > wilds.FieldScale {
		t.Fatalf("hover upland out of range: %+v", hov.Fields)
	}

	// Tile endpoint includes region, biome, pin record and lasting fields.
	tw := post(t, l, "tile", map[string]any{"seed": "map", "epoch": DefaultEpoch, "at": []int{-500, -500}})
	if tw.Code != 200 {
		t.Fatalf("tile failed: %d %s", tw.Code, tw.Body.String())
	}
	var info TileInfo
	if err := json.Unmarshal(tw.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.Region != hov.Region || info.Biome != hov.Biome || info.Fields == nil || info.Pin == nil {
		t.Fatalf("tile info mismatch with hover: tile=%+v hover=%+v", info, hov)
	}
	if *info.Fields != hov.Fields {
		t.Fatalf("tile fields %+v != hover fields %+v", *info.Fields, hov.Fields)
	}
}
