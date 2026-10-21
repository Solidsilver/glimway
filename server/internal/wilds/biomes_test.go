package wilds

import "testing"

// The area mix holds across seeds, not just "map": a coarse 512×512-chunk
// sample per seed.
func TestBiomeMixAcrossSeeds(t *testing.T) {
	S := chunkSize()
	for _, seed := range []string{"v3-0", "oak-7", "wide-world", "glim-42"} {
		c := map[string]int{}
		n, north := 0, 0
		first := map[string]int{}
		for cy := -256; cy < 256; cy += 4 {
			for cx := -256; cx < 256; cx += 4 {
				bs := BiomeAt(seed, cx*S+S/2, cy*S+S/2, nil)
				c[bs.EffectiveBiome]++
				n++
				if bs.EffectiveBiome == BiomeWhitequiet && cy < 0 {
					north++
				}
				d := max(absInt(cx), absInt(cy))
				if p, ok := first[bs.EffectiveBiome]; !ok || d < p {
					first[bs.EffectiveBiome] = d
				}
			}
		}
		woods := float64(c[BiomeHearthwickWoods]) / float64(n)
		tops := float64(c[BiomeTops]) / float64(n)
		wq := float64(c[BiomeWhitequiet]) / float64(n)
		northShare := float64(north) / float64(max(1, c[BiomeWhitequiet]))
		t.Logf("%s: woods %.1f%% tops %.1f%% whitequiet %.1f%% (north %.0f%%), first %v",
			seed, woods*100, tops*100, wq*100, northShare*100, first)
		if woods < 0.52 || woods > 0.78 || tops < 0.14 || tops > 0.36 || wq < 0.05 || wq > 0.18 {
			t.Fatalf("%s: mix woods %.3f tops %.3f whitequiet %.3f out of bounds", seed, woods, tops, wq)
		}
		if northShare < 0.8 {
			t.Fatalf("%s: whitequiet north share %.3f, want mostly north", seed, northShare)
		}
		for _, b := range AllBiomes {
			if d, ok := first[b]; !ok || d > 16 {
				t.Fatalf("%s: %s first at %d chunks (ok=%v), want <= 16", seed, b, d, ok)
			}
		}
	}
}

// Upland never steps between neighbouring tiles anywhere in the home
// envelope, so height read from it cannot make a ring-shaped wall.
func TestUplandEnvelopeContinuous(t *testing.T) {
	S := chunkSize()
	for _, seed := range []string{"map", "oak-7"} {
		for ty := -14 * S; ty <= 14*S; ty += 3 {
			prev := UplandAt(seed, -14*S, ty)
			for tx := -14*S + 1; tx <= 14*S; tx++ {
				u := UplandAt(seed, tx, ty)
				if d := u - prev; d > 40 || d < -40 {
					t.Fatalf("%s: Upland steps %d -> %d at (%d,%d)", seed, prev, u, tx, ty)
				}
				prev = u
			}
		}
	}
}

// The named whitequiet place seeds a Whitequiet neighbourhood: the region
// holding it is whitequiet@1 on every seed.
func TestNamedWhitequietRegion(t *testing.T) {
	wq := Footprint("whitequiet")
	if wq == nil {
		t.Skip("no named whitequiet place")
	}
	S := chunkSize()
	wx := (int(wq.GetCx())*2 + int(wq.GetWidth())) * S / 2
	wy := (int(wq.GetCy())*2 + int(wq.GetHeight())) * S / 2
	for _, seed := range []string{"map", "v3-0", "oak-7", "wide-world", "glim-42"} {
		rc := RegionAt(seed, wx, wy).Primary
		if sel := SelectRegionBiome(seed, rc.RX, rc.RY); sel.Biome != BiomeWhitequiet {
			t.Fatalf("%s: region %s holding the named whitequiet place is %s", seed, rc.ID(), sel.Ref)
		}
	}
}
