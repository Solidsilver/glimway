package content

import (
	contentv1 "glimway/gen/glimway/content/v1"
)

type (
	Combat      = contentv1.Combat
	CombatClass = contentv1.CombatClass
	CombatHeal  = contentv1.CombatHeal
)

// DecodeCombat reads combat JSON into the generated types, refusing nulls
// and unknown keys, then runs the schema's rules. There are no rules left
// in code: the cooldown, the four classes and the heal formula are all on
// the schema (combat.classes, and the field rules).
func DecodeCombat(raw []byte) (*Combat, error) {
	doc := &Combat{}
	if err := decodeContentProto(raw, "combat", doc); err != nil {
		return doc, err
	}
	return doc, contentValidate("combat", nil, doc)
}

func LoadCombat() (*Combat, error) {
	raw, err := FS.ReadFile("combat.json")
	if err != nil {
		return nil, err
	}
	return DecodeCombat(raw)
}

var CombatRules = func() *Combat {
	c, err := LoadCombat()
	if err != nil {
		panic(err)
	}
	return c
}()
