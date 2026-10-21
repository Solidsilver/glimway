package wilds

// Lasting world fields (0.14 iteration 2, Lane B: terrain-decisions.md,
// terrain-argon.md §1.2, terrain-sol.md §1). Pure integer functions of the
// world seed and world tile (tx, ty), independent of the weekly wick seed
// and the world border. All fields are fixed-point permille values in
// [0, 1000] (FieldScale).

import "glimway/content"

// LandformV2 is the lasting terrain & biome recipe version for 0.14
// iteration 2 (terrain-decisions.md technical calls). LandformV1 remains
// frozen at 1 for existing generation.
const LandformV2 = 2

// FieldsVersion is the version of the lasting world fields recipe.
const FieldsVersion = 1

// FieldScale is the maximum value of each lasting world field (permille).
const FieldScale = 1000

// FieldNames lists the selectable lasting world fields in canonical order.
var FieldNames = []string{"upland", "relief", "wetness", "warmth", "quiet"}

// Fields holds all lasting continuous world fields sampled at a world tile,
// each in [0, 1000].
type Fields struct {
	Upland  int `json:"upland"`
	Relief  int `json:"relief"`
	Wetness int `json:"wetness"`
	Warmth  int `json:"warmth"`
	Quiet   int `json:"quiet"`
}

// ByName returns a field's value by its canonical name.
func (f Fields) ByName(name string) (int, bool) {
	switch name {
	case "upland":
		return f.Upland, true
	case "relief":
		return f.Relief, true
	case "wetness":
		return f.Wetness, true
	case "warmth":
		return f.Warmth, true
	case "quiet":
		return f.Quiet, true
	default:
		return 0, false
	}
}

// ValidFieldName reports whether name is a known lasting world field.
func ValidFieldName(name string) bool {
	_, ok := (Fields{}).ByName(name)
	return ok
}

// landformV2Hash hashes a pass of the LandformV2 recipe from the world seed
// alone (never the weekly season or generator version).
func landformV2Hash(worldSeed, pass string, parts ...any) uint32 {
	return Hash(append([]any{worldSeed, LandformV2, "landform", pass}, parts...)...)
}

// sampleFieldOctave samples smooth 2D integer value noise at a wavelength of
// stepTiles world tiles. It averages an axis-aligned lattice and an exact
// 3-4-5 Pythagorean rotated lattice (arctan(3/4) ≈ 36.87°) so the resulting
// field has no axial grid streaks, and uses floorDiv so negative coordinates
// have no kink across zero. Result lies in [0, 65536).
func sampleFieldOctave(seed uint32, tx, ty, stepTiles int) int {
	n1 := noise{seed}
	n2 := noise{Mix(seed, 0x9e3779b9)}
	x1 := floorDiv(tx*fp, stepTiles)
	y1 := floorDiv(ty*fp, stepTiles)
	rx := tx*4 - ty*3
	ry := tx*3 + ty*4
	x2 := floorDiv(rx*fp, stepTiles*5)
	y2 := floorDiv(ry*fp, stepTiles*5)
	return (n1.at(x1, y1) + n2.at(x2, y2)) / 2
}

// stretchPermille maps a combined noise value in [0, 65536) into [0, 1000]
// with a contrast factor (in percent, e.g. 155) around the midpoint so
// multi-octave averages span the full [0, 1000] range instead of clustering
// near 500.
func stretchPermille(v, contrastPct int) int {
	centered := (v - noiseMid) * contrastPct / 100
	scaled := clamp(noiseMid+centered, 0, noiseOne-1)
	return scaled * FieldScale / noiseOne
}

// rawStructuralUpland is the unconstrained world-wide upland field in
// [0, 1000] before the near-home gate apron and shoulder envelope are applied.
// Region biome selection reads this so a region site near home measures its
// true regional upland.
func rawStructuralUpland(worldSeed string, tx, ty int) int {
	S := chunkSize()
	macro := sampleFieldOctave(landformV2Hash(worldSeed, "field:upland:macro"), tx, ty, 48*S)
	mesoRaw := sampleFieldOctave(landformV2Hash(worldSeed, "field:upland:meso"), tx, ty, 18*S)
	// Ridged meso term centered around noiseMid: forms elongated upland chains and benches.
	diff := mesoRaw - noiseMid
	if diff < 0 {
		diff = -diff
	}
	meso := clamp(noiseOne-1-diff*3, 0, noiseOne-1)
	local := sampleFieldOctave(landformV2Hash(worldSeed, "field:upland:local"), tx, ty, 7*S)
	combined := (macro*55 + meso*30 + local*15) / 100
	return stretchPermille(combined, 175)
}

// homeFlatTileDist is the Chebyshev distance in world tiles from (tx, ty) to
// the nearest protected flat home footprint (authored fixed places and the
// Tangle). Inside Town, lots, or the Tangle it is 0.
func homeFlatTileDist(tx, ty int) int {
	S := chunkSize()
	best := -1
	checkBox := func(cx0, cy0, cx1, cy1 int) {
		x0, y0 := cx0*S, cy0*S
		x1, y1 := (cx1+1)*S-1, (cy1+1)*S-1
		dx := max(x0-tx, tx-x1, 0)
		dy := max(y0-ty, ty-y1, 0)
		d := max(dx, dy)
		if best < 0 || d < best {
			best = d
		}
	}
	for _, p := range content.PlacesRules.GetFixed() {
		x0, y0, x1, y1 := content.FixedChunks(p)
		checkBox(x0, y0, x1, y1)
	}
	if tangle := Footprint("tangle"); tangle != nil {
		cx0, cy0 := int(tangle.GetCx()), int(tangle.GetCy())
		checkBox(cx0, cy0, cx0+int(tangle.GetWidth())-1, cy0+int(tangle.GetHeight())-1)
	}
	if best < 0 {
		return 1000 * S
	}
	return best
}

// UplandAt returns the lasting Upland field at world tile (tx, ty) in
// [0, 1000]. Per terrain-decisions.md call 7:
//   - Town (fixed places) and the Tangle stay flat (0), with a flat apron of
//     about one chunk (24 tiles) outside their edges;
//   - Low shoulders rise 3–6 chunks out (72..144 tiles);
//   - Full mountain upland is unconstrained from ~7 chunks out onward.
func UplandAt(worldSeed string, tx, ty int) int {
	S := chunkSize()
	u := rawStructuralUpland(worldSeed, tx, ty)
	d := homeFlatTileDist(tx, ty)
	apron := S          // 1 chunk flat apron (24 tiles)
	shoulderStart := 3 * S // 3 chunks (72 tiles)
	shoulderEnd := 6 * S   // 6 chunks (144 tiles)
	fullStart := 8 * S     // 8 chunks (192 tiles)
	switch {
	case d <= apron:
		return 0
	case d < shoulderStart:
		// Smooth ramp from 0 at 1 chunk out to shoulder height at 3 chunks out.
		t := (d - apron) * 1000 / (shoulderStart - apron)
		capU := 480 * t / 1000
		return min(u*t/1000, capU)
	case d <= shoulderEnd:
		// 3–6 chunks out: guarantee gentle low shoulders where ridge noise is
		// positive, while capping below full high-mountain summits.
		shoulderWave := sampleFieldOctave(landformV2Hash(worldSeed, "field:upland:shoulder"), tx, ty, 5*S)
		floorU := 180 + shoulderWave*260/noiseOne
		return clamp(max(u, floorU), 0, 580)
	case d < fullStart:
		t := (d - shoulderEnd) * 1000 / (fullStart - shoulderEnd)
		shoulderCap := 580 + (1000-580)*t/1000
		return min(u, shoulderCap)
	default:
		return u
	}
}

// ReliefAt returns the lasting Relief (roughness / dissection) field at world
// tile (tx, ty) in [0, 1000].
func ReliefAt(worldSeed string, tx, ty int) int {
	return reliefWithUpland(worldSeed, tx, ty, UplandAt(worldSeed, tx, ty))
}

func reliefWithUpland(worldSeed string, tx, ty, upland int) int {
	S := chunkSize()
	d := homeFlatTileDist(tx, ty)
	if d <= S {
		return 0
	}
	meso := sampleFieldOctave(landformV2Hash(worldSeed, "field:relief:meso"), tx, ty, 28*S)
	local := sampleFieldOctave(landformV2Hash(worldSeed, "field:relief:local"), tx, ty, 8*S)
	raw := stretchPermille((meso*65+local*35)/100, 160)
	r := clamp((raw*75+upland*25)/100, 0, FieldScale)
	if d < 3*S {
		r = r * (d - S) / (2 * S)
	}
	return r
}

// WetnessAt returns the lasting Wetness (hydrological moisture potential)
// field at world tile (tx, ty) in [0, 1000].
func WetnessAt(worldSeed string, tx, ty int) int {
	return wetnessWithUpland(worldSeed, tx, ty, rawStructuralUpland(worldSeed, tx, ty))
}

func wetnessWithUpland(worldSeed string, tx, ty, rawUpland int) int {
	S := chunkSize()
	macro := sampleFieldOctave(landformV2Hash(worldSeed, "field:wetness:macro"), tx, ty, 40*S)
	meso := sampleFieldOctave(landformV2Hash(worldSeed, "field:wetness:meso"), tx, ty, 14*S)
	base := stretchPermille((macro*65+meso*35)/100, 155)
	// Lowlands retain slightly more moisture; high exposed ridges shed it.
	basinBias := (500 - rawUpland) / 7
	return clamp(base+basinBias, 0, FieldScale)
}

// WarmthAt returns the lasting Warmth (climate thermal coordinate) field at
// world tile (tx, ty) in [0, 1000]. Cooler northward (-y) and at high upland.
func WarmthAt(worldSeed string, tx, ty int) int {
	return warmthWithUpland(worldSeed, tx, ty, rawStructuralUpland(worldSeed, tx, ty))
}

func warmthWithUpland(worldSeed string, tx, ty, rawUpland int) int {
	S := chunkSize()
	macro := sampleFieldOctave(landformV2Hash(worldSeed, "field:warmth:macro"), tx, ty, 64*S)
	meso := sampleFieldOctave(landformV2Hash(worldSeed, "field:warmth:meso"), tx, ty, 20*S)
	base := stretchPermille((macro*70+meso*30)/100, 150)
	// North is -y: gentle bounded latitudinal trend plus altitude lapse.
	latBias := clamp(ty/12, -150, 130)
	lapse := (rawUpland - 400) / 5
	return clamp(base+latBias-lapse, 0, FieldScale)
}

// QuietAt returns the lasting Quiet affinity field at world tile (tx, ty) in
// [0, 1000]. Independent of wetness and danger; leans northward (-y) and
// seeds a Whitequiet neighbourhood north of the named whitequiet place
// (terrain-decisions.md call 6, terrain-sol.md §1).
func QuietAt(worldSeed string, tx, ty int) int {
	S := chunkSize()
	macro := sampleFieldOctave(landformV2Hash(worldSeed, "field:quiet:macro"), tx, ty, 44*S)
	meso := sampleFieldOctave(landformV2Hash(worldSeed, "field:quiet:meso"), tx, ty, 16*S)
	base := stretchPermille((macro*65+meso*35)/100, 165)

	// Northward lean (-y is north): boosts quiet affinity in the north and
	// suppresses it in the south, bounded so any latitude can still roll peaks.
	northBias := 0
	if ty < 0 {
		northBias = min(135, (-ty)/(8*S/10+1))
	} else {
		northBias = -min(165, ty/(6*S/10+1))
	}

	// The existing named whitequiet footprint (cx: -1..1, cy: -5..-3) seeds a
	// quiet neighbourhood extending northward into the adjacent region.
	anchorX, anchorY := 0, -10*S
	if wq := Footprint("whitequiet"); wq != nil {
		anchorX = (int(wq.GetCx())*2 + int(wq.GetWidth())) * S / 2
		anchorY = (int(wq.GetCy()) - 4) * S
	}
	dx, dy := tx-anchorX, ty-anchorY
	distTiles := isqrt(dx*dx + dy*dy)
	seedRadius := 24 * S
	seedBoost := 0
	if distTiles < seedRadius {
		seedBoost = (seedRadius - distTiles) * 140 / seedRadius
	}

	return clamp(base+northBias+seedBoost, 0, FieldScale)
}

// FieldsAt evaluates all five lasting world fields at world tile (tx, ty).
func FieldsAt(worldSeed string, tx, ty int) Fields {
	rawU := rawStructuralUpland(worldSeed, tx, ty)
	u := UplandAt(worldSeed, tx, ty)
	return Fields{
		Upland:  u,
		Relief:  reliefWithUpland(worldSeed, tx, ty, u),
		Wetness: wetnessWithUpland(worldSeed, tx, ty, rawU),
		Warmth:  warmthWithUpland(worldSeed, tx, ty, rawU),
		Quiet:   QuietAt(worldSeed, tx, ty),
	}
}

// FieldAt evaluates a single named lasting world field at world tile (tx, ty).
func FieldAt(worldSeed, name string, tx, ty int) (int, bool) {
	switch name {
	case "upland":
		return UplandAt(worldSeed, tx, ty), true
	case "relief":
		return ReliefAt(worldSeed, tx, ty), true
	case "wetness":
		return WetnessAt(worldSeed, tx, ty), true
	case "warmth":
		return WarmthAt(worldSeed, tx, ty), true
	case "quiet":
		return QuietAt(worldSeed, tx, ty), true
	default:
		return 0, false
	}
}
