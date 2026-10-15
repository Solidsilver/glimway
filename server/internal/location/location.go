// Package location is the one lookup for "where am I" (docs/design/
// location-seam.md 1.2, shared-fights.md 1.11): which place a position in a
// space is in and what that place allows, which source a chunk's ground
// comes from, whether an outdoor chunk exists, and where anchors and
// world-tile content positions lie on the grid. It is pure: content only
// (content/places.json, content/wilds.json), no store. src/lib/location.ts
// is the twin; both replay content/vectors/location.json.
//
// Positions are world pixels, as Where and saved places carry them; tiles
// are 16 px and chunks content/wilds.json's chunkSize tiles, both signed
// and floor-divided (server/internal/wilds/coords.go). Content coordinates
// are int32 on the schema, bounded so every sum and product below is exact
// (places.proto); each is widened to int or float64 before arithmetic all
// the same, as the TypeScript twin's numbers are.
package location

import (
	"strings"

	"glimway/content"
	"glimway/server/internal/frontier"
	"glimway/server/internal/wilds"
	"regexp"
)

// Space is the coordinate frame a position is in, and the saved area:
// "outdoors", a curated space not yet on the grid ("village", "woodland",
// "ruin", "commons" until the join), "home:<g>" or "in:<room>".
type Space string

const Outdoors Space = "outdoors"

// Beyond is the place id of generated ground outside every Wilds footprint.
const Beyond = "beyond"

// SourceKind is where a chunk's ground comes from. Held (a kept epoch,
// Lamps) comes later, as a store-backed wrapper over SourceOf.
type SourceKind int

const (
	// SourceNone: the position isn't outdoors.
	SourceNone SourceKind = iota
	// SourceFixed: an authored layout, served at its revision.
	SourceFixed
	// SourceGenerated: made by the Wilds generator, still or at the wick.
	SourceGenerated
)

func (k SourceKind) String() string {
	switch k {
	case SourceFixed:
		return "fixed"
	case SourceGenerated:
		return "generated"
	}
	return "none"
}

// Source is a chunk's ground: a fixed layout at a revision, or generated in
// an epoch kind ("still", "wick").
type Source struct {
	Kind      SourceKind
	Layout    string
	Revision  int32
	EpochKind string
}

// RestKind is the paid rest a place offers.
type RestKind string

const (
	RestNone    RestKind = "none"
	RestVillage RestKind = "village"
	RestHome    RestKind = "home"
)

// Place is the named region a position is in and what it allows. ID is a
// place id ("commons", "tangle", "whitequiet", "beyond", a zone's place) or,
// off the grid, the space itself ("village", "home:3", "in:commons:yard").
// Source is set outdoors only.
type Place struct {
	ID               string
	Safe, Ride, Sync bool
	Rest             RestKind
	Source           Source
}

const tilePx = 16

var homeSpace = regexp.MustCompile(`^home:(0|[1-9][0-9]{0,3})$`)

// fixedAt is the fixed place whose footprint holds chunk (cx, cy), or nil.
func fixedAt(cx, cy int) *content.FixedPlace {
	for _, f := range content.PlacesRules.GetFixed() {
		x0, y0, x1, y1 := content.FixedChunks(f)
		if cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1 {
			return f
		}
	}
	return nil
}

// fixedByID is the fixed place with the id, or nil.
func fixedByID(id string) *content.FixedPlace {
	for _, f := range content.PlacesRules.GetFixed() {
		if f.GetId() == id {
			return f
		}
	}
	return nil
}

func withRules(id string, r *content.PlaceRules) Place {
	return Place{ID: id, Safe: r.GetSafe(), Ride: r.GetRide(), Sync: r.GetSync(), Rest: RestKind(r.GetRest())}
}

func fixedSource(f *content.FixedPlace) Source {
	return Source{Kind: SourceFixed, Layout: f.GetLayout(), Revision: f.GetRevision()}
}

// spaceRules are the rules of a space beside the grid, by its root
// ("village", "home:3"), or nil for a space nothing names.
func spaceRules(root string, room bool) *content.PlaceRules {
	s := content.PlacesRules.GetSpaces()
	switch {
	case root == "woodland":
		return s.GetWoodland()
	case root == "ruin":
		return s.GetRuin()
	case room && homeSpace.MatchString(root):
		return &content.PlaceRules{Safe: true, Ride: true, Sync: true, Rest: "home"}
	}
	if f := fixedByID(root); f != nil {
		return f.GetRules()
	}
	return nil
}

// At is the place a position is in (world pixels in the space's frame).
// Outdoors it is a fixed footprint's zone or the footprint itself, else the
// generated place: a Wilds footprint's id or the Beyond. A fixed place's own
// id as the space reads world pixels unchanged. A room
// takes its root space's rules and never allows riding. Any other space is
// its own place, allowing nothing. At doesn't ask whether the chunk is on
// the grid (OnGrid does).
func At(space Space, x, y float64) Place {
	if space == Outdoors {
		tx, ty := wilds.TileOfPixel(x, y)
		cx, cy := wilds.ChunkOf(tx, ty)
		if f := fixedAt(cx, cy); f != nil {
			lx, ly := tx-int(f.GetOrigin().GetTx()), ty-int(f.GetOrigin().GetTy())
			p := withRules(f.GetId(), f.GetRules())
			for _, z := range f.GetZones() {
				zx, zy := int(z.GetTx()), int(z.GetTy())
				if lx >= zx && lx < zx+int(z.GetW()) && ly >= zy && ly < zy+int(z.GetH()) {
					p = withRules(z.GetPlace(), z.GetRules())
					break
				}
			}
			p.Source = fixedSource(f)
			return p
		}
		id := Beyond
		if fp := wilds.FootprintAt(cx, cy); fp != nil {
			id = fp.GetId()
		}
		p := withRules(id, content.PlacesRules.GetGenerated())
		p.Source = Source{Kind: SourceGenerated, EpochKind: wilds.EpochKindAt(cx, cy)}
		return p
	}
	if f := fixedByID(string(space)); f != nil {
		return At(Outdoors, x, y)
	}
	if strings.HasPrefix(string(space), "in:") {
		r := spaceRules(content.RootArea(string(space)), true)
		if r == nil {
			return Place{ID: string(space), Rest: RestNone}
		}
		p := withRules(string(space), r)
		p.Ride = false
		return p
	}
	if r := spaceRules(string(space), false); r != nil {
		return withRules(string(space), r)
	}
	return Place{ID: string(space), Rest: RestNone}
}

// SourceOf is where an outdoor chunk's ground comes from: a fixed footprint
// holding it, else the generator in the chunk's epoch kind. It doesn't ask
// whether the chunk is on the grid.
func SourceOf(cx, cy int) Source {
	if f := fixedAt(cx, cy); f != nil {
		return fixedSource(f)
	}
	return Source{Kind: SourceGenerated, EpochKind: wilds.EpochKindAt(cx, cy)}
}

// OnGrid is true for an outdoor chunk that exists: generated land may be
// made there (frontier.Inside), or a fixed footprint covers it.
func OnGrid(world string, cx, cy int) bool {
	return frontier.Inside(world, cx, cy) || fixedAt(cx, cy) != nil
}

// Anchor resolves "<place>:<anchor>" ("hearthwick:arch", "hearthwick:lot:3") to
// its space and the centre of its tile in world pixels.
func Anchor(id string) (Space, float64, float64, bool) {
	place, name, ok := strings.Cut(id, ":")
	if !ok {
		return "", 0, 0, false
	}
	f := fixedByID(place)
	if f == nil {
		return "", 0, 0, false
	}
	for _, a := range f.GetAnchors() {
		if a.GetId() == name {
			tx := int(a.GetTx()) + int(f.GetOrigin().GetTx())
			ty := int(a.GetTy()) + int(f.GetOrigin().GetTy())
			return Outdoors, float64(tx)*tilePx + tilePx/2, float64(ty)*tilePx + tilePx/2, true
		}
	}
	return "", 0, 0, false
}

// ContentSpace maps a named fixed place or lot to the outdoor space.
// Content coordinates are already world tiles and are never translated.
func ContentSpace(area string) Space {
	for _, f := range content.PlacesRules.GetFixed() {
		if f.GetId() == area {
			return Outdoors
		}
		for _, z := range f.GetZones() {
			if z.GetPlace() == area {
				return Outdoors
			}
		}
	}
	return Space(area)
}
