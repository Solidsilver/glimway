package wilds

// Biome selection, disposable region pins, coherent border-band blending, and
// the first biome look for the world lab (0.14 iteration 2, Lane B:
// terrain-decisions.md calls 1, 3, 4, 6, 7, 8; terrain-sol.md §1, §3;
// terrain-argon.md §1.3–1.5).

import (
	"fmt"
	"image/color"
	"slices"
	"sync"
)

// Canonical biome IDs and current recipe version.
const (
	BiomeHearthwickWoods = "hearthwick-woods"
	BiomeTops            = "tops"
	BiomeWhitequiet      = "whitequiet"

	BiomeVersion = 1
)

// AllBiomes lists the three biomes in canonical order.
var AllBiomes = []string{BiomeHearthwickWoods, BiomeTops, BiomeWhitequiet}

// BiomeRef formats a biome ID and version as "<biome>@<version>".
func BiomeRef(biome string, version int) string {
	return fmt.Sprintf("%s@%d", biome, version)
}

// BiomeSelection describes the biome chosen for a 32-chunk region lattice cell.
type BiomeSelection struct {
	Coord        RegionCoord `json:"coord"`
	RegionID     string      `json:"regionId"`
	Site         [2]int      `json:"site"`
	Biome        string      `json:"biome"`
	Version      int         `json:"version"`
	Ref          string      `json:"ref"`
	MeanFields   Fields      `json:"meanFields"`
	RecipeDigest string      `json:"recipeDigest"`
}

// RegionPin is one entry in a disposable pin manifest (terrain-decisions.md
// calls 3, 4, 8). A region pins when a chunk inside it is generated, and
// lasts until the next update turning.
type RegionPin struct {
	WorldSeed       string      `json:"worldSeed"`
	RX              int         `json:"rx"`
	RY              int         `json:"ry"`
	RegionID        string      `json:"regionId"`
	Site            [2]int      `json:"site"`
	Biome           string      `json:"biome"`
	BiomeVersion    int         `json:"biomeVersion"`
	BiomeRef        string      `json:"biomeRef"`
	FieldsVersion   int         `json:"fieldsVersion"`
	LandformVersion int         `json:"landformVersion"`
	RecipeDigest    string      `json:"recipeDigest"`
	TriggerChunk    [2]int      `json:"triggerChunk"`
	Support         bool        `json:"support"`
}

// PinManifest is a disposable in-memory manifest of regions pinned during a
// world-lab run. It never touches the gameplay database.
type PinManifest struct {
	mu              sync.Mutex
	worldSeed       string
	generatedChunks map[[2]int]bool
	pins            map[RegionCoord]RegionPin
}

// PinManifestReport is the serializable snapshot of a PinManifest.
type PinManifestReport struct {
	WorldSeed       string      `json:"worldSeed"`
	LandformVersion int         `json:"landformVersion"`
	FieldsVersion   int         `json:"fieldsVersion"`
	GeneratedChunks int         `json:"generatedChunks"`
	DirectPins      int         `json:"directPins"`
	SupportPins     int         `json:"supportPins"`
	Pins            []RegionPin `json:"pins"`
}

// NewPinManifest creates a fresh disposable pin manifest for worldSeed.
func NewPinManifest(worldSeed string) *PinManifest {
	return &PinManifest{
		worldSeed:       worldSeed,
		generatedChunks: map[[2]int]bool{},
		pins:            map[RegionCoord]RegionPin{},
	}
}

// chunkOrderLess orders chunk coordinates deterministically by (cy, cx) so
// concurrent chunk workers always record the exact same TriggerChunk.
func chunkOrderLess(a, b [2]int) bool {
	if a[1] != b[1] {
		return a[1] < b[1]
	}
	return a[0] < b[0]
}

// PinChunk pins every region that owns tiles in generated chunk (cx, cy) as a
// direct pin, and any runner-up region whose blend band reaches into (cx, cy)
// as a support pin.
func (pm *PinManifest) PinChunk(cx, cy int) {
	if pm == nil {
		return
	}
	S := chunkSize()
	direct := map[RegionCoord]bool{}
	support := map[RegionCoord]bool{}
	// Sample a 3×3 grid of tiles across the chunk to capture all owning and
	// blend-band neighbour regions affecting this chunk.
	steps := [3]int{0, S / 2, S - 1}
	for _, dy := range steps {
		for _, dx := range steps {
			rs := RegionAt(pm.worldSeed, cx*S+dx, cy*S+dy)
			direct[rs.Primary] = true
			if rs.InBlendBand {
				support[rs.Secondary] = true
				if rs.TripleJunction {
					support[rs.Tertiary] = true
				}
			}
		}
	}

	pm.mu.Lock()
	defer pm.mu.Unlock()
	ch := [2]int{cx, cy}
	pm.generatedChunks[ch] = true

	record := func(rc RegionCoord, isSupport bool) {
		existing, ok := pm.pins[rc]
		if !ok {
			sel := SelectRegionBiome(pm.worldSeed, rc.RX, rc.RY)
			pm.pins[rc] = RegionPin{
				WorldSeed:       pm.worldSeed,
				RX:              rc.RX,
				RY:              rc.RY,
				RegionID:        rc.ID(),
				Site:            sel.Site,
				Biome:           sel.Biome,
				BiomeVersion:    sel.Version,
				BiomeRef:        sel.Ref,
				FieldsVersion:   FieldsVersion,
				LandformVersion: LandformV2,
				RecipeDigest:    sel.RecipeDigest,
				TriggerChunk:    ch,
				Support:         isSupport,
			}
			return
		}
		if existing.Support && !isSupport {
			existing.Support = false
			existing.TriggerChunk = ch
			pm.pins[rc] = existing
		} else if existing.Support == isSupport && chunkOrderLess(ch, existing.TriggerChunk) {
			existing.TriggerChunk = ch
			pm.pins[rc] = existing
		}
	}

	for rc := range direct {
		record(rc, false)
	}
	for rc := range support {
		if !direct[rc] {
			record(rc, true)
		}
	}
}

// Lookup returns the RegionPin for rc if pinned in this manifest.
func (pm *PinManifest) Lookup(rc RegionCoord) (RegionPin, bool) {
	if pm == nil {
		return RegionPin{}, false
	}
	pm.mu.Lock()
	defer pm.mu.Unlock()
	p, ok := pm.pins[rc]
	return p, ok
}

// Report returns a deterministically sorted snapshot of the pin manifest.
func (pm *PinManifest) Report() PinManifestReport {
	if pm == nil {
		return PinManifestReport{
			LandformVersion: LandformV2,
			FieldsVersion:   FieldsVersion,
			Pins:            []RegionPin{},
		}
	}
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pins := make([]RegionPin, 0, len(pm.pins))
	directCount, supportCount := 0, 0
	for _, p := range pm.pins {
		pins = append(pins, p)
		if p.Support {
			supportCount++
		} else {
			directCount++
		}
	}
	slices.SortFunc(pins, func(a, b RegionPin) int {
		ca := RegionCoord{RX: a.RX, RY: a.RY}
		cb := RegionCoord{RX: b.RX, RY: b.RY}
		if ca.Less(cb) {
			return -1
		}
		if cb.Less(ca) {
			return 1
		}
		return 0
	})
	return PinManifestReport{
		WorldSeed:       pm.worldSeed,
		LandformVersion: LandformV2,
		FieldsVersion:   FieldsVersion,
		GeneratedChunks: len(pm.generatedChunks),
		DirectPins:      directCount,
		SupportPins:     supportCount,
		Pins:            pins,
	}
}

// sampleSiteMeanFields samples a 5×5 grid of field points (spaced by 4 chunks)
// around a region's jittered site (sx, sy). It uses rawStructuralUpland so the
// local gate apron does not distort a region's overall upland character.
func sampleSiteMeanFields(worldSeed string, sx, sy int) Fields {
	step := 4 * chunkSize()
	var sumU, sumR, sumW, sumT, sumQ int
	for dy := -2; dy <= 2; dy++ {
		for dx := -2; dx <= 2; dx++ {
			tx, ty := sx+dx*step, sy+dy*step
			u := rawStructuralUpland(worldSeed, tx, ty)
			sumU += u
			sumR += reliefWithUpland(worldSeed, tx, ty, u)
			sumW += wetnessWithUpland(worldSeed, tx, ty, u)
			sumT += warmthWithUpland(worldSeed, tx, ty, u)
			sumQ += QuietAt(worldSeed, tx, ty)
		}
	}
	const n = 25
	return Fields{
		Upland:  sumU / n,
		Relief:  sumR / n,
		Wetness: sumW / n,
		Warmth:  sumT / n,
		Quiet:   sumQ / n,
	}
}

// naturalRegionBiome applies the global threshold selection rules to a region's
// 5×5 site field averages, tuned near 65% hearthwick-woods@1, 25% tops@1, and
// 10% whitequiet@1 (with whitequiet leaning strongly north).
func naturalRegionBiome(worldSeed string, rx, ry int, mean Fields) string {
	elig := int(landformV2Hash(worldSeed, "region-elig", rx, ry) % 1000)

	// Whitequiet leans north (ry < 0): higher eligibility in the north, rare in
	// the south, requiring strong quiet affinity.
	wqChance := 140
	wqMinQ := 620
	if ry < 0 {
		wqChance = 490
		wqMinQ = 560
	}
	if mean.Quiet >= wqMinQ && elig < wqChance {
		return BiomeWhitequiet
	}

	// Tops: high structural upland (with a modest contribution from relief).
	topsScore := mean.Upland + (mean.Relief-500)/5
	topsElig := int(landformV2Hash(worldSeed, "region-tops-elig", rx, ry) % 1000)
	if topsScore >= 740 || (topsScore >= 590 && topsElig < 390) {
		return BiomeTops
	}

	return BiomeHearthwickWoods
}

func regionRecipeDigest(worldSeed string, rx, ry int, site [2]int, biome string, version int) string {
	h1 := landformV2Hash(worldSeed, "pin-digest-a", rx, ry, site[0], site[1], biome, version, FieldsVersion)
	h2 := landformV2Hash(worldSeed, "pin-digest-b", rx, ry, site[0], site[1], biome, version, FieldsVersion)
	return fmt.Sprintf("%08x%08x", h1, h2)
}

var regionBiomeCache sync.Map

// SelectRegionBiome returns the deterministic BiomeSelection for region (rx, ry).
// In the 2×2 central neighbourhood around (0, 0) (rx in -1..0, ry in -1..0), it
// ensures that all three biomes appear in the four regions meeting near home
// (with Whitequiet in the northern pair) without forcing which region owns
// (0, 0), so the owner always meets Tops and Whitequiet within a short walk
// from home.
func SelectRegionBiome(worldSeed string, rx, ry int) BiomeSelection {
	key := regionCacheKey{worldSeed, rx, ry}
	if v, ok := regionBiomeCache.Load(key); ok {
		return v.(BiomeSelection)
	}
	sel := computeRegionBiome(worldSeed, rx, ry)
	regionBiomeCache.Store(key, sel)
	return sel
}

func computeRegionBiome(worldSeed string, rx, ry int) BiomeSelection {
	build := func(cx, cy int, biome string) BiomeSelection {
		st := RegionSiteAt(worldSeed, cx, cy)
		site := [2]int{st.SX, st.SY}
		mean := sampleSiteMeanFields(worldSeed, st.SX, st.SY)
		return BiomeSelection{
			Coord:        st.Coord,
			RegionID:     st.Coord.ID(),
			Site:         site,
			Biome:        biome,
			Version:      BiomeVersion,
			Ref:          BiomeRef(biome, BiomeVersion),
			MeanFields:   mean,
			RecipeDigest: regionRecipeDigest(worldSeed, cx, cy, site, biome, BiomeVersion),
		}
	}

	if rx >= -1 && rx <= 0 && ry >= -1 && ry <= 0 {
		coords := [4]RegionCoord{
			{RX: -1, RY: -1},
			{RX: 0, RY: -1},
			{RX: -1, RY: 0},
			{RX: 0, RY: 0},
		}
		var means [4]Fields
		var biomes [4]string
		for i, c := range coords {
			st := RegionSiteAt(worldSeed, c.RX, c.RY)
			means[i] = sampleSiteMeanFields(worldSeed, st.SX, st.SY)
			biomes[i] = naturalRegionBiome(worldSeed, c.RX, c.RY, means[i])
		}

		// 1. Ensure at least one of the two northern cells ((-1,-1) or (0,-1))
		// is whitequiet@1 (picking the one with higher Quiet affinity).
		wqIdx := -1
		for i := 0; i < 2; i++ {
			if biomes[i] == BiomeWhitequiet {
				wqIdx = i
				break
			}
		}
		if wqIdx < 0 {
			wqIdx = 0
			if means[1].Quiet > means[0].Quiet {
				wqIdx = 1
			}
			biomes[wqIdx] = BiomeWhitequiet
		}

		// 2. Ensure at least one of the remaining 3 cells is tops@1 (picking
		// the non-whitequiet cell with highest Upland).
		topsIdx := -1
		for i := 0; i < 4; i++ {
			if i != wqIdx && biomes[i] == BiomeTops {
				topsIdx = i
				break
			}
		}
		if topsIdx < 0 {
			for i := 0; i < 4; i++ {
				if i == wqIdx {
					continue
				}
				if topsIdx < 0 || means[i].Upland > means[topsIdx].Upland {
					topsIdx = i
				}
			}
			biomes[topsIdx] = BiomeTops
		}

		// 3. Ensure at least one of the remaining 2 cells is hearthwick-woods@1.
		hasWoods := false
		for i := 0; i < 4; i++ {
			if biomes[i] == BiomeHearthwickWoods {
				hasWoods = true
				break
			}
		}
		if !hasWoods {
			bestWoods := -1
			bestScore := 0
			for i := 0; i < 4; i++ {
				if i == wqIdx || i == topsIdx {
					continue
				}
				score := means[i].Upland + means[i].Quiet
				if bestWoods < 0 || score < bestScore {
					bestWoods = i
					bestScore = score
				}
			}
			if bestWoods >= 0 {
				biomes[bestWoods] = BiomeHearthwickWoods
			}
		}

		for i, c := range coords {
			if c.RX == rx && c.RY == ry {
				return build(rx, ry, biomes[i])
			}
		}
	}

	st := RegionSiteAt(worldSeed, rx, ry)
	mean := sampleSiteMeanFields(worldSeed, st.SX, st.SY)
	biome := naturalRegionBiome(worldSeed, rx, ry, mean)
	return build(rx, ry, biome)
}

// regionBiomeFor resolves a region's biome, consulting the disposable pin
// manifest first if provided.
func regionBiomeFor(worldSeed string, rc RegionCoord, pins *PinManifest) (string, int) {
	if p, ok := pins.Lookup(rc); ok {
		return p.Biome, p.BiomeVersion
	}
	sel := SelectRegionBiome(worldSeed, rc.RX, rc.RY)
	return sel.Biome, sel.Version
}

// TileBiomeSample describes the region ownership, border-distance band, and
// coherent patch-blended biome at a world tile (tx, ty).
type TileBiomeSample struct {
	PrimaryRegion   RegionCoord `json:"primaryRegion"`
	PrimaryBiome    string      `json:"primaryBiome"`
	PrimaryRef      string      `json:"primaryRef"`
	SecondaryRegion RegionCoord `json:"secondaryRegion"`
	SecondaryBiome  string      `json:"secondaryBiome"`
	SecondaryRef    string      `json:"secondaryRef"`
	TertiaryRegion  RegionCoord `json:"tertiaryRegion"`
	TertiaryBiome   string      `json:"tertiaryBiome"`
	EffectiveBiome  string      `json:"effectiveBiome"`
	EffectiveRef    string      `json:"effectiveRef"`
	BorderDistTiles int         `json:"borderDistTiles"`
	InBlendBand     bool        `json:"inBlendBand"`
	TripleJunction  bool        `json:"tripleJunction"`
	Blended         bool        `json:"blended"`
	PatchPermille   int         `json:"patchPermille"`
}

// BiomeAt evaluates region ownership and coherent 3–6-tile patch blending
// across the border-distance band (including three-region junctions) at world
// tile (tx, ty).
//
// Protected footprints:
//   - The Tangle ("tangle") always retains hearthwick-woods@1;
//   - The existing named "whitequiet" footprint retains whitequiet@1.
func BiomeAt(worldSeed string, tx, ty int, pins *PinManifest) TileBiomeSample {
	S := chunkSize()
	cx, cy := floorDiv(tx, S), floorDiv(ty, S)
	rs := RegionAt(worldSeed, tx, ty)

	b1, v1 := regionBiomeFor(worldSeed, rs.Primary, pins)
	b2, v2 := regionBiomeFor(worldSeed, rs.Secondary, pins)
	b3, v3 := regionBiomeFor(worldSeed, rs.Tertiary, pins)

	// Coherent 3–6-tile patch noise in [0, 1000).
	patchRaw := sampleFieldOctave(landformV2Hash(worldSeed, "blend-patch:5"), tx, ty, 5)
	patchFine := sampleFieldOctave(landformV2Hash(worldSeed, "blend-patch:3"), tx, ty, 3)
	patch := stretchPermille((patchRaw*75+patchFine*25)/100, 175)

	out := TileBiomeSample{
		PrimaryRegion:   rs.Primary,
		PrimaryBiome:    b1,
		PrimaryRef:      BiomeRef(b1, v1),
		SecondaryRegion: rs.Secondary,
		SecondaryBiome:  b2,
		SecondaryRef:    BiomeRef(b2, v2),
		TertiaryRegion:  rs.Tertiary,
		TertiaryBiome:   b3,
		EffectiveBiome:  b1,
		EffectiveRef:    BiomeRef(b1, v1),
		BorderDistTiles: rs.BorderDistTiles,
		InBlendBand:     rs.InBlendBand,
		TripleJunction:  rs.TripleJunction,
		PatchPermille:   patch,
	}

	// Honour named footprints: the Tangle is always hearthwick-woods@1, and
	// the existing named whitequiet place is always whitequiet@1.
	if fpPlace := FootprintAt(cx, cy); fpPlace != nil {
		if fpPlace.GetId() == "tangle" {
			out.EffectiveBiome = BiomeHearthwickWoods
			out.EffectiveRef = BiomeRef(BiomeHearthwickWoods, BiomeVersion)
			out.InBlendBand = false
			return out
		}
		if fpPlace.GetId() == "whitequiet" {
			out.EffectiveBiome = BiomeWhitequiet
			out.EffectiveRef = BiomeRef(BiomeWhitequiet, BiomeVersion)
			return out
		}
	}
	if FixedFootprintAt(cx, cy) != nil {
		out.EffectiveBiome = BiomeHearthwickWoods
		out.EffectiveRef = BiomeRef(BiomeHearthwickWoods, BiomeVersion)
		out.InBlendBand = false
		return out
	}

	// Half-band width: 8 tiles normally; 4 tiles when bordering Whitequiet so
	// its pale margin stays crisp and distinct (terrain-sol.md §1).
	half12 := BlendHalfBandTiles * fp
	if b1 == BiomeWhitequiet || b2 == BiomeWhitequiet {
		half12 = WhitequietBlendHalfTiles * fp
	}
	half13 := BlendHalfBandTiles * fp
	if b1 == BiomeWhitequiet || b3 == BiomeWhitequiet {
		half13 = WhitequietBlendHalfTiles * fp
	}

	if rs.Dist12FP >= half12 {
		out.InBlendBand = false
		out.TripleJunction = false
		return out
	}

	// Inside the blend band: compute normalized secondary (and at a 3-region
	// junction, tertiary) weights. At the exact bisector (dist=0), w2 reaches
	// 480 permille so coherent patches interleave across both sides of the line.
	w2 := 0
	if b2 != b1 {
		w2 = (half12 - rs.Dist12FP) * 480 / half12
	}
	w3 := 0
	if rs.Dist13FP < half13 && b3 != b1 && b3 != b2 {
		w3 = (half13 - rs.Dist13FP) * 320 / half13
	}

	if w3 > 0 && patch >= 1000-w3 {
		out.EffectiveBiome = b3
		out.EffectiveRef = BiomeRef(b3, v3)
		out.Blended = true
	} else if w2 > 0 && patch < w2 {
		out.EffectiveBiome = b2
		out.EffectiveRef = BiomeRef(b2, v2)
		out.Blended = true
	}
	return out
}

// BiomeOwnerColour returns a distinct diagnostic colour for categorical biome
// ownership overlays.
func BiomeOwnerColour(biome string) color.RGBA {
	switch biome {
	case BiomeHearthwickWoods:
		return color.RGBA{64, 136, 74, 255}
	case BiomeTops:
		return color.RGBA{168, 126, 84, 255}
	case BiomeWhitequiet:
		return color.RGBA{218, 214, 198, 255}
	default:
		return GroundColour(biome)
	}
}

// BiomeGroundColour returns the world-lab palette colour for a ground ID
// (including biome-specific ground IDs for Tops and Whitequiet).
func BiomeGroundColour(id string) color.RGBA {
	if c, ok := biomeGroundColours[id]; ok {
		return c
	}
	return GroundColour(id)
}

var biomeGroundColours = map[string]color.RGBA{
	// Tops ground palette: valley pine woods, heather moor, alpine turf, scree, slate crag.
	"tops-woods": {46, 82, 58, 255},
	"tops-moor":  {136, 122, 92, 255},
	"tops-turf":  {126, 152, 90, 255},
	"tops-scree": {150, 144, 134, 255},
	"tops-crag":  {170, 174, 182, 255},
	"tops-path":  {162, 150, 128, 255},
	// Whitequiet ground palette: ivory grass, grey soil, pale birch/snag floor, pale stone.
	"wq-ivory": {216, 212, 192, 255},
	"wq-soil":  {158, 156, 148, 255},
	"wq-birch": {176, 180, 168, 255},
	"wq-stone": {186, 186, 180, 255},
	"wq-path":  {144, 140, 132, 255},
}

// shadePermille scales a colour's RGB channels by permille/1000, clamped to 0..255.
func shadePermille(c color.RGBA, permille int) color.RGBA {
	return color.RGBA{
		R: uint8(clamp(int(c.R)*permille/1000, 0, 255)),
		G: uint8(clamp(int(c.G)*permille/1000, 0, 255)),
		B: uint8(clamp(int(c.B)*permille/1000, 0, 255)),
		A: 255,
	}
}

// BiomeAtlasColour computes the chunk-glimpse colour and resolved biome@version
// for chunk (cx, cy) in the world-lab atlas so the atlas reads clearly as three
// kinds of country with coherent patch blending across region borders.
func BiomeAtlasColour(worldSeed string, cx, cy int, land string, river bool, pins *PinManifest) (color.RGBA, TileBiomeSample) {
	S := chunkSize()
	tx, ty := cx*S+S/2, cy*S+S/2
	bs := BiomeAt(worldSeed, tx, ty, pins)
	f := FieldsAt(worldSeed, tx, ty)

	var col color.RGBA
	switch bs.EffectiveBiome {
	case BiomeWhitequiet:
		// Pale, hushed country: ivory grass in open expanses, grey soil and
		// sparse pale birch stands where land is woods, pale stone on shoulders.
		switch {
		case f.Upland >= 560 || f.Relief >= 650:
			col = biomeGroundColours["wq-stone"]
		case land == "woods":
			if bs.PatchPermille < 380 {
				col = biomeGroundColours["wq-birch"]
			} else if bs.PatchPermille < 650 {
				col = biomeGroundColours["wq-soil"]
			} else {
				col = biomeGroundColours["wq-ivory"]
			}
		default:
			col = biomeGroundColours["wq-ivory"]
		}
		col = shadePermille(col, 960+f.Upland*80/1000)

	case BiomeTops:
		// Upland country: valley pine copses, broad heather moor and alpine
		// turf benches, scree slopes, and bare slate/crag crowns high up.
		switch {
		case f.Upland >= 760:
			col = biomeGroundColours["tops-crag"]
		case f.Upland >= 640 || f.Relief >= 680:
			col = biomeGroundColours["tops-scree"]
		case land == "woods" && f.Upland < 540:
			col = biomeGroundColours["tops-woods"]
		case land == "woods":
			col = biomeGroundColours["tops-moor"]
		default:
			if f.Wetness >= 520 {
				col = biomeGroundColours["tops-turf"]
			} else {
				col = biomeGroundColours["tops-moor"]
			}
		}
		col = shadePermille(col, 920+f.Upland*140/1000)

	default:
		// hearthwick-woods@1: green low country (woods and meadow).
		if land == "woods" {
			col = color.RGBA{34, 66, 38, 255}
		} else {
			col = color.RGBA{150, 190, 96, 255}
		}
		col = shadePermille(col, 950+f.Upland*100/1000)
	}

	if river {
		wCol := GroundColour("water")
		col = color.RGBA{
			R: uint8((int(col.R) + int(wCol.R)) / 2),
			G: uint8((int(col.G) + int(wCol.G)) / 2),
			B: uint8((int(col.B) + int(wCol.B)) / 2),
			A: 255,
		}
	}
	return col, bs
}

// BiomeTileLook resolves a generated tile's biome ground ID, colour, and
// cover solidity for region/chunk views in the world lab.
//
// It respects the land's thicketPermille (so rules edits in the world lab that
// tune thicketPermille continue to take effect) while applying:
//   - Rule 15 treeline thinning on tops@1 (trees thin into moor, scree, and
//     bare crag as Upland rises);
//   - Decision 6 Whitequiet look on whitequiet@1 (ivory grass, grey soil,
//     sparse pale birch and bare snags);
//   - Coherent 3–6-tile patch blending across region border bands.
func BiomeTileLook(worldSeed string, tx, ty int, baseGround string, baseSolid bool, surface string, thicketPermille int, pins *PinManifest) (groundID string, col color.RGBA, solid bool, sample TileBiomeSample) {
	sample = BiomeAt(worldSeed, tx, ty, pins)
	// Water, ford, road, and laid surfaces keep their exact structural ground.
	if surface != "land" {
		col = GroundColour(baseGround)
		if baseSolid {
			col = shadePermille(col, 600)
		}
		return baseGround, col, baseSolid, sample
	}

	f := FieldsAt(worldSeed, tx, ty)
	grove := sampleFieldOctave(landformV2Hash(worldSeed, "biome-grove"), tx, ty, 6) * 1000 / noiseOne

	switch sample.EffectiveBiome {
	case BiomeWhitequiet:
		solid = baseSolid
		if baseSolid && thicketPermille > 0 {
			// Sparse pale birch and bare snags (~24% of normal forest cover,
			// clustered in small stands) instead of a solid wall of trees.
			keepThresh := min(260, thicketPermille*260/1000)
			solid = grove < keepThresh
		}
		switch {
		case baseGround == "path" || baseGround == "trodden" || baseGround == "verge":
			groundID = "wq-path"
		case f.Upland >= 580 || f.Relief >= 660:
			groundID = "wq-stone"
		case solid:
			groundID = "wq-birch"
		case baseGround == "woods" || baseGround == "moss":
			if grove < 460 {
				groundID = "wq-soil"
			} else {
				groundID = "wq-ivory"
			}
		default:
			groundID = "wq-ivory"
		}
		col = BiomeGroundColour(groundID)
		if solid {
			// Sparse pale birch / dark snag silhouette contrast.
			col = shadePermille(col, 720)
		}
		return groundID, col, solid, sample

	case BiomeTops:
		solid = baseSolid
		if baseSolid && thicketPermille > 0 {
			// Rule 15 (trees thin as you climb): full copses in valleys,
			// thinning across shoulders, bare stone/scree above timberline.
			var canopyKeep int
			switch {
			case f.Upland >= 780:
				canopyKeep = 60 // rare summit boulder/cairn
			case f.Upland >= 640:
				canopyKeep = 150 // sparse sub-alpine scrub / rock
			case f.Upland >= 500:
				canopyKeep = 380 // open shoulder pine/birch stands
			default:
				canopyKeep = 780 // valley copses
			}
			keepThresh := min(canopyKeep, thicketPermille*canopyKeep/1000)
			solid = grove < keepThresh
		}
		switch {
		case baseGround == "path" || baseGround == "trodden" || baseGround == "verge":
			groundID = "tops-path"
		case f.Upland >= 780:
			groundID = "tops-crag"
		case f.Upland >= 640 || f.Relief >= 680:
			groundID = "tops-scree"
		case solid:
			groundID = "tops-woods"
		case baseGround == "meadow" || f.Wetness >= 520:
			groundID = "tops-turf"
		default:
			groundID = "tops-moor"
		}
		col = BiomeGroundColour(groundID)
		if solid {
			col = shadePermille(col, 640)
		}
		return groundID, col, solid, sample

	default:
		// hearthwick-woods@1
		groundID = baseGround
		col = GroundColour(groundID)
		if baseSolid {
			col = shadePermille(col, 600)
		}
		return groundID, col, baseSolid, sample
	}
}

// FieldHeatmapColour maps a field value in [0, 1000] to a distinct, readable
// heatmap colour ramp for the world lab.
func FieldHeatmapColour(field string, v int) color.RGBA {
	v = clamp(v, 0, FieldScale)
	type stop struct {
		at  int
		col color.RGBA
	}
	var ramp []stop
	switch field {
	case "upland":
		// Deep lowland green -> olive bench -> warm ochre ridge -> pale alpine peak
		ramp = []stop{
			{0, color.RGBA{34, 72, 52, 255}},
			{350, color.RGBA{92, 142, 76, 255}},
			{555, color.RGBA{176, 152, 82, 255}},
			{780, color.RGBA{156, 112, 84, 255}},
			{1000, color.RGBA{234, 232, 226, 255}},
		}
	case "relief":
		// Calm slate -> amber slope -> steep rust/crimson crag
		ramp = []stop{
			{0, color.RGBA{38, 48, 66, 255}},
			{400, color.RGBA{88, 124, 138, 255}},
			{680, color.RGBA{208, 148, 66, 255}},
			{1000, color.RGBA{214, 62, 58, 255}},
		}
	case "wetness":
		// Dry ochre -> lush moss -> deep teal/indigo basin
		ramp = []stop{
			{0, color.RGBA{188, 154, 96, 255}},
			{450, color.RGBA{112, 168, 98, 255}},
			{750, color.RGBA{46, 134, 168, 255}},
			{1000, color.RGBA{28, 68, 142, 255}},
		}
	case "warmth":
		// Cool northern frost-blue -> temperate green-gold -> warm terracotta
		ramp = []stop{
			{0, color.RGBA{64, 116, 182, 255}},
			{350, color.RGBA{102, 166, 162, 255}},
			{550, color.RGBA{168, 186, 96, 255}},
			{1000, color.RGBA{216, 104, 62, 255}},
		}
	case "quiet":
		// Ordinary dark woods-slate -> hushed silver-sage -> luminous ivory Whitequiet
		ramp = []stop{
			{0, color.RGBA{36, 44, 48, 255}},
			{450, color.RGBA{84, 104, 108, 255}},
			{565, color.RGBA{154, 166, 158, 255}},
			{800, color.RGBA{216, 212, 194, 255}},
			{1000, color.RGBA{246, 244, 234, 255}},
		}
	default:
		g := uint8(v * 255 / FieldScale)
		return color.RGBA{g, g, g, 255}
	}

	for i := 0; i+1 < len(ramp); i++ {
		a, b := ramp[i], ramp[i+1]
		if v <= b.at {
			span := max(1, b.at-a.at)
			t := v - a.at
			return color.RGBA{
				R: uint8(int(a.col.R) + (int(b.col.R)-int(a.col.R))*t/span),
				G: uint8(int(a.col.G) + (int(b.col.G)-int(a.col.G))*t/span),
				B: uint8(int(a.col.B) + (int(b.col.B)-int(a.col.B))*t/span),
				A: 255,
			}
		}
	}
	return ramp[len(ramp)-1].col
}
