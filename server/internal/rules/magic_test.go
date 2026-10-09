package rules

import (
	"glimway/content"
	"math"
	"testing"
)

func mage(level, intel float64) *Profile {
	p := Profile{ID: "hero", Name: "Hero", Level: level, Exp: new(float64), HP: 20, MaxHP: 50, MP: 30, MaxMP: 2*intel + 30, Stats: Stats{Int: intel}, Pets: []string{}, Mounts: []string{}}
	return &p
}

func withClass(p *Profile, class string) *Profile {
	p.Class = &class
	return p
}

func TestCraftFollowsProfileThenClassMark(t *testing.T) {
	// The profile's class is the craft; Habitica's spelling reads as mage.
	if got := Craft(withClass(mage(20, 10), "healer"), "", 20); got != "healer" {
		t.Fatal("profile class", got)
	}
	if got := Craft(withClass(mage(20, 10), "wizard"), "", 20); got != "mage" {
		t.Fatal("wizard spelling", got)
	}
	// A rebirth's classless profile keeps the craft from the class mark,
	// once the level mark is 10 or more (crafts.md 4.2).
	if got := Craft(mage(1, 0), "rogue", 30); got != "rogue" {
		t.Fatal("class mark", got)
	}
	if got := Craft(mage(1, 0), "rogue", 9); got != "" {
		t.Fatal("mark before ten", got)
	}
	if got := Craft(mage(1, 0), "", 30); got != "" {
		t.Fatal("never classed", got)
	}
	if got := Craft(mage(1, 0), "wizard", 30); got != "mage" {
		t.Fatal("class mark spelling", got)
	}
	// No Habitica hero, no craft (guests follow their lack of class).
	if got := Craft(nil, "mage", 30); got != "" {
		t.Fatal("missing profile", got)
	}
}

func TestUnlockedNeedsCraftAndLevelMark(t *testing.T) {
	sig, _ := content.AbilityFor("mend")
	ward, _ := content.AbilityFor("ward-light")
	if !Unlocked("healer", 10, sig) || !Unlocked("healer", 30, ward) {
		t.Fatal("unlocked moves refused")
	}
	if Unlocked("healer", 19, ward) || Unlocked("mage", 30, ward) || Unlocked("", 30, ward) || Unlocked("healer", 30, nil) {
		t.Fatal("locked move allowed")
	}
}

func TestLevelMarkReadsTheHighestLevelSeen(t *testing.T) {
	// The mark unlocks moves (crafts.md 4.2) and reads the server's mark or
	// the stored profile's level, whichever is higher (lane F's
	// `levelMarkOf`, review finding 9): the two agree before the first
	// post-merge sync raises the mark.
	kindle, _ := content.AbilityFor("kindle")
	if got := LevelMark(mage(20, 0), 5); got != 20 {
		t.Fatal("profile level", got)
	}
	if got := LevelMark(mage(1, 0), 30); got != 30 {
		t.Fatal("the mark", got)
	}
	if got := LevelMark(nil, 30); got != 30 {
		t.Fatal("no profile", got)
	}
	// A reborn hero keeps the mark their magic earned.
	if !Unlocked("mage", LevelMark(mage(1, 0), 30), kindle) {
		t.Fatal("rebirth lost the move")
	}
}

func TestMendAndWardHealComeFromTheCastersStats(t *testing.T) {
	// combat.json's heal formula: base + bonus·int/(int+halfway), 2 places.
	if got := MendHeal(mage(20, 0)); got != 6 {
		t.Fatal(got)
	}
	if got := MendHeal(mage(20, 60)); got != 16 {
		t.Fatal(got)
	}
	ward, _ := content.AbilityFor("ward-light")
	// One pulse is 0.4 of the Mend; one ward is its three pulses.
	if got := WardPulseHeal(mage(20, 0), ward); math.Abs(got-2.4) > 1e-9 {
		t.Fatal(got)
	}
	if got := WardHeal(mage(20, 0), ward); math.Abs(got-7.2) > 1e-9 {
		t.Fatal(got)
	}
}

func bound(in ReportInput) AbilityBudget { return BoundReport(in) }

func TestBoundReportMovesShareOneManaPool(t *testing.T) {
	// A level-20 healer: the signature (18) and Ward-light (20) against one
	// pool, the signature first (crafts.md 4.4).
	p := withClass(mage(20, 0), "healer")
	in := ReportInput{State: State{HP: 10, MaxHP: 50, Mana: 30, MaxMana: 200}, Profile: p, LevelMark: 20, At: 100, Now: 100, AbilityReady: map[string]float64{}}
	in.HP, in.Mana = 50, 200
	in.Casts, in.AbilityCasts = 1, map[string]float64{"ward-light": 1}
	out := bound(in)
	// 30 mana: the signature first takes 18, the ward finds no 20 left.
	if out.Casts != 1 || out.AbilityCasts["ward-light"] != 0 {
		t.Fatal("pool order", out.Casts, out.AbilityCasts)
	}
	if out.Mana != 12 {
		t.Fatal("mana bound", out.Mana)
	}
	// With 38 the two moves just fit: 38 − 18 − 20.
	in.State.Mana = 38
	in.AbilityReady = map[string]float64{}
	out = bound(in)
	if out.Casts != 1 || out.AbilityCasts["ward-light"] != 1 || out.Mana != 0 {
		t.Fatal("both moves", out.Casts, out.AbilityCasts, out.Mana)
	}
	// Both heals: the Mend (6) and the ward's 3 pulses × 0.4 of it.
	if math.Abs(out.HP-10-6-7.2) > 1e-9 {
		t.Fatal("ward self heal", out.HP)
	}
}

func TestBoundReportTwoMovePartitionAndDebt(t *testing.T) {
	// Splitting the two moves across two reports and coalescing them into
	// one gives the same budget (server-first.md 2.2's fixture, extended).
	base := ReportInput{State: State{HP: 10, MaxHP: 50, Mana: 100, MaxMana: 200}, Profile: withClass(mage(20, 0), "healer"), LevelMark: 20, At: 100, AbilityReady: map[string]float64{}}
	first := base
	first.HP, first.Mana, first.Casts, first.AbilityCasts, first.Now = 50, 200, 1, map[string]float64{}, 100
	a := bound(first)
	second := base
	second.State.HP, second.State.Mana = a.HP, a.Mana
	second.HP, second.Mana, second.Casts = 50, 200, 0
	second.Ready = a.Ready
	second.AbilityCasts, second.AbilityReady, second.Now = map[string]float64{"ward-light": 1}, a.AbilityReady, 101
	b := bound(second)
	one := base
	one.HP, one.Mana, one.Casts, one.Now = 50, 200, 1, 101
	one.AbilityCasts = map[string]float64{"ward-light": 1}
	c := bound(one)
	if a.Casts+b.Casts != c.Casts || a.AbilityCasts["ward-light"]+b.AbilityCasts["ward-light"] != c.AbilityCasts["ward-light"] {
		t.Fatal("partition creates budget", a.Casts, b.Casts, c.Casts)
	}
	if b.Mana != c.Mana || math.Abs(b.HP-c.HP) > 1e-9 {
		t.Fatal("partition changes mana or hp", b.Mana, c.Mana, b.HP, c.HP)
	}
	// The ward's cooldown debt survives a refill and a same-time retry.
	if next := b.AbilityReady["ward-light"]; next <= 101 {
		t.Fatal("no cooldown debt stored", next)
	}
	refill := base
	refill.State.HP, refill.State.Mana = 10, 200
	refill.HP, refill.Mana, refill.Now, refill.At = 50, 200, 101, 101
	refill.AbilityCasts = map[string]float64{"ward-light": 1}
	refill.AbilityReady = b.AbilityReady
	if out := bound(refill); out.AbilityCasts["ward-light"] != 0 {
		t.Fatal("refill erased the move's debt", out.AbilityCasts)
	}
	same := refill
	same.Now, same.At = 100, 100
	if out := bound(same); out.AbilityCasts["ward-light"] != 0 {
		t.Fatal("same-time retry spent the move twice", out.AbilityCasts)
	}
}

func TestBoundReportMovesNeedTheirLevel(t *testing.T) {
	// A hero whose stored profile level and mark agree: the mark reads the
	// higher of the two, so the moves wait for their level either way.
	at := func(level float64) ReportInput {
		in := ReportInput{State: State{HP: 10, MaxHP: 50, Mana: 100, MaxMana: 200}, Profile: withClass(mage(level, 0), "healer"), LevelMark: level, At: 100, Now: 100, AbilityReady: map[string]float64{}}
		in.HP, in.Mana = 50, 200
		in.Casts, in.AbilityCasts = 1, map[string]float64{"ward-light": 1}
		return in
	}
	// Below ten: no craft's move, not even the signature.
	if out := bound(at(9)); out.Casts != 0 || out.AbilityCasts["ward-light"] != 0 || out.Mana != 100 {
		t.Fatal("locked hero cast", out)
	}
	// Below twenty: the signature, no second move.
	if out := bound(at(19)); out.Casts != 1 || out.AbilityCasts["ward-light"] != 0 {
		t.Fatal("level gates", out.Casts, out.AbilityCasts)
	}
	// Not my craft, not my move; unknown ids and junk counts are clamped.
	in := at(20)
	in.Casts = 0
	in.AbilityCasts = map[string]float64{"kindle": 2.7, "mend": -3, "walk-a-route": 4, "": 5}
	out := bound(in)
	if out.AbilityCasts["kindle"] != 0 || out.AbilityCasts["mend"] != 0 || out.AbilityCasts["walk-a-route"] != 0 || out.AbilityCasts[""] != 0 || out.Signature != 0 {
		t.Fatal("foreign or unknown move allowed", out.AbilityCasts, out.Signature)
	}
	// The signature in the map joins its own budget instead of a second one.
	in.Casts, in.AbilityCasts = 1, map[string]float64{"mend": 1}
	if out := bound(in); out.Casts != 1 || out.AbilityCasts["mend"] != 0 || out.Signature != 1 {
		t.Fatal("signature double budget", out.Casts, out.AbilityCasts, out.Signature)
	}
	in.Casts, in.AbilityCasts = 0, map[string]float64{"mend": 2}
	if out := bound(in); out.Casts != 0 || out.AbilityCasts["mend"] != 1 || out.Signature != 1 {
		t.Fatal("signature from the map", out.Casts, out.AbilityCasts, out.Signature)
	}
}

func TestBoundReportSpendsOnlyTheWardCreditItNeeds(t *testing.T) {
	in := ReportInput{State: State{HP: 30, MaxHP: 50, Mana: 50, MaxMana: 200}, Profile: mage(20, 0), LevelMark: 30, At: 100, Now: 100, AbilityReady: map[string]float64{}}
	in.HP, in.Mana, in.AllyCredit = 37.2, 50, 7.2
	out := bound(in)
	if math.Abs(out.HP-37.2) > 1e-9 || out.AllyHeal != 7.2 {
		t.Fatal("ward credit refused", out.HP, out.AllyHeal)
	}
	// A report that kept its old HP spends nothing: the pulses wait for the
	// report that raises it (review finding 3).
	in.HP = 30
	if out = bound(in); out.HP != 30 || out.AllyHeal != 0 {
		t.Fatal("a low report used credit", out.HP, out.AllyHeal)
	}
	// Only what the HP needed is spent past the maximum.
	in.HP, in.State.HP = 50, 49
	in.AllyCredit = 30
	if out = bound(in); out.HP != 50 || out.AllyHeal != 1 {
		t.Fatal("credit over the maximum", out.HP, out.AllyHeal)
	}
	// The zero-HP lock holds for heals and credit alike, and spends none.
	in.State.HP, in.HP, in.AllyCredit = 0, 10, 7.2
	if out = bound(in); out.HP != 0 || out.AllyHeal != 0 {
		t.Fatal("zero-HP lock", out.HP, out.AllyHeal)
	}
}
