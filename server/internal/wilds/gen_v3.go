package wilds

import (
	"fmt"
	"slices"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
)

// The v3 site kinds beside v2's.
const (
	SiteLampStone SiteKind = "lamp-stone" // a dark lamp stone by the Lantern Road (solid)
	SiteRumour    SiteKind = "rumour"     // this wick's rumoured find, before a place's landmark
)

// Kept is a kept neighbour: a stored chunk of another epoch beside the one
// being made (in 0.8, a Tangle chunk beside a wick chunk). Only its two
// edge tiles facing the new chunk are read.
type Kept struct {
	CX, CY int
	Chunk  *contract.WorldChunk
}

// GenerateV3 makes one chunk of the open map: a pure function of (e, cx,
// cy), plus kept neighbours' stored edges at a seam. Pass every neighbour
// (diagonals too) whose EpochKindAt differs from e.Kind; a missing one is
// read as generator v3 makes it, which is exact while it was made by v3.
// The frontier is the caller's to check: this makes any chunk.
func GenerateV3(e Epoch, cx, cy int, kept []Kept) (Chunk, error) {
	if err := e.check(); err != nil {
		return Chunk{}, err
	}
	if FixedFootprintAt(cx, cy) != nil {
		return Chunk{}, fmt.Errorf("%w: chunk %d,%d is fixed", ErrWrongEpoch, cx, cy)
	}
	if EpochKindAt(cx, cy) != e.Kind {
		return Chunk{}, fmt.Errorf("%w: chunk %d,%d is %s, the epoch %s", ErrWrongEpoch, cx, cy, EpochKindAt(cx, cy), e.Kind)
	}
	return newWorld(e).chunk(cx, cy, kept)
}

func (w *world) chunk(cx, cy int, kept []Kept) (Chunk, error) {
	S := chunkSize()
	mark, err := seasonMark(w.e.Season)
	if err != nil {
		return Chunk{}, err
	}
	kr := &keptReader{w: w.still(), stored: map[[2]int]*contract.WorldChunk{}, made: map[[2]int][]baseTile{}}
	for _, k := range kept {
		kr.stored[[2]int{k.CX, k.CY}] = k.Chunk
	}
	base := w.fill(cx*S, cy*S, cx*S+S-1, cy*S+S-1, kr)

	look := "outer"
	foot := FootprintAt(cx, cy)
	if foot != nil {
		look = foot.GetLook()
	}
	home := Tile{100 * S, 0} // past the Tangle, turncaps lean east, toward Sallow Ford
	if foot != nil && foot.GetEpochKind() == EpochStill {
		gx, gy := gateTile()
		home = Tile{gx - cx*S, gy - cy*S}
	}
	seed := ChunkSeed(w.e, cx, cy)
	tier := Tier(cx, cy)
	d := newDetail(S, subSeed(seed, "terrain"), base, look == "outer", home)

	// Places, then the sites with fixed tiles, then entities, then the
	// dealt sites (clear of the entities, as v2).
	places := w.placesIn(cx, cy)
	var marks []PlaceMark
	for _, p := range places {
		d.clearPlace(p)
		marks = append(marks, PlaceMark{ID: p.ID, Kind: p.Kind, TX: p.TX, TY: p.TY})
	}
	var sites []Site
	if foot != nil {
		for _, s := range foot.GetSites() {
			if int(s.GetCx()) == cx && int(s.GetCy()) == cy {
				sites = append(sites, Site{ID: s.GetId(), Kind: SiteKind(s.GetKind()), CX: cx, CY: cy, TX: int(s.GetTx()), TY: int(s.GetTy())})
			}
		}
	}
	if t, ok := w.road.lamps[[2]int{cx, cy}]; ok && foot == nil {
		sites = append(sites, Site{ID: lampStoneID(cx, cy), Kind: SiteLampStone, CX: cx, CY: cy, TX: t.TX, TY: t.TY})
	}
	if len(places) > 0 {
		if r, ok := w.rumour(); ok && r.Place.CX == cx && r.Place.CY == cy {
			sites = append(sites, Site{ID: r.Site, Kind: SiteRumour, CX: cx, CY: cy, TX: r.SiteTX, TY: r.SiteTY})
		}
	}
	for _, s := range sites {
		d.clearSite(s)
	}
	dry := d.dryReach()
	var avoid []Tile
	for _, s := range sites {
		avoid = append(avoid, Tile{s.TX, s.TY})
	}
	entities := d.placeEntities(NewRng(subSeed(seed, "entities")), cx, cy, tier, places, dry, avoid)
	if foot != nil && len(foot.GetDealt()) > 0 {
		dealt := d.placeDealt(NewRng(subSeed(seed, "sites")), cx, cy, dealSlots(w.e, foot), entities, sites, places, dry)
		for _, s := range dealt {
			d.clearSite(s)
		}
		sites = append(sites, dealt...)
	}
	for _, en := range entities {
		d.clearEntity(en)
		d.points = append(d.points, Tile{en.TX, en.TY})
	}

	d.mouths()
	d.layPaths(dry)
	if d.woodsAt(S/2, S/2) {
		d.addGlades()
		d.addSpurs()
		d.addOldRoads()
	}
	d.ensureReach()
	d.dress()

	return Chunk{
		CX:               cx,
		CY:               cy,
		GeneratorVersion: GeneratorV3,
		Size:             S,
		Ground:           d.ground,
		Solid:            d.solid,
		Decor:            d.decor,
		Sites:            orEmpty(sites),
		Entities:         entities,
		Look:             look,
		Mark:             mark,
		Tier:             tier,
		Land:             landName(w.landOne(cx*S+S/2, cy*S+S/2)),
		Places:           marks,
	}, nil
}

func orEmpty[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// ---------------------------------------------------------------- entities

// placeEntities places content's entity kinds (in rule order, v2's counts)
// on dry interior tiles clear of the water, the road, the sites and the
// places, then each place's own entities round its landmark. Ids are
// `<kind>:<cx>:<cy>:<index>`, the index counting within the kind. A kind
// with no room left is placed fewer times rather than failing the chunk.
func (d *detail) placeEntities(rng *Rng, cx, cy, tier int, places []*Place, dry []bool, avoid []Tile) []Entity {
	S := d.S
	data := content.WildsRules
	var occupied []Tile
	ok := func(x, y int) bool {
		i := d.at(x, y)
		if !dry[i] || d.blocked[i] || d.specialAt[i] {
			return false
		}
		switch d.base[i].kind {
		case bRoad, bWater, bFord, bBank, bOpening:
			return false
		}
		return !d.wetNear(x, y, 2)
	}
	free := func(x, y, spacing int) bool {
		if !ok(x, y) {
			return false
		}
		for _, a := range avoid {
			if cheb(x-a.TX, y-a.TY) <= entityClear {
				return false
			}
		}
		for _, p := range places {
			if cheb(x-p.TX, y-p.TY) <= p.clearing+1 {
				return false
			}
		}
		for _, p := range occupied {
			if cheb(x-p.TX, y-p.TY) < spacing {
				return false
			}
		}
		return true
	}
	pick := func() (Tile, bool) {
		room := S - 2*entityMargin
		for attempt := 0; attempt < placeAttempts; attempt++ {
			x, y := entityMargin+rng.NextInt(room), entityMargin+rng.NextInt(room)
			if free(x, y, entitySpacing) {
				return Tile{x, y}, true
			}
		}
		for spacing := entitySpacing - 1; spacing >= 2; spacing-- {
			for y := entityMargin; y < S-entityMargin; y++ {
				for x := entityMargin; x < S-entityMargin; x++ {
					if free(x, y, spacing) {
						return Tile{x, y}, true
					}
				}
			}
		}
		return Tile{}, false
	}
	counts := map[string]int{}
	out := []Entity{}
	add := func(kind string, t Tile) {
		occupied = append(occupied, t)
		e := Entity{ID: fmt.Sprintf("%s:%d:%d:%d", kind, cx, cy, counts[kind]), Kind: kind, TX: t.TX, TY: t.TY, Enemies: []string{}}
		counts[kind]++
		d.fillEntity(rng, &e, tier)
		out = append(out, e)
	}
	for _, rule := range data.EntityKinds {
		n := rng.Between(int(rule.GetMin()), int(rule.GetMax()))
		for i := 0; i < n; i++ {
			if t, found := pick(); found {
				add(rule.GetKind(), t)
			}
		}
	}
	for _, p := range places {
		for _, kind := range p.entities {
			var cands []Tile
			for y := p.TY - p.clearing; y <= p.TY+p.clearing; y++ {
				for x := p.TX - p.clearing; x <= p.TX+p.clearing; x++ {
					c := cheb(x-p.TX, y-p.TY)
					if c < 2 || c > p.clearing-1 || (x == p.TX && y > p.TY) || !d.inBounds(x, y) || !d.walk[d.at(x, y)] || !ok(x, y) {
						continue
					}
					clear := true
					for _, o := range occupied {
						if cheb(x-o.TX, y-o.TY) < 2 {
							clear = false
						}
					}
					if clear {
						cands = append(cands, Tile{x, y})
					}
				}
			}
			if len(cands) > 0 {
				add(kind, cands[rng.NextInt(len(cands))])
			}
		}
	}
	return out
}

// fillEntity draws an entity's contents: a camp's mix by its land's and
// tier's weights together, a node's material by its land's, a chest's tier
// from the tier's range, a point of interest from content's list.
func (d *detail) fillEntity(rng *Rng, e *Entity, tier int) {
	data := content.WildsRules
	land := landData(d.landAt(e.TX, e.TY))
	t := data.Tiers[max(min(tier, len(data.Tiers)), 1)-1]
	switch e.Kind {
	case kindCamp:
		var weights []int
		for _, mix := range data.CampMixes {
			weights = append(weights, weightOf(land.GetCampMixes(), mix.GetId())*weightOf(t.GetCampMixes(), mix.GetId()))
		}
		if slices.Max(weights) == 0 {
			weights = weights[:0]
			for _, mix := range data.CampMixes {
				weights = append(weights, weightOf(t.GetCampMixes(), mix.GetId()))
			}
		}
		e.Enemies = slices.Clone(data.CampMixes[weighted(rng, weights)].GetEnemies())
	case kindNode:
		var weights []int
		for _, m := range data.Materials {
			weights = append(weights, weightOf(land.GetMaterials(), m))
		}
		e.Material = data.Materials[weighted(rng, weights)]
	case kindChest:
		e.Tier = rng.Between(int(t.GetChestMin()), int(t.GetChestMax()))
	default:
		e.POI = data.PoiIds[rng.NextInt(len(data.PoiIds))]
	}
}

func weightOf(list []*content.WildsWeight, id string) int {
	for _, w := range list {
		if w.GetId() == id {
			return int(w.GetWeight())
		}
	}
	return 0
}

// ---------------------------------------------------------------- dealt sites

// dealSlots deals a footprint's dealt sites over its chunks each epoch, as
// v2's siteSlots did: an "east" site to the east column, the rest spread to
// the least-used chunks (a fixed site's chunk counts as used), then chance.
func dealSlots(e Epoch, p *content.WildsPlace) []siteSlot {
	rng := NewRng(e.hash("sites", p.GetId()))
	x0, y0 := int(p.GetCx()), int(p.GetCy())
	load := map[Tile]int{}
	for _, s := range p.GetSites() {
		load[Tile{int(s.GetCx()), int(s.GetCy())}]++
	}
	var all, east []Tile
	for cy := y0; cy < y0+int(p.GetHeight()); cy++ {
		for cx := x0; cx < x0+int(p.GetWidth()); cx++ {
			all = append(all, Tile{cx, cy})
			if cx == x0+int(p.GetWidth())-1 {
				east = append(east, Tile{cx, cy})
			}
		}
	}
	take := func(pool []Tile) Tile {
		least := -1
		for _, c := range pool {
			if least < 0 || load[c] < least {
				least = load[c]
			}
		}
		var options []Tile
		for _, c := range pool {
			if load[c] == least {
				options = append(options, c)
			}
		}
		c := options[rng.NextInt(len(options))]
		load[c]++
		return c
	}
	var out []siteSlot
	for _, s := range p.GetDealt() {
		pool := all
		if s.GetColumn() == "east" {
			pool = east
		}
		c := take(pool)
		out = append(out, siteSlot{s.GetId(), SiteKind(s.GetKind()), c.TX, c.TY})
	}
	return out
}

// placeDealt places this chunk's dealt sites clear of the edge, the water,
// the road, the entities, the places and each other.
func (d *detail) placeDealt(rng *Rng, cx, cy int, slots []siteSlot, entities []Entity, fixed []Site, places []*Place, dry []bool) []Site {
	S := d.S
	out := []Site{}
	for _, slot := range slots {
		if slot.cx != cx || slot.cy != cy {
			continue
		}
		free := func(x, y, entityGap int) bool {
			i := d.at(x, y)
			if !dry[i] || d.blocked[i] || d.wetNear(x, y, 2) {
				return false
			}
			switch d.base[i].kind {
			case bRoad, bWater, bFord, bBank:
				return false
			}
			for _, e := range entities {
				if cheb(x-e.TX, y-e.TY) <= entityGap {
					return false
				}
			}
			for _, p := range places {
				if cheb(x-p.TX, y-p.TY) <= p.clearing+2 {
					return false
				}
			}
			for _, s := range append(slices.Clone(fixed), out...) {
				if cheb(x-s.TX, y-s.TY) < siteSpacing {
					return false
				}
			}
			return slot.kind != SiteReeds || y >= reedsMinTY
		}
		for _, gap := range []int{3, 2} {
			var cands []Tile
			for y := siteMargin; y < S-siteMargin; y++ {
				for x := siteMargin; x < S-siteMargin; x++ {
					if free(x, y, gap) {
						cands = append(cands, Tile{x, y})
					}
				}
			}
			if len(cands) == 0 {
				continue
			}
			t := cands[rng.NextInt(len(cands))]
			out = append(out, Site{ID: slot.id, Kind: slot.kind, CX: cx, CY: cy, TX: t.TX, TY: t.TY})
			break
		}
	}
	return out
}
