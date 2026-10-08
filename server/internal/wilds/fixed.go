package wilds

// Integer helpers for generator v2. v2 uses no floating point at all, so a
// chunk comes out bit-identical on every machine (Go may fuse float
// multiply-adds on arm64 but not on amd64, which would split the goldens).
// Fractions are fixed-point: distances in 1/256 tile, noise in 1/65536.

const (
	fp       = 256   // fixed-point unit for distances and noise coordinates
	noiseOne = 65536 // noise values lie in [0, noiseOne)
	noiseMid = noiseOne / 2
)

// Chance is true with probability permille/1000.
func (r *Rng) Chance(permille int) bool { return r.NextInt(1000) < permille }

// Between is a uniform integer in [lo, hi].
func (r *Rng) Between(lo, hi int) int { return lo + r.NextInt(hi-lo+1) }

// Spread is a uniform integer in [-k, k].
func (r *Rng) Spread(k int) int { return r.NextInt(2*k+1) - k }

// Coin is a fair coin.
func (r *Rng) Coin() bool { return r.NextInt(2) == 1 }

// subSeed derives an independent stream from a seed, so one part of a chunk
// (entities, sites, terrain) never shifts when another draws more or less.
func subSeed(seed uint32, salt string) uint32 { return Mix(seed, Fnv1a32(salt)) }

// isqrt is floor(sqrt(n)) for n >= 0.
func isqrt(n int) int {
	if n <= 0 {
		return 0
	}
	x := n
	y := (x + 1) / 2
	for y < x {
		x = y
		y = (x + n/x) / 2
	}
	return x
}

// hypot256 is floor(256 × sqrt(dx² + dy²)).
func hypot256(dx, dy int) int { return isqrt((dx*dx + dy*dy) * fp * fp) }

// divRound is n/d rounded half away from zero (d > 0).
func divRound(n, d int) int {
	if n < 0 {
		return -((-n + d/2) / d)
	}
	return (n + d/2) / d
}

// floorDiv is n/d rounded toward negative infinity (d > 0).
func floorDiv(n, d int) int {
	q := n / d
	if n%d != 0 && n < 0 {
		q--
	}
	return q
}

func clamp(v, lo, hi int) int { return max(lo, min(hi, v)) }

// noise is smooth 2D value noise: one octave on an integer lattice,
// smoothstep-interpolated. Sample coordinates are in 1/256 of a lattice step.
type noise struct{ seed uint32 }

func (n noise) lattice(x, y int) int {
	v := uint32(x)*374761393 + uint32(y)*668265263 + n.seed*1442695041
	v = (v ^ v>>13) * 1274126177
	v ^= v >> 16
	return int(v >> 16)
}

// at samples the field at (x/256, y/256); the result lies in [0, 65536).
func (n noise) at(x, y int) int {
	x0, y0 := x>>8, y>>8 // arithmetic shifts: floor, negatives included
	fx, fy := x&255, y&255
	sx := fx * fx * (3*fp - 2*fx) >> 16
	sy := fy * fy * (3*fp - 2*fy) >> 16
	l00, l10 := n.lattice(x0, y0), n.lattice(x0+1, y0)
	l01, l11 := n.lattice(x0, y0+1), n.lattice(x0+1, y0+1)
	a := l00 + (l10-l00)*sx>>8
	b := l01 + (l11-l01)*sx>>8
	return a + (b-a)*sy>>8
}

// costHeap is a binary min-heap of (cost, cell) ordered by cost, then cell,
// so ties always break the same way.
type costHeap struct{ items [][2]int }

func (h *costHeap) less(i, j int) bool {
	a, b := h.items[i], h.items[j]
	return a[0] < b[0] || (a[0] == b[0] && a[1] < b[1])
}

func (h *costHeap) push(cost, cell int) {
	h.items = append(h.items, [2]int{cost, cell})
	i := len(h.items) - 1
	for i > 0 {
		p := (i - 1) / 2
		if !h.less(i, p) {
			break
		}
		h.items[i], h.items[p] = h.items[p], h.items[i]
		i = p
	}
}

func (h *costHeap) pop() (cost, cell int) {
	top := h.items[0]
	last := len(h.items) - 1
	h.items[0] = h.items[last]
	h.items = h.items[:last]
	i := 0
	for {
		l, r, m := 2*i+1, 2*i+2, i
		if l < len(h.items) && h.less(l, m) {
			m = l
		}
		if r < len(h.items) && h.less(r, m) {
			m = r
		}
		if m == i {
			break
		}
		h.items[i], h.items[m] = h.items[m], h.items[i]
		i = m
	}
	return top[0], top[1]
}

// cheapest runs Dijkstra on an S×S grid from `from` to the first cell
// `goal` accepts. step returns the cost of entering a cell, or a negative
// value for a cell that can't be entered. It returns the path (from first),
// or just [from] when no goal is reachable.
func cheapest(S int, from Tile, step func(x, y int) int, goal func(x, y int) bool) []Tile {
	if goal(from.TX, from.TY) {
		return []Tile{from}
	}
	dist := make([]int, S*S)
	prev := make([]int, S*S)
	for i := range dist {
		dist[i] = -1
		prev[i] = -1
	}
	h := &costHeap{}
	start := from.TY*S + from.TX
	dist[start] = 0
	h.push(0, start)
	for len(h.items) > 0 {
		d, i := h.pop()
		if d > dist[i] {
			continue
		}
		x, y := i%S, i/S
		if goal(x, y) {
			var out []Tile
			for j := i; j != -1; j = prev[j] {
				out = append(out, Tile{j % S, j / S})
			}
			for a, b := 0, len(out)-1; a < b; a, b = a+1, b-1 {
				out[a], out[b] = out[b], out[a]
			}
			return out
		}
		for _, dir := range dirs4 {
			nx, ny := x+dir[0], y+dir[1]
			if nx < 0 || ny < 0 || nx >= S || ny >= S {
				continue
			}
			c := step(nx, ny)
			if c < 0 {
				continue
			}
			ni := ny*S + nx
			if nd := d + c; dist[ni] < 0 || nd < dist[ni] {
				dist[ni] = nd
				prev[ni] = i
				h.push(nd, ni)
			}
		}
	}
	return []Tile{from}
}

var dirs4 = [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}
