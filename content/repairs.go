package content

import (
	"fmt"
	"slices"

	contentv1 "glimway/gen/glimway/content/v1"
)

// The village repairs (content/repairs.json), on the generated types
// (proto/glimway/content/v1/repairs.proto): weather-broken chores, each
// mending a piece of the village and paying a gift.
type (
	Repairs            = contentv1.Repairs
	RepairsRulesConfig = contentv1.RepairsRulesConfig
	RepairDef          = contentv1.RepairDef
	RepairPos          = contentv1.RepairPos
	RepairGift         = contentv1.RepairGift
	RepairOpenFrom     = contentv1.RepairOpenFrom
)

// DecodeRepairs reads repairs JSON into the generated types, refusing
// nulls and unknown keys, then runs the schema's rules (protovalidate) and
// the repairs' own rules.
func DecodeRepairs(raw []byte) (*Repairs, error) {
	doc := &Repairs{}
	if err := decodeContentProto(raw, "repairs", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("repairs", entryLists(doc, "repairs"), doc); err != nil {
		return doc, err
	}
	return doc, validateRepairs(doc)
}

// validateRepairs: the rules that span entries or families: ids are
// unique, the part is a part/material/consumable in the catalogue, the
// gift is one too, and the opening wick is a calendar one of a calendar
// length.
func validateRepairs(r *Repairs) error {
	ids := map[string]bool{}
	for _, v := range r.GetRepairs() {
		if ids[v.GetId()] {
			return fmt.Errorf("invalid repairs: duplicate id %s", v.GetId())
		}
		ids[v.GetId()] = true
		item, ok := ItemFor(v.GetPart())
		if !ok || item.GetKind() != "part" && item.GetKind() != "material" && item.GetKind() != "consumable" {
			return fmt.Errorf("invalid repairs: %s part", v.GetId())
		}
		if g := v.GetGift(); g != nil {
			if _, ok := ItemFor(g.GetId()); !ok {
				return fmt.Errorf("invalid repairs: %s gift", v.GetId())
			}
		}
		if o := v.GetOpenFrom(); o != nil {
			if !slices.Contains(CalendarRules.Wicks, o.GetWick()) || o.GetDay() > int32(CalendarRules.WickDays) {
				return fmt.Errorf("invalid repairs: %s openFrom", v.GetId())
			}
		}
	}
	for _, s := range r.GetRules().GetScripted() {
		if !ids[s] {
			return fmt.Errorf("invalid repairs: scripted %s", s)
		}
	}
	return nil
}

// WeatherTakes says whether weather can break this repair again (the
// default). The well's rope mends once and stays mended.
func RepairWeatherTakes(d *RepairDef) bool {
	return d.Weather == nil || d.GetWeather()
}

func LoadRepairs() (*Repairs, error) {
	raw, err := FS.ReadFile("repairs.json")
	if err != nil {
		return nil, err
	}
	return DecodeRepairs(raw)
}

var RepairRules = func() *Repairs {
	r, err := LoadRepairs()
	if err != nil {
		panic(err)
	}
	return r
}()

func RepairFor(id string) (*RepairDef, bool) {
	for _, r := range RepairRules.Repairs {
		if r.GetId() == id {
			return r, true
		}
	}
	return nil, false
}
