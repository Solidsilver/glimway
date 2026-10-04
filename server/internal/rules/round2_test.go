package rules

import "testing"

func TestRound2AForgerySignalsAndVerifiedRebirth(t *testing.T) {
	exp := 0.0
	p := Profile{Level: 5, Exp: &exp}
	xp := LifetimeXP(p.Level, exp)
	window := DeathWindow(10)
	for _, tc := range []struct {
		name string
		ref  LossReference
		high float64
		flag bool
	}{
		{"three windows tolerated", LossReference{10, xp + 3*window}, 5, false},
		{"above generous window", LossReference{10, xp + 3*window + E.CheckpointToleranceXP + 1}, 5, true},
		{"higher level but less XP", LossReference{4, xp + 1}, 5, true},
		{"ordinary loss", LossReference{6, xp + 10}, 5, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if CheckpointForgery(p, tc.ref, tc.high) != tc.flag {
				t.Fatal("wrong flag policy")
			}
		})
	}
	p.Level = 1
	if !CheckpointForgery(p, LossReference{40, LifetimeXP(40, 0)}, 1) {
		t.Fatal("client claim authorized rebirth")
	}
	if CheckpointForgery(p, LossReference{40, LifetimeXP(40, 0)}, 5) {
		t.Fatal("verified rebirth flagged")
	}
}
