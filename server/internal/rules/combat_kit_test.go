package rules

import (
	"encoding/json"
	"os"
	"testing"
)

func TestCombatKitDerivationSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../content/vectors/fights.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Kit []struct {
			Name, Craft string
			Level       float64
			Stats       Stats
			Expected    map[string]float64
		}
	}
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors.Kit {
		t.Run(v.Name, func(t *testing.T) {
			p := &Profile{Stats: v.Stats, Level: v.Level}
			if v.Craft != "" {
				p.Class = &v.Craft
			}
			k := CombatKitFor(p, "", 0)
			got := map[string]float64{"meleeDamage": k.MeleeDamage, "signatureDamage": k.SignatureDamage, "mitigation": k.Mitigation, "critChance": k.CritChance, "healAmount": k.HealAmount, "basicAttackCooldown": k.BasicAttackCooldown}
			for key, want := range v.Expected {
				if got[key] != want {
					t.Fatalf("%s = %v want %v", key, got[key], want)
				}
			}
		})
	}
	reborn := &Profile{Level: 1, Stats: Stats{Int: 60}}
	k := CombatKitFor(reborn, "healer", 20)
	if k.Class != "healer" || k.HealAmount != 16 || k.WardPulseHeal != 6.4 {
		t.Fatal(k)
	}
	mage := CombatKitFor(reborn, "wizard", 20)
	if mage.Class != "mage" || mage.SignatureDamage == 0 {
		t.Fatal(mage)
	}
	demo := CombatKitFor(nil, "healer", 20)
	if demo.Class != "" || demo.MeleeDamage != 8.13 || demo.HealAmount != 0 {
		t.Fatal(demo)
	}
}
