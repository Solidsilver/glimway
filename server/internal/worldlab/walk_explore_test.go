package worldlab

import (
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"
)

// EXPLORE=dir writes overview maps of the walk window, both strategies.
func TestExploreWalkMap(t *testing.T) {
	dir := os.Getenv("EXPLORE")
	if dir == "" {
		t.Skip()
	}
	walk, err := RenderWalk(context.Background(), Options{Walk: true, Seed: "map", Epoch: DefaultEpoch, Workers: 2, View: "region", Scale: 1})
	if err != nil {
		t.Fatal(err)
	}
	levels := []color.RGBA{{103, 137, 91, 255}, {156, 169, 101, 255}, {178, 160, 126, 255}, {211, 204, 184, 255}}
	for name, s := range walk.Strategies {
		sc := 2
		img := image.NewRGBA(image.Rect(0, 0, walk.W*sc, walk.H*sc))
		for y := 0; y < walk.H; y++ {
			for x := 0; x < walk.W; x++ {
				i := y*walk.W + x
				col := levels[s.Top[i]]
				switch s.Kind[i] {
				case 1:
					col = color.RGBA{70, 60, 70, 255}
				case 2:
					col = color.RGBA{230, 140, 40, 255}
				case 3:
					col = color.RGBA{40, 40, 40, 255}
				}
				if walk.Water[i] != 0 {
					col = color.RGBA{60, 110, 200, 255}
				}
				if walk.Prop[i] != 0 && s.Kind[i] == 0 {
					col = color.RGBA{col.R * 3 / 4, col.G * 3 / 4, col.B * 3 / 4, 255}
				}
				if s.Flags[i]&1 != 0 {
					col = blend(col, color.RGBA{90, 182, 235, 255})
				}
				if s.Flags[i]&4 != 0 {
					col = color.RGBA{230, 40, 190, 255}
				}
				if x%24 == 0 || y%24 == 0 {
					col = blend(col, color.RGBA{0, 0, 0, 255})
				}
				block(img, x*sc, y*sc, sc, col)
			}
		}
		for _, sp := range walk.Spots {
			cross(img, sp.X*sc, sp.Y*sc, 6, color.RGBA{255, 255, 255, 255})
		}
		f, _ := os.Create(dir + "/walk-" + name + ".png")
		png.Encode(f, img)
		f.Close()
	}
	t.Logf("spots %+v anchors %+v", walk.Spots, walk.Anchors)
}

func TestExploreWalkJSON(t *testing.T) {
	dir := os.Getenv("EXPLORE")
	if dir == "" {
		t.Skip()
	}
	walk, err := RenderWalk(context.Background(), Options{Walk: true, Seed: "map", Epoch: DefaultEpoch, Workers: 2, View: "region", Scale: 1})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(walk)
	os.WriteFile(dir+"/walk.json", raw, 0o644)
}
