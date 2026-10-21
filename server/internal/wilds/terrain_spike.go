package wilds

// This file is an isolated world-lab experiment. GenerateV3 never calls it.

import (
	"fmt"
	"math"
)

const (
	TerrainChunkSize       = 24
	TerrainClosed    int16 = -1
)
const (
	TerrainFlat uint8 = iota
	TerrainFace
	TerrainRamp
	TerrainRock // optional shelf rejected by the access solve; never floor
)

var terrainDX = [4]int{0, 1, 0, -1}
var terrainDY = [4]int{-1, 0, 1, 0}

// TerrainFields is the only structural-field dependency of the spike.
// Coordinates are world tiles, including outside the rendered region.
type TerrainFields interface{ Top(x, y int) uint8 }

type terrainFieldCache struct {
	x, y, w, h int
	tops       []uint8
	source     TerrainFields
}

func (f terrainFieldCache) Top(x, y int) uint8 {
	if x < f.x || y < f.y || x >= f.x+f.w || y >= f.y+f.h {
		return f.source.Top(x, y)
	}
	return f.tops[(y-f.y)*f.w+x-f.x]
}
func cacheTerrain(f TerrainFields, x, y, w, h int) TerrainFields {
	c := terrainFieldCache{x - 1, y - 12, w + 2, h + 15, nil, f}
	c.tops = make([]uint8, c.w*c.h)
	for yy := 0; yy < c.h; yy++ {
		for xx := 0; xx < c.w; xx++ {
			c.tops[yy*c.w+xx] = f.Top(c.x+xx, c.y+yy)
		}
	}
	return c
}

type TerrainTile struct {
	Top, Kind, FaceTop, FaceRow, FaceRows uint8
	Edges                                 [4]int16 // absolute 1/256 level; -1 is closed
	Built, Protected, Route               bool
}

func terrainFlat(z uint8) TerrainTile {
	q := int16(z) * 256
	return TerrainTile{Top: z, Kind: TerrainFlat, Edges: [4]int16{q, q, q, q}}
}

// TerrainPlateau removes runs shorter than four using original samples only.
// It is deliberately non-iterative: a four-row run needs at most three
// samples each way; the composed face stencil needs 12 north / 3 south.
func TerrainPlateau(f TerrainFields, x, y int) uint8 {
	z := f.Top(x, y)
	a, b := 0, 0
	for a < 3 && f.Top(x, y-a-1) == z {
		a++
	}
	for b < 3 && f.Top(x, y+b+1) == z {
		b++
	}
	if a+b+1 < 4 {
		return min(z, min(f.Top(x, y-a-1), f.Top(x, y+b+1)))
	}
	return z
}

// TerrainLocal is a pure world-coordinate stencil. A south face consumes
// exactly three rows per dropped level; N/E/W drops keep mismatched rims.
func TerrainLocal(f TerrainFields, x, y int) TerrainTile {
	z := TerrainPlateau(f, x, y)
	t := terrainFlat(z)
	for d := 9; d >= 1; d-- {
		hi, lo := TerrainPlateau(f, x, y-d), TerrainPlateau(f, x, y-d+1)
		rows := (int(hi) - int(lo)) * 3
		if hi <= lo || d > rows || hi <= z {
			continue
		}
		// A later plateau interrupts an earlier face, as in deriveFaces.
		clear := true
		for k := 1; k < d; k++ {
			if TerrainPlateau(f, x, y-d+k) >= hi {
				clear = false
				break
			}
		}
		if !clear {
			continue
		}
		if t.Kind != TerrainFace || hi > t.FaceTop {
			t.Kind, t.FaceTop, t.FaceRow, t.FaceRows = TerrainFace, hi, uint8(d-1), uint8(rows)
			t.Edges = [4]int16{-1, -1, -1, -1}
		}
	}
	return t
}

// TerrainRidge is a replaceable, seed-varied structural stub: a twenty-chunk
// bent range, broad benches, two crowns, a low principal saddle and two bowls.
type TerrainRidge struct {
	Seed              uint32
	WithoutCornerBowl bool // control experiment, retaining the broad natural bowls
}

func (f TerrainRidge) Top(x, y int) uint8 {
	if x < 32 || x > 448 {
		return 0
	}
	u := float64(x-32) / 416
	axis := 86 + 15*math.Sin(u*math.Pi*2) + float64(int(f.Seed%11)-5)
	width := min(1., min(u*7, (1-u)*7))
	lift := 3.5*width - math.Abs(float64(y)-axis)/15
	lift -= 1.8 * math.Exp(-math.Pow((float64(x)-240)/25, 2))
	for _, b := range [][2]float64{{145, 103}, {337, 72}} {
		if math.Hypot((float64(x)-b[0])/1.4, float64(y)-b[1]) < 10 {
			lift -= 1.5
		}
	}
	// A closed bowl centred on a four-chunk corner exercises access that
	// needs room beyond any one chunk's editable interior.
	if !f.WithoutCornerBowl && x >= 310 && x <= 313 && y >= 60 && y <= 73 {
		lift -= 3.5
	}
	return uint8(max(0, min(3, int(math.Floor(lift)))))
}

type TerrainAnchor struct {
	Name string `json:"name"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
}
type TerrainExit struct{ X, Y, Dir int }
type TerrainPlan struct {
	W, H               int
	Tiles              []TerrainTile
	Anchors            []TerrainAnchor
	HeldExits          []TerrainExit
	Strategy           string
	Ramps              int
	RejectedFloorTiles int
}

func (p *TerrainPlan) index(x, y int) int {
	if x < 0 || y < 0 || x >= p.W || y >= p.H {
		return -1
	}
	return y*p.W + x
}
func (p *TerrainPlan) Step(i, d int) int {
	x, y := i%p.W, i/p.W
	j := p.index(x+terrainDX[d], y+terrainDY[d])
	if j < 0 || p.Tiles[i].Edges[d] < 0 || p.Tiles[i].Edges[d] != p.Tiles[j].Edges[(d+2)%4] {
		return -1
	}
	return j
}
func TerrainWalkable(t TerrainTile) bool {
	for _, q := range t.Edges {
		if q >= 0 {
			return true
		}
	}
	return false
}

func terrainBase(f TerrainFields) *TerrainPlan {
	p := &TerrainPlan{W: 480, H: 192}
	f = cacheTerrain(f, 0, 0, p.W, p.H)
	p.Tiles = make([]TerrainTile, p.W*p.H)
	for y := 0; y < p.H; y++ {
		for x := 0; x < p.W; x++ {
			p.Tiles[y*p.W+x] = TerrainLocal(f, x, y)
		}
	}
	// Legacy chunks are flat zero with all 96 old boundary exits intact.
	// Two diagonal holds exercise the shared corner; all constraints are
	// collected before resolving the new-side apron (no neighbour priority).
	for _, c := range [][2]int{{3, 5}, {4, 4}, {5, 5}} {
		for y := c[1] * 24; y < (c[1]+1)*24; y++ {
			for x := c[0] * 24; x < (c[0]+1)*24; x++ {
				i := y*p.W + x
				p.Tiles[i] = terrainFlat(0)
				p.Tiles[i].Protected = true
				for d := 0; d < 4; d++ {
					xx, yy := x+terrainDX[d], y+terrainDY[d]
					if xx/24 != c[0] || yy/24 != c[1] {
						p.HeldExits = append(p.HeldExits, TerrainExit{x, y, d})
					}
				}
			}
		}
	}
	for _, e := range p.HeldExits {
		i := p.index(e.X+terrainDX[e.Dir], e.Y+terrainDY[e.Dir])
		p.Tiles[i] = terrainFlat(0)
		p.Tiles[i].Protected = true
	}
	// A whole-chunk gate apron, and a valid old foot position inside a new face.
	for y := 144; y < 168; y++ {
		for x := 216; x < 240; x++ {
			i := p.index(x, y)
			p.Tiles[i] = terrainFlat(0)
			p.Tiles[i].Protected = true
		}
	}
	p.Anchors = []TerrainAnchor{{"gate", 228, 156}, {"held-foot", 84, 132}, {"diagonal-north", 108, 108}, {"diagonal-south", 132, 132}}
	found := false
	for y := 65; y < 140 && !found; y++ {
		for x := 180; x < 210; x++ {
			i := p.index(x, y)
			if p.Tiles[i].Kind == TerrainFace {
				p.Anchors = append(p.Anchors, TerrainAnchor{"saved-player", x, y})
				for yy := y; yy < y+2; yy++ {
					for xx := x; xx < x+2; xx++ {
						j := p.index(xx, yy)
						p.Tiles[j] = terrainFlat(0)
						p.Tiles[j].Protected = true
					}
				}
				found = true
				break
			}
		}
	}
	return p
}

// TerrainComponents is an exact certificate over final, decoded edge heights.
// Cropped edges never imply access to home. Unknown is only for tiles outside
// this finite access domain; all in-domain components are measured.
type TerrainCertificate struct {
	Components         int   `json:"components"`
	StrandedComponents int   `json:"strandedComponents"`
	StrandedTiles      int   `json:"strandedTiles"`
	WalkableTiles      int   `json:"walkableTiles"`
	HeldExits          int   `json:"heldExits"`
	HeldExitsKept      int   `json:"heldExitsKept"`
	Anchors            int   `json:"anchors"`
	AnchorsReached     int   `json:"anchorsReached"`
	Labels             []int `json:"-"`
	Home               int   `json:"-"`
}

func (p *TerrainPlan) Certificate() TerrainCertificate {
	c := TerrainCertificate{Labels: make([]int, len(p.Tiles)), Home: -1, HeldExits: len(p.HeldExits), Anchors: len(p.Anchors)}
	for i := range c.Labels {
		c.Labels[i] = -1
	}
	sizes := []int{}
	queue := make([]int, 0, len(p.Tiles))
	for i, t := range p.Tiles {
		if c.Labels[i] >= 0 || !TerrainWalkable(t) {
			continue
		}
		id := len(sizes)
		queue = append(queue[:0], i)
		c.Labels[i] = id
		for head := 0; head < len(queue); head++ {
			for d := 0; d < 4; d++ {
				j := p.Step(queue[head], d)
				if j >= 0 && c.Labels[j] < 0 {
					c.Labels[j] = id
					queue = append(queue, j)
				}
			}
		}
		sizes = append(sizes, len(queue))
		c.WalkableTiles += len(queue)
	}
	c.Components = len(sizes)
	if len(p.Anchors) > 0 {
		a := p.Anchors[0]
		c.Home = c.Labels[p.index(a.X, a.Y)]
	}
	for id, n := range sizes {
		if id != c.Home {
			c.StrandedComponents++
			c.StrandedTiles += n
		}
	}
	for _, a := range p.Anchors {
		if c.Home >= 0 && c.Labels[p.index(a.X, a.Y)] == c.Home {
			c.AnchorsReached++
		}
	}
	for _, e := range p.HeldExits {
		i := p.index(e.X, e.Y)
		if p.Step(i, e.Dir) >= 0 && c.Home >= 0 && c.Labels[i] == c.Home {
			c.HeldExitsKept++
		}
	}
	return c
}

func (p *TerrainPlan) Chunk(cx, cy int) ([]TerrainTile, error) {
	if cx < 0 || cy < 0 || cx >= p.W/24 || cy >= p.H/24 {
		return nil, fmt.Errorf("outside spike domain")
	}
	out := make([]TerrainTile, 576)
	for y := 0; y < 24; y++ {
		copy(out[y*24:(y+1)*24], p.Tiles[(cy*24+y)*p.W+cx*24:(cy*24+y)*p.W+cx*24+24])
	}
	return out, nil
}
