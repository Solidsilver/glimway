// Package fakegen is a stand-in for generator v3 (lane O-B) in the server's
// tests: it makes simple, valid open-map chunks at signed coordinates, with
// every entity kind, the footprints' sites, the cell places with their
// landmarks and the rumour's find, all at fixed tiles a test can name. It
// implements chunks.Generator; nothing in production uses it.
package fakegen

import (
	"fmt"
	"slices"
	"strings"
	"sync"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/wilds"
)

// The fixed tiles of every fake chunk (chunk-local).
var (
	Thicket  = [2]int{5, 5}   // a thicket: solid, cleared with a spade
	Log      = [2]int{6, 5}   // a fallen trunk: solid, cleared with an axe
	Boulder  = [2]int{7, 5}   // a boulder: solid, never cleared
	Fern     = [2]int{8, 5}   // a fern: walkable undergrowth, nothing to clear
	Water    = [2]int{20, 20} // water: solid (and 21,20)
	Ford     = [2]int{22, 20} // a ford: waded
	Road     = [2]int{23, 20} // paving
	Camp     = [2]int{12, 12} // entity "camp:<cx>:<cy>:0"
	Node     = [2]int{14, 12} // "node:<cx>:<cy>:1", content's materials in turn by |cx|+|cy|
	Chest    = [2]int{16, 12} // "chest:<cx>:<cy>:2", the chunk's tier
	POI      = [2]int{18, 12} // "poi:<cx>:<cy>:3"
	Landmark = [2]int{10, 10} // a place's landmark, in its cell's middle chunk
	Find     = [2]int{10, 11} // the rumour's find, below the landmark
)

// Call is one Chunk call: the chunk and how many kept neighbours it got.
type Call struct {
	Epoch  string
	CX, CY int32
	Kept   []chunks.Kept
}

// Generator is the fake. V is its version (zero: 3). Hook, when set, runs
// inside Chunk before it answers (a test's way to race a writer in).
type Generator struct {
	V    int
	Hook func(epoch *contract.WildsEpoch, cx, cy int32)
	// Edit, when set, changes a made chunk before it is answered (a test's
	// way to turn the detail of one wick's land).
	Edit func(epoch *contract.WildsEpoch, c *contract.WorldChunk)

	mu    sync.Mutex
	Calls []Call
}

func New() *Generator { return &Generator{} }

func (g *Generator) Version() int {
	if g.V != 0 {
		return g.V
	}
	return 3
}

// Made is how many chunks the fake has made.
func (g *Generator) Made() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.Calls)
}

func terrain(id string) string { return chunks.GroundByID(id).GetTerrain() }

// Chunk makes the fake chunk. A kept neighbour's two edge tiles are copied
// onto this chunk's side of the seam (solid where solid), as v3 does.
func (g *Generator) Chunk(e *contract.WildsEpoch, cx, cy int32, kept []chunks.Kept) (*contract.WorldChunk, error) {
	g.mu.Lock()
	g.Calls = append(g.Calls, Call{Epoch: e.Id, CX: cx, CY: cy, Kept: kept})
	g.mu.Unlock()
	if g.Hook != nil {
		g.Hook(e, cx, cy)
	}
	w := content.WildsRules
	S := int(w.GetChunkSize())
	x, y := int(cx), int(cy)
	look, land := "outer", "woods"
	if p := wilds.FootprintAt(x, y); p != nil {
		look, land = p.GetLook(), p.GetLand()
	}
	if e.Kind != wilds.EpochKindAt(x, y) {
		return nil, fmt.Errorf("fakegen: chunk %d,%d is not in a %s epoch", x, y, e.Kind)
	}
	palette := []string{terrain("woods"), terrain("water"), terrain("ford"), terrain("paving")}
	ground := make([]int, S*S)
	solid := make([]bool, S*S)
	at := func(t [2]int) int { return t[1]*S + t[0] }
	ground[at(Water)], ground[Water[1]*S+Water[0]+1] = 1, 1
	solid[at(Water)], solid[Water[1]*S+Water[0]+1] = true, true
	ground[at(Ford)], ground[at(Road)] = 2, 3

	c := &contract.WorldChunk{
		EpochId: e.Id, Realm: w.GetRealm(), Cx: cx, Cy: cy, GeneratorVersion: uint32(g.Version()), Size: uint32(S),
		Palette: palette, Look: look, Tier: uint32(wilds.Tier(x, y)), Land: land,
		Decor: &contract.DecorList{},
	}
	decor := func(kind string, t [2]int, block bool) {
		k := slices.Index(c.Decor.Kinds, kind)
		if k < 0 {
			k = len(c.Decor.Kinds)
			c.Decor.Kinds = append(c.Decor.Kinds, kind)
		}
		d := c.Decor
		d.Kind, d.Tx, d.Ty = append(d.Kind, uint32(k)), append(d.Tx, uint32(t[0])), append(d.Ty, uint32(t[1]))
		d.Ox, d.Oy, d.Variant = append(d.Ox, 0), append(d.Oy, 0), append(d.Variant, 0)
		if block {
			solid[at(t)] = true
		}
	}
	decor("thicket", Thicket, true)
	decor("log", Log, true)
	decor("boulder", Boulder, true)
	decor("fern", Fern, false)

	tier := w.Tiers[c.Tier-1]
	mix := w.CampMixes[slices.IndexFunc(w.CampMixes, func(m *content.WildsCampMix) bool { return m.GetId() == tier.GetCampMixes()[0].GetId() })]
	c.Entities = []*contract.WildsEntity{
		{Id: fmt.Sprintf("camp:%d:%d:0", x, y), Kind: "camp", Tx: uint32(Camp[0]), Ty: uint32(Camp[1]), Enemies: slices.Clone(mix.GetEnemies())},
		{Id: fmt.Sprintf("node:%d:%d:1", x, y), Kind: "node", Tx: uint32(Node[0]), Ty: uint32(Node[1]), Material: w.Materials[(max(x, -x)+max(y, -y))%len(w.Materials)]},
		{Id: fmt.Sprintf("chest:%d:%d:2", x, y), Kind: "chest", Tx: uint32(Chest[0]), Ty: uint32(Chest[1]), Tier: c.Tier},
		{Id: fmt.Sprintf("poi:%d:%d:3", x, y), Kind: "poi", Tx: uint32(POI[0]), Ty: uint32(POI[1]), Poi: w.PoiIds[0]},
	}
	for _, p := range w.Places {
		for _, s := range p.Sites {
			if int(s.GetCx()) == x && int(s.GetCy()) == y {
				c.Sites = append(c.Sites, &contract.StorySite{Id: s.GetId(), Kind: siteKind(s.GetKind()), Tx: uint32(s.GetTx()), Ty: uint32(s.GetTy())})
			}
		}
		for i, s := range p.Dealt {
			if dx, dy := DealtChunk(p, i); dx == x && dy == y {
				c.Sites = append(c.Sites, &contract.StorySite{Id: s.GetId(), Kind: siteKind(s.GetKind()), Tx: uint32(2 + 3*(i%7)), Ty: 2})
			}
		}
	}
	if px, py, ok := placeCell(x, y); ok {
		kind := PlaceKind(e, px, py)
		decor(kind.GetLandmark(), Landmark, true)
		c.Places = append(c.Places, &contract.WildsPlaceMark{Id: wilds.CellPlaceID(px, py), Kind: kind.GetId(), Tx: uint32(Landmark[0]), Ty: uint32(Landmark[1])})
		if r, ok, _ := g.Rumour(e); ok && r.CX == cx && r.CY == cy {
			c.Sites = append(c.Sites, &contract.StorySite{Id: r.Site, Kind: contract.SiteKind_SITE_KIND_RUMOUR, Tx: r.TX, Ty: r.TY})
		}
	}
	for _, k := range kept {
		dx, dy := k.CX-x, k.CY-y
		for i := 0; i < S; i++ {
			for d := 0; d < 2; d++ {
				var here, there int
				switch {
				case dx == -1 && dy == 0:
					here, there = i*S+d, i*S+S-1-d
				case dx == 1 && dy == 0:
					here, there = i*S+S-1-d, i*S+d
				case dy == -1 && dx == 0:
					here, there = d*S+i, (S-1-d)*S+i
				case dy == 1 && dx == 0:
					here, there = (S-1-d)*S+i, d*S+i
				default:
					continue
				}
				solid[here] = k.Chunk.Solid[there/8]&(1<<(there%8)) != 0
			}
		}
	}
	c.Decor.Flags = make([]byte, (len(c.Decor.Kind)+3)/4)
	c.Ground = make([]byte, S*S/2)
	for i, v := range ground {
		c.Ground[i/2] |= byte(v) << (4 * (i % 2))
	}
	c.Solid = make([]byte, S*S/8)
	for i, s := range solid {
		if s {
			c.Solid[i/8] |= 1 << (i % 8)
		}
	}
	if g.Edit != nil {
		g.Edit(e, c)
	}
	return c, nil
}

// DealtChunk is where the fake deals a footprint's i-th dealt site: the east
// column for "east", else across the footprint.
func DealtChunk(p *content.WildsPlace, i int) (int, int) {
	w, h := int(p.GetWidth()), int(p.GetHeight())
	x := int(p.GetCx()) + i%w
	if p.Dealt[i].GetColumn() == "east" {
		x = int(p.GetCx()) + w - 1
	}
	return x, int(p.GetCy()) + (i/w)%h
}

func siteKind(kind string) contract.SiteKind {
	v, ok := contract.SiteKind_value["SITE_KIND_"+strings.ToUpper(strings.ReplaceAll(kind, "-", "_"))]
	if !ok {
		panic("fakegen: site kind " + kind)
	}
	return contract.SiteKind(v)
}

// placeCell: the cell whose place the chunk holds (its middle chunk), when
// the cell isn't a footprint's.
func placeCell(cx, cy int) (int, int, bool) {
	px, py := wilds.CellOf(cx, cy)
	c := content.WildsRules.GetCells()
	n := int(c.GetCellChunks())
	mx, my := int(c.GetOriginCx())+px*n+n/2, int(c.GetOriginCy())+py*n+n/2
	return px, py, mx == cx && my == cy && !wilds.FootprintCell(px, py)
}

// PlaceChunk is the chunk holding a cell's place (its middle chunk).
func PlaceChunk(px, py int) (int32, int32) {
	c := content.WildsRules.GetCells()
	n := int(c.GetCellChunks())
	return int32(int(c.GetOriginCx()) + px*n + n/2), int32(int(c.GetOriginCy()) + py*n + n/2)
}

// PlaceKind is the kind of a cell's place this epoch.
func PlaceKind(e *contract.WildsEpoch, px, py int) *content.WildsPlaceKind {
	k := content.WildsRules.PlaceKinds
	return k[wilds.Hash(e.WorldSeed, e.Season, "place", px, py)%uint32(len(k))]
}

// Cells is every place cell at home (wilds.InsideHome), in order.
func Cells() [][2]int {
	x0, y0, x1, y1 := wilds.HomeRect()
	out := [][2]int{}
	for cy := y0; cy <= y1; cy++ {
		for cx := x0; cx <= x1; cx++ {
			px, py, ok := placeCell(cx, cy)
			if ok && wilds.InsideHome(cx, cy) {
				out = append(out, [2]int{px, py})
			}
		}
	}
	return out
}

// Glimpses: meadow on even chunks, woods on odd; the Wend far west.
func (g *Generator) Glimpses(e *contract.WildsEpoch, at []chunks.ChunkXY) ([]chunks.Glimpse, error) {
	lands := content.WildsRules.Lands
	out := make([]chunks.Glimpse, len(at))
	for i, c := range at {
		out[i] = chunks.Glimpse{Land: lands[int((c.CX+c.CY)&1)%len(lands)].GetId(), River: c.CX <= -5}
	}
	return out, nil
}

// Rumour: one place cell a wick, hashed from the epoch; past the river when
// the cell lies west of the footprints.
func (g *Generator) Rumour(e *contract.WildsEpoch) (chunks.Rumour, bool, error) {
	if e.Kind != "wick" {
		return chunks.Rumour{}, false, nil
	}
	cells := Cells()
	if len(cells) == 0 {
		return chunks.Rumour{}, false, nil
	}
	p := cells[wilds.Hash(e.WorldSeed, e.Season, "rumour")%uint32(len(cells))]
	cx, cy := PlaceChunk(p[0], p[1])
	kind := PlaceKind(e, p[0], p[1])
	return chunks.Rumour{
		Place: wilds.CellPlaceID(p[0], p[1]), Kind: kind.GetId(), Landmark: kind.GetLandmark(),
		CX: cx, CY: cy, Site: fmt.Sprintf("rumour:%d:%d", cx, cy), TX: uint32(Find[0]), TY: uint32(Find[1]),
		Compass: Compass(int(cx), int(cy)), Ring: wilds.Ring(int(cx), int(cy)), PastRiver: p[0] < 0,
	}, true, nil
}

// Compass is the fake's eight-way word from chunk (0, 0) to the chunk.
func Compass(cx, cy int) string {
	ns, ew := "", ""
	if cy < 0 {
		ns = "n"
	} else if cy > 0 {
		ns = "s"
	}
	if cx > 0 {
		ew = "e"
	} else if cx < 0 {
		ew = "w"
	}
	if ns+ew == "" {
		return "n"
	}
	return ns + ew
}
