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

	landPts   map[[2]int]landPoint // as drawn
	landFinal map[[2]int]landPoint // islands settled
	places    map[[2]int]*Place
	routes    map[[4]int][]*route
	gaps      map[gapKey]int  // edge gap offsets (-1: none)
	held      map[[2]int]bool // neighbours held in another wick epoch (kept, gen_v3.go)

	river *river // nil in a still epoch
	road  *road

	warpX, warpY, dither, thicket noise
	stillWorld                    *world
}

func contentRules() *content.Wilds { return content.WildsRules }

func newWorld(e Epoch) *world {
	w := &world{
		e:         e,
		wick:      e.Kind == EpochWick,
		landPts:   map[[2]int]landPoint{},
		landFinal: map[[2]int]landPoint{},
		places:    map[[2]int]*Place{},
		routes:    map[[4]int][]*route{},
		gaps:      map[gapKey]int{},
		held:      map[[2]int]bool{},
		warpX:     noise{e.landform("warp-x")},
		warpY:     noise{e.landform("warp-y")},
		dither:    noise{e.landform("dither")},
		thicket:   noise{e.hash("thicket")},
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

// The world border (content wilds.border, 0.14): every chunk with |cx| and
// |cy| at most BorderChunks exists; nothing past it does. One rule for every
// read, move and save, the client's insideBorder its twin
// (src/lib/wilds/coords.ts).
func BorderChunks() int { return int(contentRules().GetBorder().GetChunks()) }

// InsideBorder: chunk (cx, cy) is inside the world border.
func InsideBorder(cx, cy int) bool {
	b := BorderChunks()
	return cx >= -b && cx <= b && cy >= -b && cy <= b
}

// BorderRect is the border's chunks, inclusive.
func BorderRect() (minCx, minCy, maxCx, maxCy int) {
	b := BorderChunks()
	return -b, -b, b, b
}

// Home is the land round the footprints that the hand-shaped features near
// Hearthwick are laid in: the Wend's course, and the places the rumour picks
// from. It is the 0.8 frontier's old shape (homeReach chunks round every
// footprint, no further south than homeSouth), and limits nothing else:
// generation, reads and walking go on past it to the border.
const (
	homeReach = 3
	homeSouth = 7
)

// homeRect bounds home; insideHome is its membership (the union has
// clipped outer corners).
func homeRect() (minCx, minCy, maxCx, maxCy int) {
	first := true
	add := func(x0, y0, x1, y1 int) {
		x0, y0, x1, y1 = x0-homeReach, y0-homeReach, x1+homeReach, y1+homeReach
		if first {
			minCx, minCy, maxCx, maxCy = x0, y0, x1, y1
			first = false
			return
		}
		minCx, minCy, maxCx, maxCy = min(minCx, x0), min(minCy, y0), max(maxCx, x1), max(maxCy, y1)
	}
	for _, p := range contentRules().Places {
		add(int(p.GetCx()), int(p.GetCy()), int(p.GetCx()+p.GetWidth()-1), int(p.GetCy()+p.GetHeight()-1))
	}
	for _, p := range content.PlacesRules.GetFixed() {
		add(content.FixedChunks(p))
	}
	return minCx, minCy, maxCx, min(maxCy, homeSouth)
}

func insideHome(cx, cy int) bool { return cy <= homeSouth && NearestFootprint(cx, cy) <= homeReach }

func fixedBox(p *content.FixedPlace) box {
	S := chunkSize()
	x0, y0, x1, y1 := content.FixedChunks(p)
	return tileBox(x0*S, y0*S, (x1+1)*S-1, (y1+1)*S-1)
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

// HomeRect and InsideHome are home for the fake generator (chunks/fakegen),
// which lays its rumour cells there as this one does.
func HomeRect() (int, int, int, int) { return homeRect() }
func InsideHome(cx, cy int) bool     { return insideHome(cx, cy) }
