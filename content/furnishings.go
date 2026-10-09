package content

import (
	"fmt"

	contentv1 "glimway/gen/glimway/content/v1"
)

// The one furnishings catalogue (design 2.8): every placeable piece, the
// village's rooms and players' houses alike. Home goods in homestead.json
// keep only what is homestead-specific (category, where, prices, materials)
// and refer to these ids for name and footprint. The schema and its field
// rules live in proto/glimway/content/v1/furnishings.proto.
type (
	Furnishings   = contentv1.Furnishings
	Furnishing    = contentv1.Furnishing
	FurnishBase   = contentv1.FurnishBase
	FurnishOffers = contentv1.FurnishOffers
	FurnishState  = contentv1.FurnishState
)

// DecodeFurnishings reads furnishings JSON into the generated types, refusing
// nulls and unknown keys, then runs the schema's rules (protovalidate) and
// the catalogue's own rule: one id per piece.
func DecodeFurnishings(raw []byte) (*Furnishings, error) {
	doc := &Furnishings{}
	if err := decodeContentProto(raw, "furnishings", doc); err != nil {
		return doc, err
	}
	entries := make([]entryList, 1)
	entries[0] = entryList{field: "pieces", ids: make([]string, len(doc.Pieces))}
	seen := map[string]bool{}
	for i, p := range doc.Pieces {
		entries[0].ids[i] = p.GetId()
		if seen[entries[0].ids[i]] {
			return doc, fmt.Errorf("invalid furnishings: duplicate id %s", entries[0].ids[i])
		}
		seen[entries[0].ids[i]] = true
	}
	return doc, contentValidate("furnishings", entries, doc)
}

func LoadFurnishings() (*Furnishings, error) {
	raw, err := FS.ReadFile("furnishings.json")
	if err != nil {
		return nil, err
	}
	return DecodeFurnishings(raw)
}

var FurnishingRules = func() *Furnishings {
	doc, err := LoadFurnishings()
	if err != nil {
		panic(err)
	}
	return doc
}()

func FurnishingFor(id string) (*Furnishing, bool) {
	for _, p := range FurnishingRules.Pieces {
		if p.GetId() == id {
			return p, true
		}
	}
	return nil, false
}

// PlaceOn is what a piece is placed onto: the floor, a wall, a rug, or
// another piece's surface (its top or one shelf row). Host and Offer are
// only set for a surface; built in code, so no json tags.
type PlaceOn struct {
	Kind  string
	Host  *Furnishing
	Offer string
}

// slotsFor: how many small-item slots a piece fills on a surface, or 0 when
// it can never fit one (large pieces are floor-only).
func slotsFor(size string) int {
	switch size {
	case "small":
		return 1
	case "medium":
		return 2
	}
	return 0
}

// CanPlace answers design 2.8's one placement table for any piece onto the
// floor, a wall, a rug or another piece's surface. at is the 0-based slot on
// a surface (ignored elsewhere). No per-item exceptions: size, mount and
// layer decide. A state never changes where a piece can go.
func CanPlace(piece *Furnishing, onto PlaceOn, at int) bool {
	if piece == nil {
		return false
	}
	if piece.GetLayer() == "under" {
		return onto.Kind == "floor" // a rug: only on the floor, under everything
	}
	if piece.GetMount() == "wall" {
		return onto.Kind == "wall" // wall pieces only on walls
	}
	switch onto.Kind {
	case "floor":
		return true
	case "rug":
		// A rug counts as the floor for every piece but walls and other rugs.
		return true
	case "surface":
		if onto.Host == nil || onto.Host.GetOffers() == nil {
			return false
		}
		var slots int
		switch onto.Offer {
		case "top":
			slots = int(onto.Host.GetOffers().GetTop())
		case "shelves":
			slots = int(onto.Host.GetOffers().GetShelves())
		default:
			return false
		}
		needed := slotsFor(piece.GetSize())
		// A medium piece goes on a top that's big enough, never shelves;
		// a large piece never fits a surface.
		if needed == 0 || piece.GetSize() == "medium" && onto.Offer != "top" {
			return false
		}
		return at >= 0 && at+needed <= slots
	}
	return false
}
