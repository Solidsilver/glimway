package wilds

import "fmt"

// GenerateTerrainChunk clips a warm region plan, or performs an independent
// local solve using only structural samples and mandatory protected fixtures.
// Local generation never reads another generated chunk's mutable geometry.
func GenerateTerrainChunk(f TerrainFields, constraints *TerrainPlan, cx, cy int, strategy string) ([]TerrainTile, error) {
	if strategy == "region" {
		return constraints.Chunk(cx, cy)
	}
	if cx < 0 || cy < 0 || cx >= 20 || cy >= 8 {
		return nil, fmt.Errorf("outside spike domain")
	}
	f = cacheTerrain(f, cx*24, cy*24, 24, 24)
	p := &TerrainPlan{W: 24, H: 24, Tiles: make([]TerrainTile, 576)}
	for y := 0; y < 24; y++ {
		for x := 0; x < 24; x++ {
			wx, wy := cx*24+x, cy*24+y
			t := TerrainLocal(f, wx, wy)
			if fixed := constraints.Tiles[wy*constraints.W+wx]; fixed.Protected {
				t = fixed
			}
			p.Tiles[y*24+x] = t
		}
	}
	p.repair(2, 2, 21, 21)
	return p.Tiles, nil
}

// NewTerrainSpike runs both policies against precisely the same local geometry
// and mandatory constraints. The local policy never edits a two-tile chunk rim.
// It reports unrepairable components instead of demoting boundary land and
// making neighbouring chunks disagree.
func NewTerrainSpike(f TerrainFields, strategy string) (*TerrainPlan, error) {
	p := terrainBase(f)
	p.Strategy = strategy
	switch strategy {
	case "region":
		// Realize the principal pass before repairing optional shelves. Global
		// connectivity alone would allow every walk to go around a range end.
		p.saddleRamps()
		p.repair(0, 0, p.W-1, p.H-1)
	case "chunk":
		for cy := 0; cy < p.H/24; cy++ {
			for cx := 0; cx < p.W/24; cx++ {
				tiles, _ := p.Chunk(cx, cy)
				local := &TerrainPlan{W: 24, H: 24, Tiles: tiles}
				local.repair(2, 2, 21, 21)
				p.Ramps += local.Ramps
				p.RejectedFloorTiles += local.RejectedFloorTiles
				for y := 0; y < 24; y++ {
					copy(p.Tiles[(cy*24+y)*p.W+cx*24:(cy*24+y)*p.W+cx*24+24], local.Tiles[y*24:(y+1)*24])
				}
			}
		}
	default:
		return nil, fmt.Errorf("terrain strategy must be region or chunk")
	}
	if strategy == "region" {
		c := p.Certificate()
		if c.StrandedComponents > 0 || c.HeldExitsKept != c.HeldExits || c.AnchorsReached != c.Anchors {
			return nil, fmt.Errorf("region certificate failed: %d stranded components, %d tiles; anchors %d/%d, exits %d/%d", c.StrandedComponents, c.StrandedTiles, c.AnchorsReached, c.Anchors, c.HeldExitsKept, c.HeldExits)
		}
		if !p.markRoute([][2]int{{228, 156}, {240, 156}, {240, 30}, {228, 20}}) || !p.markRoute([][2]int{{228, 156}, {456, 156}, {456, 20}, {228, 20}}) {
			return nil, fmt.Errorf("range loop routes failed")
		}
	}
	return p, nil
}

func (p *TerrainPlan) saddleRamps() {
	for y := 32; y < 140; y++ {
		for n := 4; n <= 12; n++ {
			if y+n+1 >= 144 {
				break
			}
			a, b := p.Tiles[p.index(240, y)], p.Tiles[p.index(240, y+n+1)]
			if a.Kind != TerrainFlat || b.Kind != TerrainFlat || a.Edges[2] == b.Edges[0] {
				continue
			}
			delta := int(a.Edges[2] - b.Edges[0])
			if delta < 0 {
				delta = -delta
			}
			if delta > n*64 {
				continue
			}
			s := terrainRampSpec{240, y, 2, n, a.Edges[2], b.Edges[0]}
			if p.rampFits(s, 228, 20, 252, 143, p.Certificate().Labels) {
				p.carveRamp(s)
				p.Ramps++
				break
			}
		}
	}
}

// repair uses exact components, seeking two-lane straight ramps with endpoint
// landings, a maximum rise of 1/4 level per tile, and a bounded 24-tile run.
// No protected floor, existing ramp or previously selected route is overwritten.
// Recompute after each change: inserting a ramp can split its former plateau.
func (p *TerrainPlan) repair(x0, y0, x1, y1 int) {
	for iteration := 0; iteration < 256; iteration++ {
		c := p.Certificate()
		if c.Components <= 1 {
			return
		}
		bestScore := int(^uint(0) >> 1)
		var best *terrainRampSpec
		for y := y0; y <= y1; y++ {
			for x := x0; x <= x1; x++ {
				i := p.index(x, y)
				if p.Tiles[i].Kind != TerrainFlat {
					continue
				}
				for _, d := range []int{1, 2} {
					for n := 4; n <= 24; n++ {
						ex, ey := x+terrainDX[d]*(n+1), y+terrainDY[d]*(n+1)
						if ex > x1 || ey > y1 {
							break
						}
						j := p.index(ex, ey)
						a, b := p.Tiles[i], p.Tiles[j]
						if b.Kind != TerrainFlat || a.Edges[d] == b.Edges[(d+2)%4] || c.Labels[i] == c.Labels[j] {
							continue
						}
						delta := int(a.Edges[d] - b.Edges[(d+2)%4])
						if delta < 0 {
							delta = -delta
						}
						if delta > n*64 {
							continue
						}
						spec := terrainRampSpec{x, y, d, n, a.Edges[d], b.Edges[(d+2)%4]}
						if !p.rampFits(spec, x0, y0, x1, y1, c.Labels) {
							continue
						}
						// Prefer low climbs and shorter construction, with stable ties.
						score := n + delta/16
						if score < bestScore {
							s := spec
							best = &s
							bestScore = score
						}
					}
				}
			}
		}
		if best == nil {
			p.rejectTinyShelves(x0, y0, x1, y1, c)
			return
		}
		p.carveRamp(*best)
		p.Ramps++
	}
}

// A ramp can leave a tiny optional plateau sliver. Reject it as rock rather
// than advertise an inaccessible floor. Protected land and chunk rims cannot
// be rejected; the corner bowl's 32 tiles and saved landing remain diagnostic.
func (p *TerrainPlan) rejectTinyShelves(x0, y0, x1, y1 int, c TerrainCertificate) {
	sizes := make([]int, c.Components)
	allowed := make([]bool, c.Components)
	for i := range allowed {
		allowed[i] = true
	}
	for i, label := range c.Labels {
		if label < 0 {
			continue
		}
		sizes[label]++
		t := p.Tiles[i]
		x, y := i%p.W, i/p.W
		if t.Protected || t.Route || x < x0 || x > x1 || y < y0 || y > y1 {
			allowed[label] = false
		}
	}
	for i, label := range c.Labels {
		if label < 0 || !allowed[label] || sizes[label] >= 16 {
			continue
		}
		t := &p.Tiles[i]
		t.Kind = TerrainRock
		t.Edges = [4]int16{-1, -1, -1, -1}
		t.FaceTop, t.FaceRow, t.FaceRows = 0, 0, 0
		t.Built = false
		p.RejectedFloorTiles++
	}
}

type terrainRampSpec struct {
	x, y, d, n int
	start, end int16
}

func (s terrainRampSpec) xy(k, lane int) (int, int) {
	return s.x + terrainDX[s.d]*k + terrainDY[s.d]*lane, s.y + terrainDY[s.d]*k + terrainDX[s.d]*lane
}
func (p *TerrainPlan) rampFits(s terrainRampSpec, x0, y0, x1, y1 int, labels []int) bool {
	a := p.index(s.x, s.y)
	ex, ey := s.xy(s.n+1, 0)
	b := p.index(ex, ey)
	for lane := 0; lane < 2; lane++ {
		for k := 0; k <= s.n+1; k++ {
			x, y := s.xy(k, lane)
			if x < x0 || x > x1 || y < y0 || y > y1 {
				return false
			}
			i := p.index(x, y)
			t := p.Tiles[i]
			if k == 0 {
				if t.Kind != TerrainFlat || t.Edges[s.d] != s.start || labels[i] != labels[a] {
					return false
				}
				continue
			}
			if k == s.n+1 {
				if t.Kind != TerrainFlat || t.Edges[(s.d+2)%4] != s.end || labels[i] != labels[b] {
					return false
				}
				continue
			}
			if t.Protected || t.Kind == TerrainRamp || t.Route {
				return false
			}
			// Avoid cutting through an unrelated third component.
			if TerrainWalkable(t) && labels[i] != labels[a] && labels[i] != labels[b] {
				return false
			}
		}
	}
	return true
}
func (p *TerrainPlan) carveRamp(s terrainRampSpec) {
	// Quantize each shared boundary once, with integer arithmetic.
	q := make([]int16, s.n+1)
	for k := range q {
		q[k] = s.start + int16(int(s.end-s.start)*k/s.n)
	}
	for lane := 0; lane < 2; lane++ {
		for k := 1; k <= s.n; k++ {
			x, y := s.xy(k, lane)
			i := p.index(x, y)
			t := &p.Tiles[i]
			t.Kind = TerrainRamp
			t.FaceTop = 0
			t.FaceRow = 0
			t.FaceRows = 0
			t.Built = p.Ramps%2 == 0
			t.Edges = [4]int16{-1, -1, -1, -1}
			t.Edges[(s.d+2)%4] = q[k-1]
			t.Edges[s.d] = q[k]
			side := 1
			if s.d == 1 {
				side = 2
			}
			if lane == 1 {
				side = (side + 2) % 4
			}
			t.Edges[side] = (q[k-1] + q[k]) / 2
		}
	}
}

// markRoute follows the realized walking graph between required waypoints.
// The saddle and the east-end alternative use disjoint crossing corridors.
func (p *TerrainPlan) markRoute(points [][2]int) bool {
	for k := 1; k < len(points); k++ {
		a, b := p.index(points[k-1][0], points[k-1][1]), p.index(points[k][0], points[k][1])
		prev := make([]int, len(p.Tiles))
		for i := range prev {
			prev[i] = -1
		}
		prev[a] = a
		q := []int{a}
		x0, y0 := min(points[k-1][0], points[k][0])-12, min(points[k-1][1], points[k][1])-12
		x1, y1 := max(points[k-1][0], points[k][0])+12, max(points[k-1][1], points[k][1])+12
		for head := 0; head < len(q) && prev[b] < 0; head++ {
			for d := 0; d < 4; d++ {
				j := p.Step(q[head], d)
				if j >= 0 && prev[j] < 0 && j%p.W >= x0 && j%p.W <= x1 && j/p.W >= y0 && j/p.W <= y1 {
					prev[j] = q[head]
					q = append(q, j)
				}
			}
		}
		if prev[b] < 0 {
			return false
		}
		for i := b; ; i = prev[i] {
			p.Tiles[i].Route = true
			if i == a {
				break
			}
		}
	}
	return true
}
