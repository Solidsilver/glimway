package content

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// The one furnishings catalogue (design 2.8): every placeable piece, the
// village's rooms and players' houses alike. Home goods in homestead.json
// keep only what is homestead-specific (category, where, prices, materials)
// and refer to these ids for name and footprint.
type FurnishBase struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

func (v *FurnishBase) UnmarshalJSON(raw []byte) error {
	type plain FurnishBase
	return decodeContent(raw, (*plain)(v), "x", "y", "w", "h")
}

// FurnishState: one named state of a piece that changes only by something
// that happens (a quest beat, cooking, a resident's routine), never by
// idling. Exactly one state is the default; Loop marks a slow working loop.
type FurnishState struct {
	Frames  []string `json:"frames"`
	Loop    bool     `json:"loop,omitempty"`
	Default bool     `json:"default,omitempty"`
}

func (v *FurnishState) UnmarshalJSON(raw []byte) error {
	type plain FurnishState
	return decodeContent(raw, (*plain)(v), "frames")
}

// FurnishOffers: the surfaces a piece provides for other pieces, each sized
// in small-item slots (a small piece takes one, a medium two).
type FurnishOffers struct {
	Top     int `json:"top,omitempty"`
	Shelves int `json:"shelves,omitempty"`
}

// Each present key must carry a real slot count, and at least one key must
// be present; explicit nulls are refused like any other content field.
func (v *FurnishOffers) UnmarshalJSON(raw []byte) error {
	type slots struct {
		Top     *int `json:"top"`
		Shelves *int `json:"shelves"`
	}
	var s slots
	if err := decodeContent(raw, &s); err != nil {
		return err
	}
	if s.Top == nil && s.Shelves == nil {
		return fmt.Errorf("offers need top or shelves")
	}
	for _, n := range []*int{s.Top, s.Shelves} {
		if n != nil && (*n < 1 || *n > 12) {
			return fmt.Errorf("offers slots out of range")
		}
	}
	if s.Top != nil {
		v.Top = *s.Top
	}
	if s.Shelves != nil {
		v.Shelves = *s.Shelves
	}
	return nil
}

type Furnishing struct {
	ID        string                  `json:"id"`
	Name      string                  `json:"name"`
	Facings   map[string]string       `json:"facings"`
	Footprint []int                   `json:"footprint"`
	Base      FurnishBase             `json:"base"`
	Mount     string                  `json:"mount"`
	Offers    *FurnishOffers          `json:"offers,omitempty"`
	Size      string                  `json:"size,omitempty"`
	Layer     string                  `json:"layer,omitempty"`
	States    map[string]FurnishState `json:"states,omitempty"`
	Tags      []string                `json:"tags"`
}

// Required except size, which a rug (layer "under") may omit; offers, layer
// and states are absent-means-none, and an explicit null is refused.
func (v *Furnishing) UnmarshalJSON(raw []byte) error {
	type plain Furnishing
	return decodeContent(raw, (*plain)(v), "id", "name", "facings", "footprint", "base", "mount", "tags")
}

type Furnishings struct {
	Pieces []Furnishing `json:"pieces"`
}

var furnishFacings = []string{"front", "left", "right", "diag"}
var furnishMounts = []string{"floor", "wall", "surface"}
var furnishSizes = []string{"small", "medium", "large"}

// A tag is a game-internal label ("seat", "light", "section:stories"), never
// a placement rule.
func validFurnishTag(tag string) bool {
	for _, part := range strings.Split(tag, ":") {
		if !ValidContentID(part) {
			return false
		}
	}
	return tag != ""
}

func validateFurnishStates(states map[string]FurnishState) error {
	if len(states) == 0 {
		return nil
	}
	defaults := 0
	for name, s := range states {
		if !ValidContentID(name) || len(s.Frames) == 0 {
			return fmt.Errorf("state %s", name)
		}
		for _, f := range s.Frames {
			if !ValidContentID(f) && f != "" {
				return fmt.Errorf("state %s frame %q", name, f)
			}
		}
		if s.Default {
			defaults++
		}
	}
	if defaults != 1 {
		return fmt.Errorf("states need exactly one default, have %d", defaults)
	}
	return nil
}

func ValidateFurnishings(doc Furnishings) error {
	bad := func(s string) error { return fmt.Errorf("invalid furnishings: %s", s) }
	if len(doc.Pieces) == 0 {
		return bad("empty")
	}
	seen := map[string]bool{}
	for _, p := range doc.Pieces {
		if !ValidContentID(p.ID) || seen[p.ID] {
			return bad("id " + p.ID)
		}
		seen[p.ID] = true
		if p.Name == "" {
			return bad(p.ID + " name")
		}
		if len(p.Footprint) != 2 || p.Footprint[0] < 1 || p.Footprint[0] > 12 || p.Footprint[1] < 1 || p.Footprint[1] > 10 {
			return bad(p.ID + " footprint")
		}
		if !slices.Contains(furnishMounts, p.Mount) {
			return bad(p.ID + " mount")
		}
		// A rug (layer "under") may omit its size; nothing else may.
		if p.Size != "" || p.Layer != "under" {
			if !slices.Contains(furnishSizes, p.Size) {
				return bad(p.ID + " size")
			}
		}
		if p.Layer != "" && p.Layer != "under" {
			return bad(p.ID + " layer")
		}
		if p.Tags == nil {
			return bad(p.ID + " tags")
		}
		if len(p.Facings) == 0 {
			return bad(p.ID + " facings")
		}
		for f, art := range p.Facings {
			// Art frame names may be empty until the art lands.
			if !slices.Contains(furnishFacings, f) || art != "" && !ValidContentID(art) {
				return bad(p.ID + " facing " + f)
			}
		}
		// The base is the part that touches what the piece stands on;
		// collision uses only this.
		if p.Base.X < 0 || p.Base.Y < 0 || p.Base.W < 1 || p.Base.H < 1 ||
			p.Base.X+p.Base.W > p.Footprint[0] || p.Base.Y+p.Base.H > p.Footprint[1] {
			return bad(p.ID + " base")
		}
		// A rug lies on the floor, under everything, and never blocks.
		if p.Layer == "under" && (p.Mount != "floor" || p.Offers != nil) {
			return bad(p.ID + " rug")
		}
		if err := validateFurnishStates(p.States); err != nil {
			return bad(p.ID + " " + err.Error())
		}
		seenTags := map[string]bool{}
		for _, t := range p.Tags {
			if !validFurnishTag(t) || seenTags[t] {
				return bad(p.ID + " tag " + t)
			}
			seenTags[t] = true
		}
	}
	return nil
}

func LoadFurnishings() (Furnishings, error) {
	var doc Furnishings
	b, err := FS.ReadFile("furnishings.json")
	if err == nil {
		err = json.Unmarshal(b, &doc)
	}
	if err == nil {
		err = ValidateFurnishings(doc)
	}
	return doc, err
}

var FurnishingRules = func() Furnishings {
	doc, err := LoadFurnishings()
	if err != nil {
		panic(err)
	}
	return doc
}()

func FurnishingFor(id string) (Furnishing, bool) {
	for _, p := range FurnishingRules.Pieces {
		if p.ID == id {
			return p, true
		}
	}
	return Furnishing{}, false
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
	if piece.Layer == "under" {
		return onto.Kind == "floor" // a rug: only on the floor, under everything
	}
	if piece.Mount == "wall" {
		return onto.Kind == "wall" // wall pieces only on walls
	}
	switch onto.Kind {
	case "floor":
		return true
	case "rug":
		// A rug counts as the floor for every piece but walls and other rugs.
		return true
	case "surface":
		if onto.Host == nil || onto.Host.Offers == nil {
			return false
		}
		var slots int
		switch onto.Offer {
		case "top":
			slots = onto.Host.Offers.Top
		case "shelves":
			slots = onto.Host.Offers.Shelves
		default:
			return false
		}
		needed := slotsFor(piece.Size)
		// A medium piece goes on a top that's big enough, never shelves;
		// a large piece never fits a surface.
		if needed == 0 || piece.Size == "medium" && onto.Offer != "top" {
			return false
		}
		return at >= 0 && at+needed <= slots
	}
	return false
}
