package wilds

import "fmt"

// Pass 4, the Lantern Road (open-map.md 2.2, decision 18). One line per
// world that never turns: from the Whitequiet's lantern-road opening it
// runs north road.northChunks chunks, bends road.bend, and runs on that way
// far past the frontier. Paved road.width tiles wide with a verge each
// side. A dark lamp stone stands beside it every road.lampStoneEvery chunks
// along it, a site with a fixed id, lamp-stone:<cx>:<cy> (lamps.md relights
// them in 0.9). It's a function of the world seed alone, so every epoch of
// a world agrees on it.

const roadReachChunks = 40 // how far past the bend the road runs

type road struct {
	line  *line
	half  int
	lamps map[[2]int]Tile // chunk → the lamp stone's local tile
	order [][2]int        // the chunks it passes, in order, footprints left out
}

func newRoad(seed string) *road {
	data := contentRules().GetRoad()
	S := chunkSize()
	rng := NewRng(Hash(seed, GeneratorV3, "lantern-road"))
	var ox, oy int
	for _, p := range contentRules().Places {
		if p.GetId() != data.GetFromPlace() {
			continue
		}
		for _, o := range p.GetOpenings() {
			if o.GetId() == data.GetFromOpening() {
				ox, oy = openingMiddle(o)
			}
		}
	}
	dir := 1
	if data.GetBend() == "west" {
		dir = -1
	}
	// Straight out of the opening, then north, then the bend and away.
	start := tileCentre(ox, oy+3)
	straight := tileCentre(ox, oy-8)
	north := int(data.GetNorthChunks()) * S
	knee := tileCentre(ox+rng.Spread(2), oy-north+6)
	bend := tileCentre(ox+dir*S, oy-north-4)
	controls := []pt{start, straight, knee, bend}
	y := oy - north - 4
	for i := 1; i <= roadReachChunks/2; i++ {
		y = clamp(y+rng.Spread(8), oy-north-4-S/2, oy-north-4+S/3)
		controls = append(controls, tileCentre(ox+dir*S+dir*i*2*S, y))
	}
	pts := []pt{start}
	for i := 0; i+1 < len(controls); i++ {
		depth := 2
		if i == 0 {
			depth = 0
		}
		pts = append(pts, displace(controls[i], controls[i+1], depth, 120, rng, nil)[1:]...)
	}
	r := &road{line: newLine(pts, nil), half: int(data.GetWidth()) * fp / 2, lamps: map[[2]int]Tile{}}
	r.line.boxes = nil
	for i := 0; i+1 < len(pts); i++ {
		r.line.boxes = append(r.line.boxes, segBox(pts[i], pts[i+1]).grow(r.half+fp))
	}

	// The chunks it passes, sampled every few tiles along it.
	seen := map[[2]int]bool{}
	var samples []pt
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		dx, dy := b.x-a.x, b.y-a.y
		n := max(isqrt(dx*dx+dy*dy)/(3*fp), 1)
		for k := 0; k < n; k++ {
			samples = append(samples, pt{a.x + dx*k/n, a.y + dy*k/n})
		}
	}
	for _, p := range samples {
		tx, ty := p.tile()
		c := [2]int{floorDiv(tx, S), floorDiv(ty, S)}
		if seen[c] || FootprintAt(c[0], c[1]) != nil {
			continue
		}
		seen[c] = true
		r.order = append(r.order, c)
	}
	every := int(data.GetLampStoneEvery())
	for i, c := range r.order {
		if i%every != 0 {
			continue
		}
		if t, ok := r.lampTile(c, samples, i); ok {
			r.lamps[c] = t
		}
	}
	return r
}

// lampTile: beside the road, on the verge's far side, at the sample nearest
// the chunk's middle that leaves it inside the chunk's interior (sides
// alternate along the road).
func (r *road) lampTile(c [2]int, samples []pt, i int) (Tile, bool) {
	S := chunkSize()
	mid := tileCentre(c[0]*S+S/2, c[1]*S+S/2)
	side := 1
	if i/int(contentRules().GetRoad().GetLampStoneEvery())%2 == 1 {
		side = -1
	}
	type cand struct {
		t Tile
		d int64
	}
	var best *cand
	for j, p := range samples {
		tx, ty := p.tile()
		if floorDiv(tx, S) != c[0] || floorDiv(ty, S) != c[1] {
			continue
		}
		a, b := samples[max(j-1, 0)], samples[min(j+1, len(samples)-1)]
		dx, dy := b.x-a.x, b.y-a.y
		l := max(isqrt(dx*dx+dy*dy), 1)
		off := r.half + fp + fp/2
		q := pt{p.x - side*dy*off/l, p.y + side*dx*off/l}
		qx, qy := q.tile()
		lx, ly := qx-c[0]*S, qy-c[1]*S
		if lx < 3 || ly < 3 || lx > S-4 || ly > S-4 {
			continue
		}
		if d, _, _ := r.line.nearest(tileCentre(qx, qy), nil); d <= int64(r.half)*int64(r.half) {
			continue
		}
		ddx, ddy := int64(q.x-mid.x), int64(q.y-mid.y)
		d := ddx*ddx + ddy*ddy
		if best == nil || d < best.d {
			best = &cand{Tile{lx, ly}, d}
		}
	}
	if best == nil {
		return Tile{}, false
	}
	return best.t, true
}

// lampStoneID is a lamp stone's site id.
func lampStoneID(cx, cy int) string { return fmt.Sprintf("lamp-stone:%d:%d", cx, cy) }
