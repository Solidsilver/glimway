package worldlab

// Lane B world-lab extensions: lasting world fields heatmaps, 32-chunk biome
// regions & IDs, biome ownership, border-distance blend bands, disposable pin
// manifests, and tile hover inspection (server/internal/worldlab/regions_lab.go).
// Kept in its own file so Lane A (exp/terrain-spike) merges cleanly.

import (
	"fmt"
	"image"
	"image/color"
	"strings"

	"glimway/content"
	"glimway/server/internal/wilds"
)

func landThicketPermille(landID string) int {
	for _, l := range content.WildsRules.Lands {
		if l.GetId() == landID {
			return int(l.GetThicketPermille())
		}
	}
	if len(content.WildsRules.Lands) > 0 {
		return int(content.WildsRules.Lands[0].GetThicketPermille())
	}
	return 1000
}

// RegionOverlayNames lists the overlays added by the regions & biomes lane.
var RegionOverlayNames = []string{"regions", "biomes", "blend", "pins"}

// FieldStats summarises a selected lasting world field across a rendered view.
type FieldStats struct {
	Field string  `json:"field"`
	Min   int     `json:"min"`
	Max   int     `json:"max"`
	Mean  float64 `json:"mean"`
}

// TileHover is the fast, pure-seed tile hover payload (region, biome@version,
// blend band status, and lasting world field values) served without spawning a
// chunk-generation worker.
type TileHover struct {
	Tile            [2]int       `json:"tile"`
	Chunk           [2]int       `json:"chunk"`
	Region          string       `json:"region"`
	RegionCoord     [2]int       `json:"regionCoord"`
	Biome           string       `json:"biome"`
	RegionBiome     string       `json:"regionBiome"`
	SecondaryRegion string       `json:"secondaryRegion,omitempty"`
	SecondaryBiome  string       `json:"secondaryBiome,omitempty"`
	BorderDistTiles int          `json:"borderDistTiles"`
	InBlendBand     bool         `json:"inBlendBand"`
	TripleJunction  bool         `json:"tripleJunction,omitempty"`
	Blended         bool         `json:"blended,omitempty"`
	Fields          wilds.Fields `json:"fields"`
}

// InspectHover computes TileHover directly from the lasting world fields and
// region recipes.
func InspectHover(seed string, tx, ty int) TileHover {
	cx, cy := wilds.ChunkOf(tx, ty)
	bs := wilds.BiomeAt(seed, tx, ty, nil)
	f := wilds.FieldsAt(seed, tx, ty)
	out := TileHover{
		Tile:            [2]int{tx, ty},
		Chunk:           [2]int{cx, cy},
		Region:          bs.PrimaryRegion.ID(),
		RegionCoord:     [2]int{bs.PrimaryRegion.RX, bs.PrimaryRegion.RY},
		Biome:           bs.EffectiveRef,
		RegionBiome:     bs.PrimaryRef,
		BorderDistTiles: bs.BorderDistTiles,
		InBlendBand:     bs.InBlendBand,
		TripleJunction:  bs.TripleJunction,
		Blended:         bs.Blended,
		Fields:          f,
	}
	if bs.InBlendBand {
		out.SecondaryRegion = bs.SecondaryRegion.ID()
		out.SecondaryBiome = bs.SecondaryRef
	}
	return out
}

// enrichTileInfo populates region, biome@version, field values, and the
// disposable pin record on a full TileInfo inspection.
func enrichTileInfo(seed string, info *TileInfo) {
	tx, ty := info.Tile[0], info.Tile[1]
	pins := wilds.NewPinManifest(seed)
	if info.Fixed == "" {
		pins.PinChunk(info.Chunk[0], info.Chunk[1])
	}
	bs := wilds.BiomeAt(seed, tx, ty, pins)
	f := wilds.FieldsAt(seed, tx, ty)
	info.Region = bs.PrimaryRegion.ID()
	info.RegionCoord = [2]int{bs.PrimaryRegion.RX, bs.PrimaryRegion.RY}
	info.Biome = bs.EffectiveRef
	info.RegionBiome = bs.PrimaryRef
	info.BorderDistTiles = bs.BorderDistTiles
	info.InBlendBand = bs.InBlendBand
	info.TripleJunction = bs.TripleJunction
	info.Blended = bs.Blended
	info.Fields = &f
	if bs.InBlendBand {
		info.SecondaryRegion = bs.SecondaryRegion.ID()
		info.SecondaryBiome = bs.SecondaryRef
	}
	if pin, ok := pins.Lookup(bs.PrimaryRegion); ok {
		info.Pin = &pin
	}
}

// activeField returns the selected field heatmap name from o.Field or a
// "field:<name>" overlay token, or "" if none is selected.
func activeField(o Options) string {
	if o.Field != "" {
		return o.Field
	}
	for _, s := range strings.Split(o.Overlays, ",") {
		if after, ok := strings.CutPrefix(s, "field:"); ok && wilds.ValidFieldName(after) {
			return after
		}
	}
	return ""
}

// validateFieldOption checks Options.Field and any "field:<name>" overlay.
func validateFieldOption(o Options) error {
	if o.Field != "" && !wilds.ValidFieldName(o.Field) {
		return fmt.Errorf("unknown field %q (want one of %s)", o.Field, strings.Join(wilds.FieldNames, ", "))
	}
	return nil
}

// isKnownOverlay reports whether s is a valid overlay token (including
// "field:<name>" heatmap tokens).
func isKnownOverlay(s string) bool {
	for _, n := range OverlayNames {
		if n == s {
			return true
		}
	}
	if after, ok := strings.CutPrefix(s, "field:"); ok {
		return wilds.ValidFieldName(after)
	}
	return false
}

// regionTracker accumulates biome shares, region counts, blend shares, field
// summary stats, and per-pixel region samples for post-pass overlays.
type regionTracker struct {
	seed       string
	field      string
	unit       int
	width      int
	height     int
	samples    []wilds.TileBiomeSample
	biomeCount map[string]int
	firstDist  map[string]int
	regions    map[wilds.RegionCoord]bool
	blended    int
	inBand     int
	total      int
	fieldMin   int
	fieldMax   int
	fieldSum   int64
	pins       *wilds.PinManifest
}

func newRegionTracker(o Options, width, height, unit int) *regionTracker {
	pins := wilds.NewPinManifest(o.Seed)
	if o.View == "atlas" {
		// In atlas view, glimpses never pin regions (decision 3); pin the
		// home frontier chunks so the manifest and pins overlay show pinned
		// home-adjacent regions versus unpinned outer country.
		x0, y0, x1, y1 := wilds.HomeRect()
		for cy := y0 - 2; cy <= y1+2; cy++ {
			for cx := x0 - 2; cx <= x1+2; cx++ {
				if wilds.FixedFootprintAt(cx, cy) == nil {
					pins.PinChunk(cx, cy)
				}
			}
		}
	}
	return &regionTracker{
		seed:       o.Seed,
		field:      activeField(o),
		unit:       unit,
		width:      width,
		height:     height,
		samples:    make([]wilds.TileBiomeSample, width*height),
		biomeCount: map[string]int{},
		firstDist:  map[string]int{},
		regions:    map[wilds.RegionCoord]bool{},
		fieldMin:   wilds.FieldScale + 1,
		fieldMax:   -1,
		pins:       pins,
	}
}

func chebChunkDist(cx, cy int) int {
	ax, ay := cx, cy
	if ax < 0 {
		ax = -ax
	}
	if ay < 0 {
		ay = -ay
	}
	return max(ax, ay)
}

func (rt *regionTracker) recordSample(idx, cx, cy, tx, ty int, bs wilds.TileBiomeSample) {
	rt.samples[idx] = bs
	rt.biomeCount[bs.EffectiveRef]++
	rt.regions[bs.PrimaryRegion] = true
	if bs.InBlendBand {
		rt.inBand++
	}
	if bs.Blended {
		rt.blended++
	}
	rt.total++
	d := chebChunkDist(cx, cy)
	if prev, ok := rt.firstDist[bs.EffectiveRef]; !ok || d < prev {
		rt.firstDist[bs.EffectiveRef] = d
	}
	if rt.field != "" {
		if v, ok := wilds.FieldAt(rt.seed, rt.field, tx, ty); ok {
			rt.fieldMin = min(rt.fieldMin, v)
			rt.fieldMax = max(rt.fieldMax, v)
			rt.fieldSum += int64(v)
		}
	}
}

// atlasPixelColour computes the base + biome/field colour for an atlas chunk
// glimpse and records its region metrics.
func (rt *regionTracker) atlasPixelColour(o Options, idx int, g wilds.GlimpseOf, S int) color.RGBA {
	tx, ty := g.CX*S+S/2, g.CY*S+S/2
	col, bs := wilds.BiomeAtlasColour(o.Seed, g.CX, g.CY, g.Land, g.River, rt.pins)
	rt.recordSample(idx, g.CX, g.CY, tx, ty, bs)
	if rt.field != "" {
		v, _ := wilds.FieldAt(o.Seed, rt.field, tx, ty)
		col = wilds.FieldHeatmapColour(rt.field, v)
		if g.River {
			col = blend(col, wilds.GroundColour("water"))
		}
	}
	return applyBiomePixelOverlays(o, col, bs)
}

// tilePixelLook resolves a generated tile's biome ground, solidity, and colour.
func (rt *regionTracker) tilePixelLook(o Options, globalIdx, cx, cy, lx, ly, S int, baseGroundID, surface string, baseSolid bool, thicketPermille int) (string, color.RGBA, bool) {
	tx, ty := cx*S+lx, cy*S+ly
	groundID, col, solid, bs := wilds.BiomeTileLook(o.Seed, tx, ty, baseGroundID, baseSolid, surface, thicketPermille, rt.pins)
	if rt.field != "" {
		v, _ := wilds.FieldAt(o.Seed, rt.field, tx, ty)
		col = wilds.FieldHeatmapColour(rt.field, v)
		if solid {
			col = shade(col, 8)
		}
	}
	col = applyBiomePixelOverlays(o, col, bs)
	rt.samples[globalIdx] = bs
	return groundID, col, solid
}

// finalizeStats aggregates biome, region, blend, field, and pin manifest stats
// after all chunks/glimpses have been processed.
func (rt *regionTracker) finalizeStats(o Options, st *Stats, S int) {
	if o.View != "atlas" {
		// Aggregate tile-level metrics in deterministic row-major order.
		cw := o.Rect[2] - o.Rect[0] + 1
		for y := 0; y < rt.height; y++ {
			cy := o.Rect[1] + y/S
			ly := y % S
			for x := 0; x < rt.width; x++ {
				cx := o.Rect[0] + x/S
				if wilds.FixedFootprintAt(cx, cy) != nil {
					continue
				}
				lx := x % S
				idx := y*rt.width + x
				tx, ty := cx*S+lx, cy*S+ly
				_ = cw
				rt.recordSample(idx, cx, cy, tx, ty, rt.samples[idx])
			}
		}
	}
	if rt.total > 0 {
		st.BiomeShare = map[string]float64{}
		for k, v := range rt.biomeCount {
			st.BiomeShare[k] = float64(v) / float64(rt.total)
		}
		st.FirstBiomeChunkDist = rt.firstDist
		st.RegionCount = len(rt.regions)
		bandShare := float64(rt.inBand) / float64(rt.total)
		st.BlendBandShare = &bandShare
		if rt.field != "" && rt.fieldMax >= 0 {
			st.Field = &FieldStats{
				Field: rt.field,
				Min:   rt.fieldMin,
				Max:   rt.fieldMax,
				Mean:  float64(rt.fieldSum) / float64(rt.total),
			}
		}
	}
	if rt.pins != nil {
		rep := rt.pins.Report()
		st.PinManifest = &rep
	}
}

func applyBiomePixelOverlays(o Options, col color.RGBA, bs wilds.TileBiomeSample) color.RGBA {
	if enabled(o, "biomes") {
		own := wilds.BiomeOwnerColour(bs.PrimaryBiome)
		if bs.Blended {
			own = blend(own, wilds.BiomeOwnerColour(bs.EffectiveBiome))
		}
		col = blend(col, own)
	}
	if enabled(o, "blend") {
		switch {
		case bs.TripleJunction:
			col = color.RGBA{250, 75, 220, 255}
		case bs.Blended:
			col = color.RGBA{65, 225, 235, 255}
		case bs.InBlendBand:
			col = blend(col, color.RGBA{250, 195, 45, 255})
		}
	}
	return col
}

// drawRegionOverlays paints vector-style post-pass overlays (region boundaries,
// region site markers, crisp region ID + biome@version labels, and pin badges)
// onto img after all pixels are rendered.
func (rt *regionTracker) drawRegionOverlays(o Options, img *image.RGBA, S int) {
	showRegions := enabled(o, "regions")
	showPins := enabled(o, "pins")
	if !showRegions && !showPins {
		return
	}

	scale := o.Scale
	w, h := rt.width, rt.height

	// 1. Draw warped Voronoi region borders where adjacent units have different
	// PrimaryRegion owners.
	borderCol := color.RGBA{245, 236, 190, 255}
	if showPins && !showRegions {
		borderCol = color.RGBA{120, 210, 235, 255}
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			cur := rt.samples[y*w+x].PrimaryRegion
			edge := false
			if x+1 < w && rt.samples[y*w+x+1].PrimaryRegion != cur {
				edge = true
			}
			if y+1 < h && rt.samples[(y+1)*w+x].PrimaryRegion != cur {
				edge = true
			}
			if edge {
				block(img, x*scale, y*scale, max(1, scale/2), borderCol)
			}
		}
	}

	// 2. Collect each visible region's pixel centroid so labels stay inside the
	// image even if the region's site lies near or outside the cropped rect.
	type accum struct {
		sumX, sumY, count int
		biomeRef          string
	}
	centroids := map[wilds.RegionCoord]*accum{}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			bs := rt.samples[y*w+x]
			ac, ok := centroids[bs.PrimaryRegion]
			if !ok {
				ac = &accum{biomeRef: bs.PrimaryRef}
				centroids[bs.PrimaryRegion] = ac
			}
			ac.sumX += x * scale
			ac.sumY += y * scale
			ac.count++
		}
	}

	// Convert a world tile (tx, ty) to image pixel coordinates.
	tileToPx := func(tx, ty int) (int, int) {
		if o.View == "atlas" {
			cx, cy := wilds.ChunkOf(tx, ty)
			return (cx - o.Rect[0]) * scale, (cy - o.Rect[1]) * scale
		}
		return (tx - o.Rect[0]*S) * scale, (ty - o.Rect[1]*S) * scale
	}
	inBoundsPx := func(px, py, margin int) bool {
		b := img.Bounds()
		return px >= margin && py >= margin && px < b.Dx()-margin && py < b.Dy()-margin
	}

	// Sort region keys for deterministic drawing.
	var coords []wilds.RegionCoord
	for rc := range centroids {
		coords = append(coords, rc)
	}
	for i := 0; i < len(coords); i++ {
		for j := i + 1; j < len(coords); j++ {
			if coords[j].Less(coords[i]) {
				coords[i], coords[j] = coords[j], coords[i]
			}
		}
	}

	for _, rc := range coords {
		ac := centroids[rc]
		if ac.count < 16 {
			continue
		}
		st := wilds.RegionSiteAt(o.Seed, rc.RX, rc.RY)
		sxPx, syPx := tileToPx(st.SX, st.SY)
		if inBoundsPx(sxPx, syPx, 3) {
			cross(img, sxPx, syPx, 3, color.RGBA{255, 230, 80, 255})
		}

		labelX, labelY := sxPx+5, syPx-6
		if !inBoundsPx(labelX, labelY, 28) {
			labelX = ac.sumX/ac.count - 18
			labelY = ac.sumY/ac.count - 5
		}

		shortBiome := shortBiomeTag(ac.biomeRef)
		if showRegions {
			label := fmt.Sprintf("%s %s", rc.ID(), shortBiome)
			drawPixelLabel(img, labelX, labelY, label, color.RGBA{255, 248, 214, 255})
		}
		if showPins && rt.pins != nil {
			if pin, ok := rt.pins.Lookup(rc); ok {
				pinCol := color.RGBA{255, 215, 55, 255}
				kindTag := "PIN"
				if pin.Support {
					pinCol = color.RGBA{90, 230, 250, 255}
					kindTag = "SUP"
				}
				if inBoundsPx(sxPx, syPx, 4) {
					drawDiamond(img, sxPx, syPx, 4, pinCol)
				}
				py := labelY
				if showRegions {
					py += 8
				}
				pinText := fmt.Sprintf("%s %s %s", kindTag, rc.ID(), shortBiome)
				drawPixelLabel(img, labelX, py, pinText, pinCol)
			}
		}
	}
}

func shortBiomeTag(ref string) string {
	switch {
	case strings.HasPrefix(ref, wilds.BiomeHearthwickWoods):
		return "hw@1"
	case strings.HasPrefix(ref, wilds.BiomeWhitequiet):
		return "wq@1"
	default:
		return ref
	}
}

func drawDiamond(img *image.RGBA, cx, cy, r int, col color.RGBA) {
	b := img.Bounds()
	for dy := -r; dy <= r; dy++ {
		for dx := -r; dx <= r; dx++ {
			adx, ady := dx, dy
			if adx < 0 {
				adx = -adx
			}
			if ady < 0 {
				ady = -ady
			}
			if adx+ady <= r {
				px, py := cx+dx, cy+dy
				if px >= b.Min.X && px < b.Max.X && py >= b.Min.Y && py < b.Max.Y {
					if adx+ady == r {
						img.SetRGBA(px, py, color.RGBA{20, 22, 28, 255})
					} else {
						img.SetRGBA(px, py, col)
					}
				}
			}
		}
	}
}

// Compact 3×5 bitmap font for legible labels on PNG renders.
var glyph3x5 = map[byte][5]uint8{
	'0': {0b111, 0b101, 0b101, 0b101, 0b111},
	'1': {0b010, 0b110, 0b010, 0b010, 0b111},
	'2': {0b111, 0b001, 0b111, 0b100, 0b111},
	'3': {0b111, 0b001, 0b111, 0b001, 0b111},
	'4': {0b101, 0b101, 0b111, 0b001, 0b001},
	'5': {0b111, 0b100, 0b111, 0b001, 0b111},
	'6': {0b111, 0b100, 0b111, 0b101, 0b111},
	'7': {0b111, 0b001, 0b010, 0b010, 0b010},
	'8': {0b111, 0b101, 0b111, 0b101, 0b111},
	'9': {0b111, 0b101, 0b111, 0b001, 0b111},
	'-': {0b000, 0b000, 0b111, 0b000, 0b000},
	':': {0b000, 0b010, 0b000, 0b010, 0b000},
	'@': {0b111, 0b101, 0b111, 0b100, 0b111},
	'r': {0b000, 0b111, 0b100, 0b100, 0b100},
	'h': {0b100, 0b100, 0b111, 0b101, 0b101},
	'w': {0b000, 0b101, 0b101, 0b111, 0b101},
	'q': {0b000, 0b111, 0b101, 0b111, 0b001},
	't': {0b010, 0b111, 0b010, 0b010, 0b011},
	'o': {0b000, 0b111, 0b101, 0b101, 0b111},
	'p': {0b000, 0b111, 0b101, 0b111, 0b100},
	's': {0b000, 0b111, 0b100, 0b001, 0b111},
	'P': {0b111, 0b101, 0b111, 0b100, 0b100},
	'I': {0b111, 0b010, 0b010, 0b010, 0b111},
	'N': {0b101, 0b111, 0b111, 0b101, 0b101},
	'S': {0b111, 0b100, 0b111, 0b001, 0b111},
	'U': {0b101, 0b101, 0b101, 0b101, 0b111},
}

func drawPixelLabel(img *image.RGBA, x, y int, text string, fg color.RGBA) {
	b := img.Bounds()
	w := len(text)*4 + 1
	h := 7
	bg := color.RGBA{18, 20, 26, 230}
	for py := y - 1; py < y+h-1; py++ {
		for px := x - 1; px < x+w; px++ {
			if px >= b.Min.X && px < b.Max.X && py >= b.Min.Y && py < b.Max.Y {
				img.SetRGBA(px, py, bg)
			}
		}
	}
	cx := x
	for i := 0; i < len(text); i++ {
		ch := text[i]
		if rows, ok := glyph3x5[ch]; ok {
			for ry := 0; ry < 5; ry++ {
				row := rows[ry]
				for rx := 0; rx < 3; rx++ {
					if (row>>(2-rx))&1 == 1 {
						px, py := cx+rx, y+ry
						if px >= b.Min.X && px < b.Max.X && py >= b.Min.Y && py < b.Max.Y {
							img.SetRGBA(px, py, fg)
						}
					}
				}
			}
		}
		cx += 4
	}
}
