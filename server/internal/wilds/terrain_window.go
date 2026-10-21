package wilds

// The walk lab's window (exp/terrain-walk): a bounded slice of real world
// near home, its tops from TerrainWorld, solved by both access strategies
// from the same structural samples and mandatory fixtures. Dev preview
// only: GenerateV3, the protocol and the database never see it.

import (
	"fmt"
	"slices"
)

// TerrainWindowSpec is a window of whole chunks (world chunk coordinates,
// so chunk seams in the window are the world's) and its mandatory fixtures.
type TerrainWindowSpec struct {
	CX0, CY0, CW, CH int
	// Held are old kept chunks: flat level 0, every open boundary edge an
	// exit that must stay open, as the spike's legacy fixtures.
	Held [][2]int
	// Flat are protected flat chunks (Town, the Tangle): level 0, never
	// carved by a ramp. Their exits are not constraints (the apron is flat).
	Flat [][2]int
	// Saved, when set, is a search box (world tiles x0,y0,x1,y1) for an old
	// saved foot position on a chunk rim that the new stencil makes a face:
	// a protected 2x2 level-0 landing, as the spike's saved-player fixture.
	Saved *[4]int
	// Anchors in world tiles; the first is home, the certificate's root.
	Anchors []TerrainAnchor
}

// TerrainWalkSpec is the walk lab's window on the map seed: chunks -3..11
// by -9..3, from Town's north half and the Tangle up through the named
// Whitequiet place to the level-3 wall in the north, and east over the
// shoulders to the Tops. Two diagonal held chunks sit on the shoulders
// (lane A's corner case on real ground) with a third beside them, and a
// saved foot position on a chunk rim inside a shoulder face.
func TerrainWalkSpec() TerrainWindowSpec {
	s := TerrainWindowSpec{CX0: -3, CY0: -9, CW: 15, CH: 13}
	s.Held = [][2]int{{5, -2}, {6, -3}, {6, -1}}
	for cy := -9; cy <= 3; cy++ {
		for cx := -3; cx <= 11; cx++ {
			if FixedFootprintAt(cx, cy) != nil {
				s.Flat = append(s.Flat, [2]int{cx, cy})
			} else if fp := FootprintAt(cx, cy); fp != nil && fp.GetId() == "tangle" {
				s.Flat = append(s.Flat, [2]int{cx, cy})
			}
		}
	}
	s.Saved = &[4]int{-3 * 24, -8 * 24, 4 * 24, 0}
	s.Anchors = []TerrainAnchor{{"home", 12, 30}, {"tangle", 12, -20}, {"held-a", 5*24 + 12, -2*24 + 12}, {"held-b", 6*24 + 12, -3*24 + 12}, {"held-c", 6*24 + 12, -1*24 + 12}}
	return s
}

// terrainOffset reads world fields from window coordinates. The window's
// origin is chunk-aligned, so every stencil sees world tiles.
type terrainOffset struct {
	f    TerrainFields
	x, y int
}

func (o terrainOffset) Top(x, y int) uint8 { return o.f.Top(x+o.x, y+o.y) }

// TerrainWindowPlan is a solved window: the plan in window tiles (origin
// at world tile X0,Y0) and the structural tops it was solved from.
type TerrainWindowPlan struct {
	*TerrainPlan
	X0, Y0 int
}

func terrainWindowBase(f TerrainFields, s TerrainWindowSpec) (*TerrainPlan, int, int, error) {
	if s.CW <= 0 || s.CH <= 0 || s.CW*s.CH > 400 {
		return nil, 0, 0, fmt.Errorf("terrain window must be 1..400 chunks")
	}
	x0, y0 := s.CX0*24, s.CY0*24
	p := &TerrainPlan{W: s.CW * 24, H: s.CH * 24}
	local := cacheTerrain(terrainOffset{f, x0, y0}, 0, 0, p.W, p.H)
	p.Tiles = make([]TerrainTile, p.W*p.H)
	for y := 0; y < p.H; y++ {
		for x := 0; x < p.W; x++ {
			p.Tiles[y*p.W+x] = TerrainLocal(local, x, y)
		}
	}
	in := func(c [2]int) bool {
		return c[0] >= s.CX0 && c[1] >= s.CY0 && c[0] < s.CX0+s.CW && c[1] < s.CY0+s.CH
	}
	for _, c := range s.Flat {
		if !in(c) {
			continue
		}
		lx, ly := (c[0]-s.CX0)*24, (c[1]-s.CY0)*24
		for y := ly; y < ly+24; y++ {
			for x := lx; x < lx+24; x++ {
				i := y*p.W + x
				p.Tiles[i] = terrainFlat(0)
				p.Tiles[i].Protected = true
			}
		}
	}
	// Held chunks, as the spike: all constraints are gathered before the
	// new-side landings, so a shared corner never depends on order.
	for _, c := range s.Held {
		if !in(c) {
			return nil, 0, 0, fmt.Errorf("held chunk %v outside the window", c)
		}
		lx, ly := (c[0]-s.CX0)*24, (c[1]-s.CY0)*24
		for y := ly; y < ly+24; y++ {
			for x := lx; x < lx+24; x++ {
				i := y*p.W + x
				p.Tiles[i] = terrainFlat(0)
				p.Tiles[i].Protected = true
				for d := 0; d < 4; d++ {
					xx, yy := x+terrainDX[d], y+terrainDY[d]
					if (xx < lx || yy < ly || xx >= lx+24 || yy >= ly+24) && p.index(xx, yy) >= 0 {
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
	for _, a := range s.Anchors {
		i := p.index(a.X-x0, a.Y-y0)
		if i < 0 || !TerrainWalkable(p.Tiles[i]) {
			return nil, 0, 0, fmt.Errorf("anchor %s is not floor", a.Name)
		}
		p.Anchors = append(p.Anchors, TerrainAnchor{a.Name, a.X - x0, a.Y - y0})
	}
	if s.Saved != nil {
		b := s.Saved
		found := false
		for y := max(b[1]-y0, 0); y <= min(b[3]-y0, p.H-2) && !found; y++ {
			if y%24 != 0 {
				continue // the landing's two rows are a chunk's top rim
			}
			for x := max(b[0]-x0, 0); x <= min(b[2]-x0, p.W-2); x++ {
				if x%24 < 4 || x%24 > 20 {
					continue
				}
				face := true
				for yy := y; yy < y+2; yy++ {
					for xx := x; xx < x+2; xx++ {
						t := p.Tiles[yy*p.W+xx]
						face = face && t.Kind == TerrainFace && !t.Protected
					}
				}
				if !face {
					continue
				}
				p.Anchors = append(p.Anchors, TerrainAnchor{"saved-player", x, y})
				for yy := y; yy < y+2; yy++ {
					for xx := x; xx < x+2; xx++ {
						j := yy*p.W + xx
						p.Tiles[j] = terrainFlat(0)
						p.Tiles[j].Protected = true
					}
				}
				found = true
				break
			}
		}
	}
	return p, x0, y0, nil
}

// NewTerrainWindow solves a window by one strategy. "region" repairs the
// whole window as one plan; "chunk" repairs each chunk's 2..21 interior
// alone, as lane A's per-chunk repair. Neither publishes or errors on a
// failed certificate: the lab shows what each leaves stranded.
func NewTerrainWindow(f TerrainFields, s TerrainWindowSpec, strategy string) (*TerrainWindowPlan, error) {
	p, x0, y0, err := terrainWindowBase(f, s)
	if err != nil {
		return nil, err
	}
	p.Strategy = strategy
	switch strategy {
	case "region":
		p.repairBatched(0, 0, p.W-1, p.H-1)
	case "chunk":
		for cy := 0; cy < p.H/24; cy++ {
			for cx := 0; cx < p.W/24; cx++ {
				local := &TerrainPlan{W: 24, H: 24, Tiles: make([]TerrainTile, 576)}
				for y := 0; y < 24; y++ {
					copy(local.Tiles[y*24:(y+1)*24], p.Tiles[(cy*24+y)*p.W+cx*24:])
				}
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
	return &TerrainWindowPlan{p, x0, y0}, nil
}

// repairBatched is repair for a large window: the same candidate rules,
// score and exact recomputation, but each pass carves every best candidate
// that joins a pair of components not yet joined in that pass and whose
// footprint (with a one-tile margin) touches no other ramp of the pass.
// The first pick of each pass is exactly repair's. Splits a ramp makes are
// found by the next pass's fresh certificate, as in repair.
func (p *TerrainPlan) repairBatched(x0, y0, x1, y1 int) {
	type cand struct {
		s     terrainRampSpec
		score int
		order int
	}
	for pass := 0; pass < 256; pass++ {
		c := p.Certificate()
		if c.Components <= 1 {
			return
		}
		// Best candidate per unordered component pair.
		best := map[[2]int]cand{}
		order := 0
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
						delta := abs(int(a.Edges[d] - b.Edges[(d+2)%4]))
						if delta > n*64 {
							continue
						}
						spec := terrainRampSpec{x, y, d, n, a.Edges[d], b.Edges[(d+2)%4]}
						key := [2]int{min(c.Labels[i], c.Labels[j]), max(c.Labels[i], c.Labels[j])}
						score := n + delta/16
						if have, ok := best[key]; ok && have.score <= score {
							continue
						}
						if !p.rampFits(spec, x0, y0, x1, y1, c.Labels) {
							continue
						}
						order++
						best[key] = cand{spec, score, order}
					}
				}
			}
		}
		if len(best) == 0 {
			p.rejectTinyShelves(x0, y0, x1, y1, c)
			return
		}
		list := make([]cand, 0, len(best))
		for _, v := range best {
			list = append(list, v)
		}
		slices.SortFunc(list, func(a, b cand) int {
			if a.score != b.score {
				return a.score - b.score
			}
			return a.order - b.order
		})
		parent := make([]int, c.Components)
		for i := range parent {
			parent[i] = i
		}
		var find func(int) int
		find = func(i int) int {
			for parent[i] != i {
				parent[i] = parent[parent[i]]
				i = parent[i]
			}
			return i
		}
		used := map[int]bool{}
		for _, k := range list {
			s := k.s
			la, lb := find(c.Labels[p.index(s.x, s.y)]), 0
			ex, ey := s.xy(s.n+1, 0)
			lb = find(c.Labels[p.index(ex, ey)])
			if la == lb {
				continue
			}
			clash := false
			var foot []int
			for lane := -1; lane <= 2 && !clash; lane++ {
				for kk := -1; kk <= s.n+2; kk++ {
					x, y := s.xy(kk, lane)
					i := p.index(x, y)
					if i < 0 {
						continue
					}
					if used[i] {
						clash = true
						break
					}
					foot = append(foot, i)
				}
			}
			if clash {
				continue
			}
			for _, i := range foot {
				used[i] = true
			}
			parent[la] = lb
			p.carveRamp(s)
			p.Ramps++
		}
	}
}
