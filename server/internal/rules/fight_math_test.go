package rules

import (
	"encoding/json"
	"glimway/content"
	contentv1 "glimway/gen/glimway/content/v1"
	"os"
	"testing"
)

func TestFightSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../content/vectors/fights.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Kit []struct {
			Name, Craft string
			Level       int
			Stats       map[string]float64
			Expected    map[string]float64
		}
		Crit []struct {
			Seed, SwingCounter uint32
			Chance, Roll       float64
			Crit               bool
		}
		Damage []struct {
			Base, StunnedMultiplier, Damage float64
			Crit, Tool                      bool
		}
		Reach []struct {
			Kind                                   string
			X, Y, FacingX, FacingY, EnemyX, EnemyY float64
			Hit                                    bool
		}
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Kit) < 20 || len(vectors.Crit) < 60 || len(vectors.Damage) < 30 || len(vectors.Reach) < 100 {
		t.Fatal("insufficient vectors")
	}
	c := content.CombatRules
	formula := func(stat float64, f *contentv1.CombatFormula) float64 {
		return CombatFormula(stat, f.GetBase(), f.GetMaximumBonus(), f.GetHalfway(), f.GetDecimalPlaces())
	}
	for _, v := range vectors.Kit {
		t.Run(v.Name, func(t *testing.T) {
			got := map[string]float64{
				"meleeDamage":         formula(v.Stats["str"], c.GetMelee()),
				"signatureDamage":     0,
				"mitigation":          formula(v.Stats["con"], c.GetMitigation()),
				"critChance":          formula(v.Stats["per"], c.GetCrit()),
				"healAmount":          0,
				"basicAttackCooldown": c.GetClassless().GetBasicAttackCooldownSeconds(),
			}
			if v.Craft != "" {
				class := c.GetClasses()[v.Craft]
				got["basicAttackCooldown"] = class.GetBasicAttackCooldownSeconds()
				if v.Level >= 10 {
					got["signatureDamage"] = formula(v.Stats[class.GetDamageStat()], c.GetSignature())
				}
				if v.Level >= 10 && v.Craft == "healer" {
					f := c.GetHeal()
					got["healAmount"] = CombatFormula(v.Stats["int"], f.GetBase(), f.GetMaximumBonus(), f.GetHalfway(), f.GetDecimalPlaces())
				}
			}
			for key, want := range v.Expected {
				if got[key] != want {
					t.Fatalf("%s: got %v want %v", key, got[key], want)
				}
			}
		})
	}
	for _, v := range vectors.Crit {
		if FightCritRoll(v.Seed, v.SwingCounter) != v.Roll || FightCrit(v.Seed, v.SwingCounter, v.Chance) != v.Crit {
			t.Fatal("crit", v)
		}
	}
	for _, v := range vectors.Damage {
		if got := FightDamage(v.Base, v.Crit, v.StunnedMultiplier, v.Tool); got != v.Damage {
			t.Fatal("damage", got, v)
		}
	}
	for _, v := range vectors.Reach {
		if FightReach(v.Kind, v.X, v.Y, v.FacingX, v.FacingY, v.EnemyX, v.EnemyY) != v.Hit {
			t.Fatal("reach", v)
		}
	}
}
