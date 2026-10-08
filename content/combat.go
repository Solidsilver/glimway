package content

import (
	"encoding/json"
	"fmt"
)

type CombatClass struct {
	BasicAttackCooldownSeconds float64 `json:"basicAttackCooldownSeconds"`
	CastCost                   float64 `json:"castCost"`
}
type Combat struct {
	SignatureCooldownSeconds float64                `json:"signatureCooldownSeconds"`
	Classes                  map[string]CombatClass `json:"classes"`
	Heal                     struct {
		Base          float64 `json:"base"`
		MaximumBonus  float64 `json:"maximumBonus"`
		Halfway       float64 `json:"halfway"`
		DecimalPlaces int     `json:"decimalPlaces"`
	} `json:"heal"`
}

func LoadCombat() (Combat, error) {
	var c Combat
	raw, err := FS.ReadFile("combat.json")
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	if c.SignatureCooldownSeconds != 1 || len(c.Classes) != 4 || c.Heal.Base <= 0 || c.Heal.MaximumBonus <= 0 || c.Heal.Halfway <= 0 || c.Heal.DecimalPlaces != 2 {
		return c, fmt.Errorf("invalid combat table")
	}
	for _, id := range []string{"warrior", "mage", "rogue", "healer"} {
		v, ok := c.Classes[id]
		if !ok || v.BasicAttackCooldownSeconds <= 0 || v.CastCost <= 0 {
			return c, fmt.Errorf("invalid combat class %s", id)
		}
	}
	return c, nil
}

var CombatRules = func() Combat {
	c, err := LoadCombat()
	if err != nil {
		panic(err)
	}
	return c
}()
