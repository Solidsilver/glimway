package wilds

// Slopes is a database-free world-lab recipe. No live generator calls it.
import (
	"context"
	"fmt"
	"math"

	"glimway/content"
)

const (
	SlopeRecipe     = "slopes-gen@1"
	SlopeHeightUnit = 256
	// SlopeWalkLimit is the maximum gradient: one level per four tiles.
	SlopeWalkLimit  = SlopeHeightUnit / 4
	SlopeOwnerTiles = 576
)

type SlopeKind uint8

const (
	SlopeGround SlopeKind = iota
	SlopeSteep
	SlopeCrag
	SlopeCliff
)

func (k SlopeKind) String() string { return [...]string{"slope", "steep", "crag", "cliff"}[k] }

// SlopeGroundData is terrain metadata only. Cover is a separate system.
type SlopeGroundData struct {
	Kind                SlopeKind
	Unreachable         bool  // deliberate spire footprint; never inferred from connectivity
	Discontinuity       uint8 // closed N/E/S/W field edges; bits 0..3
	FaceRow, FaceRows   uint8
	FaceTop, FaceBottom uint16
}

// SlopeTile is a resolved view, never the stored continuous field.
type SlopeTile struct {
	Corners [4]uint16 // NW, NE, SE, SW; absolute 1/256 level
	SlopeGroundData
}

// SlopeRange describes one bounded range, its saddle, and nearby rock features.
type SlopeRange struct {
	ID         string  `json:"id"`
	X          int     `json:"x"`
	Y          int     `json:"y"`
	HalfLength int     `json:"halfLength"`
	Height     float64 `json:"heightLevels"`
	PassX      int     `json:"passX"`
	Spire      [2]int  `json:"spire"`
	Outcrop    [2]int  `json:"outcrop"`
	// V2 diagnostics describe the rotated, winding range in world coordinates.
	Angle      float64   `json:"angleRadians,omitempty"`
	Width      float64   `json:"shoulderHalfWidth,omitempty"`
	PassEnds   [2][2]int `json:"passEnds,omitempty"`
	TunnelEnds [2][2]int `json:"tunnelEnds,omitempty"`
	Crest      [][2]int  `json:"crest,omitempty"`
	Branch     [][2]int  `json:"branch,omitempty"`
}

func SlopeRangeAt(seed string, ox, oy int) SlopeRange {
	h := landformV2Hash(seed, "slopes-range", ox, oy)
	x, y := ox*SlopeOwnerTiles+288+int(h%33)-16, oy*SlopeOwnerTiles+288+int(h>>8%33)-16
	u := UplandAt(seed, x, y)
	r := SlopeRange{ID: fmt.Sprintf("range:%d:%d", ox, oy), X: x, Y: y, HalfLength: 176 + int(h>>16%17), Height: 6 + float64(u)/250}
	r.PassX = x + int(h>>24%49) - 24
	spireY := y + 136
	if y < 0 {
		spireY = y - 136
	}
	r.Spire = [2]int{x + 130, spireY}
	r.Outcrop = [2]int{x - 120, y - 136}
	return r
}

// SlopeSampler caches only bounded, world-aligned field nodes for one request.
// Interpolation is at absolute 8-tile nodes, including at negative coordinates.
type SlopeSampler struct {
	Seed     string
	recipe   string
	nodes    map[[2]int][2]int
	ranges   map[[2]int]SlopeRange
	rangesV2 map[[2]int]*slopeRangeV2
}

func NewSlopeSampler(seed string) *SlopeSampler {
	return &SlopeSampler{Seed: seed, nodes: map[[2]int][2]int{}, ranges: map[[2]int]SlopeRange{}}
}
func (s *SlopeSampler) owner(x, y int) SlopeRange {
	k := [2]int{floorDiv(x, SlopeOwnerTiles), floorDiv(y, SlopeOwnerTiles)}
	if r, ok := s.ranges[k]; ok {
		return r
	}
	var r SlopeRange
	if s.recipe == SlopeRecipeV2 {
		r = s.rangeV2(x, y).SlopeRange
	} else {
		r = SlopeRangeAt(s.Seed, k[0], k[1])
	}
	s.ranges[k] = r
	return r
}
func (s *SlopeSampler) node(x, y int) [2]int {
	k := [2]int{x, y}
	if n, ok := s.nodes[k]; ok {
		return n
	}
	u := UplandAt(s.Seed, x, y)
	n := [2]int{u, reliefWithUpland(s.Seed, x, y, u)}
	s.nodes[k] = n
	return n
}
func (s *SlopeSampler) fields(x, y int) (float64, float64) {
	ax, ay := floorDiv(x, 8)*8, floorDiv(y, 8)*8
	a, b, c, d := s.node(ax, ay), s.node(ax+8, ay), s.node(ax, ay+8), s.node(ax+8, ay+8)
	fx, fy := float64(x-ax)/8, float64(y-ay)/8
	lerp := func(i int) float64 {
		return (float64(a[i])*(1-fx)*(1-fy) + float64(b[i])*fx*(1-fy) + float64(c[i])*(1-fx)*fy + float64(d[i])*fx*fy) / 1000
	}
	return lerp(0), lerp(1)
}
func slopeEase(v float64) float64    { v = math.Max(0, math.Min(1, v)); return v * v * (3 - 2*v) }
func slopeTent(v, w float64) float64 { return slopeEase(1 - math.Abs(v)/w) }

// Keep Euclidean distance continuous here; the lasting fields' integer
// distance is appropriate for permille samples but stairs a sharp upper rib.
func slopeHomeDistance(x, y int) float64 {
	best := math.Inf(1)
	box := func(x0, y0, x1, y1 int) {
		dx := max(x0*24-x, x-(x1+1)*24+1, 0)
		dy := max(y0*24-y, y-(y1+1)*24+1, 0)
		best = math.Min(best, math.Hypot(float64(dx), float64(dy)))
	}
	for _, p := range content.PlacesRules.GetFixed() {
		x0, y0, x1, y1 := content.FixedChunks(p)
		box(x0, y0, x1, y1)
	}
	if p := Footprint("tangle"); p != nil {
		x0, y0 := int(p.GetCx()), int(p.GetCy())
		box(x0, y0, x0+int(p.GetWidth())-1, y0+int(p.GetHeight())-1)
	}
	return best
}

// shape returns unquantized height and intentional crest/spire masks. Ranges
// have broad smooth lower sides and a narrow upper rock rib split by a saddle.
func (s *SlopeSampler) shape(x, y int) (float64, bool, bool) {
	if s.recipe == SlopeRecipeV2 {
		return s.shapeV2(x, y)
	}
	u, relief := s.fields(x, y)
	d := slopeHomeDistance(x, y)
	if d <= 24 {
		return 0, false, false
	}
	home := slopeEase(float64(d-24) / 120)
	base := 2.8*u + 0.22*relief*math.Sin(float64(x)/37)*math.Sin(float64(y)/43)
	r := s.owner(x, y)
	dx := float64(x - r.X)
	axis := float64(r.Y) + 9*math.Sin(dx/87)
	dy := float64(y) - axis
	end := slopeEase((float64(r.HalfLength) - math.Abs(dx)) / 56)
	notch := 1 - 0.98*slopeTent(float64(x-r.PassX), 64)
	lower := 3 * slopeTent(dy, 96) * end * (0.35 + 0.65*notch)
	upper := (r.Height - 3) * slopeTent(dy, 16) * end * notch
	far := slopeEase(float64(d-144) / 96)
	z := base*home + (lower+upper)*far
	z += 0.18 * relief * math.Sin(dx/5) * slopeTent(dy, 8) * end * notch * far
	// A broad intentional jagged rib overlaps the steep sides. A narrow
	// five-tile crown left quantization-sized usable slivers inside that rib.
	crestWidth := 12 + 2*math.Pow(math.Sin(dx/9), 2)
	crest := math.Abs(dy) < crestWidth && end*notch*far > 0.22
	sx, sy := float64(x-r.Spire[0]), float64(y-r.Spire[1])
	sd := math.Hypot(sx, sy)
	spire := sd < 16 && far > 0.99
	if spire {
		z = math.Max(z, base+(15-base)*slopeEase((16-sd)/12))
	}
	// One-sided outcrop: long gentle approach from the north, south lip.
	ox, oy := float64(x-r.Outcrop[0]), y-r.Outcrop[1]
	if oy < 0 {
		z += 2 * slopeTent(ox, 38) * slopeEase(float64(oy+64)/64) * far
	}
	return math.Max(0, z), crest, spire
}
func (s *SlopeSampler) Corner(x, y int) uint16 {
	z, _, _ := s.shape(x, y)
	return uint16(math.Round(z * SlopeHeightUnit))
}

// SlopeGradientSquared bounds the Euclidean gradient of the bilinear tile
// at all four corners. It also bounds every interior point of that patch.
func SlopeGradientSquared(c [4]uint16) int64 {
	a, b, d, e := int64(c[0]), int64(c[1]), int64(c[2]), int64(c[3])
	return max((b-a)*(b-a)+(e-a)*(e-a), (b-a)*(b-a)+(d-b)*(d-b), (d-e)*(d-e)+(d-b)*(d-b), (d-e)*(d-e)+(e-a)*(e-a))
}
func (s *SlopeSampler) Tile(x, y int) SlopeTile {
	return s.tile(x, y, [4]uint16{s.Corner(x, y), s.Corner(x+1, y), s.Corner(x+1, y+1), s.Corner(x, y+1)})
}
func (s *SlopeSampler) tile(x, y int, corners [4]uint16) SlopeTile {
	t := SlopeTile{Corners: corners}
	_, crest, spire := s.shape(x, y)
	t.Unreachable = spire
	if SlopeGradientSquared(t.Corners) > SlopeWalkLimit*SlopeWalkLimit {
		t.Kind = SlopeSteep
	}
	if crest {
		t.Kind = SlopeCrag
	}
	r := s.owner(x, y)
	// Pure local south-face rule. Only intentional scarp lips cast faces;
	// continuous slopes never acquire faces at whole-level contours. A higher
	// intervening surface interrupts the face, as in the spike's local rule.
	row := y - r.Outcrop[1]
	if row >= -1 && row < 6 && abs(x-r.Outcrop[0]) < 38 {
		hi, lo := s.Corner(x, r.Outcrop[1]-1), s.Corner(x, r.Outcrop[1])
		if hi > lo {
			if row == -1 {
				t.Discontinuity |= 1 << 2
			}
			if row == 0 {
				t.Discontinuity |= 1 << 0
			}
		}
		if row >= 0 {
			t = ResolveSlopeSouthFace(t, row, hi, lo)
		}
	}
	return t
}

// ResolveSlopeSouthFace is the future shore/scarp hook. The caller supplies
// an intentional lip, exact heights, and distance south in rows. A whole-level
// drop consumes three rows per level; fractional drops round the footprint up.
// A higher surface interrupts the face. This never changes corner elevations.
func ResolveSlopeSouthFace(t SlopeTile, row int, top, bottom uint16) SlopeTile {
	if top <= bottom || row < 0 {
		return t
	}
	rows := (int(top-bottom)*3 + 255) / 256
	if row < rows && top > max(t.Corners[0], t.Corners[1]) {
		t.Kind = SlopeCliff
		t.FaceRow = uint8(row)
		t.FaceRows = uint8(rows)
		t.FaceTop = top
		t.FaceBottom = bottom
	}
	return t
}

type SlopePlan struct {
	X, Y int
	*SlopeSurface
	Ranges []SlopeRange
}

func NewSlopePlan(ctx context.Context, seed string, x, y, w, h int) (*SlopePlan, error) {
	return NewSlopePlanRecipe(ctx, seed, SlopeRecipe, x, y, w, h)
}

// NewSlopePlanRecipe builds an explicitly versioned preview behind the same
// quantized surface and access API as NewSlopePlan.
func NewSlopePlanRecipe(ctx context.Context, seed, recipe string, x, y, w, h int) (*SlopePlan, error) {
	if w <= 0 || h <= 0 || w > 2400000/h {
		return nil, fmt.Errorf("slope plan needs 1..2400000 tiles")
	}
	sampler, err := NewSlopeSamplerRecipe(seed, recipe)
	if err != nil {
		return nil, err
	}
	surface, err := sampler.Surface(ctx, x, y, w, h)
	if err != nil {
		return nil, err
	}
	p := &SlopePlan{X: x, Y: y, SlopeSurface: surface}
	for oy := floorDiv(y, SlopeOwnerTiles); oy <= floorDiv(y+h-1, SlopeOwnerTiles); oy++ {
		for ox := floorDiv(x, SlopeOwnerTiles); ox <= floorDiv(x+w-1, SlopeOwnerTiles); ox++ {
			p.Ranges = append(p.Ranges, sampler.owner(ox*SlopeOwnerTiles+288, oy*SlopeOwnerTiles+288))
		}
	}
	return p, nil
}
func (p *SlopePlan) Index(x, y int) int {
	if x < p.X || y < p.Y || x >= p.X+p.W || y >= p.Y+p.H {
		return -1
	}
	return (y-p.Y)*p.W + x - p.X
}
func (p *SlopePlan) Step(i, d int) int {
	if d < 0 || d > 3 || !p.Walkable(i) {
		return -1
	}
	j := p.Index(p.X+i%p.W+terrainDX[d], p.Y+i/p.W+terrainDY[d])
	if !p.Walkable(j) || p.Ground[i].Discontinuity&(1<<d) != 0 || p.Ground[j].Discontinuity&(1<<((d+2)%4)) != 0 {
		return -1
	}
	a, b := p.Tile(i).Corners, p.Tile(j).Corners
	match := [4]bool{a[0] == b[3] && a[1] == b[2], a[1] == b[0] && a[2] == b[3], a[3] == b[0] && a[2] == b[1], a[0] == b[1] && a[3] == b[2]}
	if !match[d] {
		return -1
	}
	return j
}

type SlopeCertificate struct {
	Components            int   `json:"components"`
	HomeTiles             int   `json:"homeTiles"`
	StrandedComponents    int   `json:"strandedComponents"`
	StrandedTiles         int   `json:"strandedTiles"`
	IntentionalComponents int   `json:"intentionalComponents"`
	IntentionalTiles      int   `json:"intentionalWalkableTiles"`
	Labels                []int `json:"-"`
	Home                  int   `json:"-"`
}

func (p *SlopePlan) Certificate(hx, hy int) SlopeCertificate {
	c := SlopeCertificate{Labels: make([]int, len(p.Ground)), Home: -1}
	for i := range c.Labels {
		c.Labels[i] = -1
	}
	sizes := []int{}
	deliberate := []bool{}
	q := make([]int, 0, len(p.Ground))
	for i := range p.Ground {
		if !p.Walkable(i) || c.Labels[i] >= 0 {
			continue
		}
		id := len(sizes)
		q = append(q[:0], i)
		c.Labels[i] = id
		intent := true
		for head := 0; head < len(q); head++ {
			intent = intent && p.Ground[q[head]].Unreachable
			for d := 0; d < 4; d++ {
				j := p.Step(q[head], d)
				if j >= 0 && c.Labels[j] < 0 {
					c.Labels[j] = id
					q = append(q, j)
				}
			}
		}
		sizes = append(sizes, len(q))
		deliberate = append(deliberate, intent)
	}
	c.Components = len(sizes)
	if i := p.Index(hx, hy); i >= 0 {
		c.Home = c.Labels[i]
	}
	for id, n := range sizes {
		if id == c.Home {
			c.HomeTiles = n
		} else if deliberate[id] {
			c.IntentionalComponents++
			c.IntentionalTiles += n
		} else {
			c.StrandedComponents++
			c.StrandedTiles += n
		}
	}
	return c
}

// Route is a shortest cardinal route; forbidden tiles let the lab measure a
// genuine end detour with the saddle closed, against the same endpoints.
func (p *SlopePlan) Route(a, b [2]int, forbidden func(int, int) bool) [][2]int {
	start, end := p.Index(a[0], a[1]), p.Index(b[0], b[1])
	if !p.Walkable(start) || !p.Walkable(end) {
		return nil
	}
	prev := make([]int32, len(p.Ground))
	for i := range prev {
		prev[i] = -1
	}
	prev[start] = int32(start)
	q := []int{start}
	for head := 0; head < len(q) && prev[end] < 0; head++ {
		for d := 0; d < 4; d++ {
			j := p.Step(q[head], d)
			if j < 0 || prev[j] >= 0 {
				continue
			}
			x, y := p.X+j%p.W, p.Y+j/p.W
			if forbidden != nil && forbidden(x, y) {
				continue
			}
			prev[j] = int32(q[head])
			q = append(q, j)
		}
	}
	if prev[end] < 0 {
		return nil
	}
	out := [][2]int{}
	for i := end; ; i = int(prev[i]) {
		out = append(out, [2]int{p.X + i%p.W, p.Y + i/p.W})
		if i == start {
			break
		}
	}
	for a, b := 0, len(out)-1; a < b; a, b = a+1, b-1 {
		out[a], out[b] = out[b], out[a]
	}
	return out
}
