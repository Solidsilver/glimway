package wilds

import "fmt"

// Pass 4, the Lantern Road (open-map.md 2.2, decision 18). One line per
// world that never turns: from the Whitequiet's lantern-road opening it
// runs north road.northChunks chunks, bends road.bend, and runs on that way
// far past the frontier, wandering inside one row of chunks. Paved
// road.width tiles wide with a verge each side. A dark lamp stone stands
// beside it every road.lampStoneEvery chunks of its length, a site with a
// fixed id, lamp-stone:<cx>:<cy> (lamps.md relights them in 0.9). It's a
// function of the world seed alone, so every epoch of a world agrees on it.

const roadReachChunks = 40 // how far past the bend the road runs

type road struct {
	line  *line
	half  int
	lamps map[[2]int]Tile // chunk → the lamp stone's local tile
	marks []lampMark      // the lamp stones in order along the road
}

// lampMark is a lamp stone as laid along the road: its chunk, local tile,
// and how far along the road (fp) the sample it stands beside lies.
type lampMark struct {
	chunk [2]int
	tile  Tile
	along int
}

func newRoad(seed string) *road {
	data := contentRules().GetRoad()
	S := chunkSize()
	rng := NewRng(landformHash(seed, "lantern-road"))
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
	// Straight out of the opening, then north, then the bend and away along
	// the middle of one row of chunks (so it doesn't zigzag between rows).
	north := int(data.GetNorthChunks()) * S
	row := floorDiv(oy-north-4, S)
	yc := row*S + S/2
	band := S/2 - 6
	start := tileCentre(ox, oy+3)
	straight := tileCentre(ox, oy-8)
	knee := tileCentre(ox+rng.Spread(2), yc+band+4)
	bend := tileCentre(ox+dir*S, yc)
	controls := []pt{start, straight, knee, bend}
	y := yc
	for i := 1; i <= roadReachChunks/2; i++ {
		y = clamp(y+rng.Spread(6), yc-band+2, yc+band-2)
		controls = append(controls, tileCentre(ox+dir*S+dir*i*2*S, y))
	}
	fix := func(p pt) pt {
		if _, ty := p.tile(); ty < yc+band {
			p.y = clamp(p.y, tileCentre(0, yc-band).y, tileCentre(0, yc+band).y)
		}
		return p
	}
	pts := []pt{start}
	for i := 0; i+1 < len(controls); i++ {
		depth := 2
		if i == 0 {
			depth = 0
		}
		f := fix
		if i < 2 {
			f = nil // the straight run north
		}
		pts = append(pts, displace(controls[i], controls[i+1], depth, 120, rng, f)[1:]...)
	}
	r := &road{line: newLine(pts, nil), half: int(data.GetWidth()) * fp / 2, lamps: map[[2]int]Tile{}}
	r.line.boxes = nil
	for i := 0; i+1 < len(pts); i++ {
		r.line.boxes = append(r.line.boxes, segBox(pts[i], pts[i+1]).grow(r.half+fp))
	}
	r.layLamps(pts)
	return r
}

// layLamps stands a lamp stone every lampStoneEvery chunks of the road's
// length, from half a chunk past where it leaves the footprint: beside the
// road on the verge's far side (the sides alternate), or the other side, or
// a little further along, until the stone stands inside its own chunk's
// interior, in a chunk with no stone yet.
func (r *road) layLamps(pts []pt) {
	S := chunkSize()
	// Samples a tile apart, with how far along each lies.
	var samples []pt
	var along []int
	run := 0
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		dx, dy := b.x-a.x, b.y-a.y
		l := isqrt(dx*dx + dy*dy)
		n := max(l/fp, 1)
		for k := 0; k < n; k++ {
			samples = append(samples, pt{a.x + dx*k/n, a.y + dy*k/n})
			along = append(along, run+l*k/n)
		}
		run += l
	}
	out := -1
	for j, p := range samples {
		tx, ty := p.tile()
		if FootprintAt(floorDiv(tx, S), floorDiv(ty, S)) == nil {
			out = j
			break
		}
	}
	if out < 0 {
		return
	}
	every := int(contentRules().GetRoad().GetLampStoneEvery()) * S * fp
	j := out
	for k := 0; ; k++ {
		mark := along[out] + S*fp/2 + k*every
		for j < len(samples) && along[j] < mark {
			j++
		}
		if j >= len(samples)-S {
			return
		}
		side := 1 - 2*(k%2)
		if m, ok := r.lampNear(samples, along, j, side); ok {
			r.lamps[m.chunk] = m.tile
			r.marks = append(r.marks, m)
		}
	}
}

// lampNear finds a lamp stone's tile by sample j: this side, the other,
// then a sample or two further along or back, out to half a chunk.
func (r *road) lampNear(samples []pt, along []int, j, side int) (lampMark, bool) {
	S := chunkSize()
	for slide := 0; slide <= S/2; slide++ {
		for _, sj := range []int{j + slide, j - slide} {
			if sj < 2 || sj >= len(samples)-2 || (slide == 0 && sj != j) {
				continue
			}
			for _, sd := range []int{side, -side} {
				p, a, b := samples[sj], samples[sj-2], samples[sj+2]
				dx, dy := b.x-a.x, b.y-a.y
				l := max(isqrt(dx*dx+dy*dy), 1)
				off := r.half + fp + fp/2
				qx, qy := pt{p.x - sd*dy*off/l, p.y + sd*dx*off/l}.tile()
				c := [2]int{floorDiv(qx, S), floorDiv(qy, S)}
				lx, ly := qx-c[0]*S, qy-c[1]*S
				if lx < 3 || ly < 3 || lx > S-4 || ly > S-4 || FootprintAt(c[0], c[1]) != nil {
					continue
				}
				if _, taken := r.lamps[c]; taken {
					continue
				}
				if d, _, _ := r.line.nearest(tileCentre(qx, qy), nil); d <= int64(r.half)*int64(r.half) {
					continue
				}
				return lampMark{chunk: c, tile: Tile{lx, ly}, along: along[sj]}, true
			}
		}
	}
	return lampMark{}, false
}

// lampStoneID is a lamp stone's site id.
func lampStoneID(cx, cy int) string { return fmt.Sprintf("lamp-stone:%d:%d", cx, cy) }

// RoadStone is one of the Lantern Road's lamp stones: its site id, chunk
// and chunk-local tile.
type RoadStone struct {
	ID     string
	CX, CY int
	Tile   Tile
}

// RoadStones are the Lantern Road's lamp stones in order along it, from the
// Whitequiet out. Like the road, a function of the world seed alone.
func RoadStones(seed string) []RoadStone {
	r := newRoad(seed)
	out := make([]RoadStone, 0, len(r.marks))
	for _, m := range r.marks {
		out = append(out, RoadStone{ID: lampStoneID(m.chunk[0], m.chunk[1]), CX: m.chunk[0], CY: m.chunk[1], Tile: m.tile})
	}
	return out
}
