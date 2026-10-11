package wilds

import (
	"slices"

	"glimway/content"
)

// world is one v3 epoch's plan: the passes above the chunk (lands, the
// Wend, the Lantern Road, cells and routes), computed lazily and only as far
// as a chunk needs. It's a cache of pure functions of the epoch: two worlds
// of one epoch always answer the same, so a chunk made alone equals the
// same chunk made beside others. A world isn't safe for concurrent use;
// each GenerateV3 call makes its own.
type world struct {
	e    Epoch
	wick bool

	landPts map[[2]int]landPoint
	places  map[[2]int]*Place
	routes  map[[4]int]*route
	fordsAt map[[2]int]*line // extra fords per cell (nil: none)
	gaps    map[gapKey]int   // edge gap offsets (-1: none)

	river *river // nil in a still epoch
	road  *road

	warpX, warpY, dither, breakX, breakY, thicket noise
	stillWorld                                    *world
}

func contentRules() *content.Wilds { return content.WildsRules }

func newWorld(e Epoch) *world {
	w := &world{
		e:       e,
		wick:    e.Kind == EpochWick,
		landPts: map[[2]int]landPoint{},
		places:  map[[2]int]*Place{},
		routes:  map[[4]int]*route{},
		fordsAt: map[[2]int]*line{},
		gaps:    map[gapKey]int{},
		warpX:   noise{e.hash("warp-x")},
		warpY:   noise{e.hash("warp-y")},
		dither:  noise{e.hash("dither")},
		breakX:  noise{e.hash("break-x")},
		breakY:  noise{e.hash("break-y")},
		thicket: noise{e.hash("thicket")},
	}
	w.road = newRoad(e.WorldSeed)
	if w.wick {
		w.river = newRiver(w)
	}
	return w
}

// still is the still world of the same seed (for the kept side of a seam).
func (w *world) still() *world {
	if !w.wick {
		return w
	}
	if w.stillWorld == nil {
		w.stillWorld = newWorld(w.e.still())
	}
	return w.stillWorld
}

// ---------------------------------------------------------------- content

// landIndex is a land's index in content lands, or -1.
func landIndex(id string) int {
	return slices.IndexFunc(contentRules().Lands, func(l *content.WildsLand) bool { return l.GetId() == id })
}

// landGrounds are one land's grounds, resolved.
type landGrounds struct{ floor, open, verge, path, trodden Ground }

var landGround = func() []landGrounds {
	var out []landGrounds
	for _, l := range contentRules().Lands {
		g := l.GetGround()
		out = append(out, landGrounds{groundID(g.GetFloor()), groundID(g.GetOpen()), groundID(g.GetVerge()), groundID(g.GetPath()), groundID(g.GetTrodden())})
	}
	return out
}()

// groundSurface is each ground's surface (land, water, ford, road, laid).
var groundSurface = func() []string {
	var out []string
	for _, g := range contentRules().Grounds {
		out = append(out, g.GetSurface())
	}
	return out
}()

// The river's and road's grounds.
var (
	groundRiverWater = groundID(contentRules().GetRiver().GetWaterGround())
	groundRiverBank  = groundID(contentRules().GetRiver().GetBankGround())
	groundRiverFord  = groundID(contentRules().GetRiver().GetFordGround())
	groundPaving     = groundID(contentRules().GetRoad().GetGround())
	groundRoadVerge  = groundID(contentRules().GetRoad().GetVergeGround())
)

// weighted draws an index by weight; weights must not all be zero.
func weighted(rng *Rng, weights []int) int {
	total := 0
	for _, w := range weights {
		total += w
	}
	if total <= 0 {
		return 0
	}
	r := rng.NextInt(total)
	for i, w := range weights {
		if r < w {
			return i
		}
		r -= w
	}
	return len(weights) - 1
}

// frontierChunks is the 0.8 frontier rectangle from content (the same rule
// as frontier.Inside and frontier.Rect, which import this package): every
// chunk within frontier.reach of a footprint, none south of southLimit.
func frontierChunks() (minCx, minCy, maxCx, maxCy int) {
	f := contentRules().GetFrontier()
	r := int(f.GetReach())
	for i, p := range contentRules().Places {
		x0, y0 := int(p.GetCx())-r, int(p.GetCy())-r
		x1, y1 := int(p.GetCx()+p.GetWidth())-1+r, int(p.GetCy()+p.GetHeight())-1+r
		if i == 0 {
			minCx, minCy, maxCx, maxCy = x0, y0, x1, y1
			continue
		}
		minCx, minCy, maxCx, maxCy = min(minCx, x0), min(minCy, y0), max(maxCx, x1), max(maxCy, y1)
	}
	return minCx, minCy, maxCx, min(maxCy, int(f.GetSouthLimit()))
}

// insideReach is frontier.Inside for 0.8 (content's reach and south limit).
func insideReach(cx, cy int) bool {
	f := contentRules().GetFrontier()
	return cy <= int(f.GetSouthLimit()) && NearestFootprint(cx, cy) <= int(f.GetReach())
}

// footprintBox is a footprint's tiles in fp.
func footprintBox(p *content.WildsPlace) box {
	S := chunkSize()
	x0, y0 := int(p.GetCx())*S, int(p.GetCy())*S
	return tileBox(x0, y0, x0+int(p.GetWidth())*S-1, y0+int(p.GetHeight())*S-1)
}

// gateTile is the Commons gate: the middle of the Tangle's commons-gate
// opening, on its chunk's edge.
func gateTile() (int, int) {
	for _, p := range contentRules().Places {
		for _, o := range p.GetOpenings() {
			if o.GetId() == "commons-gate" {
				return openingMiddle(o)
			}
		}
	}
	return 0, 0
}

// openingMiddle is the world tile at an opening's middle, on its edge.
func openingMiddle(o *content.WildsOpening) (int, int) {
	S := chunkSize()
	x0, y0 := int(o.GetCx())*S, int(o.GetCy())*S
	mid := int(o.GetOffset()) + int(o.GetWidth())/2
	switch o.GetEdge() {
	case "north":
		return x0 + mid, y0
	case "south":
		return x0 + mid, y0 + S - 1
	case "west":
		return x0, y0 + mid
	default:
		return x0 + S - 1, y0 + mid
	}
}
