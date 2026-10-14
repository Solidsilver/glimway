package content

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	contentv1 "glimway/gen/glimway/content/v1"
)

// The places over the outdoor grid (content/places.json): the fixed
// footprints, the rules generated places share and the rules of the spaces
// beside the grid, read by server/internal/location and its client twin
// (src/lib/location.ts). The schema and its field rules live in
// proto/glimway/content/v1/places.proto.
type (
	Places      = contentv1.Places
	FixedPlace  = contentv1.FixedPlace
	PlaceRules  = contentv1.PlaceRules
	SpaceRules  = contentv1.SpaceRules
	PlaceTile   = contentv1.PlaceTile
	PlaceZone   = contentv1.PlaceZone
	PlaceAnchor = contentv1.PlaceAnchor
)

// DecodePlaces reads places JSON into the generated types, refusing nulls
// and unknown keys, then runs the schema's rules and the rules that span
// entries and files (placesRules, against the shipped Wilds footprints).
func DecodePlaces(raw []byte) (*Places, error) {
	doc := &Places{}
	if err := decodeContentProto(raw, "places", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("places", entryLists(doc, "fixed"), doc); err != nil {
		return doc, err
	}
	return doc, placesRules(doc, WildsRules)
}

func LoadPlaces() (*Places, error) {
	raw, err := FS.ReadFile("places.json")
	if err != nil {
		return nil, err
	}
	return DecodePlaces(raw)
}

var PlacesRules = func() *Places {
	doc, err := LoadPlaces()
	if err != nil {
		panic(err)
	}
	return doc
}()

// FixedChunks is a fixed place's footprint as an inclusive chunk rectangle.
func FixedChunks(p *FixedPlace) (x0, y0, x1, y1 int) {
	x0, y0 = int(p.GetCx()), int(p.GetCy())
	return x0, y0, x0 + int(p.GetWidth()) - 1, y0 + int(p.GetHeight()) - 1
}

// placeSpaces are the ids a fixed place may not take: the outdoor space, the
// Beyond and the spaces beside the grid.
var placeSpaces = []string{"outdoors", "beyond", "village", "woodland", "ruin", "home", "in"}

// placesRules: the rules that span entries, the twin of the TypeScript
// loader's (src/lib/places.ts), word for word. Fixed places have unique ids
// that no Wilds footprint or space uses, lie apart from each other and from
// the Wilds footprints, and keep their zones and anchors inside their own
// footprint; zone and anchor ids are unique in their place; gate anchors
// are numbered gate:0 to gate:n-1, n being the place's gate capacity.
func placesRules(p *Places, w *Wilds) error {
	bad := func(format string, args ...any) error {
		return fmt.Errorf("invalid places: "+format, args...)
	}
	S := int(w.GetChunkSize())
	type rect struct {
		id             string
		x0, y0, x1, y1 int
	}
	var taken []rect
	for _, f := range w.GetPlaces() {
		taken = append(taken, rect{f.GetId(), int(f.GetCx()), int(f.GetCy()), int(f.GetCx()) + int(f.GetWidth()) - 1, int(f.GetCy()) + int(f.GetHeight()) - 1})
	}
	seen := map[string]bool{}
	for _, f := range p.GetFixed() {
		id := f.GetId()
		if seen[id] {
			return bad("duplicate place %s", id)
		}
		seen[id] = true
		if slices.Contains(placeSpaces, id) || slices.ContainsFunc(w.GetPlaces(), func(g *WildsPlace) bool { return g.GetId() == id }) {
			return bad("place %s is reserved", id)
		}
		x0, y0, x1, y1 := FixedChunks(f)
		for _, r := range taken {
			if x0 <= r.x1 && r.x0 <= x1 && y0 <= r.y1 && r.y0 <= y1 {
				return bad("place %s overlaps %s", id, r.id)
			}
		}
		taken = append(taken, rect{id, x0, y0, x1, y1})
		// The footprint in layout tiles, inclusive.
		ox, oy := int(f.GetOrigin().GetTx()), int(f.GetOrigin().GetTy())
		lx0, ly0, lx1, ly1 := x0*S-ox, y0*S-oy, (x1+1)*S-1-ox, (y1+1)*S-1-oy
		inside := func(tx, ty int) bool { return tx >= lx0 && tx <= lx1 && ty >= ly0 && ty <= ly1 }
		zones := map[string]bool{}
		for _, z := range f.GetZones() {
			if zones[z.GetId()] {
				return bad("%s: duplicate zone %s", id, z.GetId())
			}
			zones[z.GetId()] = true
			tx, ty := int(z.GetTx()), int(z.GetTy())
			if !inside(tx, ty) || !inside(tx+int(z.GetW())-1, ty+int(z.GetH())-1) {
				return bad("%s zone %s: outside the footprint", id, z.GetId())
			}
		}
		anchors := map[string]bool{}
		for _, a := range f.GetAnchors() {
			if anchors[a.GetId()] {
				return bad("%s: duplicate anchor %s", id, a.GetId())
			}
			anchors[a.GetId()] = true
			if !inside(int(a.GetTx()), int(a.GetTy())) {
				return bad("%s anchor %s: outside the footprint", id, a.GetId())
			}
		}
		// The gate anchors are the frozen capacity: gate:0 up to gate:n-1.
		gates := map[int]bool{}
		for _, a := range f.GetAnchors() {
			n, ok := strings.CutPrefix(a.GetId(), "gate:")
			if !ok {
				continue
			}
			if !gateNumber.MatchString(n) {
				return bad("%s anchor %s: not a gate number", id, a.GetId())
			}
			g, _ := strconv.Atoi(n)
			gates[g] = true
		}
		for g := range len(gates) {
			if !gates[g] {
				return bad("%s: gate anchors skip gate:%d", id, g)
			}
		}
	}
	return nil
}

var gateNumber = regexp.MustCompile(`^(0|[1-9][0-9]{0,3})$`)
