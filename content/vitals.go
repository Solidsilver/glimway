package content

import (
	contentv1 "glimway/gen/glimway/content/v1"
)

type Vitals = contentv1.Vitals

// DecodeVitals reads vitals JSON into the generated type, refusing nulls
// and unknown keys, then runs the schema's rules. There are no rules left
// in code: a missing key reads as zero and the vitals.range rule refuses
// it, with NaN and infinities refused by the same comparisons.
func DecodeVitals(raw []byte) (*Vitals, error) {
	doc := &Vitals{}
	if err := decodeContentProto(raw, "vitals", doc); err != nil {
		return doc, err
	}
	return doc, contentValidate("vitals", nil, doc)
}

func LoadVitals() (*Vitals, error) {
	raw, err := FS.ReadFile("vitals.json")
	if err != nil {
		return nil, err
	}
	return DecodeVitals(raw)
}

var VitalsRules = func() *Vitals {
	v, err := LoadVitals()
	if err != nil {
		panic(err)
	}
	return v
}()
