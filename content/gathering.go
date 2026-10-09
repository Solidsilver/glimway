package content

import (
	"fmt"
	"slices"
	"strings"

	contentv1 "glimway/gen/glimway/content/v1"
)

// Gathering rules and yields (content/gathering.json; docs/items/crafting-and-repair.md).
// The schema and its field rules live in proto/glimway/content/v1/gathering.proto.

type (
	Gathering           = contentv1.Gathering
	GatheringArea       = contentv1.GatheringArea
	GatheringCaps       = contentv1.GatheringCaps
	GatheringActionCaps = contentv1.GatheringActionCaps
	GatheringYield      = contentv1.GatheringYield
	GatheringTarget     = contentv1.GatheringTarget
)

// DecodeGathering reads gathering JSON into the generated types, refusing
// nulls and unknown keys, then runs the schema's rules (protovalidate) and
// the gathering's own rules.
func DecodeGathering(raw []byte) (*Gathering, error) {
	doc := &Gathering{}
	if err := decodeContentProto(raw, "gathering", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("gathering", entryLists(doc, "seeds"), doc); err != nil {
		return doc, err
	}
	return doc, validateGathering(doc)
}

// validateGathering: the rules that span entries or families: every area's
// targets exist, every yield names a catalogue item, and every mark and
// wick is a calendar name.
func validateGathering(g *Gathering) error {
	cal, err := LoadCalendar()
	if err != nil {
		return fmt.Errorf("invalid gathering: calendar: %v", err)
	}
	for _, area := range []string{"wilds", "woodland", "home"} {
		if len(g.GetAreas()[area].GetTargets()) == 0 {
			return fmt.Errorf("invalid gathering: area %s offers nothing", area)
		}
	}
	for area, list := range g.GetAreas() {
		for _, t := range list.GetTargets() {
			if _, ok := g.GetTargets()[t]; !ok {
				return fmt.Errorf("invalid gathering: area %s names unknown target %s", area, t)
			}
		}
	}
	for id, t := range g.GetTargets() {
		if t.GetMark() != "" && !slices.Contains(cal.Marks, t.GetMark()) || t.GetWick() != "" && !slices.Contains(cal.Wicks, t.GetWick()) {
			return fmt.Errorf("invalid gathering: target %s has an invalid season", id)
		}
		for _, y := range t.GetYields() {
			if _, ok := ItemFor(y.GetItem()); !ok {
				return fmt.Errorf("invalid gathering: target %s yields unknown item %s", id, y.GetItem())
			}
			if y.GetMark() != "" && !slices.Contains(cal.Marks, y.GetMark()) {
				return fmt.Errorf("invalid gathering: target %s yield %s has an invalid mark", id, y.GetItem())
			}
		}
	}
	for _, id := range g.GetSeeds() {
		d, ok := ItemFor(id)
		if !ok || d.GetKind() != "seed" {
			return fmt.Errorf("invalid gathering: seed %s is unknown or not a seed", id)
		}
	}
	return nil
}

func LoadGathering() (*Gathering, error) {
	raw, err := FS.ReadFile("gathering.json")
	if err != nil {
		return nil, err
	}
	return DecodeGathering(raw)
}

var GatheringRules = func() *Gathering {
	g, err := LoadGathering()
	if err != nil {
		panic(fmt.Sprintf("content/gathering.json: %v", err))
	}
	return g
}()

// InSeason: whether a piece (or yield) turns up on the given calendar day.
func GatheringYieldInSeason(y *GatheringYield, d CalendarDay) bool {
	return y.GetMark() == "" || d.Mark == y.GetMark()
}
func GatheringTargetInSeason(t *GatheringTarget, d CalendarDay) bool {
	if t.GetMark() != "" && d.Mark != t.GetMark() {
		return false
	}
	return t.GetWick() == "" || d.Wick == t.GetWick()
}

func GatheringTargetFor(targetID string) (*GatheringTarget, bool) {
	t, ok := GatheringRules.Targets[targetID]
	return t, ok
}

// GatheringOffered: whether a place (a progress area: "wilds", "woodland",
// "home:<gate>") has pieces of a target at all. Anywhere else has none.
func GatheringOffered(area, target string) bool {
	if strings.HasPrefix(area, "home:") {
		area = "home"
	}
	return slices.Contains(GatheringRules.GetAreas()[area].GetTargets(), target)
}

func IsGatheringSeed(itemDef string) bool {
	return slices.Contains(GatheringRules.Seeds, itemDef)
}
