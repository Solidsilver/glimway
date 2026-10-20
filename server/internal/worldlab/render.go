package worldlab

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"sync"
	"time"

	"glimway/content"
	"glimway/server/internal/wilds"
)

type Stats struct {
	Content         string             `json:"content"`
	ContentSHA256   string             `json:"contentSHA256"`
	View            string             `json:"view"`
	Seed            string             `json:"seed"`
	Epoch           string             `json:"epoch"`
	Rect            [4]int             `json:"rect"`
	ChunkSize       int                `json:"chunkSize"`
	Chunks          int                `json:"chunks"`
	Generated       int                `json:"generatedChunks"`
	Fixed           int                `json:"fixedChunks"`
	LandShare       map[string]float64 `json:"landShareByChunkCentre"`
	GroundShare     map[string]float64 `json:"groundShare,omitempty"`
	SolidShare      *float64           `json:"solidShare,omitempty"`
	CampsPer100     *float64           `json:"campsPer100Chunks,omitempty"`
	PlacesPer100    *float64           `json:"placesPer100Chunks,omitempty"`
	LongestLandRun  int                `json:"longestAxialLandRunChunks"`
	Unreachable     *int               `json:"unreachableWalkableTiles,omitempty"`
	ReachDefinition string             `json:"reachDefinition,omitempty"`
	Milliseconds    float64            `json:"generationMs"`
	Note            string             `json:"note"`
}

type marker struct {
	x, y   int
	colour color.RGBA
}

type made struct {
	index int
	chunk wilds.Chunk
	err   error
}

func epoch(o Options, cx, cy int) wilds.Epoch {
	if wilds.EpochKindAt(cx, cy) == wilds.EpochStill {
		return wilds.StillEpoch(o.Seed)
	}
	return wilds.WickEpoch(o.Seed, o.Epoch)
}

// Render draws one view of the generator in this process, with the rules
// content.WildsRules holds now (a worker's, after ConfigureForTools, or the
// embedded ones). Use Spawn to render in a fresh worker process.
func Render(ctx context.Context, o Options) (Result, error) {
	started := time.Now()
	S := int(content.WildsRules.GetChunkSize())
	cw, ch := o.Rect[2]-o.Rect[0]+1, o.Rect[3]-o.Rect[1]+1
	coords := make([][2]int, 0, cw*ch)
	for y := o.Rect[1]; y <= o.Rect[3]; y++ {
		for x := o.Rect[0]; x <= o.Rect[2]; x++ {
			coords = append(coords, [2]int{x, y})
		}
	}
	// Land and river are lasting geography, so a wick glimpse is also the
	// correct centre-land sample for still footprints.
	glimpses := wilds.Glimpses(wilds.WickEpoch(o.Seed, o.Epoch), coords)
	st := Stats{View: o.View, Seed: o.Seed, Epoch: o.Epoch, Rect: o.Rect, ChunkSize: S, Chunks: len(coords), LandShare: map[string]float64{}, Note: "Land shares and axial runs sample chunk centres. Rectangles include both endpoints."}
	source := o.Raw
	if len(source) == 0 {
		source, _ = content.FS.ReadFile("wilds.json")
	}
	digest := sha256.Sum256(source)
	st.Content = o.Content
	if st.Content == "" {
		st.Content = "embedded"
		if len(o.Raw) > 0 {
			st.Content = "edited"
		}
	}
	st.ContentSHA256 = hex.EncodeToString(digest[:])
	landCounts := map[string]int{}
	lands := make([]string, len(coords))
	for i, g := range glimpses {
		lands[i] = g.Land
		landCounts[g.Land]++
	}
	for k, v := range landCounts {
		st.LandShare[k] = float64(v) / float64(len(coords))
	}
	st.LongestLandRun = longestRun(lands, cw, ch)
	unit := 1
	if o.View != "atlas" {
		unit = S
	}
	width, height := cw*unit, ch*unit
	img := image.NewRGBA(image.Rect(0, 0, width*o.Scale, height*o.Scale))
	res := Result{Width: width, Height: height, Scale: o.Scale}
	if o.Signatures {
		res.Signatures = make([]uint64, width*height)
	}
	var road []bool
	if enabled(o, "road") {
		road = wilds.RoadCrossings(wilds.WickEpoch(o.Seed, o.Epoch), coords)
	}
	if o.View == "atlas" {
		for i, g := range glimpses {
			c := landColour(g.Land)
			if g.River {
				c = blend(c, wilds.GroundColour("water"))
			}
			c = overlayColour(o, c, g.CX, g.CY, 0, 0, unit, g.River, road != nil && road[i], 0)
			block(img, (i%cw)*o.Scale, (i/cw)*o.Scale, o.Scale, c)
			if o.Signatures {
				res.Signatures[i] = uint64(wilds.Hash("glimpse", g.Land, boolInt(g.River)))
			}
		}
		st.Note += " Atlas never generates chunks; tile, camp, solid and reach metrics are unavailable. Blue tint marks chunks crossed by the Wend."
	} else {
		walk := make([]bool, width*height)
		valid := make([]bool, width*height)
		groundCounts := map[string]int{}
		var markers []marker
		var anchors []int
		tiles, solid, camps, places := 0, 0, 0, 0
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		jobs := make(chan int)
		results := make(chan made, o.Workers)
		var wg sync.WaitGroup
		for range o.Workers {
			wg.Go(func() {
				for i := range jobs {
					p := coords[i]
					c, err := wilds.GenerateV3(epoch(o, p[0], p[1]), p[0], p[1], nil)
					select {
					case results <- made{i, c, err}:
					case <-ctx.Done():
						return
					}
				}
			})
		}
		go func() {
			defer close(jobs)
			for i, p := range coords {
				if wilds.FixedFootprintAt(p[0], p[1]) != nil {
					continue
				}
				select {
				case jobs <- i:
				case <-ctx.Done():
					return
				}
			}
		}()
		go func() { wg.Wait(); close(results) }()
		for i, p := range coords {
			if wilds.FixedFootprintAt(p[0], p[1]) != nil {
				st.Fixed++
				if o.View == "chunk" {
					cancel()
					return res, fmt.Errorf("chunk %d,%d is authored fixed ground, not generated wilderness", p[0], p[1])
				}
				for y := 0; y < S; y++ {
					for x := 0; x < S; x++ {
						c := color.RGBA{75, 75, 82, 255}
						if (x+y)%6 < 2 {
							c = color.RGBA{100, 100, 110, 255}
						}
						block(img, ((i%cw)*S+x)*o.Scale, ((i/cw)*S+y)*o.Scale, o.Scale, c)
						if o.Signatures {
							res.Signatures[((i/cw)*S+y)*width+(i%cw)*S+x] = uint64(wilds.Hash("fixed", p[0], p[1]))
						}
					}
				}
			}
		}
		for m := range results {
			if m.err != nil {
				cancel()
				return res, m.err
			}
			c := m.chunk
			st.Generated++
			places += len(c.Places)
			ox, oy := (m.index%cw)*S, (m.index/cw)*S
			density := solidPermille(c)
			for i, g := range c.Ground {
				id := content.WildsRules.Grounds[int(g)].GetId()
				groundCounts[id]++
				tiles++
				x, y := i%S, i/S
				global := (oy+y)*width + ox + x
				valid[global] = true
				walk[global] = !c.Solid[i]
				col := wilds.GroundColour(id)
				if c.Solid[i] {
					solid++
					col = shade(col, 6)
				}
				if enabled(o, "solid") {
					if c.Solid[i] {
						col = color.RGBA{224, 56, 85, 255}
					} else {
						col = shade(col, 4)
					}
				}
				surface := content.WildsRules.Grounds[int(g)].GetSurface()
				col = overlayColour(o, col, c.CX, c.CY, x, y, S, surface == "water" || surface == "ford", surface == "road", density)
				block(img, (ox+x)*o.Scale, (oy+y)*o.Scale, o.Scale, col)
				if o.Signatures {
					res.Signatures[global] = uint64(wilds.Hash("tile", id, boolInt(c.Solid[i])))
				}
			}
			mark := func(x, y int, col color.RGBA) {
				markers = append(markers, marker{ox + x, oy + y, col})
				anchors = append(anchors, (oy+y)*width+ox+x)
			}
			signature := func(x, y int, kind string, value any) {
				if o.Signatures {
					raw, _ := json.Marshal(value)
					k := (oy+y)*width + ox + x
					res.Signatures[k] ^= uint64(wilds.Hash(kind, string(raw))) << 32
				}
			}
			for _, d := range c.Decor {
				signature(d.TX, d.TY, "decor", d)
			}
			for _, e := range c.Entities {
				if e.Kind == "camp" {
					camps++
				}
				mark(e.TX, e.TY, color.RGBA{240, 240, 240, 255})
				signature(e.TX, e.TY, "entity", e)
			}
			for _, s := range c.Sites {
				col := color.RGBA{220, 60, 220, 255}
				if s.Kind == wilds.SiteLampStone {
					col = color.RGBA{250, 220, 40, 255}
				}
				if s.Kind == wilds.SiteRumour {
					col = color.RGBA{250, 120, 20, 255}
				}
				mark(s.TX, s.TY, col)
				signature(s.TX, s.TY, "site", s)
			}
			for _, p := range c.Places {
				mark(p.TX, p.TY, color.RGBA{230, 30, 30, 255})
				signature(p.TX, p.TY, "place", p)
			}
		}
		if err := ctx.Err(); err != nil {
			return res, err
		}
		st.GroundShare = map[string]float64{}
		if tiles > 0 {
			for k, v := range groundCounts {
				st.GroundShare[k] = float64(v) / float64(tiles)
			}
			share := float64(solid) / float64(tiles)
			st.SolidShare = &share
		}
		if st.Generated > 0 {
			a, b := float64(camps)*100/float64(st.Generated), float64(places)*100/float64(st.Generated)
			st.CampsPer100 = &a
			st.PlacesPer100 = &b
		}
		unreachable := reach(img, walk, valid, width, height, o.Scale, enabled(o, "reach") || o.View == "chunk", anchors...)
		for _, m := range markers {
			block(img, m.x*o.Scale, m.y*o.Scale, o.Scale, m.colour)
		}
		st.Unreachable = &unreachable
		st.ReachDefinition = "4-neighbour walkable components with no tile on the render boundary or beside omitted fixed ground; cropped paths leaving the view are treated as reachable. Cyan walkability-tree paths link boundary samples and markers; orange = isolated."
		st.Note += " Fixed authored chunks are grey hatching and excluded from tile/camp/place metrics. Entities white; sites magenta; lamp stones yellow; rumours orange; places red."
	}
	if enabled(o, "rumours") {
		if r, ok := wilds.Rumour(wilds.WickEpoch(o.Seed, o.Epoch)); ok {
			cx, cy := r.Place.CX, r.Place.CY
			if cx >= o.Rect[0] && cx <= o.Rect[2] && cy >= o.Rect[1] && cy <= o.Rect[3] {
				x, y := (cx-o.Rect[0])*unit, (cy-o.Rect[1])*unit
				if unit > 1 {
					x += r.SiteTX
					y += r.SiteTY
				}
				cross(img, x*o.Scale, y*o.Scale, max(2, o.Scale), color.RGBA{255, 115, 10, 255})
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return res, err
	}
	res.PNG = buf.Bytes()
	st.Milliseconds = float64(time.Since(started).Microseconds()) / 1000
	res.Stats = st
	return res, nil
}

func solidPermille(c wilds.Chunk) int {
	n := 0
	for _, s := range c.Solid {
		if s {
			n++
		}
	}
	return n * 1000 / len(c.Solid)
}
func landColour(id string) color.RGBA {
	if id == "woods" {
		return color.RGBA{34, 66, 38, 255}
	}
	if id == "meadow" {
		return color.RGBA{150, 190, 96, 255}
	}
	return wilds.GroundColour(id)
}
func shade(c color.RGBA, n int) color.RGBA {
	return color.RGBA{uint8(int(c.R) * n / 10), uint8(int(c.G) * n / 10), uint8(int(c.B) * n / 10), 255}
}
func blend(a, b color.RGBA) color.RGBA {
	return color.RGBA{uint8((int(a.R) + int(b.R)) / 2), uint8((int(a.G) + int(b.G)) / 2), uint8((int(a.B) + int(b.B)) / 2), 255}
}
func block(img *image.RGBA, x, y, n int, c color.RGBA) {
	for yy := y; yy < y+n; yy++ {
		for xx := x; xx < x+n; xx++ {
			img.SetRGBA(xx, yy, c)
		}
	}
}
func cross(img *image.RGBA, x, y, r int, c color.RGBA) {
	for d := -r; d <= r; d++ {
		img.SetRGBA(x+d, y, c)
		img.SetRGBA(x, y+d, c)
	}
}

func overlayColour(o Options, c color.RGBA, cx, cy, tx, ty, unit int, river, road bool, solid int) color.RGBA {
	if enabled(o, "tiers") {
		tier := wilds.Tier(cx, cy)
		c = blend(c, wilds.GroundColour(fmt.Sprint("tier-", tier)))
	}
	if enabled(o, "wend") && river {
		c = color.RGBA{50, 150, 245, 255}
	}
	if enabled(o, "road") && road {
		c = color.RGBA{250, 210, 100, 255}
	}
	if enabled(o, "solid") && unit > 1 && (tx == 0 || ty == 0) {
		c = color.RGBA{uint8(solid * 255 / 1000), uint8((1000 - solid) * 255 / 1000), 80, 255}
	}
	if enabled(o, "land-cells") {
		n := int(content.WildsRules.LandSizes.GetLandCellChunks())
		if (cx%n == 0 && tx == 0) || (cy%n == 0 && ty == 0) {
			c = color.RGBA{220, 80, 200, 255}
		}
	}
	if enabled(o, "place-cells") {
		cell := content.WildsRules.Cells
		n := int(cell.GetCellChunks())
		if ((cx-int(cell.GetOriginCx()))%n == 0 && tx == 0) || ((cy-int(cell.GetOriginCy()))%n == 0 && ty == 0) {
			c = color.RGBA{100, 215, 220, 255}
		}
	}
	if enabled(o, "frontier") {
		x0, y0, x1, y1 := wilds.FrontierRect()
		// The rectangle is diagnostic, not a generation or clipping boundary.
		if ((cx == x0 && tx == 0) || (cx == x1 && tx == unit-1)) && cy >= y0 && cy <= y1 || ((cy == y0 && ty == 0) || (cy == y1 && ty == unit-1)) && cx >= x0 && cx <= x1 {
			c = color.RGBA{255, 70, 65, 255}
		}
	}
	return c
}

func longestRun(lands []string, w, h int) int {
	best := 0
	for y := 0; y < h; y++ {
		run := 0
		last := ""
		for x := 0; x < w; x++ {
			v := lands[y*w+x]
			if v == last {
				run++
			} else {
				run = 1
				last = v
			}
			best = max(best, run)
		}
	}
	for x := 0; x < w; x++ {
		run := 0
		last := ""
		for y := 0; y < h; y++ {
			v := lands[y*w+x]
			if v == last {
				run++
			} else {
				run = 1
				last = v
			}
			best = max(best, run)
		}
	}
	return best
}

// Each component is reachable when it meets a cropped edge. The graph drawn
// is a BFS spanning forest of the actual walkability graph, not straight lines
// between landmarks that might cross solid terrain.
func reach(img *image.RGBA, walk, valid []bool, w, h, scale int, paint bool, anchors ...int) int {
	seen := make([]bool, len(walk))
	parentByTile := make([]int, len(walk))
	kept := make([]bool, len(walk))
	anchorSet := map[int]bool{}
	for _, a := range anchors {
		anchorSet[a] = true
	}
	unreachable := 0
	queue := make([]int, 0, 4096)
	parents := make([]int, 0, 4096)
	for root, open := range walk {
		if !open || seen[root] {
			continue
		}
		queue = queue[:0]
		parents = parents[:0]
		queue = append(queue, root)
		parents = append(parents, -1)
		seen[root] = true
		parentByTile[root] = -1
		boundary := false
		for head := 0; head < len(queue); head++ {
			i := queue[head]
			x, y := i%w, i/w
			if x == 0 || y == 0 || x == w-1 || y == h-1 {
				boundary = true
			}
			for _, d := range [][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}} {
				xx, yy := x+d[0], y+d[1]
				if xx < 0 || xx >= w || yy < 0 || yy >= h {
					continue
				}
				j := yy*w + xx
				if !valid[j] {
					boundary = true
				}
				if walk[j] && !seen[j] {
					seen[j] = true
					queue = append(queue, j)
					parents = append(parents, i)
					parentByTile[j] = i
				}
			}
		}
		if !boundary {
			unreachable += len(queue)
		}
		if paint {
			c := color.RGBA{65, 205, 210, 255}
			if !boundary {
				c = color.RGBA{255, 150, 25, 255}
			}
			for k, i := range queue {
				x, y := i%w, i/w
				if anchorSet[i] || k == len(queue)-1 || ((x == 0 || y == 0 || x == w-1 || y == h-1) && (x+y)%8 == 0) {
					for j := i; j >= 0 && !kept[j]; j = parentByTile[j] {
						kept[j] = true
					}
				}
			}
			for k, i := range queue {
				if !kept[i] {
					continue
				}
				x, y := (i%w)*scale+scale/2, (i/w)*scale+scale/2
				img.SetRGBA(x, y, c)
				if scale >= 3 && parents[k] >= 0 {
					p := parents[k]
					xx, yy := (p%w)*scale+scale/2, (p/w)*scale+scale/2
					for x != xx || y != yy {
						img.SetRGBA(x, y, c)
						if x < xx {
							x++
						} else if x > xx {
							x--
						}
						if y < yy {
							y++
						} else if y > yy {
							y--
						}
					}
				}
			}
		}
	}
	return unreachable
}

type DiffStats struct {
	A            Stats `json:"a"`
	B            Stats `json:"b"`
	Changed      int     `json:"changedUnits"`
	Share        float64 `json:"changedShare"`
	Unit         string  `json:"unit"`
	Milliseconds float64 `json:"totalMs"`
	Note         string  `json:"note"`
}

// Compare lays out A, B and a change mask side by side. Both need
// Signatures and the same view, rectangle and scale.
func Compare(a, b Result, elapsed time.Duration) ([]byte, DiffStats, error) {
	if a.Width != b.Width || a.Height != b.Height || a.Scale != b.Scale || a.Stats.ChunkSize != b.Stats.ChunkSize {
		return nil, DiffStats{}, fmt.Errorf("content versions need matching chunk size and image dimensions")
	}
	ia, err := png.Decode(bytes.NewReader(a.PNG))
	if err != nil {
		return nil, DiffStats{}, err
	}
	ib, err := png.Decode(bytes.NewReader(b.PNG))
	if err != nil {
		return nil, DiffStats{}, err
	}
	if len(a.Signatures) != a.Width*a.Height || len(b.Signatures) != len(a.Signatures) {
		return nil, DiffStats{}, fmt.Errorf("missing comparison signatures")
	}
	w, h := ia.Bounds().Dx(), ia.Bounds().Dy()
	img := image.NewRGBA(image.Rect(0, 0, w*3+4, h))
	draw.Draw(img, img.Bounds(), image.NewUniform(color.RGBA{20, 22, 28, 255}), image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(0, 0, w, h), ia, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(w+2, 0, w*2+2, h), ib, image.Point{}, draw.Src)
	count := 0
	for i, s := range a.Signatures {
		c := color.RGBA{33, 40, 46, 255}
		if s != b.Signatures[i] {
			count++
			c = color.RGBA{255, 80, 110, 255}
		}
		block(img, w*2+4+(i%a.Width)*a.Scale, (i/a.Width)*a.Scale, a.Scale, c)
	}
	unit := "tiles"
	if a.Stats.View == "atlas" {
		unit = "chunk glimpses"
	}
	st := DiffStats{a.Stats, b.Stats, count, float64(count) / float64(len(a.Signatures)), unit, float64(elapsed.Microseconds()) / 1000, "Panels: A, B, changed. Tile changes compare ground ID, solidity, decor, entities, sites and places; atlas compares land and river crossing. Overlays do not affect the change mask."}
	var out bytes.Buffer
	err = png.Encode(&out, img)
	return out.Bytes(), st, err
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
