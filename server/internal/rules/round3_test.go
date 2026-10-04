package rules

import "testing"

func TestRound3HighestCreditBoundAndFullDayAllowance(t *testing.T) {
	high := LossReference{Level: 60, XP: LifetimeXP(60, 0)}
	target := high.XP - 3*DeathWindow(high.Level) - E.CheckpointToleranceXP - 1
	ref := CreditReference(target)
	exp := target - LifetimeXP(ref.Level, 0)
	p := Profile{Level: ref.Level, Exp: &exp}
	latest := ref
	for _, tc := range []struct {
		age  int64
		flag bool
	}{{-1, true}, {0, true}, {86399, true}, {86400, false}, {2 * 86400, false}} {
		if CheckpointForgery(p, latest, 20, high, tc.age) != tc.flag {
			t.Fatal("full-day highest-report allowance", tc)
		}
	}
	latest.Level = 1
	p.Level = 1
	exp = 0
	if !CheckpointForgery(p, latest, 20, high, 0) {
		t.Fatal("highest reference incorrectly authorized rebirth")
	}
	latest.Level = 40
	if CheckpointForgery(p, latest, 20, high, 0) {
		t.Fatal("latest verified-history rebirth exempted incorrectly")
	}
	if !CheckpointForgery(p, latest, 1, high, 0) {
		t.Fatal("client-only level history authorized rebirth")
	}
}
func TestRound3CreditReferenceInvertsLevelCurve(t *testing.T) {
	for _, level := range []float64{1, 2, 20, 60, 100, 101, 500, MaxProfileLevel} {
		for _, exp := range []float64{0, 0.5, XPToNextLevel(level) - 1} {
			xp := LifetimeXP(level, exp)
			r := CreditReference(xp)
			if r.Level != level || r.XP != xp {
				t.Fatal("credit level recovery", level, exp, r)
			}
		}
	}
}
