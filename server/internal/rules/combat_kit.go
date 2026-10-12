package rules

import (
	"glimway/content"
	contentv1 "glimway/gen/glimway/content/v1"
)

// CombatKit is the server twin of getCombatKit. Stats already include the
// imported gear; appearance/costume never participates in combat.
type CombatKit struct {
	Class                                                string
	MeleeDamage, SignatureDamage, Mitigation, CritChance float64
	BasicAttackCooldown, HealAmount, WardPulseHeal       float64
}

func combatValue(stat float64, f *contentv1.CombatFormula) float64 {
	return CombatFormula(stat, f.GetBase(), f.GetMaximumBonus(), f.GetHalfway(), f.GetDecimalPlaces())
}

func CombatKitFor(p *Profile, classMark string, levelMark float64) CombatKit {
	stats := Stats{Str: 9, Int: 7, Con: 8, Per: 8} // DEMO_CHARACTER, like getCombatKit(null).
	if p != nil {
		stats = p.Stats
	}
	mark := LevelMark(p, levelMark)
	c := Craft(p, classMark, mark)
	r := content.CombatRules
	k := CombatKit{Class: c, MeleeDamage: combatValue(stats.Str, r.GetMelee()), Mitigation: combatValue(stats.Con, r.GetMitigation()), CritChance: combatValue(stats.Per, r.GetCrit()), BasicAttackCooldown: r.GetClassless().GetBasicAttackCooldownSeconds()}
	if row := r.GetClasses()[c]; row != nil {
		k.BasicAttackCooldown = row.GetBasicAttackCooldownSeconds()
		if mark >= 10 {
			s := map[string]float64{"str": stats.Str, "int": stats.Int, "con": stats.Con, "per": stats.Per}[row.GetDamageStat()]
			k.SignatureDamage = combatValue(s, r.GetSignature())
			if c == "healer" {
				f := r.GetHeal()
				k.HealAmount = CombatFormula(stats.Int, f.GetBase(), f.GetMaximumBonus(), f.GetHalfway(), f.GetDecimalPlaces())
			}
		}
	}
	if c == "healer" && mark >= 20 {
		a, _ := content.AbilityFor("ward-light")
		k.WardPulseHeal = k.HealAmount * a.GetNumbers().GetPulseHealFraction()
	}
	return k
}
