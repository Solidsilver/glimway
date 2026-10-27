package wilds

import (
	"context"
	"fmt"
	"math"
	"slices"
	"testing"
)

// The footprint is the analytic support of the main shoulder, tributary,
// pinnacle and outcrop, including their zero-height outer fringe. It excludes
// the rest of the owner square, so low country cannot dilute the rock share.
func rangeFootprint(r *slopeRangeV2, x, y int) bool {
	a, b := r.local(x, y)
	return ((math.Abs(a) < float64(r.HalfLength) && math.Abs(b-r.axis(a)) < r.Width+9*math.Sin(a/63+r.phase)) ||
		(r.branchHeight > 0 && a > 24 && a < 146 && math.Abs(b-r.fork(a)) < 58)) && math.Hypot(a, b) < 250 ||
		math.Hypot(float64(x-r.Spire[0]), float64(y-r.Spire[1])) < 29 ||
		(abs(x-r.Outcrop[0]) < 38 && y >= r.Outcrop[1]-64 && y < r.Outcrop[1]+6)
}

func TestSlopeRangesWalkability(t *testing.T) {
	for _, seed := range []string{"map", "slopes-17", "slopes-991"} {
		p, err := NewSlopePlanRecipe(context.Background(), seed, SlopeRecipeV2, -576, -576, 1152, 1152)
		if err != nil {
			t.Fatal(err)
		}
		c := p.Certificate(12, 30)
		s, _ := NewSlopeSamplerRecipe(seed, SlopeRecipeV2)
		for _, rr := range p.Ranges {
			r := s.rangeV2(rr.X, rr.Y)
			kinds := [4]int{}
			high := [3]int{}
			n, walk, homeHigh := 0, 0, 0
			gradients := []float64{}
			target := [2]int{}
			maxZ := 0.0
			for y := floorDiv(r.Y, 576) * 576; y < floorDiv(r.Y, 576)*576+576; y++ {
				for x := floorDiv(r.X, 576) * 576; x < floorDiv(r.X, 576)*576+576; x++ {
					if !rangeFootprint(r, x, y) {
						continue
					}
					i := p.Index(x, y)
					tile := p.Tile(i)
					n++
					kinds[tile.Kind]++
					z := float64(int(tile.Corners[0])+int(tile.Corners[1])+int(tile.Corners[2])+int(tile.Corners[3])) / 1024
					if !tile.Unreachable && tile.Kind != SlopeCliff {
						gradients = append(gradients, math.Sqrt(float64(SlopeGradientSquared(tile.Corners)))/256)
					}
					if p.Walkable(i) && !tile.Unreachable {
						walk++
						for k, level := range []float64{3, 6, 9} {
							if z > level {
								high[k]++
							}
						}
						if z >= 8 && c.Labels[i] == c.Home {
							homeHigh++
							if z > maxZ {
								target = [2]int{x, y}
								maxZ = z
							}
						}
					}
				}
			}
			slices.Sort(gradients)
			fmt.Printf("RANGE %s %s n=%d kinds=%.2f/%.2f/%.2f/%.2f walk=%.2f high3/6/9=%v home8=%d shoulder-p95=%.4f\n", seed, r.ID, n, 100*float64(kinds[0])/float64(n), 100*float64(kinds[1])/float64(n), 100*float64(kinds[2])/float64(n), 100*float64(kinds[3])/float64(n), 100*float64(walk)/float64(n), high, homeHigh, gradients[(len(gradients)*95)/100])
			if float64(walk)/float64(n) < 0.75 {
				t.Errorf("%s %s: less than 75%% walkable", seed, r.ID)
			}
			if gradients[len(gradients)*95/100] > 0.225 {
				t.Errorf("%s %s: typical shoulder exceeds 90%% of walk limit", seed, r.ID)
			}
			if homeHigh >= 50 && len(p.Route([2]int{12, 30}, target, func(x, y int) bool {
				a, b := r.local(x, y)
				return math.Abs(a-r.notch) < 4 && math.Abs(b-r.axis(r.notch)) < 26
			})) == 0 {
				t.Errorf("%s %s: high ground requires the pass", seed, r.ID)
			}
			if homeHigh < 50 {
				t.Errorf("%s %s: no substantial home-connected level-8 shoulder", seed, r.ID)
			}
		}
	}
}
