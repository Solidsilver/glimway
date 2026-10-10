package api

import (
	"encoding/json"
	"glimway/server/internal/rules"
	"math"
	"testing"
)

// The relayed Ward-light carries the hub's own pulse amount (review finding
// 11): the caster's rules.WardPulseHeal, never a number the client sent, and
// only on a ward.

func (w *wsClient) expectPulseHeal() (string, *float64) {
	w.t.Helper()
	e := w.expect("ability")
	var out struct {
		Ability   string   `json:"ability"`
		PulseHeal *float64 `json:"pulseHeal"`
	}
	if err := json.Unmarshal([]byte(e.Raw), &out); err != nil {
		w.t.Fatal(err)
	}
	return out.Ability, out.PulseHeal
}

func TestRelayedWardCarriesTheCastersPulse(t *testing.T) {
	x := newRig(t)
	// Level 100: Habitica's level bonus puts INT at 50.
	healer := profile("alice", 100, 0, 20)
	class := "healer"
	healer.Class = &class
	x.set(healer)
	c, s := x.ready("alice")
	bc, bs := x.member("bob", s.WorldID)
	ts := startPresence(t, x, presenceTestConfig())
	alice := wsConnect(t, ts, c, s.Lease)
	alice.join("village")
	bob := wsConnect(t, ts, bc, bs.Lease)
	bob.join("village")
	alice.expect("join")
	alice.send(position(320, 320))
	bob.expect("pos")

	// A seasoned healer's pulse, not the Mend's base share.
	want := rules.WardPulseHeal(&healer, mustAbility(t, "ward-light"))
	if want <= 2.4 {
		t.Fatal("the fixture should out-heal the base share", want)
	}
	cast := castMessage("ward-light", 320, 320)
	cast["pulseHeal"] = 999
	alice.send(cast)
	ability, pulse := bob.expectPulseHeal()
	if ability != "ward-light" || pulse == nil || math.Abs(*pulse-want) > 1e-9 {
		t.Fatal("relayed pulse", ability, pulse, want)
	}

	// The signature carries none, even when the client sends one.
	mend := castMessage("mend", 320, 320)
	mend["pulseHeal"] = 5
	alice.send(mend)
	if ability, pulse := bob.expectPulseHeal(); ability != "mend" || pulse != nil {
		t.Fatal("a pulse on a mend", ability, pulse)
	}
}
