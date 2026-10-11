package wilds

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"
)

// The frontier as a picture: every chunk of the 0.8 frontier for one wick,
// drawn tile by tile in ground colours (solid tiles darker), with landmarks,
// lamp stones, sites and entities marked and faint chunk lines. Not a test
// of anything; run it to look at the map:
//
//	GLIMWAY_MAP_PNG=../../../.agent/frontier.png go test ./internal/wilds -run TestRenderFrontierPNG
//
// GLIMWAY_MAP_SEED picks the world seed (default "map"), GLIMWAY_MAP_SEASON
// the wick season.

var groundColours = map[string]color.RGBA{
	"woods": {38, 74, 42, 255}, "moss": {86, 128, 62, 255}, "verge": {150, 134, 90, 255},
	"path": {176, 150, 100, 255}, "trodden": {128, 98, 62, 255}, "road": {120, 120, 112, 255},
	"water": {40, 92, 140, 255}, "meadow": {146, 186, 92, 255}, "bank": {204, 186, 138, 255},
	"ford": {96, 150, 186, 255}, "paving": {160, 160, 160, 255}, "laid-stone": {180, 180, 190, 255},
	"laid-plank": {160, 120, 80, 255},
}

func TestRenderFrontierPNG(t *testing.T) {
	out := os.Getenv("GLIMWAY_MAP_PNG")
	if out == "" {
		t.Skip("GLIMWAY_MAP_PNG=<file.png> draws the frontier")
	}
	seed := os.Getenv("GLIMWAY_MAP_SEED")
	if seed == "" {
		seed = "map"
	}
	season := os.Getenv("GLIMWAY_MAP_SEASON")
	if season == "" {
		season = "t:1795000000:1796209600"
	}
	img := renderFrontier(t, seed, season)
	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s", out)
}

func renderFrontier(t testing.TB, seed, season string) *image.RGBA {
	const px = 3
	S := chunkSize()
	minCx, minCy, maxCx, maxCy := frontierChunks()
	W, H := (maxCx-minCx+1)*S*px, (maxCy-minCy+1)*S*px
	img := image.NewRGBA(image.Rect(0, 0, W, H))
	ids := map[Ground]string{}
	for i, g := range contentRules().Grounds {
		ids[Ground(i)] = g.GetId()
	}
	dot := func(x, y int, c color.RGBA) {
		for dy := 0; dy < px; dy++ {
			for dx := 0; dx < px; dx++ {
				img.Set(x*px+dx, y*px+dy, c)
			}
		}
	}
	for cy := minCy; cy <= maxCy; cy++ {
		for cx := minCx; cx <= maxCx; cx++ {
			c := mustV3(t, seed, season, cx, cy)
			ox, oy := (cx-minCx)*S, (cy-minCy)*S
			for i, g := range c.Ground {
				col := groundColours[ids[g]]
				if c.Solid[i] {
					col = shade(col, 6)
				}
				x, y := i%S, i/S
				if x == 0 || y == 0 {
					col = shade(col, 9)
				}
				dot(ox+x, oy+y, col)
			}
			for _, e := range c.Entities {
				dot(ox+e.TX, oy+e.TY, color.RGBA{240, 240, 240, 255})
			}
			for _, s := range c.Sites {
				col := color.RGBA{220, 60, 220, 255}
				switch s.Kind {
				case SiteLampStone:
					col = color.RGBA{250, 220, 40, 255}
				case SiteRumour:
					col = color.RGBA{250, 120, 20, 255}
				}
				dot(ox+s.TX, oy+s.TY, col)
			}
			for _, p := range c.Places {
				dot(ox+p.TX, oy+p.TY, color.RGBA{230, 30, 30, 255})
			}
		}
	}
	return img
}

// shade is a colour at tenths of its brightness.
func shade(c color.RGBA, tenths int) color.RGBA {
	f := func(v uint8) uint8 { return uint8(int(v) * tenths / 10) }
	return color.RGBA{f(c.R), f(c.G), f(c.B), 255}
}

// mustV3 makes one chunk of a world, in the epoch its coordinates take.
func mustV3(t testing.TB, seed, season string, cx, cy int) Chunk {
	t.Helper()
	e := WickEpoch(seed, season)
	if EpochKindAt(cx, cy) == EpochStill {
		e = StillEpoch(seed)
	}
	c, err := GenerateV3(e, cx, cy, nil)
	if err != nil {
		t.Fatalf("%s %d,%d: %v", seed, cx, cy, err)
	}
	return c
}
