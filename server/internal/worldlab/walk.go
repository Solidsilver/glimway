package worldlab

// The walk lab (exp/terrain-walk): a real window of world near home, its
// heights from lane B's fields (wilds.TerrainWorld) under both of lane A's
// access strategies, dressed with lane B's biome grounds and cover, for the
// height lab to walk (src/game/height-lab/walk.ts). It runs in a worker like
// every render; nothing is pinned, saved or served to the game.

import (
	"context"
	"encoding/binary"
	"fmt"
	"time"

	"glimway/content"
	"glimway/server/internal/wilds"
)

// WalkRecipe names what the walk serves; the client checks it.
const WalkRecipe = "terrain-walk@1"

// WalkPath is the walk's route under Prefix: POST {seed}.
const WalkPath = "terrain-walk"

// TerrainWalk is the window, shared planes first (one byte a tile, row by
// row, window tiles; palettes beside them), then each strategy's geometry.
type TerrainWalk struct {
	Recipe string `json:"recipe"`
	Seed   string `json:"seed"`
	Epoch  string `json:"epoch"`
	// World tile of the window's first tile, its size in tiles, its chunks.
	X0     int    `json:"x0"`
	Y0     int    `json:"y0"`
	W      int    `json:"w"`
	H      int    `json:"h"`
	Chunks [4]int `json:"chunks"`
	// Structural tops 0–3 before any fixture or repair (wilds.TerrainWorld).
	Tops      []byte   `json:"tops"`
	Grounds   []string `json:"grounds"`
	Ground    []byte   `json:"ground"`
	PropKinds []string `json:"propKinds"`
	// Prop per tile: 0 none, else 1 + index into PropKinds.
	Prop    []byte   `json:"prop"`
	Water   []byte   `json:"water"`
	Biomes  []string `json:"biomes"`
	Biome   []byte   `json:"biome"`
	Regions []string `json:"regions"`
	Region  []byte   `json:"region"`
	// Strategies: "region" and "chunk".
	Strategies map[string]*WalkStrategy `json:"strategies"`
	Anchors    []wilds.TerrainAnchor    `json:"anchors"`
	Spots      []WalkSpot               `json:"spots"`
	Timings    map[string]float64       `json:"timingsMs"`
	Note       string                   `json:"note"`
}

// WalkStrategy is one strategy's solved window. Kind and Top one byte a
// tile; Edges four little-endian int16 a tile (absolute 1/256 level, -1
// closed); Face three bytes a tile (top, row, rows); Flags one byte a tile
// (1 protected, 2 built ramp, 4 stranded, 8 held exit tile).
type WalkStrategy struct {
	Kind        []byte                   `json:"kind"`
	Top         []byte                   `json:"top"`
	Edges       []byte                   `json:"edges"`
	Face        []byte                   `json:"face"`
	Flags       []byte                   `json:"flags"`
	Ramps       int                      `json:"ramps"`
	Rejected    int                      `json:"rejectedOptionalFloorTiles"`
	Certificate wilds.TerrainCertificate `json:"certificate"`
	Stranded    []TerrainStranded        `json:"stranded"`
	SolveMS     float64                  `json:"solveMs"`
}

// WalkSpot is a named place to stand (window tiles), for the screenshots
// and the notes: where the strategies differ, a ramp up a shoulder, the
// Whitequiet's edge.
type WalkSpot struct {
	Name string `json:"name"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
	Note string `json:"note"`
}

// The walk's dressing: kinds the height lab draws (its PropSpot kinds).
var walkPropKinds = []string{"oak", "pine", "birch", "boulder", "thicket", "fern", "snag"}

func walkProp(kind string) byte {
	for i, k := range walkPropKinds {
		if k == kind {
			return byte(i + 1)
		}
	}
	return 0
}

type walkPalette struct {
	names []string
	index map[string]byte
}

func (p *walkPalette) of(name string) byte {
	if p.index == nil {
		p.index = map[string]byte{}
	}
	if i, ok := p.index[name]; ok {
		return i
	}
	if len(p.names) == 255 {
		return 254 // never reached in a window this size
	}
	p.index[name] = byte(len(p.names))
	p.names = append(p.names, name)
	return p.index[name]
}

// RenderWalk solves and dresses the walk's window (wilds.TerrainWalkSpec)
// on a seed. Height and access read only the lasting fields; ground and
// cover read the wick season's generated chunks, as the world lab's region
// view does.
func RenderWalk(ctx context.Context, o Options) (*TerrainWalk, error) {
	spec := wilds.TerrainWalkSpec()
	f := wilds.TerrainWorld{Seed: o.Seed}
	out := &TerrainWalk{Recipe: WalkRecipe, Seed: o.Seed, Epoch: o.Epoch, X0: spec.CX0 * 24, Y0: spec.CY0 * 24, W: spec.CW * 24, H: spec.CH * 24, Chunks: [4]int{spec.CX0, spec.CY0, spec.CW, spec.CH}, Strategies: map[string]*WalkStrategy{}, Timings: map[string]float64{}, PropKinds: walkPropKinds}
	out.Note = "Dev preview. Tops from Upland and Relief (wilds.TerrainWorld); the spike's south-face stencil and exact 1/256 edges. Region plan repairs the whole window; per-chunk repair each chunk's 2..21 interior. Held chunks and the saved landing are synthetic fixtures. The certificate is height only: cover and water are not part of it (cover is cleared on ramps and their landings). Woods cover is thinned to a light dressing. Nothing pins or saves."
	n := out.W * out.H
	plans := map[string]*wilds.TerrainWindowPlan{}
	for _, strategy := range []string{"region", "chunk"} {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		start := time.Now()
		p, err := wilds.NewTerrainWindow(f, spec, strategy)
		if err != nil {
			return nil, err
		}
		plans[strategy] = p
		ms := float64(time.Since(start).Microseconds()) / 1000
		out.Timings["solve:"+strategy] = ms
		out.Strategies[strategy] = walkStrategy(p, ms)
	}
	out.Anchors = plans["region"].Anchors
	start := time.Now()
	out.Tops = make([]byte, n)
	for y := 0; y < out.H; y++ {
		for x := 0; x < out.W; x++ {
			out.Tops[y*out.W+x] = f.Top(out.X0+x, out.Y0+y)
		}
	}
	out.Timings["tops"] = float64(time.Since(start).Microseconds()) / 1000
	start = time.Now()
	if err := dressWalk(ctx, o, out, plans); err != nil {
		return nil, err
	}
	out.Timings["dress"] = float64(time.Since(start).Microseconds()) / 1000
	out.Spots = walkSpots(out, plans)
	return out, nil
}

func walkStrategy(p *wilds.TerrainWindowPlan, ms float64) *WalkStrategy {
	n := len(p.Tiles)
	s := &WalkStrategy{Kind: make([]byte, n), Top: make([]byte, n), Edges: make([]byte, n*8), Face: make([]byte, n*3), Flags: make([]byte, n), Ramps: p.Ramps, Rejected: p.RejectedFloorTiles, SolveMS: ms}
	c := p.Certificate()
	s.Certificate = c
	held := map[int]bool{}
	for _, e := range p.HeldExits {
		held[e.Y*p.W+e.X] = true
	}
	for i, t := range p.Tiles {
		s.Kind[i] = t.Kind
		s.Top[i] = t.Top
		for d, q := range t.Edges {
			binary.LittleEndian.PutUint16(s.Edges[i*8+d*2:], uint16(q))
		}
		s.Face[i*3], s.Face[i*3+1], s.Face[i*3+2] = t.FaceTop, t.FaceRow, t.FaceRows
		var fl byte
		if t.Protected {
			fl |= 1
		}
		if t.Kind == wilds.TerrainRamp && t.Built {
			fl |= 2
		}
		if c.Labels[i] >= 0 && c.Labels[i] != c.Home {
			fl |= 4
		}
		if held[i] {
			fl |= 8
		}
		s.Flags[i] = fl
	}
	components := map[int]*TerrainStranded{}
	for i, label := range c.Labels {
		if label < 0 || label == c.Home {
			continue
		}
		st := components[label]
		x, y := i%p.W, i/p.W
		if st == nil {
			st = &TerrainStranded{Bounds: [4]int{x, y, x, y}}
			components[label] = st
		}
		st.Tiles++
		st.Bounds = [4]int{min(st.Bounds[0], x), min(st.Bounds[1], y), max(st.Bounds[2], x), max(st.Bounds[3], y)}
	}
	for id := 0; id < c.Components; id++ {
		if st := components[id]; st != nil {
			s.Stranded = append(s.Stranded, *st)
		}
	}
	return s
}

// dressWalk lays lane B's ground and cover on the window: the generated
// chunk's ground through wilds.BiomeTileLook, cover as the height lab's
// props, Town as plain paving and meadow. Cover never stands on a face, a
// ramp of either strategy or beside one, nor on protected ground.
func dressWalk(ctx context.Context, o Options, out *TerrainWalk, plans map[string]*wilds.TerrainWindowPlan) error {
	n := out.W * out.H
	out.Ground, out.Prop, out.Water, out.Biome, out.Region = make([]byte, n), make([]byte, n), make([]byte, n), make([]byte, n), make([]byte, n)
	var grounds, biomes, regions walkPalette
	keep := make([]bool, n) // where cover may stand: flat in both strategies, not protected, not by a ramp
	for i := range keep {
		keep[i] = true
	}
	for _, p := range plans {
		for i, t := range p.Tiles {
			if t.Kind != wilds.TerrainFlat || t.Protected {
				keep[i] = false
			}
			if t.Kind == wilds.TerrainRamp {
				x, y := i%out.W, i/out.W
				for yy := y - 2; yy <= y+2; yy++ {
					for xx := x - 2; xx <= x+2; xx++ {
						if xx >= 0 && yy >= 0 && xx < out.W && yy < out.H {
							keep[yy*out.W+xx] = false
						}
					}
				}
			}
		}
	}
	ramp := func(i int) (bool, bool) {
		for _, p := range plans {
			if t := p.Tiles[i]; t.Kind == wilds.TerrainRamp {
				return true, t.Built
			}
		}
		return false, false
	}
	for cy := out.Chunks[1]; cy < out.Chunks[1]+out.Chunks[3]; cy++ {
		for cx := out.Chunks[0]; cx < out.Chunks[0]+out.Chunks[2]; cx++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			ox, oy := (cx-out.Chunks[0])*24, (cy-out.Chunks[1])*24
			if wilds.FixedFootprintAt(cx, cy) != nil {
				// Town isn't generated; plain ground marks it.
				for ly := 0; ly < 24; ly++ {
					for lx := 0; lx < 24; lx++ {
						i := (oy+ly)*out.W + ox + lx
						tx, ty := cx*24+lx, cy*24+ly
						g := "meadow"
						if mod(tx, 12) < 2 || mod(ty, 12) < 2 {
							g = "paving"
						}
						out.Ground[i] = grounds.of(g)
						b := wilds.BiomeAt(o.Seed, tx, ty, nil)
						out.Biome[i] = biomes.of("town · " + b.EffectiveRef)
						out.Region[i] = regions.of(b.PrimaryRegion.ID())
					}
				}
				continue
			}
			c, err := wilds.GenerateV3(epoch(o, cx, cy), cx, cy, nil)
			if err != nil {
				return err
			}
			thicket := landThicketPermille(c.Land)
			for li, g := range c.Ground {
				lx, ly := li%24, li/24
				i := (oy+ly)*out.W + ox + lx
				tx, ty := cx*24+lx, cy*24+ly
				base := content.WildsRules.Grounds[int(g)]
				id, _, solid, b := wilds.BiomeTileLook(o.Seed, tx, ty, base.GetId(), c.Solid[li], base.GetSurface(), thicket, nil)
				out.Biome[i] = biomes.of(b.EffectiveRef)
				out.Region[i] = regions.of(b.PrimaryRegion.ID())
				isRamp, built := ramp(i)
				water := base.GetSurface() == "water"
				switch {
				case isRamp && built:
					id = "path"
				case isRamp:
					id = "trodden"
				case water && keep[i]:
					out.Water[i] = 1
				case water:
					id = "bank"
				}
				out.Ground[i] = grounds.of(id)
				if !solid || !keep[i] || water {
					if keep[i] && !water && b.EffectiveBiome == wilds.BiomeHearthwickWoods && wilds.Hash("walk-fern", o.Seed, tx, ty)%1000 < 18 {
						out.Prop[i] = walkProp("fern")
					}
					continue
				}
				out.Prop[i] = walkCover(o.Seed, tx, ty, b.EffectiveBiome, id)
			}
		}
	}
	out.Grounds, out.Biomes, out.Regions = grounds.names, biomes.names, regions.names
	return nil
}

// walkCover is the prop a solid tile shows, or none: the woods' thicket
// maze thinned to about a third by a coherent stand field (a light
// dressing), Tops pines below the scree and boulders above, the
// Whitequiet's pale birch.
func walkCover(seed string, tx, ty int, biome, ground string) byte {
	h := wilds.Hash("walk-cover", seed, tx, ty) % 1000
	switch biome {
	case wilds.BiomeTops:
		if ground == "tops-scree" || ground == "tops-crag" {
			return walkProp("boulder")
		}
		return walkProp("pine")
	case wilds.BiomeWhitequiet:
		if ground == "wq-stone" {
			return walkProp("boulder")
		}
		if h < 300 {
			return walkProp("snag")
		}
		return walkProp("birch")
	}
	stand := wilds.Hash("walk-stand", seed, tx/3, ty/3) % 1000
	if stand >= 380 {
		return 0
	}
	switch {
	case h < 300:
		return walkProp("oak")
	case h < 450:
		return walkProp("pine")
	case h < 520:
		return walkProp("birch")
	}
	return walkProp("thicket")
}

func mod(a, b int) int { return ((a % b) + b) % b }

// walkSpots finds where to stand: home; the foot of a region-plan ramp up
// to the shoulders' second level nearest the Tops; the Whitequiet's edge
// north of the Tangle; and the per-chunk strategy's largest stranded
// component (none when it strands nothing: that is a finding too).
func walkSpots(out *TerrainWalk, plans map[string]*wilds.TerrainWindowPlan) []WalkSpot {
	spots := []WalkSpot{}
	home := out.Anchors[0]
	spots = append(spots, WalkSpot{"home", home.X, home.Y, "spawn: Town's north edge, below the Tangle"})
	r := plans["region"]
	// A ramp foot: the low landing of a ramp whose low edge is level 1 or
	// more (a shoulder's step up), nearest the Tops region.
	tops := byte(255)
	for i, name := range out.Biomes {
		if name == wilds.BiomeRef(wilds.BiomeTops, wilds.BiomeVersion) {
			tops = byte(i)
		}
	}
	tx, ty := 0, 0
	nt := 0
	for i, b := range out.Biome {
		if b == tops {
			tx += i % out.W
			ty += i / out.W
			nt++
		}
	}
	if nt > 0 {
		tx, ty = tx/nt, ty/nt
	} else {
		tx, ty = out.W, 0
	}
	best, bestD := -1, 1<<60
	for i, t := range r.Tiles {
		if t.Kind != wilds.TerrainRamp {
			continue
		}
		lo := int16(32767)
		for _, q := range t.Edges {
			if q >= 0 {
				lo = min(lo, q)
			}
		}
		if lo < 256 {
			continue
		}
		x, y := i%out.W, i/out.W
		if d := (x-tx)*(x-tx) + (y-ty)*(y-ty); d < bestD {
			best, bestD = i, d
		}
	}
	if best >= 0 {
		// Walk down the ramp to its low landing.
		i := best
		for k := 0; k < 30; k++ {
			t := r.Tiles[i]
			if t.Kind != wilds.TerrainRamp {
				break
			}
			low, ld := int16(32767), -1
			for d, q := range t.Edges {
				if q >= 0 && q < low {
					low, ld = q, d
				}
			}
			j := r.Step(i, ld)
			if j < 0 {
				break
			}
			i = j
		}
		spots = append(spots, WalkSpot{"ramp", i % out.W, i / out.W, "the foot of a region-plan ramp up a shoulder, nearest the Tops"})
		// And up it to its high landing.
		i = best
		for k := 0; k < 30; k++ {
			t := r.Tiles[i]
			if t.Kind != wilds.TerrainRamp {
				break
			}
			high, hd := int16(-1), -1
			for d, q := range t.Edges {
				if q > high {
					high, hd = q, d
				}
			}
			j := r.Step(i, hd)
			if j < 0 {
				break
			}
			i = j
		}
		spots = append(spots, WalkSpot{"ramp-top", i % out.W, i / out.W, "the top of that ramp"})
	}
	// The Whitequiet's edge: the southernmost Whitequiet tile north of the
	// Tangle anchor's column band, walkable in both strategies.
	wq := byte(255)
	for i, name := range out.Biomes {
		if name == wilds.BiomeRef(wilds.BiomeWhitequiet, wilds.BiomeVersion) {
			wq = byte(i)
		}
	}
	tangle := out.Anchors[1]
	edge := -1
	for y := tangle.Y; y >= 0 && edge < 0; y-- {
		for dx := 0; dx <= 24 && edge < 0; dx++ {
			for _, x := range []int{tangle.X - dx, tangle.X + dx} {
				i := y*out.W + x
				if x < 0 || x >= out.W || out.Biome[i] != wq || out.Prop[i] != 0 || out.Water[i] != 0 {
					continue
				}
				if wilds.TerrainWalkable(r.Tiles[i]) && wilds.TerrainWalkable(plans["chunk"].Tiles[i]) && i+out.W < len(out.Biome) && out.Biome[i+out.W] != wq {
					edge = i
					break
				}
			}
		}
	}
	if edge >= 0 {
		spots = append(spots, WalkSpot{"whitequiet", edge % out.W, edge / out.W, "the Whitequiet's southern edge, north of the Tangle"})
	}
	// The per-chunk ramp nearest home that the region plan doesn't have:
	// where the strategies' ways up differ.
	near, nearD := -1, 1<<60
	for i, t := range plans["chunk"].Tiles {
		if t.Kind != wilds.TerrainRamp || r.Tiles[i].Kind == wilds.TerrainRamp {
			continue
		}
		x, y := i%out.W, i/out.W
		if d := (x-home.X)*(x-home.X) + (y-home.Y)*(y-home.Y); d < nearD {
			near, nearD = i, d
		}
	}
	if near >= 0 {
		spots = append(spots, WalkSpot{"chunk-ramp", near % out.W, near / out.W, "a per-chunk repair ramp nearest home that the region plan doesn't cut"})
	}
	c := out.Strategies["chunk"]
	big := -1
	for k, s := range c.Stranded {
		if big < 0 || s.Tiles > c.Stranded[big].Tiles {
			big = k
		}
	}
	if big >= 0 {
		b := c.Stranded[big].Bounds
		// A stranded tile near the component's middle.
		mx, my := (b[0]+b[2])/2, (b[1]+b[3])/2
		at, atD := -1, 1<<60
		for y := b[1]; y <= b[3]; y++ {
			for x := b[0]; x <= b[2]; x++ {
				i := y*out.W + x
				if c.Flags[i]&4 == 0 || out.Prop[i] != 0 || out.Water[i] != 0 {
					continue
				}
				if d := (x-mx)*(x-mx) + (y-my)*(y-my); d < atD {
					at, atD = i, d
				}
			}
		}
		if at >= 0 {
			spots = append(spots, WalkSpot{"stranded", at % out.W, at / out.W, fmt.Sprintf("per-chunk repair strands %d tiles here", c.Stranded[big].Tiles)})
		}
	}
	return spots
}
