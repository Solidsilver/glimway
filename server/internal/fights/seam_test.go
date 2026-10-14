package fights

import (
	"testing"
	"time"

	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/location"
	"glimway/server/internal/rules"
)

func outdoorSafe(x, y float64) bool { return location.At(location.Outdoors, x, y).Safe }

// Replay a committed wisp tell as its target crosses the gate mouth.
func TestWispDropsTargetOnCommonsGround(t *testing.T) {
	for _, state := range []wire.FightEnemyState{wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE, wire.FightEnemyState_FIGHT_ENEMY_STATE_TELEGRAPH, wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE} {
		t.Run(state.String(), func(t *testing.T) {
			g := testGeometry()
			g.Safe = outdoorSafe
			r := NewRoom(Key{World: "world", Realm: "hearthwick", Epoch: "epoch"}, 1, g, []Camp{{ID: "camp", X: 40, Y: 350, Kinds: wisps(1)}}, 42, origin, 0)
			p := player(40, 375)
			r.Cover(p, origin)
			r.Step(at(100))
			e := r.enemies[0]
			if e.target != p.Observer {
				t.Fatal("wisp did not acquire unsafe target", e.target)
			}
			e.row.State = state
			p.Y = 384
			r.Cover(p, at(200))
			r.Step(at(300))
			if e.target != "" || r.targetNow(e) != nil {
				t.Fatal("safe target retained", e.target)
			}
			if r.players[p.Observer] == nil {
				t.Fatal("safe player lost room coverage")
			}
			// Coverage persists for later claims, but it must not lure a wisp via a decoy.
			r.decoys[p.Observer] = decoy{x: 40, y: 375, until: origin.Add(time.Minute).UnixMilli()}
			if r.targetNow(e) != nil {
				t.Fatal("unsafe decoy kept a safe owner targeted")
			}
		})
	}
}

func TestBoltsStopAtSafeTileAcrossChunkEdge(t *testing.T) {
	g := testGeometry()
	g.Safe = outdoorSafe
	if !g.CanBoltFly(40, 383) || g.CanBoltFly(40, 384) {
		t.Fatal("bolt crossed the Commons boundary")
	}
	// Hold open geometry on both sides so safety, not missing ground, stops it.
	next := testGeometry()
	next.CY = 1
	next.Safe = outdoorSafe
	x, y := 40.0, 360.0
	sx, sy := rules.FightBoltSpawn(x, y, 0)
	check := func(samples int) {
		t.Helper()
		if samples <= 0 {
			t.Fatal("bolt did not fly on unsafe ground")
		}
		_, last := boltPoint(sx, sy, 0, 1, samples)
		_, stopped := boltPoint(sx, sy, 0, 1, samples+1)
		if last >= 384 || stopped < 384 {
			t.Fatal("wrong stop sample", samples, last, stopped)
		}
	}
	check(BoltSamples(g.CanBoltFly, x, y, 0, 1))
	check(NewGround(g, next).BoltSamples(x, y, 0, 1))
	// Enemy movement, including shoves, cannot enter a safe tile.
	next.CY = 0
	next.Safe = func(x, y float64) bool { return x >= 160 }
	ex, ey, blocked := next.MoveBlocked(150, 112, 40, 0)
	if !blocked || ex >= 160 || ey != 112 {
		t.Fatal("enemy entered safe ground", ex, ey, blocked)
	}
}

// The room replay must settle a bolt at the safe tile before an enemy
// beyond it can take damage; checking geometry alone misses flight wiring.
func TestBoltReplayStopsBeforeEnemyBeyondSafeTile(t *testing.T) {
	g := testGeometry()
	g.Safe = func(x, y float64) bool { return x >= 160 && x < 176 }
	r := NewRoom(Key{World: "world", Realm: "hearthwick", Epoch: "epoch"}, 1, g, []Camp{{ID: "camp", X: 210, Y: 112, Kinds: wisps(1)}}, 42, origin, 0)
	p := player(110, 112)
	r.Cover(p, origin)
	e := r.enemies[0]
	hp := e.row.Hp
	c := cast("fingersnap", p.X, p.Y, 1, 0, 6)
	c.ID, c.Player = 77, p.Observer
	if rows, later := r.Cast(c, origin); !later || len(rows) != 0 {
		t.Fatal("bolt did not launch", rows, later)
	}
	var result *BoltResult
	for ms := 100; ms <= 1300 && result == nil; ms += 100 {
		for _, b := range r.Step(at(ms)).Bolts {
			result = &b
		}
	}
	if result == nil || result.ID != 77 || len(result.Hits) != 0 || e.row.Hp != hp {
		t.Fatal("bolt flew through safe tile", result, e.row.Hp, hp)
	}
}

func TestSafeBystandersWitnessWithoutScalingCamp(t *testing.T) {
	for _, safe := range []bool{true, false} {
		g := testGeometry()
		if safe {
			g.Safe = outdoorSafe
		}
		r := NewRoom(Key{World: "world", Realm: "hearthwick", Epoch: "epoch"}, 1, g, []Camp{{ID: "camp", X: 40, Y: 350, Kinds: wisps(3)}}, 42, origin, 0)
		fighter := player(40, 375)
		bystander := player(40, 392)
		bystander.ID, bystander.Observer = "bystander", "bystander"
		r.Cover(fighter, origin)
		r.Cover(bystander, origin)
		r.Step(at(100))
		c := r.camps[0]
		want := 4
		if safe {
			want = 3
		}
		if !c.started || c.size != want || len(c.members) != want {
			t.Fatalf("safe=%v: camp size=%d members=%d", safe, c.size, len(c.members))
		}
		if !c.witnesses[bystander.ID] {
			t.Fatal("safe bystander lost claim witness")
		}
	}
}
