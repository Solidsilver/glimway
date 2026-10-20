package wilds

import "glimway/content"

// Pass 3, the Wend (open-map.md 2.2, decisions 2, 12 and 17). One river per
// world, the same every wick (lasting geography): a seeded polyline that
// enters the 0.8 frontier from one of river.enters (north or west), bends
// through the west, and leaves at the south limit's row no further east
// than river.leavesMaxCx, toward the mill. It never comes into the Tangle
// (it keeps a margin from it), and north of the Tangle it may run at most
// in the Whitequiet's west column (which keeps it west of the Lantern Road
// too). Water is minWidth to maxWidth tiles wide, varying smoothly; a bank
// runs along both sides.
//
// The river is crossed only at fords (decision 12): where a route's centre
// line runs over water, fordWidth tiles of shallows. Every route gets one,
// and the reach test shows that's enough: nothing is walled off.

const (
	// Tiles the river's centre keeps from the Tangle, the Whitequiet's
	// middle and (beyond its widest half) the west lot column, whose banks
	// then stay clear of the seams' feather (seams.go).
	riverMargin = 10
	bankWidth   = 3 * fp / 2
)

type river struct {
	line    *line
	maxHalf int
}

// riverBounds: the furthest east the river's centre may run at row y.
type riverBounds struct {
	stillTop, eastStill, eastNorth int
	fixedTop, eastFixed            int
}

func newRiverBounds() riverBounds {
	S := chunkSize()
	data := contentRules().GetRiver()
	halfMax := (int(data.GetMaxWidth()) + 1) / 2
	b := riverBounds{stillTop: 1 << 30, eastStill: 1 << 30, eastNorth: 1 << 30, fixedTop: 1 << 30, eastFixed: 1 << 30}
	for _, p := range contentRules().Places {
		x0, y0 := int(p.GetCx())*S, int(p.GetCy())*S
		if p.GetEpochKind() == EpochStill {
			b.stillTop = min(b.stillTop, y0)
			b.eastStill = min(b.eastStill, x0-riverMargin-halfMax)
		} else {
			b.eastNorth = min(b.eastNorth, x0+S-1-riverMargin-halfMax)
		}
	}
	for _, p := range content.PlacesRules.GetFixed() {
		b.fixedTop = min(b.fixedTop, int(p.GetCy())*S)
		b.eastFixed = min(b.eastFixed, int(p.GetCx())*S-riverMargin-halfMax)
	}
	b.eastNorth = min(b.eastNorth, b.eastStill+S) // never further east than the west column
	return b
}

// east is the furthest east (tiles) the centre may run at row y.
func (b riverBounds) east(y int) int {
	if y >= b.fixedTop-riverMargin-chunkSize()/2 {
		return min(b.eastFixed, b.eastStill)
	}
	if y >= b.stillTop-riverMargin-chunkSize()/2 {
		return b.eastStill
	}
	return b.eastNorth
}

func newRiver(w *world) *river {
	data := contentRules().GetRiver()
	S := chunkSize()
	rng := NewRng(w.e.landform("wend"))
	minCx, minCy, _, maxCy := frontierChunks()
	X0, Y0, Y1 := minCx*S, minCy*S, (maxCy+1)*S-1
	bounds := newRiverBounds()
	// The northern reach is narrower than the town/lots reach. Enter through
	// its actual west edge, while leaving two chunks west of the lots.
	northWest := int(contentRules().Places[0].GetCx()) - int(contentRules().GetFrontier().GetReach())
	for _, p := range contentRules().Places {
		northWest = min(northWest, int(p.GetCx())-int(contentRules().GetFrontier().GetReach()))
	}
	entryX := northWest * S
	at := func(x, y int) pt { return tileCentre(x, y) }

	var start, second pt
	enters := data.GetEnters()
	switch enters[rng.NextInt(len(enters))] {
	case "west":
		ys := rng.Between(Y0+S, bounds.stillTop-2*S)
		start = at(entryX-3*S, ys)
		second = at(entryX+S/2, clamp(ys+rng.Spread(S/2), Y0+S/2, bounds.stillTop-2*S))
	default: // north (an east entry would cross the road: read as north)
		xs := rng.Between(entryX+S, bounds.eastNorth-8)
		start = at(xs, Y0-3*S)
		second = at(clamp(xs+rng.Spread(S/2), entryX+S, bounds.eastNorth-8), Y0+S/2)
	}
	exitEast := min((int(data.GetLeavesMaxCx())+1)*S-1, bounds.east(Y1)) - 8
	xx := rng.Between(X0+S, max(exitEast, X0+S))
	exit := at(xx, Y1)
	end := at(xx+rng.Spread(S/2), Y1+3*S)
	_, sy := second.tile()
	ym := (sy + Y1) / 2
	lo, hi := int(data.GetMinWidth()), int(data.GetMaxWidth())
	mid := at(rng.Between(X0+S, max(bounds.east(ym)-12, X0+S)), ym)

	// Inside the frontier it stays east of its west edge too, so the land
	// west of it is never a strip reached only from outside.
	west := X0 + S/2 + (hi+1)/2
	fix := func(inside bool) func(pt) pt {
		return func(p pt) pt {
			x, y := p.tile()
			if e := bounds.east(y); x > e {
				p.x = tileCentre(e, y).x
			}
			westAt := west
			if y < bounds.fixedTop-int(contentRules().GetFrontier().GetReach())*S {
				westAt = max(westAt, entryX+S/2+(hi+1)/2)
			}
			if inside && x < westAt {
				p.x = tileCentre(westAt, y).x
			}
			return p
		}
	}
	controls := []pt{start, second, mid, exit, end}
	var pts []pt
	for i := 0; i+1 < len(controls); i++ {
		piece := displace(controls[i], controls[i+1], 4, 220, rng, fix(i > 0))
		if i > 0 {
			piece = piece[1:]
		}
		pts = append(pts, piece...)
	}
	// Width wanders smoothly along the river.
	n := noise{w.e.landform("wend-width")}
	half := make([]int, len(pts))
	for i := range pts {
		width := lo*fp + (hi-lo)*fp*n.at(i*fp/5, 0)>>16
		half[i] = width / 2
	}
	return &river{line: newLine(pts, half), maxHalf: hi * fp / 2}
}

// crossesChunk: does the Wend's water cross chunk (cx, cy)?
func (r *river) crossesChunk(cx, cy int) bool {
	b := chunkBox(cx, cy)
	segs := r.line.segs(b, 0)
	if len(segs) == 0 {
		return false
	}
	S := chunkSize()
	for ty := cy * S; ty < cy*S+S; ty++ {
		for tx := cx * S; tx < cx*S+S; tx++ {
			if d, half, ok := r.line.nearest(tileCentre(tx, ty), segs); ok && d <= int64(half)*int64(half) {
				return true
			}
		}
	}
	return false
}
