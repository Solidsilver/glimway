package api

import (
	"context"
	"encoding/json"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"math"
	"net/http"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
)

// The report's per-move budgets and the magic marks over real HTTP
// (docs/design/crafts.md 4.2 and 4.4).

func (x *rig) abilityReport(c *http.Cookie, p *contract.PlayResponse, seq, basis, hp, mana, casts float64, moves map[string]float64) *contract.Envelope {
	x.t.Helper()
	req := &contract.ReportRequest{Lease: p.Lease, Client: "tab-a", Generation: p.ReportGeneration, Seq: seq, Basis: basis, Hp: hp, Mana: mana, Casts: casts, AbilityCasts: moves, Place: &contract.Where{Area: "village", X: 400, Y: 300}}
	raw, _ := protojson.Marshal(req)
	w := x.rawHTTP("POST", "/api/report", json.RawMessage(raw), c)
	var out contract.Envelope
	if e := protojson.Unmarshal(w.Body.Bytes(), &out); e != nil || w.Code != 200 {
		x.t.Fatal(w.Code, w.Body.String(), e)
	}
	return &out
}

// setVitals is a server vitals write (a refill, a fall): it resets the
// watermark and returns the version the next report must name.
func setVitals(t *testing.T, x *rig, hp, mana float64) float64 {
	t.Helper()
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	s, err := store.Load(context.Background(), tx, x.account("alice"))
	if err != nil {
		t.Fatal(err)
	}
	s.VitalsWritten = true
	s.State.HP, s.State.Mana = hp, mana
	if err = store.Persist(context.Background(), tx, &s, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	tx.Commit()
	return float64(s.Version)
}

// healer: a level-20 healer signed in on their own profile.
func (x *rig) healer() (*http.Cookie, *contract.PlayResponse, rules.Profile) {
	x.t.Helper()
	p := profile("alice", 20, 0, 20)
	class := "healer"
	p.Class = &class
	x.set(p)
	c, play := x.reportSetup()
	return c, play, p
}

func TestReportAbilityBudgetsAndReadyRows(t *testing.T) {
	x := newRig(t)
	c, play, p := x.healer()
	ward, _ := content.AbilityFor("ward-light")
	pulse := rules.WardPulseHeal(&p, ward)
	basis := setVitals(t, x, 10, 100)
	first := x.abilityReport(c, play, 1, basis, 50, 200, 0, map[string]float64{"ward-light": 1})
	if !first.GetReport().Accepted || first.GetReport().AbilityCasts["ward-light"] != 1 {
		t.Fatal(first)
	}
	// The caster stands in their own circle: three pulses of 0.4 of a Mend.
	if math.Abs(first.State.Vitals.Hp-(10+3*pulse)) > 1e-9 {
		t.Fatal("ward self heal", first.State.Vitals.Hp, 3*pulse)
	}
	// Its cooldown budget is persisted, on the wire and in the table.
	ready := first.State.Vitals.AbilityReadyAt["ward-light"]
	if ready <= float64(x.now.Load()) {
		t.Fatal("no move cooldown debt", ready)
	}
	var stored float64
	if err := x.db.DB.QueryRow("SELECT ready_at FROM player_ability_ready WHERE account_id=? AND ability='ward-light'", x.account("alice")).Scan(&stored); err != nil || stored != ready {
		t.Fatal("move budget not persisted", err, stored, ready)
	}
	if first.State.Magic == nil || first.State.Magic.LevelMark != 20 {
		t.Fatal("level mark", first.State.Magic)
	}
	// A same-time retry of the same move spends nothing: one budget.
	again := x.abilityReport(c, play, 2, first.State.Version, 50, 200, 0, map[string]float64{"ward-light": 1})
	if again.GetReport().AbilityCasts["ward-light"] != 0 || again.State.Vitals.AbilityReadyAt["ward-light"] != ready {
		t.Fatal("same-time retry spent the move twice", again)
	}
	// A stale-basis report applies nothing and leaves the debt alone.
	tx, _ := x.db.DB.Begin()
	s, err := store.Load(context.Background(), tx, x.account("alice"))
	if err != nil {
		t.Fatal(err)
	}
	s.VitalsWritten = true
	s.State.HP = 20
	if err = store.Persist(context.Background(), tx, &s, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	tx.Commit()
	x.now.Add(20)
	stale := x.abilityReport(c, play, 3, again.State.Version, 50, 200, 0, map[string]float64{"ward-light": 1})
	if !stale.GetReport().StaleBasis || stale.GetReport().AbilityCasts["ward-light"] != 0 || stale.State.Vitals.AbilityReadyAt["ward-light"] != ready {
		t.Fatal("stale report moved the budget", stale)
	}
	// A replay of a settled sequence applies no budget either.
	replay := x.abilityReport(c, play, 3, again.State.Version, 50, 200, 0, map[string]float64{"ward-light": 1})
	if replay.GetReport().AbilityCasts["ward-light"] != 0 || replay.State.Vitals.AbilityReadyAt["ward-light"] != ready {
		t.Fatal("replay spent the move", replay)
	}
	// Past the debt the move casts again, coalesced by id.
	x.now.Add(10)
	after := x.abilityReport(c, play, 4, stale.State.Version, 50, 200, 0, map[string]float64{"ward-light": 2})
	if after.GetReport().AbilityCasts["ward-light"] != 2 {
		t.Fatal("cooldown allowance", after.GetReport().AbilityCasts)
	}
	if after.State.Vitals.AbilityReadyAt["ward-light"] <= ready {
		t.Fatal("no new debt", after.State.Vitals.AbilityReadyAt)
	}
}

func TestReportSignatureBudgetSharesThePool(t *testing.T) {
	x := newRig(t)
	c, play, _ := x.healer()
	// The signature by casts and by id are one budget (lane F sends either
	// way): one initial allowance, one mana pool.
	basis := setVitals(t, x, 10, 30)
	out := x.abilityReport(c, play, 1, basis, 50, 200, 1, map[string]float64{"mend": 1})
	if out.GetReport().Casts != 1 || out.GetReport().AbilityCasts["mend"] != 0 {
		t.Fatal("signature double budget", out.GetReport())
	}
	if out.State.Vitals.Mana != 30-content.SignatureMana("healer") {
		t.Fatal("mana", out.State.Vitals.Mana)
	}
	// A classless hero's report allows no casts at all.
	y := newRig(t)
	c2, play2 := y.reportSetup()
	basis2 := setVitals(t, y, 10, 30)
	none := y.abilityReport(c2, play2, 1, basis2, 50, 200, 1, map[string]float64{"mend": 1})
	if none.GetReport().Casts != 0 || none.GetReport().AbilityCasts["mend"] != 0 {
		t.Fatal("classless cast", none.GetReport())
	}
}

// classMarkOf reads the wrapper the wire carries (absent: no class yet).
func classMarkOf(m *contract.Magic) string {
	if m == nil || m.GetClassMark() == nil {
		return ""
	}
	return m.GetClassMark().GetValue()
}

func TestProfileRaisesMagicMarks(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	wizard := "wizard"
	p := profile("alice", 20, 0, 20)
	p.Class = &wizard
	x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
	read := func() (string, float64) {
		var classMark string
		var level float64
		if err := x.db.DB.QueryRow("SELECT COALESCE(class_mark,''),verified_high_level FROM sync_baselines WHERE account_id=?", x.account("alice")).Scan(&classMark, &level); err != nil {
			t.Fatal(err)
		}
		return classMark, level
	}
	// The mark keeps the game's spellings and the highest level seen.
	if classMark, level := read(); classMark != "mage" || level != 20 {
		t.Fatal("marks", classMark, level)
	}
	state := decodeProtoState(t, x, c)
	if state.State.Magic.LevelMark != 20 || classMarkOf(state.State.Magic) != "mage" {
		t.Fatal("PlayerState.magic", state.State.Magic)
	}
	// A classless sync (a rebirth) keeps the class mark, and the level mark
	// only ever rises.
	s = x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 1, 0, 20), s.State), c, 200)
	if classMark, level := read(); classMark != "mage" || level != 20 {
		t.Fatal("classless sync moved the marks", classMark, level)
	}
	state = decodeProtoState(t, x, c)
	if classMarkOf(state.State.Magic) != "mage" || state.State.Magic.LevelMark != 20 {
		t.Fatal("reborn hero lost the craft", state.State.Magic)
	}
}

func decodeProtoState(t *testing.T, x *rig, c *http.Cookie) *contract.StateResponse {
	t.Helper()
	w := x.rawHTTP("GET", "/api/state", nil, c)
	var out contract.StateResponse
	if err := protojson.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return &out
}
