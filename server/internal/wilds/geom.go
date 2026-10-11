package wilds

// Integer plane geometry for generator v3's world-wide lines (the Wend, the
// Lantern Road, routes). Points are in 1/256 tile (fp); tile (tx, ty)'s
// centre is (tx*256+128, ty*256+128). Everything is integer so a chunk comes
// out the same on every machine.

type pt struct{ x, y int }

func tileCentre(tx, ty int) pt { return pt{tx*fp + fp/2, ty*fp + fp/2} }

// tileOf is the tile a point lies on.
func (p pt) tile() (int, int) { return floorDiv(p.x, fp), floorDiv(p.y, fp) }

const tOne = 1024 // the fraction along a segment, in 1/1024

// dist2Seg is the squared distance (fp²) from p to segment ab, and how far
// along ab the nearest point lies (0..tOne).
func dist2Seg(p, a, b pt) (int64, int) {
	dx, dy := int64(b.x-a.x), int64(b.y-a.y)
	px, py := int64(p.x-a.x), int64(p.y-a.y)
	den := dx*dx + dy*dy
	num := px*dx + py*dy
	var t int64
	switch {
	case den == 0 || num <= 0:
	case num >= den:
		t = tOne
	default:
		t = num * tOne / den
	}
	qx, qy := px-dx*t/tOne, py-dy*t/tOne
	return qx*qx + qy*qy, int(t)
}

// box is an inclusive rectangle in fp.
type box struct{ x0, y0, x1, y1 int }

func (b box) grow(r int) box         { return box{b.x0 - r, b.y0 - r, b.x1 + r, b.y1 + r} }
func (b box) has(p pt) bool          { return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1 }
func (b box) meets(o box) bool       { return b.x0 <= o.x1 && o.x0 <= b.x1 && b.y0 <= o.y1 && o.y0 <= b.y1 }
func segBox(a, b pt) box             { return box{min(a.x, b.x), min(a.y, b.y), max(a.x, b.x), max(a.y, b.y)} }
func tileBox(x0, y0, x1, y1 int) box { return box{x0 * fp, y0 * fp, (x1+1)*fp - 1, (y1+1)*fp - 1} }

// chunkBox is a chunk's tiles in fp.
func chunkBox(cx, cy int) box {
	S := chunkSize()
	return tileBox(cx*S, cy*S, cx*S+S-1, cy*S+S-1)
}

// line is a polyline with a half-width (fp) at each point.
type line struct {
	pts   []pt
	half  []int
	boxes []box // each segment's box, grown by its widest half-width
}

func newLine(pts []pt, half []int) *line {
	l := &line{pts: pts, half: half}
	for i := 0; i+1 < len(pts); i++ {
		r := 0
		if half != nil {
			r = max(half[i], half[i+1])
		}
		l.boxes = append(l.boxes, segBox(pts[i], pts[i+1]).grow(r))
	}
	return l
}

// segs lists the segments whose box, grown by r, meets b.
func (l *line) segs(b box, r int) []int {
	var out []int
	for i, sb := range l.boxes {
		if sb.grow(r).meets(b) {
			out = append(out, i)
		}
	}
	return out
}

// nearest is the least squared distance from p to the line over the given
// segments (all when nil), and the half-width there. ok is false when no
// segment was looked at.
func (l *line) nearest(p pt, segs []int) (d2 int64, half int, ok bool) {
	look := func(i int) {
		d, t := dist2Seg(p, l.pts[i], l.pts[i+1])
		if !ok || d < d2 {
			d2, ok = d, true
			if l.half != nil {
				half = l.half[i] + (l.half[i+1]-l.half[i])*t/tOne
			}
		}
	}
	if segs == nil {
		for i := 0; i+1 < len(l.pts); i++ {
			look(i)
		}
	} else {
		for _, i := range segs {
			look(i)
		}
	}
	return d2, half, ok
}

// displace subdivides a→b depth times, pushing each midpoint sideways by up
// to ampPermille/1000 of its segment's length (midpoint displacement: the
// line bends, but any piece of it is computable from its two ends and the
// rng). The result runs from a to b inclusive. fix, when set, may move each
// new midpoint (to keep it inside or outside a box).
func displace(a, b pt, depth int, ampPermille int, rng *Rng, fix func(pt) pt) []pt {
	pts := []pt{a, b}
	for d := 0; d < depth; d++ {
		next := []pt{pts[0]}
		for i := 0; i+1 < len(pts); i++ {
			p, q := pts[i], pts[i+1]
			off := rng.Spread(1000) * ampPermille / 1000
			m := pt{(p.x+q.x)/2 - (q.y-p.y)*off/1000, (p.y+q.y)/2 + (q.x-p.x)*off/1000}
			if fix != nil {
				m = fix(m)
			}
			next = append(next, m, q)
		}
		pts = next
	}
	return pts
}

// cross is the z of (b-a)×(c-a).
func cross(a, b, c pt) int64 {
	return int64(b.x-a.x)*int64(c.y-a.y) - int64(b.y-a.y)*int64(c.x-a.x)
}

// crosses is true when segments ab and cd properly intersect (or touch).
func crosses(a, b, c, d pt) bool {
	d1, d2 := cross(c, d, a), cross(c, d, b)
	d3, d4 := cross(a, b, c), cross(a, b, d)
	if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)) {
		return true
	}
	on := func(p, q, r pt) bool {
		return min(p.x, q.x) <= r.x && r.x <= max(p.x, q.x) && min(p.y, q.y) <= r.y && r.y <= max(p.y, q.y)
	}
	return (d1 == 0 && on(c, d, a)) || (d2 == 0 && on(c, d, b)) || (d3 == 0 && on(a, b, c)) || (d4 == 0 && on(a, b, d))
}

// crossPoint is where ab meets cd (they must cross); the midpoint of the
// overlap when they're collinear.
func crossPoint(a, b, c, d pt) pt {
	den := cross(pt{}, pt{b.x - a.x, b.y - a.y}, pt{d.x - c.x, d.y - c.y})
	if den == 0 {
		return pt{(a.x + b.x) / 2, (a.y + b.y) / 2}
	}
	num := cross(pt{}, pt{c.x - a.x, c.y - a.y}, pt{d.x - c.x, d.y - c.y})
	return pt{a.x + int(int64(b.x-a.x)*num/den), a.y + int(int64(b.y-a.y)*num/den)}
}

// crossCount is how many times segment ab crosses the line.
func (l *line) crossCount(a, b pt) int {
	n := 0
	sb := segBox(a, b)
	for i := 0; i+1 < len(l.pts); i++ {
		if !segBox(l.pts[i], l.pts[i+1]).meets(sb) {
			continue
		}
		if crosses(a, b, l.pts[i], l.pts[i+1]) {
			n++
		}
	}
	return n
}

func chunkSize() int { return int(contentRules().GetChunkSize()) }
