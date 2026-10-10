package content

import (
	"fmt"
	"slices"
	"strings"

	contentv1 "glimway/gen/glimway/content/v1"
)

// The fishery rules (content/fishing.json; docs/design/crafts.md 5.4), on
// the generated types (proto/glimway/content/v1/fishing.proto): the
// fullness bands, the shared hold and spacing, and each water's banks and
// species.
type (
	Fishing     = contentv1.Fishing
	FishBand    = contentv1.FishBand
	FishWater   = contentv1.FishWater
	FishBank    = contentv1.FishBank
	FishTile    = contentv1.FishTile
	FishSpecies = contentv1.FishSpecies
)

// DecodeFishing reads fishing JSON into the generated types, refusing nulls
// and unknown keys, then runs the schema's rules (protovalidate) and the
// fishery's own rules.
func DecodeFishing(raw []byte) (*Fishing, error) {
	doc := &Fishing{}
	if err := decodeContentProto(raw, "fishing", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("fishing", entryLists(doc, "waters"), doc); err != nil {
		return doc, err
	}
	return doc, validateFishing(doc)
}

// validateFishing: the rules that span entries or families (identical in
// src/lib/fishing.ts). The bands run fullest to emptiest with unique ids;
// each water's banks and species are unique; a species is a stackable
// catalogue item; a closed mark is a calendar mark.
func validateFishing(v *Fishing) error {
	bands := map[string]bool{}
	for i, b := range v.GetBands() {
		if bands[b.GetId()] {
			return fmt.Errorf("invalid fishing: duplicate band %s", b.GetId())
		}
		bands[b.GetId()] = true
		if i > 0 && b.GetAtLeastPercent() >= v.GetBands()[i-1].GetAtLeastPercent() {
			return fmt.Errorf("invalid fishing: band order %s", b.GetId())
		}
	}
	// The last band floors at 0: a water with fish in it always has a band
	// (5.3, "very low: under 20 % but at least one fish").
	if floor := v.GetBands()[len(v.GetBands())-1]; floor.GetAtLeastPercent() != 0 {
		return fmt.Errorf("invalid fishing: band floor %s", floor.GetId())
	}
	cal, err := LoadCalendar()
	if err != nil {
		return fmt.Errorf("invalid fishing: calendar")
	}
	waters := map[string]bool{}
	for _, w := range v.GetWaters() {
		if waters[w.GetId()] {
			return fmt.Errorf("invalid fishing: duplicate water %s", w.GetId())
		}
		waters[w.GetId()] = true
		// The id names the water's own area (`water:<area>:<name>`): a
		// mismatch would put the fish in one place and its stock in another
		// (review finding 15).
		if parts := strings.Split(w.GetId(), ":"); len(parts) != 3 || parts[0] != "water" || parts[1] != w.GetArea() {
			return fmt.Errorf("invalid fishing: water id %s does not name its area %s", w.GetId(), w.GetArea())
		}
		banks := map[string]bool{}
		for _, bank := range w.GetBanks() {
			if banks[bank.GetId()] {
				return fmt.Errorf("invalid fishing: %s duplicate bank %s", w.GetId(), bank.GetId())
			}
			banks[bank.GetId()] = true
			for _, mark := range bank.GetClosedIn() {
				if !slices.Contains(cal.GetMarks(), mark) {
					return fmt.Errorf("invalid fishing: %s bank %s closed mark %s", w.GetId(), bank.GetId(), mark)
				}
			}
		}
		species := map[string]bool{}
		for _, s := range w.GetSpecies() {
			if species[s.GetItem()] {
				return fmt.Errorf("invalid fishing: %s duplicate species %s", w.GetId(), s.GetItem())
			}
			species[s.GetItem()] = true
			d, ok := ItemFor(s.GetItem())
			if !ok || !ItemStackable(d) {
				return fmt.Errorf("invalid fishing: %s unknown species %s", w.GetId(), s.GetItem())
			}
		}
	}
	return nil
}

func LoadFishing() (*Fishing, error) {
	raw, err := FS.ReadFile("fishing.json")
	if err != nil {
		return nil, err
	}
	return DecodeFishing(raw)
}

var FishingRules = func() *Fishing {
	f, err := LoadFishing()
	if err != nil {
		panic(err)
	}
	return f
}()

// WaterFor is a fishery by its entity id.
func WaterFor(id string) (*FishWater, bool) {
	for _, w := range FishingRules.GetWaters() {
		if w.GetId() == id {
			return w, true
		}
	}
	return nil, false
}

// BankFor is one bank of a water.
func BankFor(w *FishWater, id string) (*FishBank, bool) {
	for _, b := range w.GetBanks() {
		if b.GetId() == id {
			return b, true
		}
	}
	return nil, false
}

// BandAt is the band a fullness percentage falls in (design 5.3: the first
// whose atLeastPercent it reaches; the bands run fullest to emptiest). A
// water with no fish has no band — the caller refuses before looking.
func BandAt(fullnessPercent float64) *FishBand {
	for _, b := range FishingRules.GetBands() {
		if fullnessPercent >= float64(b.GetAtLeastPercent()) {
			return b
		}
	}
	return nil
}
