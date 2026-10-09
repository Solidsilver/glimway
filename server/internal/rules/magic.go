package rules

import (
	"glimway/content"
	"math"
)

// Magic's marks, the hero's craft and the report's per-move budgets
// (docs/design/crafts.md 4.2 and 4.4). Pure rules: the level mark is
// `sync_baselines.verified_high_level` (the highest level a verified sync has
// seen), the class mark is the last class a sync saw.

// LevelMark is the mark unlocks read (crafts.md 4.2): the server's mark, or
// the stored profile's level when that is higher (the next sync raises the
// mark to it). Same as lane F's `levelMarkOf`, so the two agree before the
// first post-merge sync (review finding 9).
func LevelMark(p *Profile, mark float64) float64 {
	if p == nil {
		return mark
	}
	return math.Max(mark, p.Level)
}

// Craft is the hero's craft (4.2): the profile's class, or, after a rebirth
// left the profile classless, the last class a sync saw once the level mark
// is 10 or more. A hero who never had a class has none, and a missing
// profile (no Habitica hero) has no craft either.
func Craft(p *Profile, classMark string, levelMark float64) string {
	if p == nil {
		return ""
	}
	if p.Class != nil {
		if c, ok := NormalizeClass(*p.Class); ok {
			return c
		}
		return ""
	}
	if classMark != "" && levelMark >= 10 {
		if c, ok := NormalizeClass(classMark); ok {
			return c
		}
	}
	return ""
}

// Unlocked: a move is yours when its class is your craft and its level is at
// most your level mark (4.2, "What unlocks"). Veterans get everything at
// once, and a rebirth keeps what the level mark already earned.
func Unlocked(craft string, levelMark float64, a *content.Ability) bool {
	return a != nil && craft != "" && a.GetClass() == craft && float64(a.GetLevel()) <= levelMark
}

// MendHeal is the server's own heal amount from the caster's stats
// (combat.json's heal formula, rounded to its decimal places). The caller
// decides who heals: only the healer's craft mends.
func MendHeal(p *Profile) float64 {
	if p == nil {
		return 0
	}
	h := content.CombatRules.GetHeal()
	scale := math.Pow10(int(h.GetDecimalPlaces()))
	return math.Floor((h.GetBase()+h.GetMaximumBonus()*p.Stats.Int/(p.Stats.Int+h.GetHalfway()))*scale+.5) / scale
}

// WardPulseHeal is one Ward-light pulse (4.3: "each pulse is 0.4 of your
// Mend"), and WardHeal is one whole ward (its pulses together) — the most a
// restart can lose with it (4.5).
func WardPulseHeal(p *Profile, a *content.Ability) float64 {
	if a == nil {
		return 0
	}
	n := a.GetNumbers()
	if n == nil {
		return 0
	}
	return MendHeal(p) * n.GetPulseHealFraction()
}

func WardHeal(p *Profile, a *content.Ability) float64 {
	if a == nil {
		return 0
	}
	n := a.GetNumbers()
	if n == nil {
		return 0
	}
	return WardPulseHeal(p, a) * float64(n.GetPulses())
}

// ReportInput is one report's numbers beside the stored state they bound
// against (server-first.md 2.2, "Reports"; crafts.md 4.4).
type ReportInput struct {
	State     State
	Profile   *Profile
	LevelMark float64
	ClassMark string
	// Reported: what the screen shows.
	HP, Mana     float64
	Casts        float64
	AbilityCasts map[string]float64
	// Stored: vitals_at, cast_ready_at and player_ability_ready.
	At           float64
	Ready        float64
	AbilityReady map[string]float64
	Now          float64
	// AllyCredit is ward credit other healers left (4.5); the report uses
	// it up.
	AllyCredit float64
}

// AbilityBudget is what the world kept (crafts.md 4.4): each move's accepted
// count on its own cooldown, one mana pool across them, and the HP the heals
// and ward credit allow.
type AbilityBudget struct {
	HP, Mana float64
	// Casts is the accepted signature count as reported in `casts`, and
	// AbilityCasts echoes every reported id as accepted. Signature is the
	// signature move's accepted total, wherever it was reported.
	Casts        float64
	Signature    float64
	AbilityCasts map[string]float64
	AllyHeal     float64
	Ready        float64
	AbilityReady map[string]float64
}

// clampCount: reported counts are whole and non-negative; anything else is
// clamped, not refused (server-first.md 2.2).
func clampCount(n float64) float64 {
	if !finite(n) || n <= 0 {
		return 0
	}
	return math.Floor(n)
}

// BoundReport widens the signature budget to one budget per move (4.4). The
// moves are allowed in table order, the signature first: each takes the
// least of its reported count, its own cooldown allowance and what the one
// mana pool still affords. The signature keeps its budget on `cast_ready_at`
// and the combat moves theirs on `player_ability_ready`; a signature id in
// `ability_casts` joins the signature's budget rather than starting a
// second one (lane F sends signatures either way).
func BoundReport(in ReportInput) AbilityBudget {
	s := in.State
	out := AbilityBudget{HP: in.HP, Mana: in.Mana, AbilityCasts: map[string]float64{}, AbilityReady: map[string]float64{}}
	elapsed := math.Max(0, in.Now-in.At)
	ready := math.Max(in.Ready, in.At)
	pool := s.Mana + content.VitalsRules.GetRegenCap()*elapsed
	alive := in.Profile != nil && s.HP > 0
	mark := LevelMark(in.Profile, in.LevelMark)
	craft := Craft(in.Profile, in.ClassMark, mark)
	heal := float64(0)
	if craft == "healer" {
		heal = MendHeal(in.Profile)
	}
	// One move's take from the shared pool, and its next ready time: the
	// same allowance and persistence as the signature has always had.
	take := func(reported, readyAt, cooldown, cost float64, allowed bool) (float64, float64) {
		n := float64(0)
		if allowed && alive && cooldown > 0 && cost > 0 {
			slots := math.Max(0, 1+math.Floor((in.Now-math.Max(readyAt, in.At))/cooldown))
			n = math.Min(clampCount(reported), math.Min(slots, math.Floor(pool/cost)))
			pool -= n * cost
		}
		return n, math.Max(in.Now, math.Max(readyAt, in.At)+n*cooldown)
	}

	// The signature (table order, the signature first): its own budget on
	// cast_ready_at, and the accepted count split as reported.
	var sig *content.Ability
	for _, a := range content.AbilitiesRules.GetAbilities() {
		if a.GetClass() == craft && a.GetKind() == "signature" {
			sig = a
			break
		}
	}
	sigCost := content.SignatureMana(craft)
	sigReadyAt := ready
	reported := clampCount(in.Casts)
	if sig != nil {
		// A signature id in the map joins its budget (lane F sends either
		// way); no other key does.
		reported += clampCount(in.AbilityCasts[sig.GetId()])
	}
	total, next := take(reported, sigReadyAt, content.CombatRules.GetSignatureCooldownSeconds(), sigCost, Unlocked(craft, mark, sig))
	out.Signature = total
	out.Casts = math.Min(clampCount(in.Casts), total)
	out.Ready = next
	if sig != nil {
		if _, seen := in.AbilityCasts[sig.GetId()]; seen {
			out.AbilityCasts[sig.GetId()] = total - out.Casts
		}
	}

	// Each combat move in the table's order, on its own budget.
	for _, a := range content.AbilitiesRules.GetAbilities() {
		if a.GetKind() != "combat" {
			continue
		}
		reported, seen := in.AbilityCasts[a.GetId()]
		if !seen {
			continue
		}
		n, next := take(reported, in.AbilityReady[a.GetId()], a.GetCooldownSeconds(), float64(a.GetMana()), Unlocked(craft, mark, a))
		out.AbilityCasts[a.GetId()] = n
		out.AbilityReady[a.GetId()] = next
	}
	// Any other id is not a move here: its count is allowed as 0.
	for id := range in.AbilityCasts {
		if _, ok := out.AbilityCasts[id]; !ok {
			out.AbilityCasts[id] = 0
		}
	}

	// HP may rise by the healer's accepted Mends (today's rule), the
	// accepted Ward-lights (the caster stands in their own circle) and the
	// ward credit other healers left. The zero-HP lock holds for all three.
	ward := float64(0)
	for _, a := range content.AbilitiesRules.GetAbilities() {
		n := a.GetNumbers()
		if n == nil || n.GetPulses() <= 0 || n.GetPulseHealFraction() <= 0 {
			continue
		}
		ward += out.AbilityCasts[a.GetId()] * float64(n.GetPulses()) * n.GetPulseHealFraction() * heal
	}
	credit := in.AllyCredit
	if !finite(credit) || credit < 0 {
		credit = 0
	}
	own := out.Signature*heal + ward
	raise := own
	if alive {
		raise += credit
	}
	out.HP = math.Min(in.HP, math.Min(s.MaxHP, s.HP+raise))
	// Only what the HP actually needed is ward credit spent (review finding
	// 3): the rest of the pulses wait for their own report or their expiry,
	// and this echoes the part used.
	out.AllyHeal = math.Min(math.Max(out.HP-math.Min(s.MaxHP, s.HP+own), 0), credit)
	out.Mana = math.Min(in.Mana, math.Max(0, math.Min(s.MaxMana, pool)))
	return out
}
