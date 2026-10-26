package wilds

import (
	"fmt"
	"math"
)

const SlopeRecipeV2 = "slopes-gen@2"

// NewSlopeSamplerRecipe selects geography independently of the surface/codec
// contract. The original constructor and SlopeRecipe remain frozen at @1.
func NewSlopeSamplerRecipe(seed, recipe string) (*SlopeSampler, error) {
	if recipe != SlopeRecipe && recipe != SlopeRecipeV2 {
		return nil, fmt.Errorf("unknown slope recipe %q", recipe)
	}
	s := NewSlopeSampler(seed)
	s.recipe = recipe
	s.rangesV2 = map[[2]int]*slopeRangeV2{}
	return s, nil
}

// Every feature has support inside radius 250 of the jittered centre.
// Centre jitter is at most 32 per axis: 250+32 < 288, so relief and masks
// vanish before a 576-tile owner border. Only the world-wide base survives
// there; evaluating the containing owner needs no neighbouring plans.
type slopeRangeV2 struct {
	SlopeRange
	cos, sin, phase, notch, branchSide float64
}

func (r *slopeRangeV2) world(u, v float64) [2]int {
	return [2]int{r.X + int(math.Round(u*r.cos-v*r.sin)), r.Y + int(math.Round(u*r.sin+v*r.cos))}
}
func (r *slopeRangeV2) local(x, y int) (float64, float64) {
	dx, dy := float64(x-r.X), float64(y-r.Y)
	return dx*r.cos + dy*r.sin, -dx*r.sin + dy*r.cos
}
func (r *slopeRangeV2) axis(u float64) float64 {
	return 25*math.Sin(u/72+r.phase) + 12*math.Sin(u/35-r.phase) + 5*math.Sin(u/13+r.phase)
}
func (r *slopeRangeV2) fork(u float64) float64 {
	return r.axis(u) + r.branchSide*(u-24)*0.72
}
func (s *SlopeSampler) rangeV2(x, y int) *slopeRangeV2 {
	key := [2]int{floorDiv(x, SlopeOwnerTiles), floorDiv(y, SlopeOwnerTiles)}
	if r := s.rangesV2[key]; r != nil {
		return r
	}
	h := landformV2Hash(s.Seed, "slopes-gen@2:range", key[0], key[1])
	r := &slopeRangeV2{}
	r.ID = fmt.Sprintf("range:%d:%d", key[0], key[1])
	r.X, r.Y = key[0]*576+288+int(h%65)-32, key[1]*576+288+int(h>>7%65)-32
	r.Angle = float64(h>>14%6283) / 1000
	r.sin, r.cos = math.Sincos(r.Angle)
	r.phase = float64(h>>5%6283) / 1000
	r.notch = float64(int(h>>19%33) - 16)
	r.branchSide = 1
	if h&1 != 0 {
		r.branchSide = -1
	}
	r.HalfLength = 158 + int(h>>24%29)
	r.Width = 74 + float64(h>>10%17)
	// Lane B's continuous upland and relief choose mountain character. No
	// categorical biome multiplier can create a wall at a region boundary.
	u, relief := s.fields(r.X, r.Y)
	r.Height = 7 + 3*u + relief
	pass := r.world(r.notch, r.axis(r.notch))
	r.PassX = pass[0] // retained for old diagnostic readers; V2 uses PassEnds
	r.PassEnds = [2][2]int{r.world(r.notch, r.axis(r.notch)-112), r.world(r.notch, r.axis(r.notch)+112)}
	r.TunnelEnds = [2][2]int{r.world(-88, r.axis(-88)-32), r.world(-88, r.axis(-88)+32)}
	r.Outcrop = [2]int{r.X - 142, r.Y + 166}
	best := math.Inf(-1)
	for _, pt := range [][2]int{r.world(-65, -174*r.branchSide), r.world(65, -174*r.branchSide), r.world(-65, 174*r.branchSide), r.world(65, 174*r.branchSide)} {
		if d := slopeHomeDistance(pt[0], pt[1]); d > best {
			r.Spire = pt
			best = d
		}
	}
	// Move the outcrop to the other side if the far-home pinnacle occupies
	// its approach. Pinnacles must stay outside the protected-land envelope.
	if math.Hypot(float64(r.Spire[0]-r.Outcrop[0]), float64(r.Spire[1]-r.Outcrop[1])) < 110 {
		r.Outcrop[0] = r.X + 142
	}
	for t := -r.HalfLength; t <= r.HalfLength; t += 8 {
		r.Crest = append(r.Crest, r.world(float64(t), r.axis(float64(t))))
	}
	for t := 24; t <= 140; t += 8 {
		r.Branch = append(r.Branch, r.world(float64(t), r.fork(float64(t))))
	}
	s.rangesV2[key] = r
	return r
}

func (s *SlopeSampler) shapeV2(x, y int) (float64, bool, bool) {
	d := slopeHomeDistance(x, y)
	if d <= 24 {
		return 0, false, false
	}
	u, relief := s.fields(x, y)
	home, far := slopeEase((d-24)/120), slopeEase((d-144)/96)
	// Smooth warped hills survive outside the range footprints. Frequencies
	// and amplitudes keep ordinary low country comfortably below the limit.
	wx := float64(x) + 18*math.Sin(float64(y)/103)
	wy := float64(y) + 15*math.Sin(float64(x)/127)
	base := (2.6*u + (0.35+0.65*relief)*math.Sin(wx/23)*math.Sin(wy/29)) * home
	r := s.rangeV2(x, y)
	a, b := r.local(x, y)
	dy := b - r.axis(a)
	end := slopeEase((float64(r.HalfLength) - math.Abs(a)) / 58)
	notch := 1 - 0.985*slopeTent(a-r.notch, 66)
	width := r.Width + 9*math.Sin(a/63+r.phase)
	crownWidth := 17 + 5*math.Sin(a/49+r.phase) + 2*math.Sin(a/11-r.phase)
	peak := 0.72 + 0.18*math.Sin(a/29+r.phase) + 0.10*math.Sin(a/13-r.phase)
	lower := 3.1 * (0.82 + 0.18*math.Sin(a/31+r.phase)) * slopeTent(dy, width) * end * (0.32 + 0.68*notch)
	upper := (r.Height - 3.1) * slopeTent(dy, crownWidth) * end * notch * peak
	// A tapering tributary spur splits from the main ridge. Max, rather than
	// addition, leaves a sheltered bowl between the two without over-tall joins.
	branchEnd := slopeEase((a-24)/40) * slopeEase((146-a)/50)
	branchDY := b - r.fork(a)
	lower = math.Max(lower, 2.7*slopeTent(branchDY, 58)*branchEnd)
	upper = math.Max(upper, (r.Height-3.8)*slopeTent(branchDY, 16)*branchEnd*0.72)
	z := base + (lower+upper)*far
	z += 0.24 * relief * math.Sin(a/6+r.phase) * math.Sin(a/13) * slopeTent(dy, crownWidth) * end * notch * far
	// Crag follows only the narrow upper ridges. It overlaps their steep
	// shoulders, avoiding incidental walkable slivers on the serrated crest.
	crest := far > 0.2 && ((math.Abs(dy) < crownWidth+3 && end*notch > 0.20) || (math.Abs(branchDY) < 19 && branchEnd > 0.20))
	// Join the fork headwall until the bowl has eight tiles of clearance.
	// Two almost-touching ribbons otherwise leave isolated quantized slivers.
	if far > 0.2 && end*notch > 0.20 && branchEnd > 0.20 && math.Abs(r.fork(a)-r.axis(a)) < crownWidth+30 && b > math.Min(r.axis(a), r.fork(a)) && b < math.Max(r.axis(a), r.fork(a)) {
		crest = true
	}
	// A faceted, asymmetrical pinnacle: warped diamond sections, not a round
	// cone. The deliberately unreachable footprint is set before certification.
	dx, dySpire := float64(x-r.Spire[0]), float64(y-r.Spire[1])
	sx, sy := dx*r.cos+dySpire*r.sin, -dx*r.sin+dySpire*r.cos
	sd := math.Abs(sx+0.28*sy+2.5*math.Sin(sy/5)) + 0.78*math.Abs(sy)
	spire := sd < 21 && far > 0.99
	if spire {
		z = math.Max(z, base+(15-base)*slopeEase((21-sd)/17.5))
	}
	ox, oy := float64(x-r.Outcrop[0]), y-r.Outcrop[1]
	if oy < 0 {
		z += 2 * slopeTent(ox, 38) * slopeEase(float64(oy+64)/64) * far
	}
	return math.Max(0, z), crest, spire
}
