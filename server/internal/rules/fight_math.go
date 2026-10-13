package rules

import (
	"glimway/content"
	"math"
)

// Float twins of src/lib/fight-math.ts. Go may fuse a*b+c into one
// multiply-add (arm64 does; amd64 with GOAMD64=v1 doesn't), and JS never
// does, so every product that meets an add or subtract here is wrapped in
// float64(), which the Go spec says rounds it and blocks the fusion. Keep the
// TS grouping too: (y - o) + f*s, not y + (f*s - o). The reach vectors hold
// boundary cases where either slip flips the verdict.
//
// Rounding: Go's Floor(x + 0.5) and JS's Math.round agree except at
// 0.49999999999999994 (Go 1, JS 0), which no formula here can produce;
// math.Round is not the twin either (it rounds -2.5 to -3, JS to -2).

// CombatFormula is base + diminishing bonus, rounded as on the client.
// Keep this operation order; the vectors cover saturation and rounding.
func CombatFormula(stat, base, maximumBonus, halfway float64, decimalPlaces int32) float64 {
	scale := math.Pow10(int(decimalPlaces))
	value := base + float64(maximumBonus*(stat/(stat+halfway)))
	return math.Floor(float64(value*scale)+0.5) / scale
}

// FightCritRoll finalizes seed XOR counter with Murmur3's uint32 mixer.
// Go uint32 overflow matches Math.imul. One roll per swing/cast, shared
// by all targets; counters start at zero and wrap modulo 2^32. Seeds are
// never zero: with seed 0 a first swing (counter 0) rolls 0 and always crits.
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
		damage = math.Max(1, math.Floor(float64(base*a.GetToolDamageFraction())+0.5))
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
		sx = x + float64(facingX*a.GetSlashOffsetX())
		sy = y - a.GetOriginYOffset() + float64(facingY*a.GetSlashOffsetY())
		radius = a.GetSlashRadius()
	case "bolt":
	default:
		return false
	}
	dx, dy := enemyX-sx, enemyY-a.GetEnemyYOffset()-sy
	return float64(dx*dx)+float64(dy*dy) < radius*radius
}

// FightBoltSpawn is where a bolt starts from a caster's feet: ahead along
// the facing's x only, and up to the hero's centre.
func FightBoltSpawn(x, y, facingX float64) (float64, float64) {
	a := content.CombatRules.GetAttack()
	return x + float64(facingX*a.GetBoltSpawnOffsetX()), y - a.GetOriginYOffset()
}

// FightTickMs is the world tick (design decision 11): every room ticks on
// the same grid, tick = floor(server Unix ms / 100) modulo 2^32.
const FightTickMs = 100

// FightTickAt places a server instant (Unix ms, never negative) on the grid:
// its tick and the milliseconds past it (0-99).
func FightTickAt(unixMs int64) (tick, offsetMs uint32) {
	return uint32(unixMs / FightTickMs), uint32(unixMs % FightTickMs)
}

// FightTickDiff is a - b across the wrap: positive when a is later. It is
// right while the two are within about 6.8 years of each other.
func FightTickDiff(a, b uint32) int32 {
	return int32(a - b)
}

// FightCounterWindow is how far ahead of the last swing counter the server
// takes the next one: a swing or cast it never saw (dropped, refused before
// it counted) leaves a gap, not a lockout.
const FightCounterWindow = 1024

// FightCounterAhead: next is 1 to FightCounterWindow past last, across the
// wrap. A repeat, a counter behind last, or one further ahead is stale. The
// first swing on a socket has no last and is always taken.
func FightCounterAhead(last, next uint32) bool {
	ahead := FightTickDiff(next, last)
	return ahead >= 1 && ahead <= FightCounterWindow
}

// FightWindupTicks is when, counted in whole ticks from the start of a
// wind-up, the aim locks and the attack launches. The sim ticks at 10 Hz,
// so it rounds both towards the player: the lock comes at the last tick that
// leaves at least `lock` seconds, and the launch at the first tick at or
// after `windup`. A telegraph never gives less warning than today's (wisp:
// lock at 3, launch at 5; beetle: 5 and 8). Kinds are the camp kinds.
func FightWindupTicks(kind string) (lock, launch uint32, ok bool) {
	var windup, locked float64
	switch kind {
	case "wisp":
		windup, locked = content.EnemyRules.GetWisp().GetWindup(), content.EnemyRules.GetWisp().GetLock()
	case "beetle":
		windup, locked = content.EnemyRules.GetBeetle().GetWindup(), content.EnemyRules.GetBeetle().GetLock()
	default:
		return 0, 0, false
	}
	windupMs, lockMs := fightWholeMs(windup), fightWholeMs(locked)
	return uint32((windupMs - lockMs) / FightTickMs), uint32((windupMs + FightTickMs - 1) / FightTickMs), true
}

// FightAimLocked: elapsedTicks since the wind-up began (FightTickDiff from
// the state_tick). Negative is before the wind-up (a rewind can ask), so
// neither locked nor launched; false for an unknown kind.
func FightAimLocked(kind string, elapsedTicks int32) bool {
	lock, _, ok := FightWindupTicks(kind)
	return ok && int64(elapsedTicks) >= int64(lock)
}
func FightLaunched(kind string, elapsedTicks int32) bool {
	_, launch, ok := FightWindupTicks(kind)
	return ok && int64(elapsedTicks) >= int64(launch)
}

// fightWholeMs: seconds from content as whole milliseconds, so 0.8 - 0.5
// can't slip to 0.30000000000000004.
func fightWholeMs(seconds float64) int64 {
	return int64(math.Floor(float64(seconds*1000) + 0.5))
}

// FightFacingStep quantises a facing for the wire (FightEnemy.facing): 256ths
// of a turn from +x towards +y, rounded to the nearest. (0, 0) faces +x.
// Only the sim quantises; the client reads steps (fightFacingFromStep).
func FightFacingStep(x, y float64) uint32 {
	turns := math.Atan2(y, x) / (2 * math.Pi)
	return uint32(int64(math.Floor(float64(turns*256)+0.5)) & 255)
}

// FightScuttleOffset is the cumulative left/right/straight local displacement.
func FightScuttleOffset(seconds float64) (float64, float64) {
	t := content.EnemyRules.GetBeetle()
	leg := t.GetChargeTime() / 3
	a := t.GetScuttleAngle() * math.Pi / 180
	first := math.Max(0, math.Min(leg, seconds))
	second := math.Max(0, math.Min(leg, seconds-leg))
	third := math.Max(0, math.Min(leg, seconds-2*leg))
	return t.GetChargeSpeed() * (float64((first+second)*math.Cos(a)) + third), t.GetChargeSpeed() * (first - second) * math.Sin(a)
}

const CampLeash = 160.0
const CampReturnMargin = 8.0

// FightLeashFraction clips a segment to its first exit from the home circle.
func FightLeashFraction(x, y, dx, dy float64) float64 {
	if math.Hypot(x+dx, y+dy) <= CampLeash {
		return 1
	}
	a := float64(dx*dx) + float64(dy*dy)
	if a == 0 || math.Hypot(x, y) > CampLeash {
		return 0
	}
	b := float64(x*dx) + float64(y*dy)
	c := float64(x*x) + float64(y*y) - CampLeash*CampLeash
	return math.Max(0, math.Min(1, (-b+math.Sqrt(math.Max(0, float64(b*b)-float64(a*c))))/a))
}
