package content

import "testing"

func TestFightContentLoaders(t *testing.T) {
	runLoaderVectors(t, "combat", "combat-loader", func(raw []byte) (any, error) { return DecodeCombat(raw) })
	runLoaderVectors(t, "enemies", "enemies-loader", func(raw []byte) (any, error) { return DecodeEnemies(raw) })
	var vectors struct {
		Timing []struct {
			Kind             string
			Elapsed          float64
			Locked, Launched bool
		}
	}
	readVectors(t, "fights", &vectors)
	if len(vectors.Timing) == 0 {
		t.Fatal("no timing vectors")
	}
	for _, v := range vectors.Timing {
		windup, lock := EnemyRules.GetWisp().GetWindup(), EnemyRules.GetWisp().GetLock()
		if v.Kind == "beetle" {
			windup, lock = EnemyRules.GetBeetle().GetWindup(), EnemyRules.GetBeetle().GetLock()
		}
		if (windup-v.Elapsed <= lock) != v.Locked || (v.Elapsed >= windup) != v.Launched {
			t.Fatal(v)
		}
	}
	if EnemyRules.GetWisp().GetHp() != 10 || EnemyRules.GetBeetle().GetStunnedTakes() != 1.5 || EnemyRules.GetKnock().GetTime() != .13 {
		t.Fatal("changed enemy tuning")
	}
}
