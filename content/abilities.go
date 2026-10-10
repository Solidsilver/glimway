package content

import (
	"fmt"

	contentv1 "glimway/gen/glimway/content/v1"
)

// The ability table (content/abilities.json; docs/design/crafts.md 4.1),
// on the generated types (proto/glimway/content/v1/abilities.proto): who
// has the move, from which level, what it costs, how often it can be used,
// and its numbers.
type (
	Abilities      = contentv1.Abilities
	Ability        = contentv1.Ability
	AbilityNumbers = contentv1.AbilityNumbers
)

// DecodeAbilities reads abilities JSON into the generated types, refusing
// nulls and unknown keys, then runs the schema's rules (protovalidate) and
// the table's own rules: unique ids, one signature per class at level 10,
// and at most one combat move per class.
func DecodeAbilities(raw []byte) (*Abilities, error) {
	doc := &Abilities{}
	if err := decodeContentProto(raw, "abilities", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("abilities", entryLists(doc, "abilities"), doc); err != nil {
		return doc, err
	}
	return doc, validateAbilities(doc)
}

// abilityNumbers are the numbers each move's behaviour depends on (review
// finding 15). A missing one loads as zero and silently changes what the
// server does — Kindle's reach, Ward-light's circle — so the loader refuses
// the move without it. The counterpart is src/lib/abilities.ts.
var abilityNumbers = map[string][]string{
	"kindle":     {"reachTiles"},
	"ward-light": {"pulses", "pulseHealFraction", "radiusTiles"},
}

// validateAbilities: the rules that span entries (design 4.1, "rules across
// entries, in code once"), identical in src/lib/abilities.ts.
func validateAbilities(v *Abilities) error {
	seen := map[string]bool{}
	signature := map[string]bool{}
	combat := map[string]bool{}
	for _, a := range v.GetAbilities() {
		if seen[a.GetId()] {
			return fmt.Errorf("invalid abilities: duplicate id %s", a.GetId())
		}
		seen[a.GetId()] = true
		n := a.GetNumbers()
		numbers := map[string]float64{
			"reachTiles":        n.GetReachTiles(),
			"pulses":            float64(n.GetPulses()),
			"pulseHealFraction": n.GetPulseHealFraction(),
			"radiusTiles":       n.GetRadiusTiles(),
			"durationSeconds":   n.GetDurationSeconds(),
		}
		for _, field := range abilityNumbers[a.GetId()] {
			if numbers[field] <= 0 {
				return fmt.Errorf("invalid abilities: %s needs %s", a.GetId(), field)
			}
		}
		switch a.GetKind() {
		case "signature":
			if a.GetLevel() != 10 {
				return fmt.Errorf("invalid abilities: %s signature level", a.GetId())
			}
			if signature[a.GetClass()] {
				return fmt.Errorf("invalid abilities: %s second signature", a.GetId())
			}
			signature[a.GetClass()] = true
		case "combat":
			if combat[a.GetClass()] {
				return fmt.Errorf("invalid abilities: %s second move", a.GetId())
			}
			combat[a.GetClass()] = true
		}
	}
	for _, class := range []string{"warrior", "mage", "healer", "rogue"} {
		if !signature[class] {
			return fmt.Errorf("invalid abilities: %s has no signature", class)
		}
	}
	return nil
}

func LoadAbilities() (*Abilities, error) {
	raw, err := FS.ReadFile("abilities.json")
	if err != nil {
		return nil, err
	}
	return DecodeAbilities(raw)
}

var AbilitiesRules = func() *Abilities {
	a, err := LoadAbilities()
	if err != nil {
		panic(err)
	}
	return a
}()

// AbilityFor is a move by id.
func AbilityFor(id string) (*Ability, bool) {
	for _, a := range AbilitiesRules.GetAbilities() {
		if a.GetId() == id {
			return a, true
		}
	}
	return nil, false
}

// SignatureMana is what the class's signature costs (design 4.1: each
// class's cast cost moved to its signature's mana); 0 when the class has
// no signature, which allows no casts.
func SignatureMana(class string) float64 {
	for _, a := range AbilitiesRules.GetAbilities() {
		if a.GetClass() == class && a.GetKind() == "signature" {
			return float64(a.GetMana())
		}
	}
	return 0
}
