package content

import (
	contentv1 "glimway/gen/glimway/content/v1"
)

// Bundled Habitica gear/appearance catalog snapshot
// (content/habitica-gear.json): numeric item data derived from Habitica
// content; art is NOT bundled here. The schema and its (few) rules live in
// proto/glimway/content/v1/habitica_gear.proto; the old hand-written
// loaders checked nothing per entry, and the snapshot is generated upstream.
type (
	HabiticaGear            = contentv1.HabiticaGear
	HabiticaGearProvenance  = contentv1.HabiticaGearProvenance
	HabiticaGearItem        = contentv1.HabiticaGearItem
	HabiticaGearAppearances = contentv1.HabiticaGearAppearances
	HabiticaGearHair        = contentv1.HabiticaGearHair
)

// DecodeHabiticaGear reads the snapshot JSON into the generated types,
// refusing nulls and unknown keys; there are no schema rules and no
// cross-entry rules to run afterwards.
func DecodeHabiticaGear(raw []byte) (*HabiticaGear, error) {
	doc := &HabiticaGear{}
	if err := decodeContentProto(raw, "habitica-gear", doc); err != nil {
		return doc, err
	}
	return doc, contentValidate("habitica-gear", nil, doc)
}

func LoadHabiticaGear() (*HabiticaGear, error) {
	raw, err := FS.ReadFile("habitica-gear.json")
	if err != nil {
		return nil, err
	}
	return DecodeHabiticaGear(raw)
}

// HabiticaGearRules is the validated snapshot, loaded once at start-up.
var HabiticaGearRules = func() *HabiticaGear {
	doc, err := LoadHabiticaGear()
	if err != nil {
		panic(err)
	}
	return doc
}()
