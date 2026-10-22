package worldlab

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"time"

	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/proto"
)

type SlopeRangeMetrics struct {
	wilds.SlopeRange
	PassSteps       int      `json:"passSteps"`
	EndSteps        int      `json:"endSteps"`
	ExtraSteps      int      `json:"extraSteps"`
	PassMaxGradient float64  `json:"passMaxRisePerTile"`
	Pass            [][2]int `json:"-"`
	End             [][2]int `json:"-"`
	PassWaypoints   [][2]int `json:"passWaypoints"`
	EndWaypoints    [][2]int `json:"endWaypoints"`
}
type SlopeTunnel struct {
	Range        string `json:"range"`
	North        [2]int `json:"north"`
	South        [2]int `json:"south"`
	Length       int    `json:"lengthTiles"`
	BlockedTiles int    `json:"blockedTiles"`
}
type SlopeBudget struct {
	Chunk            [2]int              `json:"chunk"`
	Samples          int                 `json:"samples"`
	WarmMS           TerrainDistribution `json:"generationAndEncodeMs"`
	HeightBytes      int                 `json:"heightBytes"`
	BareWholeBytes   int                 `json:"bareWholeBytes"`
	DressingHeadroom int                 `json:"dressingHeadroomBytes"`
}
type SlopeMetrics struct {
	Recipe         string                        `json:"recipe"`
	Domain         [4]int                        `json:"domainTiles"`
	HeightRange    [2]float64                    `json:"heightRangeLevels"`
	MaxRise        float64                       `json:"maxWalkableRisePerTile"`
	Certificate    wilds.SlopeCertificate        `json:"certificate"`
	Kinds          map[string]int                `json:"kindTiles"`
	BiomeKinds     map[string]map[string]float64 `json:"kindShareByBiome"`
	Ranges         []SlopeRangeMetrics           `json:"ranges"`
	Tunnels        []SlopeTunnel                 `json:"tunnelCandidates"`
	Budgets        map[string]SlopeBudget        `json:"budgets"`
	AllHeightBytes TerrainDistribution           `json:"allChunkHeightBytes"`
	AllWholeBytes  TerrainDistribution           `json:"allBareWholeChunkBytes"`
	GeometrySHA256 string                        `json:"geometrySHA256"`
	ColdMS         float64                       `json:"coldFieldMs"`
	Note           string                        `json:"note"`
}

func slopeChunk(p *wilds.SlopePlan, cx, cy int) []wilds.SlopeTile {
	t := make([]wilds.SlopeTile, 576)
	for y := 0; y < 24; y++ {
		i := p.Index(cx*24, cy*24+y)
		copy(t[y*24:(y+1)*24], p.Tiles[i:i+24])
	}
	return t
}
func slopeBareBytes(tiles []wilds.SlopeTile, cx, cy int, raw []byte) int {
	c := wilds.Chunk{CX: cx, CY: cy, Size: 24, GeneratorVersion: 3, Ground: make([]wilds.Ground, 576), Solid: make([]bool, 576), Land: "slopes-lab"}
	for i, t := range tiles {
		c.Solid[i] = t.Kind != wilds.SlopeGround
	}
	return proto.Size(wilds.ToProto(c, DefaultEpoch)) + len(raw) + 4
}
func slopeMeasure(ctx context.Context, seed string) (*wilds.SlopePlan, *SlopeMetrics, error) {
	start := time.Now()
	p, err := wilds.NewSlopePlan(ctx, seed, -576, -576, 1152, 1152)
	if err != nil {
		return nil, nil, err
	}
	m := &SlopeMetrics{Recipe: wilds.SlopeRecipe, Domain: [4]int{-576, -576, 575, 575}, ColdMS: float64(time.Since(start).Nanoseconds()) / 1e6, Kinds: map[string]int{}, BiomeKinds: map[string]map[string]float64{}, Budgets: map[string]SlopeBudget{}, HeightRange: [2]float64{1000, 0}, Note: "Finite home-rooted height certificate over all 48x48 chunks, never crop edges. 10x4 px hero fits cardinal tile-centre routes; mounts, cover, water and kept-land migration are outside this experiment. Bare bytes = undressed WorldChunk protobuf plus length-framed lab envelope, not a dressed protocol claim. Warm timing constructs a fresh bounded sampler and encodes; decode/checks excluded. Four-bit coarse corner range is 0..15 plus 8 fractional bits; heights are never clamped."}
	m.Certificate = p.Certificate(12, 30)
	if m.Certificate.StrandedTiles > 0 {
		return nil, nil, fmt.Errorf("slope certificate: %d unintended stranded tiles", m.Certificate.StrandedTiles)
	}
	for _, r := range p.Ranges {
		a, b := [2]int{r.PassX, r.Y - 104}, [2]int{r.PassX, r.Y + 104}
		pass := p.Route(a, b, func(x, y int) bool { return x < r.PassX-1 || x > r.PassX+1 })
		// Close only the saddle neck (its 64-tile notch support and the
		// bent crest's full width), then measure the actual walking graph.
		// Forcing a detour outside the whole nominal range would inflate it.
		end := p.Route(a, b, func(x, y int) bool { return absInt(x-r.PassX) < 64 && absInt(y-r.Y) < 24 })
		if len(pass) == 0 || len(end) == 0 {
			return nil, nil, fmt.Errorf("range %s has no pass or end detour", r.ID)
		}
		rm := SlopeRangeMetrics{SlopeRange: r, PassSteps: len(pass) - 1, EndSteps: len(end) - 1, ExtraSteps: len(end) - len(pass), Pass: pass, End: end}
		rm.PassWaypoints = slopeRouteWaypoints(pass)
		rm.EndWaypoints = slopeRouteWaypoints(end)
		for _, pt := range pass {
			g := math.Sqrt(float64(wilds.SlopeGradientSquared(p.Tiles[p.Index(pt[0], pt[1])].Corners))) / 256
			rm.PassMaxGradient = math.Max(rm.PassMaxGradient, g)
		}
		m.Ranges = append(m.Ranges, rm)
		// A short upper shoulder; endpoints must already reach home, while
		// the cut itself crosses rock. This is metadata only, never a tunnel.
		x := r.PassX + 86
		y := r.Y + int(math.Round(9*math.Sin(float64(x-r.X)/87)))
		tc := SlopeTunnel{Range: r.ID, North: [2]int{x, y - 24}, South: [2]int{x, y + 24}, Length: 48}
		for yy := y - 24; yy <= y+24; yy++ {
			if p.Tiles[p.Index(x, yy)].Kind != wilds.SlopeGround {
				tc.BlockedTiles++
			}
		}
		if tc.BlockedTiles > 0 && m.Certificate.Labels[p.Index(x, y-24)] == m.Certificate.Home && m.Certificate.Labels[p.Index(x, y+24)] == m.Certificate.Home {
			m.Tunnels = append(m.Tunnels, tc)
		}
	}
	biomeCounts := map[string]map[string]int{}
	totals := map[string]int{}
	hash := sha256.New()
	sizes := []float64{}
	wholeSizes := []float64{}
	for cy := -24; cy < 24; cy++ {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		for cx := -24; cx < 24; cx++ {
			tiles := slopeChunk(p, cx, cy)
			raw, err := wilds.EncodeSlopeChunk(tiles)
			if err != nil {
				return nil, nil, err
			}
			decoded, err := wilds.DecodeSlopeChunk(raw)
			if err != nil {
				return nil, nil, err
			}
			for i, t := range tiles {
				if t != decoded[i] {
					return nil, nil, fmt.Errorf("codec changed geometry")
				}
			}
			hash.Write(raw)
			sizes = append(sizes, float64(len(raw)))
			wholeSizes = append(wholeSizes, float64(slopeBareBytes(tiles, cx, cy, raw)))
			for yy := 0; yy < 24; yy++ {
				for xx := 0; xx < 24; xx++ {
					biome := wilds.BiomeAt(seed, cx*24+xx, cy*24+yy, nil).EffectiveBiome
					if biomeCounts[biome] == nil {
						biomeCounts[biome] = map[string]int{}
					}
					t := tiles[yy*24+xx]
					k := t.Kind.String()
					m.Kinds[k]++
					biomeCounts[biome][k]++
					totals[biome]++
					for _, q := range t.Corners {
						z := float64(q) / 256
						m.HeightRange[0] = math.Min(m.HeightRange[0], z)
						m.HeightRange[1] = math.Max(m.HeightRange[1], z)
					}
					if t.Kind == wilds.SlopeGround {
						m.MaxRise = math.Max(m.MaxRise, math.Sqrt(float64(wilds.SlopeGradientSquared(t.Corners)))/256)
					}
				}
			}
		}
	}
	for biome, counts := range biomeCounts {
		m.BiomeKinds[biome] = map[string]float64{}
		for _, kind := range []string{"slope", "steep", "crag", "cliff"} {
			m.BiomeKinds[biome][kind] = float64(counts[kind]) / float64(totals[biome])
		}
	}
	m.AllHeightBytes = terrainDistribution(sizes)
	m.AllWholeBytes = terrainDistribution(wholeSizes)
	m.GeometrySHA256 = hex.EncodeToString(hash.Sum(nil))
	r := p.Ranges[3]
	fixtures := map[string][2]int{"flat": {0, 1}, "hills": {6, 2}, "mountainside": {floorSlope(r.X+90, 24), floorSlope(r.Y+12, 24)}, "spire": {floorSlope(r.Spire[0], 24), floorSlope(r.Spire[1], 24)}}
	for name, xy := range fixtures {
		var times []float64
		var raw []byte
		var tiles []wilds.SlopeTile
		for i := 0; i < 81; i++ {
			at := time.Now()
			s := wilds.NewSlopeSampler(seed)
			tiles = make([]wilds.SlopeTile, 576)
			for y := 0; y < 24; y++ {
				for x := 0; x < 24; x++ {
					tiles[y*24+x] = s.Tile(xy[0]*24+x, xy[1]*24+y)
				}
			}
			var err error
			raw, err = wilds.EncodeSlopeChunk(tiles)
			if err != nil {
				return nil, nil, err
			}
			if i > 0 {
				times = append(times, float64(time.Since(at).Nanoseconds())/1e6)
			}
		}
		whole := slopeBareBytes(tiles, xy[0], xy[1], raw)
		m.Budgets[name] = SlopeBudget{Chunk: xy, Samples: 80, WarmMS: terrainDistribution(times), HeightBytes: len(raw), BareWholeBytes: whole, DressingHeadroom: 6144 - whole}
	}
	return p, m, nil
}
func absInt(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
func floorSlope(x, d int) int {
	q := x / d
	if x%d < 0 {
		q--
	}
	return q
}

// Preserve exact cardinal routes compactly: each consecutive waypoint pair is
// a straight run on the certified graph, with no diagonal shortcut at bends.
func slopeRouteWaypoints(route [][2]int) [][2]int {
	if len(route) < 3 {
		return route
	}
	out := [][2]int{route[0]}
	for i := 1; i < len(route)-1; i++ {
		a, b, c := route[i-1], route[i], route[i+1]
		if b[0]-a[0] != c[0]-b[0] || b[1]-a[1] != c[1]-b[1] {
			out = append(out, b)
		}
	}
	return append(out, route[len(route)-1])
}

var slopeColours = [4]color.RGBA{{116, 168, 100, 255}, {190, 137, 75, 255}, {113, 97, 119, 255}, {46, 40, 53, 255}}

func slopeHeightColour(t wilds.SlopeTile) color.RGBA {
	z := float64(t.Corners[0]+t.Corners[1]+t.Corners[2]+t.Corners[3]) / 1024
	stops := []struct {
		z float64
		c color.RGBA
	}{{0, color.RGBA{66, 111, 76, 255}}, {2, color.RGBA{126, 157, 96, 255}}, {5, color.RGBA{184, 158, 103, 255}}, {10, color.RGBA{181, 178, 167, 255}}, {15, color.RGBA{247, 241, 221, 255}}}
	base := stops[len(stops)-1].c
	for i := 1; i < len(stops); i++ {
		if z <= stops[i].z {
			a, b := stops[i-1], stops[i]
			v := (z - a.z) / (b.z - a.z)
			mix := func(x, y uint8) uint8 { return uint8(float64(x)*(1-v) + float64(y)*v) }
			base = color.RGBA{mix(a.c.R, b.c.R), mix(a.c.G, b.c.G), mix(a.c.B, b.c.B), 255}
			break
		}
	}
	dx := (float64(t.Corners[1]) + float64(t.Corners[2]) - float64(t.Corners[0]) - float64(t.Corners[3])) / 512
	dy := (float64(t.Corners[3]) + float64(t.Corners[2]) - float64(t.Corners[0]) - float64(t.Corners[1])) / 512
	light := (1 + dx*0.6 + dy*0.7) / math.Sqrt(1+dx*dx+dy*dy)
	light = math.Max(0.35, math.Min(1.2, light))
	return color.RGBA{uint8(math.Min(255, float64(base.R)*light)), uint8(math.Min(255, float64(base.G)*light)), uint8(math.Min(255, float64(base.B)*light)), 255}
}
func renderSlopes(ctx context.Context, o Options) (Result, error) {
	start := time.Now()
	p, m, err := slopeMeasure(ctx, o.Seed)
	if err != nil {
		return Result{}, err
	}
	step := 1
	if o.View == "atlas" {
		step = 24
	}
	w, h := (o.Rect[2]-o.Rect[0]+1)*24/step, (o.Rect[3]-o.Rect[1]+1)*24/step
	img := image.NewRGBA(image.Rect(0, 0, w*o.Scale, h*o.Scale))
	res := Result{Width: w, Height: h, Scale: o.Scale}
	for yy := 0; yy < h; yy++ {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		for xx := 0; xx < w; xx++ {
			x, y := o.Rect[0]*24+xx*step+step/2, o.Rect[1]*24+yy*step+step/2
			i := p.Index(x, y)
			t := p.Tiles[i]
			col := slopeHeightColour(t)
			if o.Slopes == "kinds" {
				col = slopeColours[t.Kind]
			}
			if o.Slopes == "reach" {
				col = slopeColours[t.Kind]
				if t.Unreachable {
					col = color.RGBA{159, 102, 220, 255}
				}
				if t.Kind == wilds.SlopeGround {
					col = color.RGBA{63, 164, 107, 255}
					if m.Certificate.Labels[i] != m.Certificate.Home {
						col = color.RGBA{240, 35, 152, 255}
						if t.Unreachable {
							col = color.RGBA{195, 152, 255, 255}
						}
					}
				}
			}
			block(img, xx*o.Scale, yy*o.Scale, o.Scale, col)
		}
	}
	point := func(pt [2]int, col color.RGBA, radius int) {
		x, y := (pt[0]-o.Rect[0]*24)*o.Scale/step, (pt[1]-o.Rect[1]*24)*o.Scale/step
		for dy := -radius; dy <= radius; dy++ {
			for dx := -radius; dx <= radius; dx++ {
				img.SetRGBA(x+dx, y+dy, col)
			}
		}
	}
	if o.Slopes == "routes" {
		for _, r := range m.Ranges {
			for _, pt := range r.End {
				point(pt, color.RGBA{65, 219, 245, 255}, 1)
			}
			for _, pt := range r.Pass {
				point(pt, color.RGBA{255, 228, 65, 255}, 1)
			}
		}
	}
	if o.Slopes == "tunnels" {
		for _, t := range m.Tunnels {
			for y := t.North[1]; y <= t.South[1]; y++ {
				point([2]int{t.North[0], y}, color.RGBA{245, 100, 224, 255}, 1)
			}
			point(t.North, color.RGBA{255, 255, 255, 255}, 3)
			point(t.South, color.RGBA{255, 255, 255, 255}, 3)
		}
	}
	for _, r := range m.Ranges {
		point([2]int{r.PassX, r.Y}, color.RGBA{255, 225, 70, 255}, 3)
		point(r.Spire, color.RGBA{209, 163, 255, 255}, 3)
	}
	point([2]int{12, 30}, color.RGBA{255, 255, 255, 255}, 4)
	labels := map[string]string{"height": "HEIGHT 0-15 / HILLSHADE", "kinds": "SLOPE GREEN / STEEP OCHRE / CRAG PURPLE / CLIFF DARK", "routes": "PASS GOLD / END DETOUR CYAN", "reach": "HOME GREEN / STRANDED PINK / INTENTIONAL PURPLE", "tunnels": "TUNNEL CANDIDATES PINK / ENTRANCES WHITE"}
	// Place a dark legend directly in each exported image.
	for y := 0; y < 19 && y < img.Bounds().Dy(); y++ {
		for x := 0; x < min(img.Bounds().Dx(), len(labels[o.Slopes])*4+12); x++ {
			img.SetRGBA(x, y, color.RGBA{24, 29, 35, 255})
		}
	}
	drawSlopeLabel(img, 6, 5, labels[o.Slopes], color.RGBA{244, 242, 232, 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return Result{}, err
	}
	res.PNG = buf.Bytes()
	u := m.Certificate.StrandedTiles
	res.Stats = Stats{Slopes: m, View: o.View, Seed: o.Seed, Epoch: o.Epoch, Rect: o.Rect, ChunkSize: 24, Chunks: 2304, Generated: 2304, LandShare: map[string]float64{}, Unreachable: &u, Milliseconds: float64(time.Since(start).Nanoseconds()) / 1e6, Note: labels[o.Slopes] + ". Biome shares count every tile's effective biome. " + m.Note}
	return res, nil
}

// The region-label font only contains letters needed for short region IDs.
// Complete the uppercase alphabet locally for exported diagnostic legends.
func drawSlopeLabel(img *image.RGBA, x, y int, text string, fg color.RGBA) {
	letters := map[byte][5]uint8{
		'A': {2, 5, 7, 5, 5}, 'B': {6, 5, 6, 5, 6}, 'C': {3, 4, 4, 4, 3}, 'D': {6, 5, 5, 5, 6},
		'E': {7, 4, 6, 4, 7}, 'F': {7, 4, 6, 4, 4}, 'G': {3, 4, 5, 5, 3}, 'H': {5, 5, 7, 5, 5},
		'J': {1, 1, 1, 5, 2}, 'K': {5, 5, 6, 5, 5}, 'L': {4, 4, 4, 4, 7}, 'M': {5, 7, 7, 5, 5},
		'O': {2, 5, 5, 5, 2}, 'Q': {2, 5, 5, 3, 1}, 'R': {6, 5, 6, 5, 5}, 'T': {7, 2, 2, 2, 2},
		'V': {5, 5, 5, 5, 2}, 'W': {5, 5, 7, 7, 5}, 'X': {5, 5, 2, 5, 5}, 'Y': {5, 5, 2, 2, 2}, 'Z': {7, 1, 2, 4, 7}, '/': {1, 1, 2, 4, 4},
	}
	for i := 0; i < len(text); i++ {
		rows, ok := letters[text[i]]
		if !ok {
			rows = glyph3x5[text[i]]
		}
		for dy, row := range rows {
			for dx := 0; dx < 3; dx++ {
				if row&(1<<(2-dx)) != 0 {
					img.SetRGBA(x+i*4+dx, y+dy, fg)
				}
			}
		}
	}
}
