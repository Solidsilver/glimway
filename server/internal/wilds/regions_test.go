package wilds

import (
	"sync"
	"testing"
)

func TestFieldsDeterminismAndHomeEnvelope(t *testing.T) {
	S := chunkSize()
	for _, seed := range []string{"map", "v3-0", "oak-7"} {
		// Inside the Tangle (cx: -1..1, cy: -2..0) and the 1-chunk gate apron:
		// Upland and Relief are 0.
		for _, tile := range [][2]int{{0, 0}, {12, -12}, {-12, -36}, {0, 12}} {
			f := FieldsAt(seed, tile[0], tile[1])
			if f.Upland != 0 || f.Relief != 0 {
				t.Fatalf("%s tile %v in home flat apron has Upland=%d Relief=%d, want 0", seed, tile, f.Upland, f.Relief)
			}
		}

		// Shoulders 3–6 chunks out from home: non-zero, capped at <= 580.
		maxShoulder := 0
		for ang := 0; ang < 8; ang++ {
			dx := [8]int{1, 1, 0, -1, -1, -1, 0, 1}[ang]
			dy := [8]int{0, -1, -1, -1, 0, 1, 1, 1}[ang]
			tx, ty := dx*5*S, dy*5*S
			u := UplandAt(seed, tx, ty)
			if u > 580 {
				t.Fatalf("%s shoulder at (%d,%d) has Upland=%d > 580", seed, tx, ty, u)
			}
			maxShoulder = max(maxShoulder, u)
		}
		if maxShoulder < 180 {
			t.Fatalf("%s had no low shoulders 5 chunks out (max Upland=%d)", seed, maxShoulder)
		}

		// Bounds and negative coordinates.
		var northQuiet, southQuiet, northWarmth, southWarmth int
		samples := 0
		for cy := -120; cy <= 120; cy += 8 {
			if cy == 0 {
				continue
			}
			for cx := -120; cx <= 120; cx += 8 {
				tx, ty := cx*S+S/2, cy*S+S/2
				f := FieldsAt(seed, tx, ty)
				for _, name := range FieldNames {
					v, ok := f.ByName(name)
					if !ok || v < 0 || v > FieldScale {
						t.Fatalf("%s field %s at (%d,%d) = %d, out of [0, %d]", seed, name, tx, ty, v, FieldScale)
					}
					if v2, ok2 := FieldAt(seed, name, tx, ty); !ok2 || v2 != v {
						t.Fatalf("%s FieldAt(%s) = %d, FieldsAt = %d", seed, name, v2, v)
					}
				}
				if cy < -16 {
					northQuiet += f.Quiet
					northWarmth += f.Warmth
					samples++
				} else if cy > 16 {
					southQuiet += f.Quiet
					southWarmth += f.Warmth
				}
			}
		}
		if northQuiet <= southQuiet {
			t.Fatalf("%s: Quiet does not lean north (north sum=%d, south sum=%d)", seed, northQuiet, southQuiet)
		}
		if northWarmth >= southWarmth {
			t.Fatalf("%s: Warmth does not cool northward (north sum=%d, south sum=%d)", seed, northWarmth, southWarmth)
		}
	}
}

func TestRegionsGeometryAndNegativeCoords(t *testing.T) {
	S := chunkSize()
	L := RegionChunks * S
	for ry := -4; ry <= 4; ry++ {
		for rx := -4; rx <= 4; rx++ {
			st := RegionSiteAt("map", rx, ry)
			cx, cy := rx*L+L/2, ry*L+L/2
			if st.SX < cx-RegionJitterChunks*S || st.SX > cx+RegionJitterChunks*S ||
				st.SY < cy-RegionJitterChunks*S || st.SY > cy+RegionJitterChunks*S {
				t.Fatalf("region (%d,%d) site (%d,%d) outside ±%d chunks of centre (%d,%d)",
					rx, ry, st.SX, st.SY, RegionJitterChunks, cx, cy)
			}
		}
	}

	// Verify negative coordinates, border-distance band, and three-region junctions.
	foundBlend := false
	foundTriple := false
	foundNeg := false
	for cy := -64; cy < 64; cy++ {
		for cx := -64; cx < 64; cx++ {
			tx, ty := cx*S+S/2, cy*S+S/2
			rs := RegionAt("map", tx, ty)
			if rs.Primary.RX < 0 && rs.Primary.RY < 0 {
				foundNeg = true
			}
			if rs.InBlendBand {
				foundBlend = true
			}
			if rs.TripleJunction {
				foundTriple = true
			}
		}
	}
	if !foundNeg || !foundBlend {
		t.Fatalf("missing negative region (%v) or blend band (%v)", foundNeg, foundBlend)
	}
	// Scan at 2-tile step around a region corner to verify a three-region junction exists.
	for ty := -40 * S; ty <= 20*S && !foundTriple; ty += 2 {
		for tx := -40 * S; tx <= 20*S; tx += 2 {
			if RegionAt("map", tx, ty).TripleJunction {
				foundTriple = true
				break
			}
		}
	}
	if !foundTriple {
		t.Fatal("expected at least one three-region junction in (-40..20)^2 chunks")
	}
}

func TestBiomeAreaMixAndHomeProximity(t *testing.T) {
	S := chunkSize()
	counts := map[string]int{}
	northWQ, southWQ := 0, 0
	total := 0
	firstDist := map[string]int{}

	for cy := -128; cy < 128; cy++ {
		for cx := -128; cx < 128; cx++ {
			tx, ty := cx*S+S/2, cy*S+S/2
			bs := BiomeAt("map", tx, ty, nil)
			counts[bs.EffectiveRef]++
			total++
			if bs.EffectiveBiome == BiomeWhitequiet {
				if cy < 0 {
					northWQ++
				} else {
					southWQ++
				}
			}
			d := max(absInt(cx), absInt(cy))
			if prev, ok := firstDist[bs.EffectiveRef]; !ok || d < prev {
				firstDist[bs.EffectiveRef] = d
			}
		}
	}

	hwShare := float64(counts["hearthwick-woods@1"]) / float64(total)
	topsShare := float64(counts["tops@1"]) / float64(total)
	wqShare := float64(counts["whitequiet@1"]) / float64(total)
	wqNorthShare := float64(northWQ) / float64(max(1, northWQ+southWQ))

	t.Logf("256x256 atlas ('map'): hearthwick-woods@1=%.1f%%, tops@1=%.1f%%, whitequiet@1=%.1f%% (north share=%.1f%%)",
		hwShare*100, topsShare*100, wqShare*100, wqNorthShare*100)
	t.Logf("first appearance (Chebyshev chunks from 0,0): %+v", firstDist)

	if hwShare < 0.55 || hwShare > 0.75 {
		t.Fatalf("hearthwick-woods@1 share %.3f outside [0.55, 0.75]", hwShare)
	}
	if topsShare < 0.18 || topsShare > 0.33 {
		t.Fatalf("tops@1 share %.3f outside [0.18, 0.33]", topsShare)
	}
	if wqShare < 0.06 || wqShare > 0.16 {
		t.Fatalf("whitequiet@1 share %.3f outside [0.06, 0.16]", wqShare)
	}
	if wqNorthShare < 0.70 {
		t.Fatalf("whitequiet@1 should lean north, got north share %.3f", wqNorthShare)
	}

	// Owner must meet all three biomes within a reasonable walk from home (<= 16 chunks).
	for _, ref := range []string{"hearthwick-woods@1", "tops@1", "whitequiet@1"} {
		d, ok := firstDist[ref]
		if !ok || d > 16 {
			t.Fatalf("biome %s first appears at %d chunks from home (ok=%v), want <= 16", ref, d, ok)
		}
	}
}

func TestDisposablePinManifestOrderIndependence(t *testing.T) {
	var coords [][2]int
	for cy := -16; cy < 16; cy += 3 {
		for cx := -16; cx < 16; cx += 3 {
			coords = append(coords, [2]int{cx, cy})
		}
	}

	pm1 := NewPinManifest("map")
	for _, c := range coords {
		pm1.PinChunk(c[0], c[1])
	}

	pm2 := NewPinManifest("map")
	var wg sync.WaitGroup
	for i := len(coords) - 1; i >= 0; i-- {
		c := coords[i]
		wg.Go(func() {
			pm2.PinChunk(c[0], c[1])
		})
	}
	wg.Wait()

	r1, r2 := pm1.Report(), pm2.Report()
	if r1.GeneratedChunks != len(coords) || r1.DirectPins == 0 || len(r1.Pins) != len(r2.Pins) {
		t.Fatalf("unexpected pin report: r1=%+v r2=%+v", r1, r2)
	}
	for i := range r1.Pins {
		if r1.Pins[i] != r2.Pins[i] {
			t.Fatalf("pin[%d] mismatch under concurrent reversed order: %+v vs %+v", i, r1.Pins[i], r2.Pins[i])
		}
	}
}

func absInt(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
