package content

import "testing"

func TestFightContentLoaders(t *testing.T) {
	runLoaderVectors(t, "combat", "combat-loader", func(raw []byte) (any, error) { return DecodeCombat(raw) })
	runLoaderVectors(t, "enemies", "enemies-loader", func(raw []byte) (any, error) { return DecodeEnemies(raw) })
	// The tick-based aim lock and launch are checked against the vectors in
	// server/internal/rules (FightWindupTicks); here, only that today's
	// telegraph windows survive the 10 Hz grid.
	var vectors struct {
		Windup []struct {
			Kind                 string
			LockTick, LaunchTick int64
		}
	}
	readVectors(t, "fights", &vectors)
	if len(vectors.Windup) != 2 {
		t.Fatal("windup vectors")
	}
	for _, v := range vectors.Windup {
		windup, lock := EnemyRules.GetWisp().GetWindup(), EnemyRules.GetWisp().GetLock()
		if v.Kind == "beetle" {
			windup, lock = EnemyRules.GetBeetle().GetWindup(), EnemyRules.GetBeetle().GetLock()
		}
		warning := float64(v.LaunchTick-v.LockTick) / 10
		if warning < lock || float64(v.LaunchTick)/10 < windup {
			t.Fatal("a 10 Hz telegraph shorter than today's", v)
		}
	}
	if EnemyRules.GetWisp().GetHp() != 10 || EnemyRules.GetBeetle().GetStunnedTakes() != 1.5 || EnemyRules.GetKnock().GetTime() != .13 {
		t.Fatal("changed enemy tuning")
	}
}
