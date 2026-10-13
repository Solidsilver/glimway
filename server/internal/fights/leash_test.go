package fights

import (
	"glimway/content"
	wire "glimway/server/internal/gen/glimway/v2"
	"math"
	"testing"
)

func leashRoom(kind string) (*Room, *enemy) {
	r := testRoom(1)
	e := r.enemies[0]
	e.kind = kind
	e.homeX, e.homeY, e.x, e.y = 180, 180, 180, 180
	r.Cover(player(280, 180), origin)
	e.target = "socket-a"
	e.readyAt = 1 << 60
	return r, e
}
func TestSoftLeashWalkAndHysteresis(t *testing.T) {
	for _, kind := range []string{kindWisp, kindBeetle} {
		r, e := leashRoom(kind)
		e.x = e.homeX + 170
		r.step(e, 100100)
		if e.x >= 350 || e.x < 340 || e.target != "" || !e.returning {
			t.Fatal("outside enemy did not walk home", kind, e.x, e.target)
		}
		e.x = e.homeX + 156
		if p, _, _ := r.target(e, 100200); p != nil {
			t.Fatal("reacquired before return margin")
		}
		e.x = e.homeX + 151
		if p, _, _ := r.target(e, 100300); p == nil || e.returning {
			t.Fatal("did not reacquire inside margin")
		}
	}
}
func TestKnockPastLeashDoesNotSnap(t *testing.T) {
	r, e := leashRoom(kindWisp)
	e.x = e.homeX + 158
	e.knockX = 170
	e.knockLeft = .13
	r.step(e, 100100)
	if e.x <= e.homeX+CampLeash || e.target != "" || !e.returning {
		t.Fatal("knock failed to cross leash")
	}
	r.step(e, 100200)
	outside := e.x
	r.step(e, 100300)
	if e.x >= outside || e.x < e.homeX+CampLeash || e.target != "" {
		t.Fatal("knock snapped or did not walk home", e.x)
	}
}
func TestAttacksSkidAtLeashIntoRecovery(t *testing.T) {
	for _, kind := range []string{kindWisp, kindBeetle} {
		r, e := leashRoom(kind)
		e.x = e.homeX + 155
		e.dirX = 1
		r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE, 100000)
		r.step(e, 100100)
		if math.Abs(math.Hypot(e.x-e.homeX, e.y-e.homeY)-CampLeash) > 1e-8 || e.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER {
			t.Fatal("did not skid into recovery", kind, e.x, e.y, e.row.State)
		}
	}
}
func TestScuttlePathBoundedAndLocked(t *testing.T) {
	r, e := leashRoom(kindBeetle)
	e.dirX = 1
	r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE, 100000)
	length := 0.0
	previousX, previousY := e.x, e.y
	for tick := 1; tick <= 5; tick++ {
		r.step(e, 100000+int64(tick*100))
		length += math.Hypot(e.x-previousX, e.y-previousY)
		previousX, previousY = e.x, e.y
		if tick == 1 && e.y <= e.homeY {
			t.Fatal("first dash did not angle")
		}
		// Move the hero: locked path must not turn to follow.
		r.players["socket-a"].Y = 220
	}
	if length > 110 || math.Abs(e.x-e.homeX-98.35382907247958) > 1e-8 || math.Abs(e.y-e.homeY) > 1e-8 || e.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER {
		t.Fatal("scuttle path", length, e.x, e.y, e.row.State)
	}
}
func TestScuttleWallCrashStillDazes(t *testing.T) {
	r, e := leashRoom(kindBeetle)
	e.x = 374
	e.y = 180
	e.dirX = 1
	// Home near chunk edge, so collision wins well before the camp circle.
	e.homeX = 340
	r.players["socket-a"].X = 370
	r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE, 100000)
	r.step(e, 100100)
	if e.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_STUNNED {
		t.Fatal("wall did not stun", e.row.State)
	}
	hp := e.row.Hp
	r.hit(e, 2, false, false, e.x-20, e.y, 100100)
	if hp-e.row.Hp != 2*content.EnemyRules.GetBeetle().GetStunnedTakes() {
		t.Fatal("crash lost damage multiplier")
	}
}
