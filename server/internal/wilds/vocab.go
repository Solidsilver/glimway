package wilds

// The Wilds' ground and decor vocabulary, read from content/wilds.json
// (ids by value), and the decor piece a chunk carries.

import (
	"slices"

	"glimway/content"
)

// Ground is a ground id: its index in content/wilds.json `grounds`, whose
// `terrain` is the palette name a chunk carries (the TERRAIN key in
// src/lib/tile.ts, which the ground art reads).
type Ground uint8

// The grounds generator v2 paints with, looked up by content id.
var (
	GroundWoods   = groundID("woods")   // under the trees: dark loam, moss and leaf litter
	GroundMoss    = groundID("moss")    // walkable moss in clearings and glades
	GroundVerge   = groundID("verge")   // walkable verge beside a path's trodden line
	GroundPath    = groundID("path")    // the trodden line of a path
	GroundTrodden = groundID("trodden") // bare, trodden earth around camps
	GroundRoad    = groundID("road")    // broken cobbles of the old road
	GroundWater   = groundID("water")   // still water (a backwater of the Wend): solid
)

// GroundIDs are the palette names of the ground ids, by value.
var GroundIDs = loadGroundIDs()

func loadGroundIDs() []string {
	out := []string{}
	for _, g := range content.WildsRules.Grounds {
		out = append(out, g.GetTerrain())
	}
	return out
}

func (g Ground) String() string { return GroundIDs[g] }

// groundRank: a carve only ever raises a tile's ground (moss never paints
// over a path).
var groundRank = loadGroundRank()

func loadGroundRank() []int {
	out := []int{}
	for _, g := range content.WildsRules.Grounds {
		out = append(out, int(g.GetRank()))
	}
	return out
}

// groundID is the ground with the content id; a missing one is a broken
// build, caught at start.
func groundID(id string) Ground {
	i := slices.IndexFunc(content.WildsRules.Grounds, func(g *content.WildsGround) bool { return g.GetId() == id })
	if i < 0 {
		panic("wilds: no ground " + id)
	}
	return Ground(i)
}

// DecorKind is a kind of decor piece: its index in content/wilds.json
// `decor` (src/game/wilds/decor.ts reads the same list).
type DecorKind uint8

// The decor kinds generator v2 places, looked up by content kind.
var (
	DecorOak       = decorID("oak")
	DecorPine      = decorID("pine")
	DecorBirch     = decorID("birch")
	DecorIronOak   = decorID("iron-oak")
	DecorSnag      = decorID("snag")
	DecorThicket   = decorID("thicket")
	DecorStump     = decorID("stump")
	DecorRingStump = decorID("ring-stump")
	DecorLog       = decorID("log")
	DecorBoulder   = decorID("boulder")
	DecorCairn     = decorID("cairn")
	DecorFern      = decorID("fern")
	DecorGrass     = decorID("grass")
	DecorFlowers   = decorID("flowers")
	DecorTurncaps  = decorID("turncaps")
	DecorReeds     = decorID("reeds")
	DecorRoots     = decorID("roots")
	DecorLitter    = decorID("litter")
	DecorPebbles   = decorID("pebbles")
)

// DecorKinds are the decor kind names, by value.
var DecorKinds = loadDecorKinds()

func loadDecorKinds() []string {
	out := []string{}
	for _, d := range content.WildsRules.Decor {
		out = append(out, d.GetKind())
	}
	return out
}

func (k DecorKind) String() string { return DecorKinds[k] }

func decorID(kind string) DecorKind {
	i := slices.Index(DecorKinds, kind)
	if i < 0 {
		panic("wilds: no decor kind " + kind)
	}
	return DecorKind(i)
}

// DecorArt is a kind's art footprint in px (width centred on the anchor,
// height above it). Blocking pieces only stand on solid tiles; flat ones are
// ground decals drawn under everything.
type DecorArt struct {
	W, H     int
	Blocking bool
	Flat     bool
}

// DecorArts is the footprint of each kind, by value (content `decor`).
var DecorArts = loadDecorArts()

func loadDecorArts() []DecorArt {
	out := []DecorArt{}
	for _, d := range content.WildsRules.Decor {
		out = append(out, DecorArt{int(d.GetW()), int(d.GetH()), d.GetBlocking(), d.GetFlat()})
	}
	return out
}

// Decor is one piece of dressing. The art stands on its tile's bottom edge,
// centred, nudged by (OX, OY) px. Variant is 0–7 (the art seeds from it);
// Flip mirrors it (turncaps: lean east); Overhang marks a blocking piece
// whose art reaches over a walkable tile.
type Decor struct {
	Kind     DecorKind `json:"kind"`
	TX       int       `json:"tx"`
	TY       int       `json:"ty"`
	OX       int       `json:"ox"`
	OY       int       `json:"oy"`
	Variant  int       `json:"variant"`
	Flip     bool      `json:"flip"`
	Overhang bool      `json:"overhang"`
}

const tilePx = 16

// jitter256 is a noise field mapped to ±amp/2 tiles, in 1/256 tile.
func jitter256(n noise, x, y, amp256 int) int { return (n.at(x, y) - noiseMid) * amp256 >> 16 }

// edgeOY: a tuft against the woods to the north tucks up under the trees,
// one to the south sits on the tile's foot, one to the side keeps `side`.
func edgeOY(dy, side int) int {
	switch {
	case dy < 0:
		return -7
	case dy > 0:
		return 1
	}
	return side
}
