package wilds

// The walk lab's structural heights (exp/terrain-walk): the spike's single
// TerrainFields hook, driven by lane B's lasting fields. Preview only:
// GenerateV3 never calls it.

// Level thresholds on the dissected upland, in permille. Shoulders (upland
// 180–580 near home) reach level 1, rarely 2; the Tops climb to 2 and 3.
var terrainLevelAt = [3]int{300, 600, 780}

// TerrainWorld reads tops 0–3 from Upland, roughened by Relief: a coherent
// one-to-two-chunk dissection term, scaled by relief, nudges the upland
// before it is cut into levels, so rough country breaks into benches and
// smooth country keeps broad steps. Pure integer functions of the world
// seed and tile, so seams and negative coordinates need nothing special.
type TerrainWorld struct{ Seed string }

func (f TerrainWorld) Top(x, y int) uint8 {
	u := UplandAt(f.Seed, x, y)
	if u == 0 {
		return 0
	}
	r := reliefWithUpland(f.Seed, x, y, u)
	cut := sampleFieldOctave(landformV2Hash(f.Seed, "terrain:dissect"), x, y, 40)
	fine := sampleFieldOctave(landformV2Hash(f.Seed, "terrain:bench"), x, y, 14)
	d := ((cut-noiseMid)*70 + (fine-noiseMid)*30) / 100 // about ±noiseMid
	v := u + d*r/1000*320/noiseMid
	z := uint8(0)
	for _, t := range terrainLevelAt {
		if v >= t {
			z++
		}
	}
	return z
}
