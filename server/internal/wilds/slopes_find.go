package wilds

// Diagnostics for finding the existing recipe's features. No geometry is
// changed here. Owners have open transit rims (slopes_ranges_test.go); a
// stand's component must meet that rim, the shared backbone leading home.
import (
	"context"
	"math"
)

type SlopeFeature struct {
	Kind   string  `json:"kind"`
	Target [2]int  `json:"target"`
	Stand  [2]int  `json:"stand"`
	Level  float64 `json:"level"`
	Owner  [2]int  `json:"owner"`
}

// SlopeRangeMarkers reads only the analytic plan, never a surface or graph.
func SlopeRangeMarkers(seed, recipe string, ox, oy int) ([]SlopeFeature, error) {
	s, err := NewSlopeSamplerRecipe(seed, recipe)
	if err != nil {
		return nil, err
	}
	r := s.owner(ox*SlopeOwnerTiles+288, oy*SlopeOwnerTiles+288)
	pass := [2]int{r.PassX, r.Y}
	if recipe == SlopeRecipeV2 {
		rr := s.rangeV2(r.X, r.Y)
		pass = rr.world(rr.notch, rr.axis(rr.notch))
	}
	out := []SlopeFeature{}
	if slopeHomeDistance(pass[0], pass[1]) > 240 {
		out = append(out, SlopeFeature{Kind: "pass", Target: pass})
	}
	if s.Tile(r.Spire[0], r.Spire[1]).Unreachable {
		out = append(out, SlopeFeature{Kind: "spire", Target: r.Spire})
	}
	return out, nil
}

// SlopeOwnerFeatures certifies exactly one 576² owner. The caller searches
// at most the 3×3 owners around the player; it never expands a search.
// Certification concerns height geometry, not separately generated cover.
func SlopeOwnerFeatures(ctx context.Context, seed, recipe string, ox, oy int) ([]SlopeFeature, error) {
	p, err := NewSlopePlanRecipe(ctx, seed, recipe, ox*SlopeOwnerTiles, oy*SlopeOwnerTiles, SlopeOwnerTiles, SlopeOwnerTiles)
	if err != nil {
		return nil, err
	}
	c := p.Certificate(p.X, p.Y)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	connected := func(x, y int) bool {
		i := p.Index(x, y)
		return i >= 0 && c.Home >= 0 && c.Labels[i] == c.Home && p.Walkable(i) && !p.Ground[i].Unreachable
	}
	// Refuse a broken transit rim rather than calling an isolated component
	// home-connected. Exact Step checks include both corners and edge flags.
	for j := 0; j < SlopeOwnerTiles-1; j++ {
		for _, v := range [][3]int{{p.X + j, p.Y, 1}, {p.X + j, p.Y + 575, 1}, {p.X, p.Y + j, 2}, {p.X + 575, p.Y + j, 2}} {
			if !connected(v[0], v[1]) || p.Step(p.Index(v[0], v[1]), v[2]) < 0 {
				return nil, nil
			}
		}
	}
	// The backbone in the home owner must actually reach the Commons.
	if p.Index(12, 30) >= 0 && !connected(12, 30) {
		return nil, nil
	}
	level := func(x, y int) float64 {
		t := p.Tile(p.Index(x, y))
		sum := 0
		for _, z := range t.Corners {
			sum += int(z)
		}
		return float64(sum) / (4 * SlopeHeightUnit)
	}
	clear := func(x, y int) bool {
		if !connected(x, y) {
			return false
		}
		for d := 0; d < 4; d++ {
			if p.Step(p.Index(x, y), d) < 0 {
				return false
			}
		}
		return true
	}
	out := []SlopeFeature{}
	add := func(kind string, target [2]int, desired [2]int, radius int) {
		best := math.Inf(1)
		var stand [2]int
		for y := desired[1] - radius; y <= desired[1]+radius; y++ {
			for x := desired[0] - radius; x <= desired[0]+radius; x++ {
				d := math.Hypot(float64(x-desired[0]), float64(y-desired[1]))
				if d < best && clear(x, y) {
					best = d
					stand = [2]int{x, y}
				}
			}
		}
		if !math.IsInf(best, 1) {
			out = append(out, SlopeFeature{kind, target, stand, level(stand[0], stand[1]), [2]int{ox, oy}})
		}
	}
	r := p.Ranges[0]
	s, _ := NewSlopeSamplerRecipe(seed, recipe)
	crest := r.Crest
	pass := [2]int{r.PassX, r.Y}
	ends := r.PassEnds
	var forbidden func(int, int) bool
	if recipe == SlopeRecipeV2 {
		rr := s.rangeV2(r.X, r.Y)
		pass = rr.world(rr.notch, rr.axis(rr.notch))
		forbidden = func(x, y int) bool { a, _ := rr.local(x, y); return math.Abs(a-rr.notch) > 2 }
	} else {
		for x := r.X - r.HalfLength; x <= r.X+r.HalfLength; x += 8 {
			crest = append(crest, [2]int{x, r.Y + int(math.Round(9*math.Sin(float64(x-r.X)/87)))})
		}
		ends = [2][2]int{{r.PassX, r.Y - 112}, {r.PassX, r.Y + 112}}
		forbidden = func(x, y int) bool { return abs(x-r.PassX) > 2 }
	}
	// The pass is selected from an exact cardinal crossing of the planned
	// saddle, with both endpoints in the certified home component.
	if connected(ends[0][0], ends[0][1]) && connected(ends[1][0], ends[1][1]) {
		path := p.Route(ends[0], ends[1], forbidden)
		best := math.Inf(1)
		var at [2]int
		for _, pt := range path {
			d := math.Hypot(float64(pt[0]-pass[0]), float64(pt[1]-pass[1]))
			if d < best && clear(pt[0], pt[1]) {
				best = d
				at = pt
			}
		}
		if !math.IsInf(best, 1) {
			add("pass", pass, at, 0)
		}
	}
	// Aim at actual upper rock; land on its nearest walkable shoulder.
	bestZ := -1.0
	var peak [2]int
	for _, pt := range crest {
		i := p.Index(pt[0], pt[1])
		if i >= 0 && p.Ground[i].Kind == SlopeCrag && level(pt[0], pt[1]) > bestZ {
			bestZ = level(pt[0], pt[1])
			peak = pt
		}
	}
	if bestZ >= 0 {
		add("crest", peak, peak, 64)
	}
	if i := p.Index(r.Spire[0], r.Spire[1]); i >= 0 && p.Ground[i].Unreachable {
		// The nearest connected ground outside the deliberate footprint.
		// The dev camera fits the spire, rather than standing in its shadow.
		add("spire", r.Spire, r.Spire, 48)
	}
	// Outcrops have a gentle north approach and an explicit south face.
	if i := p.Index(r.Outcrop[0], r.Outcrop[1]); i >= 0 && p.Ground[i].Kind == SlopeCliff {
		add("outcrop-top", r.Outcrop, [2]int{r.Outcrop[0], r.Outcrop[1] - 3}, 8)
		add("outcrop-foot", r.Outcrop, [2]int{r.Outcrop[0], r.Outcrop[1] + 8}, 5)
	}
	// Hills are broad ordinary raised ground outside the mountain features.
	// Retain bounded 24-tile samples so "nearest" follows the caller, rather
	// than always sending them to a single arbitrary hill in an owner.
	for y := p.Y + 12; y < p.Y+p.H; y += 24 {
		for x := p.X + 12; x < p.X+p.W; x += 24 {
			if !clear(x, y) {
				continue
			}
			z := level(x, y)
			if z < 0.7 || z > 3 || math.Hypot(float64(x-r.X), float64(y-r.Y)) < 230 {
				continue
			}
			out = append(out, SlopeFeature{"hills", [2]int{x, y}, [2]int{x, y}, z, [2]int{ox, oy}})
		}
	}
	// A tunnel candidate remains metadata: two reachable mouths separated
	// by blocked rock, never a promised traversable tunnel.
	t := r.TunnelEnds
	if recipe == SlopeRecipe {
		t = [2][2]int{{r.X - 88, r.Y - 32}, {r.X - 88, r.Y + 32}}
	}
	if connected(t[0][0], t[0][1]) && connected(t[1][0], t[1][1]) {
		blocked := false
		for k := 0; k <= 64; k++ {
			x := t[0][0] + (t[1][0]-t[0][0])*k/64
			y := t[0][1] + (t[1][1]-t[0][1])*k/64
			if !connected(x, y) {
				blocked = true
			}
		}
		if blocked {
			add("tunnel", t[0], t[0], 8)
		}
	}
	return out, nil
}
