package wilds

import "testing"

// TestCampDensity counts camps per 100 generated chunks on fixed seeds, in
// the ten by ten chunks round home and in ten by ten at the frontier's far
// corner, and keeps the open Wilds from filling up with camps again (the
// owner, 2026-10-20: "too many camps and creatures"). Camp glades are
// counted apart: their camp is the glade's own fight, with its chest.
func TestCampDensity(t *testing.T) {
	gx, gy := gateTile()
	hx, hy := ChunkOf(gx, gy)
	_, _, maxCx, maxCy := frontierChunks()
	areas := []struct {
		name   string
		cx, cy int
	}{{"home", hx - 5, hy - 5}, {"far", maxCx - 9, maxCy - 9}}
	for _, a := range areas {
		chunks, camps, glades := 0, 0, 0
		for _, w := range v3Worlds(3) {
			for cy := a.cy; cy < a.cy+10; cy++ {
				for cx := a.cx; cx < a.cx+10; cx++ {
					if FixedFootprintAt(cx, cy) != nil || !InsideReach(cx, cy) {
						continue
					}
					ch, err := GenerateV3(epochFor(w[0], w[1], cx, cy), cx, cy, nil)
					if err != nil {
						t.Fatal(err)
					}
					chunks++
					for _, e := range ch.Entities {
						if e.Kind == kindCamp {
							camps++
						}
					}
					for _, p := range ch.Places {
						if p.Kind == "camp-glade" {
							glades++
						}
					}
				}
			}
		}
		if chunks == 0 {
			t.Fatalf("%s: no generated chunks", a.name)
		}
		per100 := func(n int) float64 { return float64(n) * 100 / float64(chunks) }
		t.Logf("%s (%d chunks): %.0f camps per 100 chunks, %.0f of them in camp glades", a.name, chunks, per100(camps), per100(glades))
		if per100(camps-glades) > 70 {
			t.Errorf("%s: %.0f open camps per 100 chunks; the Wilds ask for at most one in two", a.name, per100(camps-glades))
		}
	}
}
