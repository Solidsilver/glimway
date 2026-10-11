package rules

import (
	"encoding/json"
	"glimway/content"
	contentv1 "glimway/gen/glimway/content/v1"
	"os"
	"testing"
)

func TestFightSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../content/vectors/fights.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Kit []struct {
			Name, Craft string
			Level       int
			Stats       map[string]float64
			Expected    map[string]float64
		}
		Crit []struct {
			Seed, SwingCounter uint32
			Chance, Roll       float64
			Crit               bool
		}
		Damage []struct {
			Base, StunnedMultiplier, Damage float64
			Crit, Tool                      bool
		}
		Reach []struct {
			Kind                                   string
			X, Y, FacingX, FacingY, EnemyX, EnemyY float64
			Hit                                    bool
		}
		Timing []struct {
			Kind             string
			ElapsedTicks     int32
			Locked, Launched bool
		}
		Windup []struct {
			Kind                 string
			LockTick, LaunchTick uint32
		}
		Ticks []struct {
			UnixMs         int64
			Tick, OffsetMs uint32
		}
		TickDiff []struct {
			A, B uint32
			Diff int32
		}
		BoltSpawn []struct {
			X, Y, FacingX, SpawnX, SpawnY float64
		}
		Counter []struct {
			Last, Next uint32
			Accepted   bool
		}
		Facing []struct {
			X, Y float64
			Step uint32
		}
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Kit) < 20 || len(vectors.Crit) < 60 || len(vectors.Damage) < 30 || len(vectors.Reach) < 150 ||
		len(vectors.Timing) < 15 || len(vectors.Windup) != 2 || len(vectors.Ticks) < 10 || len(vectors.TickDiff) < 10 ||
		len(vectors.BoltSpawn) < 4 || len(vectors.Facing) < 8 || len(vectors.Counter) < 15 {
		t.Fatal("insufficient vectors")
	}
	c := content.CombatRules
	formula := func(stat float64, f *contentv1.CombatFormula) float64 {
		return CombatFormula(stat, f.GetBase(), f.GetMaximumBonus(), f.GetHalfway(), f.GetDecimalPlaces())
	}
	for _, v := range vectors.Kit {
		t.Run(v.Name, func(t *testing.T) {
			got := map[string]float64{
				"meleeDamage":         formula(v.Stats["str"], c.GetMelee()),
				"signatureDamage":     0,
				"mitigation":          formula(v.Stats["con"], c.GetMitigation()),
				"critChance":          formula(v.Stats["per"], c.GetCrit()),
				"healAmount":          0,
				"basicAttackCooldown": c.GetClassless().GetBasicAttackCooldownSeconds(),
			}
			if v.Craft != "" {
				class := c.GetClasses()[v.Craft]
				got["basicAttackCooldown"] = class.GetBasicAttackCooldownSeconds()
				if v.Level >= 10 {
					got["signatureDamage"] = formula(v.Stats[class.GetDamageStat()], c.GetSignature())
				}
				if v.Level >= 10 && v.Craft == "healer" {
					f := c.GetHeal()
					got["healAmount"] = CombatFormula(v.Stats["int"], f.GetBase(), f.GetMaximumBonus(), f.GetHalfway(), f.GetDecimalPlaces())
				}
			}
			for key, want := range v.Expected {
				if got[key] != want {
					t.Fatalf("%s: got %v want %v", key, got[key], want)
				}
			}
		})
	}
	for _, v := range vectors.Crit {
		if FightCritRoll(v.Seed, v.SwingCounter) != v.Roll || FightCrit(v.Seed, v.SwingCounter, v.Chance) != v.Crit {
			t.Fatal("crit", v)
		}
	}
	for _, v := range vectors.Damage {
		if got := FightDamage(v.Base, v.Crit, v.StunnedMultiplier, v.Tool); got != v.Damage {
			t.Fatal("damage", got, v)
		}
	}
	for _, v := range vectors.Reach {
		if FightReach(v.Kind, v.X, v.Y, v.FacingX, v.FacingY, v.EnemyX, v.EnemyY) != v.Hit {
			t.Fatal("reach", v)
		}
	}
	for _, v := range vectors.Timing {
		if FightAimLocked(v.Kind, v.ElapsedTicks) != v.Locked || FightLaunched(v.Kind, v.ElapsedTicks) != v.Launched {
			t.Fatal("timing", v)
		}
	}
	for _, v := range vectors.Windup {
		if lock, launch, ok := FightWindupTicks(v.Kind); !ok || lock != v.LockTick || launch != v.LaunchTick {
			t.Fatal("windup", v, lock, launch)
		}
	}
	if _, _, ok := FightWindupTicks("guardian"); ok || FightAimLocked("guardian", 99) {
		t.Fatal("a guardian has no server wind-up")
	}
	for _, v := range vectors.Ticks {
		if tick, offset := FightTickAt(v.UnixMs); tick != v.Tick || offset != v.OffsetMs {
			t.Fatal("tick", v, tick, offset)
		}
	}
	for _, v := range vectors.TickDiff {
		if FightTickDiff(v.A, v.B) != v.Diff {
			t.Fatal("tick diff", v)
		}
	}
	for _, v := range vectors.BoltSpawn {
		if x, y := FightBoltSpawn(v.X, v.Y, v.FacingX); x != v.SpawnX || y != v.SpawnY {
			t.Fatal("bolt spawn", v, x, y)
		}
	}
	negative := false
	for _, v := range vectors.Timing {
		negative = negative || v.ElapsedTicks < 0
	}
	if !negative {
		t.Fatal("no timing row before the wind-up")
	}
	for _, v := range vectors.Counter {
		if FightCounterAhead(v.Last, v.Next) != v.Accepted {
			t.Fatal("counter", v)
		}
	}
	for _, v := range vectors.Facing {
		if FightFacingStep(v.X, v.Y) != v.Step {
			t.Fatal("facing", v)
		}
	}
}
