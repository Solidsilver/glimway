package wilds

// Generator v2: the whole Wilds chunk, made on the server (server-first.md,
// section 3). One chunk is its ground and solid grids, its exits, its decor,
// its story-site geometry and its entities with their loot inputs. A region
// epoch's nine chunks are made at once (GenerateRegion), stored, and never
// regenerated.
//
// v2 keeps v1's places and rules (the same regions, entity kinds and counts,
// loot tables, sites and crossing) but is free to lay them out anew; it is
// not compatible with v1 or with the TypeScript generator. Everything is a
// pure function of the epoch and the chunk coordinates, in integer
// arithmetic only.
//
// Seeds: each chunk's seed is ChunkSeed(epoch, cx, cy) (the epoch carries
// generator version 2); entities, sites and terrain draw from separate
// sub-streams of it. Region-wide choices (where each site goes, where each
// shared edge's gap sits) come from hashes of the epoch alone, so both
// sides of an edge agree without generating each other.

import (
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"glimway/content"
)

// GeneratorV2 is the generator version this file implements.
const GeneratorV2 = 2

// Region ids and the crossing between them.
const (
	InnerRegion = "inner-1" // the Tangle, permanent
	OuterRegion = "outer-1" // the Whitequiet, turning each wick
)

// ErrGeneratorUnavailable: the epoch names a generator version this code
// doesn't have (the server answers `generator-unavailable`).
var ErrGeneratorUnavailable = errors.New("wilds: generator unavailable")

// Tile is a tile position inside a chunk.
type Tile struct {
	TX int `json:"tx"`
	TY int `json:"ty"`
}

// Dir is the edge an exit sits on.
type Dir uint8

const (
	North Dir = iota
	East
	South
	West
)

func (d Dir) String() string { return [...]string{"north", "east", "south", "west"}[d] }

// Exit is a doorway on a chunk edge. To is "chunk:<region>:<cx>:<cy>" or
// "commons"; Entry is where the hero arrives, in the tiles of To (for
// "commons", the Commons owns its own arrival and Entry is the tile just
// inside this gap, as in v1).
type Exit struct {
	TX    int    `json:"tx"`
	TY    int    `json:"ty"`
	TW    int    `json:"tw"`
	TH    int    `json:"th"`
	Dir   Dir    `json:"dir"`
	To    string `json:"to"`
	Entry Tile   `json:"entry"`
}

func (e Exit) contains(x, y int) bool {
	return x >= e.TX && x < e.TX+e.TW && y >= e.TY && y < e.TY+e.TH
}

// near is true within r tiles of the doorway rectangle.
func (e Exit) near(x, y, r int) bool {
	return x >= e.TX-r && x < e.TX+e.TW+r && y >= e.TY-r && y < e.TY+e.TH+r
}

// SiteKind names a story site (src/lib/wilds/outer.ts):
//   - echo: a phantom camp where an Echo of the Six can wait (outer)
//   - given: where the outer Wilds give a text back, by the way home (outer entry)
//   - cairn: the Amberwash forage cairn (outer)
//   - nest: a dead iron-oak with a jackdaw's nest (outer)
//   - reeds: a backwater of the Wend, with a still pool two tiles north (outer)
//   - plank: a plank half-buried where the bridge tore (the Tangle's crossing)
type SiteKind string

const (
	SiteEcho  SiteKind = "echo"
	SiteGiven SiteKind = "given"
	SiteCairn SiteKind = "cairn"
	SiteNest  SiteKind = "nest"
	SiteReeds SiteKind = "reeds"
	SitePlank SiteKind = "plank"
)

// Site is a story site's geometry: never who or what waits there for a
// player. ID is stable within the epoch: the kind, or "echo:<n>".
type Site struct {
	ID   string   `json:"id"`
	Kind SiteKind `json:"kind"`
	CX   int      `json:"cx"`
	CY   int      `json:"cy"`
	TX   int      `json:"tx"`
	TY   int      `json:"ty"`
}

// Chunk is one generated chunk. Ground and Solid are row-major,
// cell i = ty*Size + tx.
type Chunk struct {
	RegionID         string   `json:"regionId"`
	CX               int      `json:"cx"`
	CY               int      `json:"cy"`
	GeneratorVersion int      `json:"generatorVersion"`
	Size             int      `json:"size"`
	Ground           []Ground `json:"ground"`
	Solid            []bool   `json:"solid"`
	Exits            []Exit   `json:"exits"`
	Decor            []Decor  `json:"decor"`
	Sites            []Site   `json:"sites"`
	Entities         []Entity `json:"entities"`
	Spawn            Tile     `json:"spawn"`
	Look             string   `json:"look"` // "tangle" | "outer"
	Mark             string   `json:"mark"` // the season's Mark for the outer look; "" when permanent
}

// Walkable is true for an in-chunk tile that isn't solid.
func (c *Chunk) Walkable(x, y int) bool {
	return x >= 0 && y >= 0 && x < c.Size && y < c.Size && !c.Solid[y*c.Size+x]
}

// Region is a region epoch's whole output: every chunk (row-major,
// cy*Width + cx) and every story site (the Echo rule assigns over all of
// them).
type Region struct {
	RegionID string  `json:"regionId"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Chunks   []Chunk `json:"chunks"`
	Sites    []Site  `json:"sites"`
}

// Chunk returns the chunk at (cx, cy), or nil outside the grid.
func (r *Region) Chunk(cx, cy int) *Chunk {
	if cx < 0 || cy < 0 || cx >= r.Width || cy >= r.Height {
		return nil
	}
	return &r.Chunks[cy*r.Width+cx]
}

// GenerateRegion makes all chunks of a region epoch (pre-generation at
// epoch creation).
func GenerateRegion(epoch Epoch) (Region, error) {
	region, err := v2Region(epoch)
	if err != nil {
		return Region{}, err
	}
	out := Region{RegionID: region.GetId(), Width: int(region.GetGridWidth()), Height: int(region.GetGridHeight()), Sites: []Site{}}
	for cy := 0; cy < int(region.GetGridHeight()); cy++ {
		for cx := 0; cx < int(region.GetGridWidth()); cx++ {
			c, err := GenerateChunk(epoch, cx, cy)
			if err != nil {
				return Region{}, err
			}
			out.Chunks = append(out.Chunks, c)
			out.Sites = append(out.Sites, c.Sites...)
		}
	}
	return out, nil
}

// GenerateChunk makes one chunk of a region epoch.
func GenerateChunk(epoch Epoch, cx, cy int) (Chunk, error) {
	region, err := v2Region(epoch)
	if err != nil {
		return Chunk{}, err
	}
	if cx < 0 || cy < 0 || cx >= int(region.GetGridWidth()) || cy >= int(region.GetGridHeight()) {
		return Chunk{}, fmt.Errorf("wilds: chunk %d,%d is outside region %s", cx, cy, region.GetId())
	}
	mark, err := seasonMark(epoch.Season)
	if err != nil {
		return Chunk{}, err
	}
	data := content.WildsRules
	S := int(data.GetChunkSize())
	outer := region.GetKind() == "outer"
	seed := ChunkSeed(epoch, cx, cy)

	exits := chunkExits(epoch, region, cx, cy)
	spawn := spawnTile(S, exits)
	entities, err := placeEntities(NewRng(subSeed(seed, "entities")), S, cx, cy, exits, spawn)
	if err != nil {
		return Chunk{}, err
	}
	sites := placeSites(NewRng(subSeed(seed, "sites")), S, cx, cy, siteSlots(epoch, region), exits, spawn, entities)

	// Turncaps lean toward a light that held: in the Tangle, home (the
	// Commons gap on the entry chunk); past the crossing, east, toward
	// Sallow Ford.
	home := Tile{(int(region.GetEntryX())-cx)*S + homeGapTX + 1, (int(region.GetEntryY())-cy)*S + S - 1}
	if outer {
		home = Tile{100 * S, 0}
	}
	w := newWoods(woodsInput{
		size: S, seed: subSeed(seed, "terrain"), exits: exits, entities: entities,
		spawn: spawn, home: home, sites: sites, outer: outer,
	})
	w.lay()

	c := Chunk{
		RegionID:         region.GetId(),
		CX:               cx,
		CY:               cy,
		GeneratorVersion: GeneratorV2,
		Size:             S,
		Ground:           w.ground,
		Solid:            w.solid,
		Exits:            exits,
		Decor:            w.decor,
		Sites:            sites,
		Entities:         entities,
		Spawn:            spawn,
		Look:             "tangle",
		Mark:             mark,
	}
	if outer {
		c.Look = "outer"
	}
	return c, nil
}

func v2Region(epoch Epoch) (*content.WildsRegion, error) {
	if epoch.GeneratorVersion != GeneratorV2 {
		return nil, fmt.Errorf("%w: version %d", ErrGeneratorUnavailable, epoch.GeneratorVersion)
	}
	return regionFor(content.WildsRules, epoch.RegionID)
}

// seasonMark is the Mark an outer season ("t:<startsAt>:<endsAt>") falls
// in, or "" for the permanent season "0".
func seasonMark(season string) (string, error) {
	if season == "0" {
		return "", nil
	}
	parts := strings.Split(season, ":")
	if len(parts) == 3 && parts[0] == "t" {
		start, err1 := strconv.ParseInt(parts[1], 10, 64)
		end, err2 := strconv.ParseInt(parts[2], 10, 64)
		if err1 == nil && err2 == nil && end > start {
			return content.CalendarAt(content.CalendarRules, start).Mark, nil
		}
	}
	return "", fmt.Errorf("wilds: bad season %q", season)
}

// ---------------------------------------------------------------- exits

const (
	// homeGapTX is the way home on a region's entry chunk: the south edge at
	// tx = 1. The Tangle's leads to the Commons (whose arrival tile is fixed
	// at (2, 22)); the Whitequiet's leads back over the crossing.
	homeGapTX = 1
	// edgeMargin keeps chunk-to-chunk gaps clear of the corners.
	edgeMargin = 4
)

// crossingChunk is the Tangle chunk whose north edge opens onto the
// Whitequiet's entry chunk, through a gap centred on that edge.
var crossingChunk = Tile{1, 0}

func chunkArea(regionID string, cx, cy int) string {
	return fmt.Sprintf("chunk:%s:%d:%d", regionID, cx, cy)
}

// inward is the tile just inside a gap: where stepping through it lands.
func inward(S int, dir Dir, offset int) Tile {
	switch dir {
	case North:
		return Tile{offset + 1, 1}
	case South:
		return Tile{offset + 1, S - 2}
	case West:
		return Tile{1, offset + 1}
	default:
		return Tile{S - 2, offset + 1}
	}
}

// inward is the tile just inside this doorway.
func (e Exit) inward(S int) Tile {
	if e.Dir == North || e.Dir == South {
		return inward(S, e.Dir, e.TX)
	}
	return inward(S, e.Dir, e.TY)
}

func gap(S int, dir Dir, offset int) (tx, ty, tw, th int) {
	switch dir {
	case North:
		return offset, 0, exitGap, 1
	case South:
		return offset, S - 1, exitGap, 1
	case West:
		return 0, offset, 1, exitGap
	default:
		return S - 1, offset, 1, exitGap
	}
}

// edgeOffset is where the 3-tile gap sits along the shared edge east of
// (cx, cy) (vertical) or south of it (horizontal). Both chunks of the edge
// compute the same value from the epoch.
func edgeOffset(epoch Epoch, region *content.WildsRegion, S, cx, cy int, vertical bool) int {
	lo, hi := edgeMargin, S-edgeMargin-exitGap
	axis := "south"
	if vertical {
		axis = "east"
	} else if cx == int(region.GetEntryX()) && cy == int(region.GetEntryY()) {
		lo = homeGapTX + exitGap + edgeMargin // keep clear of the way home on the same edge
	}
	h := Hash(epoch.WorldSeed, epoch.RegionID, epoch.GeneratorVersion, epoch.Season, "edge", axis, cx, cy)
	return lo + int(h%uint32(hi-lo+1))
}

// chunkExits lists a chunk's exits in a fixed order: north, east, south,
// west to neighbouring chunks, then the way home (entry chunk) or the
// crossing (the Tangle's crossing chunk).
func chunkExits(epoch Epoch, region *content.WildsRegion, cx, cy int) []Exit {
	S := int(content.WildsRules.GetChunkSize())
	out := []Exit{}
	add := func(dir Dir, offset int, to string, entry Tile) {
		tx, ty, tw, th := gap(S, dir, offset)
		out = append(out, Exit{TX: tx, TY: ty, TW: tw, TH: th, Dir: dir, To: to, Entry: entry})
	}
	if cy > 0 {
		o := edgeOffset(epoch, region, S, cx, cy-1, false)
		add(North, o, chunkArea(region.GetId(), cx, cy-1), inward(S, South, o))
	}
	if cx < int(region.GetGridWidth())-1 {
		o := edgeOffset(epoch, region, S, cx, cy, true)
		add(East, o, chunkArea(region.GetId(), cx+1, cy), inward(S, West, o))
	}
	if cy < int(region.GetGridHeight())-1 {
		o := edgeOffset(epoch, region, S, cx, cy, false)
		add(South, o, chunkArea(region.GetId(), cx, cy+1), inward(S, North, o))
	}
	if cx > 0 {
		o := edgeOffset(epoch, region, S, cx-1, cy, true)
		add(West, o, chunkArea(region.GetId(), cx-1, cy), inward(S, East, o))
	}
	crossingOffset := S/2 - 1
	if cx == int(region.GetEntryX()) && cy == int(region.GetEntryY()) {
		if region.GetId() == OuterRegion {
			add(South, homeGapTX, chunkArea(InnerRegion, crossingChunk.TX, crossingChunk.TY), inward(S, North, crossingOffset))
		} else {
			add(South, homeGapTX, "commons", inward(S, South, homeGapTX))
		}
	}
	if region.GetId() == InnerRegion && cx == crossingChunk.TX && cy == crossingChunk.TY {
		if outer, err := regionFor(content.WildsRules, OuterRegion); err == nil {
			add(North, crossingOffset, chunkArea(OuterRegion, int(outer.GetEntryX()), int(outer.GetEntryY())), inward(S, South, homeGapTX))
		}
	}
	return out
}

// spawnTile is just inside the way home when the chunk has one, else just
// inside its first south, north, west or east gap.
func spawnTile(S int, exits []Exit) Tile {
	for _, e := range exits {
		if e.Dir == South && e.TX == homeGapTX && (e.To == "commons" || strings.HasPrefix(e.To, "chunk:"+InnerRegion+":")) {
			return e.inward(S)
		}
	}
	for _, dir := range []Dir{South, North, West, East} {
		for _, e := range exits {
			if e.Dir == dir {
				return e.inward(S)
			}
		}
	}
	return Tile{S / 2, S / 2}
}

// ---------------------------------------------------------------- entities

const (
	entityMargin  = 3 // entities keep this far from the chunk edge
	entityClear   = 3 // ... and from exits and the spawn
	entitySpacing = 4 // ... and from each other (Chebyshev), relaxed when crowded
)

// placeEntities places the content/wilds.json entity kinds in rule order.
// Ids are `<kind>:<cx>:<cy>:<index>`, the index counting within the kind,
// so they are stable within the epoch.
func placeEntities(rng *Rng, S, cx, cy int, exits []Exit, spawn Tile) ([]Entity, error) {
	data := content.WildsRules
	var occupied []Tile
	free := func(x, y, spacing int) bool {
		for _, e := range exits {
			if e.near(x, y, entityClear) {
				return false
			}
		}
		if cheb(x-spawn.TX, y-spawn.TY) <= entityClear {
			return false
		}
		for _, p := range occupied {
			if cheb(x-p.TX, y-p.TY) < spacing {
				return false
			}
		}
		return true
	}
	place := func() (Tile, bool) {
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
	out := []Entity{}
	for _, rule := range data.EntityKinds {
		count := rng.Between(int(rule.GetMin()), int(rule.GetMax()))
		for i := 0; i < count; i++ {
			t, ok := place()
			if !ok {
				return nil, fmt.Errorf("wilds: no room for a %s in chunk %d,%d", rule.GetKind(), cx, cy)
			}
			occupied = append(occupied, t)
			e := Entity{ID: fmt.Sprintf("%s:%d:%d:%d", rule.GetKind(), cx, cy, i), Kind: rule.GetKind(), TX: t.TX, TY: t.TY, Enemies: []string{}}
			switch rule.GetKind() {
			case kindCamp:
				e.Enemies = slices.Clone(data.CampMixes[rng.NextInt(len(data.CampMixes))].GetEnemies())
			case kindNode:
				e.Material = data.Materials[rng.NextInt(len(data.Materials))]
			case kindChest:
				e.Tier = rng.Between(1, 3)
			default:
				e.POI = data.PoiIds[rng.NextInt(len(data.PoiIds))]
			}
			out = append(out, e)
		}
	}
	return out, nil
}

func cheb(dx, dy int) int { return max(abs(dx), abs(dy)) }

// ---------------------------------------------------------------- story sites

// echoSites is the number of Echo camps per outer epoch.
const echoSites = 3

type siteSlot struct {
	id     string
	kind   SiteKind
	cx, cy int
}

// siteSlots is which chunk each of an epoch's sites sits in: in the
// Whitequiet the given-back spot in the entry chunk, one Echo in the east
// column (toward Sallow Ford), two more Echoes, the cairn, the nest and the
// reeds, spread over the other chunks; in the Tangle only the plank by the
// crossing.
func siteSlots(epoch Epoch, region *content.WildsRegion) []siteSlot {
	if region.GetKind() != "outer" {
		if region.GetId() == InnerRegion {
			return []siteSlot{{"plank", SitePlank, crossingChunk.TX, crossingChunk.TY}}
		}
		return nil
	}
	rng := NewRng(Hash(epoch.WorldSeed, epoch.RegionID, epoch.GeneratorVersion, epoch.Season, "sites"))
	load := map[Tile]int{{int(region.GetEntryX()), int(region.GetEntryY())}: 1}
	var away []Tile
	for cy := 0; cy < int(region.GetGridHeight()); cy++ {
		for cx := 0; cx < int(region.GetGridWidth()); cx++ {
			if cx != int(region.GetEntryX()) || cy != int(region.GetEntryY()) {
				away = append(away, Tile{cx, cy})
			}
		}
	}
	// Spread out: the least-used chunks first, then chance.
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
	out := []siteSlot{{"given", SiteGiven, int(region.GetEntryX()), int(region.GetEntryY())}}
	var east []Tile
	for _, c := range away {
		if c.TX == int(region.GetGridWidth())-1 {
			east = append(east, c)
		}
	}
	c := take(east)
	out = append(out, siteSlot{"echo:0", SiteEcho, c.TX, c.TY})
	for i := 1; i < echoSites; i++ {
		c := take(away)
		out = append(out, siteSlot{"echo:" + strconv.Itoa(i), SiteEcho, c.TX, c.TY})
	}
	for _, kind := range []SiteKind{SiteCairn, SiteNest, SiteReeds} {
		c := take(away)
		out = append(out, siteSlot{string(kind), kind, c.TX, c.TY})
	}
	return out
}

const (
	siteMargin  = 4 // sites keep this far from the chunk edge
	siteSpacing = 5 // ... and from each other (Chebyshev)
	reedsMinTY  = 6 // a reed pool sits two tiles north of its site
)

// placeSites places this chunk's sites on tiles clear of the exit mouths,
// the spawn and the entities. The plank prefers the spot just inside the
// crossing, the given-back spot the way home.
func placeSites(rng *Rng, S, cx, cy int, slots []siteSlot, exits []Exit, spawn Tile, entities []Entity) []Site {
	out := []Site{}
	for _, slot := range slots {
		if slot.cx != cx || slot.cy != cy {
			continue
		}
		var prefer *Tile
		switch slot.kind {
		case SitePlank:
			prefer = &Tile{S/2 + 3, 4}
		case SiteGiven:
			prefer = &Tile{6, S - 5}
		}
		free := func(x, y, entityGap int) bool {
			for _, e := range exits {
				if e.near(x, y, 3) {
					return false
				}
			}
			if cheb(x-spawn.TX, y-spawn.TY) <= 3 {
				return false
			}
			for _, e := range entities {
				if cheb(x-e.TX, y-e.TY) <= entityGap {
					return false
				}
			}
			for _, s := range out {
				if cheb(x-s.TX, y-s.TY) < siteSpacing {
					return false
				}
			}
			return slot.kind != SiteReeds || y >= reedsMinTY
		}
		for _, entityGap := range []int{3, 2} {
			var candidates []Tile
			for y := siteMargin; y < S-siteMargin; y++ {
				for x := siteMargin; x < S-siteMargin; x++ {
					if free(x, y, entityGap) {
						candidates = append(candidates, Tile{x, y})
					}
				}
			}
			if len(candidates) == 0 {
				continue
			}
			var t Tile
			if prefer != nil {
				p := *prefer
				slices.SortStableFunc(candidates, func(a, b Tile) int {
					da := (a.TX-p.TX)*(a.TX-p.TX) + (a.TY-p.TY)*(a.TY-p.TY)
					db := (b.TX-p.TX)*(b.TX-p.TX) + (b.TY-p.TY)*(b.TY-p.TY)
					return da - db
				})
				t = candidates[rng.NextInt(min(3, len(candidates)))]
			} else {
				t = candidates[rng.NextInt(len(candidates))]
			}
			out = append(out, Site{ID: slot.id, Kind: slot.kind, CX: cx, CY: cy, TX: t.TX, TY: t.TY})
			break
		}
	}
	return out
}
