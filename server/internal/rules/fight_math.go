package rules

import (
	"glimway/content"
	"math"
)

// CombatFormula is base + diminishing bonus, rounded as on the client.
// Keep this operation order; the vectors cover saturation and rounding.
func CombatFormula(stat, base, maximumBonus, halfway float64, decimalPlaces int32) float64 {
	scale := math.Pow10(int(decimalPlaces))
	return math.Floor((base+maximumBonus*(stat/(stat+halfway)))*scale+0.5) / scale
}

// FightCritRoll finalizes seed XOR counter with Murmur3's uint32 mixer.
// Go uint32 overflow matches Math.imul. One roll per swing/cast, shared
// by all targets; counters start at zero and wrap modulo 2^32.
func FightCritRoll(seed, swingCounter uint32) float64 {
	word := seed ^ swingCounter
	word ^= word >> 16
	word *= 0x85ebca6b
	word ^= word >> 13
	word *= 0xc2b2ae35
	word ^= word >> 16
	return float64(word) / 4294967296
}
func FightCrit(seed, swingCounter uint32, chance float64) bool {
	return FightCritRoll(seed, swingCounter) < chance
}

// FightDamage preserves tool rounding, crit, then stunned vulnerability.
func FightDamage(base float64, crit bool, stunnedMultiplier float64, tool bool) float64 {
	a := content.CombatRules.GetAttack()
	damage := base
	if tool {
		damage = math.Max(1, math.Floor(base*a.GetToolDamageFraction()+0.5))
	}
	if crit {
		damage *= a.GetCritMultiplier()
	}
	return damage * stunnedMultiplier
}

// FightReach uses sprite feet for enemies and slashes; bolts use their
// current centre. Facing must be unit length. The radius boundary is open.
func FightReach(kind string, x, y, facingX, facingY, enemyX, enemyY float64) bool {
	a := content.CombatRules.GetAttack()
	sx, sy, radius := x, y, a.GetBoltRadius()
	switch kind {
	case "slash":
		sx += facingX * a.GetSlashOffsetX()
		sy += -a.GetOriginYOffset() + facingY*a.GetSlashOffsetY()
		radius = a.GetSlashRadius()
	case "bolt":
	default:
		return false
	}
	dx, dy := enemyX-sx, enemyY-a.GetEnemyYOffset()-sy
	return dx*dx+dy*dy < radius*radius
}
