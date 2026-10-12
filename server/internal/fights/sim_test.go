package fights

import (
	"glimway/content"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"math"
	"sync/atomic"
	"testing"
	"time"
)

func campRoom(camps ...Camp) *Room {
	return NewRoom(Key{World: "world", Realm: "hearthwick", Epoch: "epoch"}, 1, testGeometry(), camps, 42, origin, 0)
}
func named(id string, x, y float64) Player {
	return Player{ID: id, Observer: "socket-" + id, Seed: 7, X: x, Y: y, Kit: rules.CombatKitFor(nil, "", 0)}
}
func at(ms int) time.Time { return origin.Add(time.Duration(ms) * time.Millisecond) }
func kill(r *Room, c *camp, ms int64) {
	for _, e := range c.members {
		if e.row.Hp > 0 {
			r.hit(e, 1000, false, false, e.x-10, e.y, ms)
		}
	}
}
func kinds(events []*wire.FightEvent, kind wire.FightEventKind) int {
	n := 0
	for _, e := range events {
		if e.Kind == kind {
			n++
		}
	}
	return n
}
func cast(id string, x, y, fx, fy float64, damage float64) Cast {
	tick, _ := rules.FightTickAt(origin.UnixMilli())
	return Cast{Player: "socket-alice", Ability: id, X: x, Y: y, Damage: damage, Fight: &wire.FightCast{Facing: &wire.FightFacing{X: fx, Y: fy}, SeenTick: tick}}
}

// A beetle keeps its distance, winds up for 8 ticks, charges along the
// locked aim and crashes into a wall: dazed, it takes stunnedTakes, a charge
// is too heavy to shove, and it recovers after its stun.
func TestBeetleChargeIntoWallStunsAndTakesMore(t *testing.T) {
	g := testGeometry()
	for ty := 0; ty < g.Size; ty++ {
		g.Open[ty*g.Size+12] = false // a wall at x 192..208
	}
	r := NewRoom(Key{World: "w", Realm: "r", Epoch: "e"}, 1, g, []Camp{{ID: "camp:0:0:0", X: 100, Y: 112, Kinds: []string{"beetle"}}}, 1, origin, 0)
	b := r.enemies[0]
	if b.kind != kindBeetle || b.row.Kind != wire.FightEnemyKind_FIGHT_ENEMY_KIND_BEETLE || b.row.MaxHp != content.EnemyRules.GetBeetle().GetHp() {
		t.Fatal("beetle row", b.row.String())
	}
	b.readyAt = 0
	r.Cover(named("alice", 180, 112), origin)
	f := r.Step(at(100))
	if kinds(f.Events, wire.FightEventKind_FIGHT_EVENT_KIND_WINDUP_START) != 1 {
		t.Fatal("no wind-up", f.Events)
	}
	lock, launch, _ := rules.FightWindupTicks("beetle")
	for n := 2; n <= int(launch)+1; n++ {
		f = r.Step(at(n * 100))
		if n == int(lock)+1 && kinds(f.Events, wire.FightEventKind_FIGHT_EVENT_KIND_AIM_LOCK) != 1 {
			t.Fatal("no aim lock at", n)
		}
	}
	if b.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE {
		t.Fatal("charge did not launch", b.row.State)
	}
	// Mid-charge a blow lands but cannot shove it.
	r.hit(b, 1, false, false, b.x-10, b.y, at(int(launch)*100+150).UnixMilli())
	if b.knockLeft != 0 || b.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE {
		t.Fatal("charging beetle was shoved or interrupted")
	}
	ms := int(launch)*100 + 100
	for b.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE && ms < 3000 {
		ms += 100
		r.Step(at(ms))
	}
	if b.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_STUNNED || b.x > 192-EnemyRadius+1e-9 || b.x < 180 {
		t.Fatal("charge did not crash into the wall", b.row.State, b.x)
	}
	hp := b.row.Hp
	row := r.hit(b, 2, false, false, 170, 112, at(ms).UnixMilli())
	if want := 2 * content.EnemyRules.GetBeetle().GetStunnedTakes(); row.Damage != want || b.row.Hp != hp-want {
		t.Fatal("stunned damage", row.Damage, want)
	}
	stunned := ms
	for b.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_STUNNED && ms < 6000 {
		ms += 100
		r.Step(at(ms))
	}
	if got := ms - stunned; got < int(wholeMs(content.EnemyRules.GetBeetle().GetStun())) || got > int(wholeMs(content.EnemyRules.GetBeetle().GetStun()))+300 {
		t.Fatal("stun length", got)
	}
}

// A beetle backs off a player inside its keep-away band and approaches one beyond it.
func TestBeetleKeepsChargingDistance(t *testing.T) {
	r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"beetle"}})
	b := r.enemies[0]
	b.readyAt = math.MaxInt64
	r.Cover(named("alice", 140, 112), origin)
	r.Step(at(100))
	if b.x >= 120 {
		t.Fatal("beetle did not back off", b.x)
	}
	far := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"beetle"}})
	far.enemies[0].readyAt = math.MaxInt64
	far.Cover(named("alice", 230, 112), origin)
	far.Step(at(100))
	if far.enemies[0].x <= 120 {
		t.Fatal("beetle did not approach", far.enemies[0].x)
	}
}

// Three accounts at the camp at its first aggro scale a base of three to
// five; extras rise as SPAWN events and spawned rows. A downed account and
// a second socket of the same account do not count. HP never scales.
func TestCampScalesOnceAtFirstAggro(t *testing.T) {
	r := campRoom(Camp{ID: "camp:0:0:0", X: 120, Y: 112, Kinds: []string{"wisp", "wisp", "beetle"}})
	r.Cover(named("alice", 150, 112), origin)
	r.Cover(named("bob", 150, 130), origin)
	twin := named("bob", 150, 140)
	twin.Observer = "socket-bob-2"
	r.Cover(twin, origin)
	down := named("dan", 150, 120)
	down.Down = true
	r.Cover(down, origin)
	join := r.Join(1)
	if len(join.Enemies) != 3 {
		t.Fatal("base mix", len(join.Enemies))
	}
	f := r.Step(at(100))
	c := r.camps[0]
	if c.size != 4 || kinds(f.Events, wire.FightEventKind_FIGHT_EVENT_KIND_SPAWN) != 1 || f.Delta == nil || len(f.Delta.Spawned) != 1 {
		t.Fatal("two live accounts should add one", c.size, f.Events, f.Delta)
	}
	validate(t, f.Delta)
	extra := f.Delta.Spawned[0]
	if extra.Id != "wilds:camp:0:0:0:3" || extra.Enemy != 3 || extra.Kind != wire.FightEnemyKind_FIGHT_ENEMY_KIND_WISP || extra.MaxHp != content.EnemyRules.GetWisp().GetHp() {
		t.Fatal(extra)
	}
	// Size is frozen: a third account arriving later adds nothing.
	r.Cover(named("carol", 140, 112), at(150))
	f = r.Step(at(200))
	if c.size != 4 || f.Delta != nil && len(f.Delta.Spawned) != 0 {
		t.Fatal("size changed after first aggro")
	}

	big := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp", "wisp", "beetle"}})
	for _, id := range []string{"a", "b", "c", "d"} {
		big.Cover(named(id, 130, 112), origin)
	}
	f = big.Step(at(100))
	if big.camps[0].size != CampMax || len(f.Delta.Spawned) != 2 || f.Delta.Spawned[1].Kind != wire.FightEnemyKind_FIGHT_ENEMY_KIND_WISP {
		t.Fatal("cap at five, extras cycle the mix", big.camps[0].size, f.Delta)
	}
	validate(t, f.Delta)
	// A single wisp camp stays one with one player.
	solo := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp"}})
	solo.Cover(named("a", 130, 112), origin)
	solo.Step(at(100))
	if solo.camps[0].size != 1 || len(solo.enemies) != 1 {
		t.Fatal("solo camp scaled")
	}
}

// A first blow starts the camp too: it scales before the fall is judged, so
// a one-hit kill cannot end a camp that should have risen bigger.
func TestFirstHitScalesBeforeFall(t *testing.T) {
	r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp"}})
	r.Cover(named("alice", 300, 300), origin) // out of aggro, inside the 3x3
	r.Cover(named("bob", 125, 112), origin)
	r.Cover(named("carol", 130, 112), origin)
	r.hit(r.enemies[0], 1000, false, false, 110, 112, origin.UnixMilli())
	if len(r.camps[0].members) != 2 || r.camps[0].Fallen || len(r.falls) != 0 {
		t.Fatal("one-hit kill skipped scaling", len(r.camps[0].members))
	}
}

// Two camps in one room fall independently, each with its own witnesses
// (from its own first aggro), and each cycle respawns exactly at the fall
// writer's boundary with fresh ids, never resurrecting the old rows.
func TestCampsFallAndRespawnIndependently(t *testing.T) {
	r := campRoom(Camp{ID: "a", Cycle: 4, X: 60, Y: 112, Kinds: []string{"wisp"}}, Camp{ID: "b", Cycle: 9, X: 300, Y: 112, Kinds: []string{"beetle", "wisp"}})
	a, b := r.camps[0], r.camps[1]
	r.Cover(named("alice", 70, 112), origin)
	r.Step(at(100))
	if !a.started || b.started {
		t.Fatal("aggro is per camp", a.started, b.started)
	}
	kill(r, a, at(150).UnixMilli())
	f := r.Step(at(200))
	if len(f.Falls) != 1 || f.Falls[0].Camp != "a" || f.Falls[0].Cycle != 4 || f.Falls[0].At != at(150).UnixMilli() || len(f.Falls[0].Witnesses) != 1 || f.Falls[0].Witnesses[0] != "alice" {
		t.Fatal("camp a fall", f.Falls)
	}
	// A late friend witnesses b, not a.
	r.Cover(named("bob", 290, 112), at(250))
	r.Step(at(300))
	if !b.started || !b.witnesses["bob"] || a.witnesses["bob"] {
		t.Fatal("witnesses are per camp")
	}
	// b falls a second later, so its respawn boundary is its own.
	kill(r, b, at(1350).UnixMilli())
	f = r.Step(at(1400))
	if len(f.Falls) != 1 || f.Falls[0].Camp != "b" || f.Falls[0].Cycle != 9 || len(f.Falls[0].Witnesses) != 2 {
		t.Fatal("camp b fall", f.Falls)
	}
	respawn := RespawnAt(at(150).UnixMilli())
	if respawn != (at(150).UnixMilli()/1000+int64(content.WildsRules.GetTimers().GetCampRespawnSeconds()))*1000 || a.RespawnAt != respawn {
		t.Fatal("respawn boundary", a.RespawnAt, respawn)
	}
	old := a.members[0].row.Enemy
	// Alice steps away, so the fresh cycle starts unaggroed.
	r.Leave("socket-alice", at(500))
	early := r.Step(time.UnixMilli(respawn - 100))
	if early.Delta != nil && len(early.Delta.Spawned)+len(early.Delta.Removed) > 0 || !a.Fallen {
		t.Fatal("respawned before its boundary")
	}
	f = r.Step(time.UnixMilli(respawn))
	if a.Fallen || a.Cycle != 5 || a.started || len(a.witnesses) != 0 || f.Delta == nil || len(f.Delta.Removed) != 1 || f.Delta.Removed[0] != old || len(f.Delta.Spawned) != 1 {
		t.Fatal("respawn", a.Fallen, a.Cycle, f.Delta)
	}
	validate(t, f.Delta)
	if row := f.Delta.Spawned[0]; row.Id != "wilds:a:1" || row.Enemy <= old || row.Hp != row.MaxHp || kinds(f.Events, wire.FightEventKind_FIGHT_EVENT_KIND_SPAWN) != 1 {
		t.Fatal("fresh life", row)
	}
	if !b.Fallen || len(f.Falls) != 0 {
		t.Fatal("b respawned with a, or a fall was re-emitted")
	}
	// The new cycle falls on its own record.
	r.Cover(named("alice", 70, 112), time.UnixMilli(respawn+50))
	r.Step(time.UnixMilli(respawn + 100))
	kill(r, a, respawn+150)
	f = r.Step(time.UnixMilli(respawn + 200))
	if len(f.Falls) != 1 || f.Falls[0].Cycle != 5 {
		t.Fatal("next cycle fall", f.Falls)
	}
}

// A camp whose current cycle already has a fall record wakes as its dead:
// rows a returning witness's screen reads as won. Nothing acts, nothing
// falls again, and it respawns at the recorded boundary.
func TestFallenWakeShowsDeadRowsUntilRespawn(t *testing.T) {
	fell := at(-5000).UnixMilli()
	r := campRoom(Camp{ID: "c", Cycle: 2, X: 120, Y: 112, Kinds: []string{"wisp", "beetle"}, Fallen: true, RespawnAt: RespawnAt(fell)})
	join := r.Join(3)
	validate(t, join)
	if len(join.Enemies) != 2 {
		t.Fatal("fallen wake hid its camp", join.Enemies)
	}
	for _, row := range join.Enemies {
		if row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_DEAD || row.Hp != 0 || row.CampId != "c" {
			t.Fatal("not a dead row", row)
		}
	}
	r.Cover(named("alice", 125, 112), origin)
	for ms := 100; ms <= 1000; ms += 100 {
		f := r.Step(at(ms))
		if f.Delta != nil || len(f.Falls) != 0 || len(f.Events) != 0 || r.camps[0].started {
			t.Fatal("dead camp acted", f)
		}
	}
	if rows := r.Slash(Attack{Player: "socket-alice", Swing: slash(125, 112, 0, 0, &wire.FightTarget{Room: 1, Enemy: 0}), Damage: 5}, at(1000)); len(rows) != 1 || rows[0].RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_ALREADY_DEAD {
		t.Fatal("hit a dead row", rows)
	}
	f := r.Step(time.UnixMilli(RespawnAt(fell)))
	if len(f.Delta.Removed) != 2 || len(f.Delta.Spawned) != 2 || r.camps[0].Cycle != 3 {
		t.Fatal("fallen camp did not respawn", f.Delta)
	}
	validate(t, f.Delta)
}

// Join is the published baseline: an enemy that rises between ticks is not
// in it, and the next delta brings it as a spawned row exactly once.
func TestJoinBaselineAroundMidTickSpawn(t *testing.T) {
	r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp"}})
	r.Cover(named("alice", 300, 300), origin)
	r.Cover(named("bob", 125, 112), origin)
	r.Cover(named("carol", 128, 112), origin)
	r.hit(r.enemies[0], 1, false, false, 110, 112, at(50).UnixMilli())
	join := r.Join(1)
	if len(join.Enemies) != 1 || join.Enemies[0].Hp != join.Enemies[0].MaxHp {
		t.Fatal("join is not the published baseline", join.Enemies)
	}
	f := r.Step(at(100))
	// Alice is beyond the scaling radius: bob and carol add one.
	if len(f.Delta.Spawned) != 1 || len(f.Delta.Changed) == 0 || f.Delta.Changed[0].Hp == nil {
		t.Fatal("delta missing the mid-tick changes", f.Delta)
	}
	if again := r.Step(at(200)); again.Delta != nil && len(again.Delta.Spawned) != 0 {
		t.Fatal("spawned twice")
	}
}

func TestCleaveMendAndShadowstepStrikes(t *testing.T) {
	sig := 7.0
	r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp", "wisp", "wisp"}})
	r.Cover(named("alice", 120, 150), origin)
	// Cleave: ahead of the feet along the facing, reach 40; it never crits.
	c := cast("cleave", 120, 150, 0, -1, sig)
	c.Crit = true
	rows, later := r.Cast(c, origin)
	if later || len(rows) != 3 {
		t.Fatal("cleave", rows)
	}
	for _, row := range rows {
		if row.Damage != sig {
			t.Fatal("cleave crit or wrong damage", row)
		}
	}
	// Facing away, it reaches nothing; a predicted row is refused.
	c = cast("cleave", 120, 150, 0, 1, sig)
	c.Fight.Predicted = []*wire.FightTarget{{Room: 1, Enemy: 0}}
	if rows, _ := r.Cast(c, at(100)); len(rows) != 1 || rows[0].RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_OUT_OF_REACH {
		t.Fatal("cleave behind", rows)
	}

	m := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp", "wisp", "wisp"}})
	m.Cover(named("alice", 120, 175), origin)
	if rows, _ := m.Cast(cast("mend", 120, 175, 1, 0, sig), origin); len(rows) != 3 {
		t.Fatal("mend pulse reach 70", rows)
	}
	far := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp"}})
	far.Cover(named("alice", 120, 200), origin)
	if rows, _ := far.Cast(cast("mend", 120, 200, 1, 0, sig), origin); len(rows) != 0 {
		t.Fatal("mend reached too far", rows)
	}

	// Shadowstep: a 64.5 px dash, then a crit-able strike at its end.
	s := campRoom(Camp{ID: "c", X: 200, Y: 112, Kinds: []string{"wisp"}})
	s.Cover(named("alice", 130, 112), origin)
	c = cast("shadowstep", 130, 112, 1, 0, sig)
	c.Crit = true
	rows, _ = s.Cast(c, origin)
	if len(rows) != 1 || rows[0].Damage != sig*content.CombatRules.GetAttack().GetCritMultiplier() {
		t.Fatal("snapstrike", rows)
	}
	// Without the dash's reach, the same enemy is out of a standing strike.
	s2 := campRoom(Camp{ID: "c", X: 200, Y: 112, Kinds: []string{"wisp"}})
	s2.Cover(named("alice", 130, 112), origin)
	if rows, _ := s2.Cast(cast("shadowstep", 130, 112, -1, 0, sig), origin); len(rows) != 0 {
		t.Fatal("snapstrike backwards hit", rows)
	}
	// A wall stops the dash: reach drops to 22 at the wall.
	g := testGeometry()
	for ty := 0; ty < g.Size; ty++ {
		g.Open[ty*g.Size+9] = false // x 144..160
	}
	if x, _ := NewGround(g).Dash(130, 112, 1, 0); x > 144-EnemyRadius+1e-9 {
		t.Fatal("dash went through a wall", x)
	}
	if x, _ := NewGround(testGeometry()).Dash(130, 112, 1, 0); math.Abs(x-194.5) > 1e-9 {
		t.Fatal("dash length", x)
	}
}

func TestFingersnapBoltUsesSignatureDamageAndNeverCrits(t *testing.T) {
	r := campRoom(Camp{ID: "c", X: 180, Y: 112, Kinds: []string{"wisp"}})
	r.Cover(named("alice", 120, 112), origin)
	c := cast("fingersnap", 120, 112, 1, 0, 6)
	c.Crit, c.ID = true, 77
	if rows, later := r.Cast(c, origin); !later || rows != nil {
		t.Fatal("fingersnap answers when its bolt lands")
	}
	var hit *BoltResult
	for ms := 100; ms <= 1300 && hit == nil; ms += 100 {
		for _, b := range r.Step(at(ms)).Bolts {
			hit = &b
		}
	}
	if hit == nil || hit.ID != 77 || len(hit.Hits) != 1 || hit.Hits[0].Damage != 6 {
		t.Fatal("fingersnap bolt", hit)
	}
}

// Kindle slows everything inside its patch to its share, for its time.
func TestKindleSlowsEnemiesInsideThePatch(t *testing.T) {
	run := func(kindle bool) float64 {
		r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp"}})
		r.enemies[0].readyAt = math.MaxInt64
		r.Cover(named("alice", 190, 112), origin)
		if kindle {
			if rows, _ := r.Cast(cast("kindle", 120, 112, 1, 0, 0), origin); len(rows) != 0 {
				t.Fatal("kindle deals no damage")
			}
		}
		r.Step(at(100))
		return r.enemies[0].x - 120
	}
	plain, slowed := run(false), run(true)
	k, _ := content.AbilityFor("kindle")
	if math.Abs(slowed-plain*k.GetNumbers().GetSlow()) > 1e-9 {
		t.Fatal("kindle slow", plain, slowed)
	}
	r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp"}})
	r.Cover(named("alice", 190, 112), origin)
	r.Cast(cast("kindle", 120, 112, 1, 0, 0), origin)
	r.Step(time.UnixMilli(origin.UnixMilli() + wholeMs(k.GetNumbers().GetDurationSeconds())))
	if len(r.patches) != 0 {
		t.Fatal("patch outlived its time")
	}
}

// Stand: a lunge that reaches a planted caster stops short. A wisp squashes
// into recovery for the stagger, a beetle is dazed and takes more.
func TestStandStaggersLungesAtThePlantedCaster(t *testing.T) {
	stand, _ := content.AbilityFor("stand")
	stagger := wholeMs(stand.GetNumbers().GetStaggerSeconds())
	for _, kind := range []string{"wisp", "beetle"} {
		r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{kind}})
		e := r.enemies[0]
		e.readyAt = 0
		r.Cover(named("alice", 150, 112), origin)
		if rows, _ := r.Cast(cast("stand", 150, 112, -1, 0, 0), origin); len(rows) != 0 {
			t.Fatal("stand deals no damage")
		}
		ms := 0
		for e.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE && ms < 2000 {
			ms += 100
			r.Step(at(ms))
		}
		for e.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE && ms < 3000 {
			ms += 100
			r.Step(at(ms))
		}
		want := wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER
		if kind == kindBeetle {
			want = wire.FightEnemyState_FIGHT_ENEMY_STATE_STUNNED
		}
		reach := lungeReach(kind) + standMargin
		if e.row.State != want || e.holdMS != stagger || math.Hypot(150-e.x, (112-8)-(e.y-6)) >= reach {
			t.Fatal(kind, "not staggered at the planted caster", e.row.State, e.holdMS, e.x)
		}
		if math.Hypot(150-e.x, (112-8)-(e.y-6)) < reach-8 {
			t.Fatal(kind, "stagger came late", e.x)
		}
	}
	// Unplanted, the same wisp hops through.
	r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp"}})
	r.enemies[0].readyAt = 0
	r.Cover(named("alice", 150, 112), origin)
	for ms := 100; ms <= 900; ms += 100 {
		r.Step(at(ms))
	}
	if r.enemies[0].holdMS == stagger || r.enemies[0].x < 150 {
		t.Fatal("unplanted hop stopped", r.enemies[0].x)
	}
}

// Echo: enemies aim at the decoy in place of the caster while it lasts,
// and events name it.
func TestEchoDecoyIsTheTarget(t *testing.T) {
	r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp"}})
	e := r.enemies[0]
	e.readyAt = 0
	r.Cover(named("alice", 150, 112), origin)
	r.Cast(cast("echo", 150, 112, 1, 0, 0), origin)
	// Alice walks off; the decoy stays where she cast it.
	r.Cover(named("alice", 150, 150), at(50))
	f := r.Step(at(100))
	if len(f.Events) != 1 || f.Events[0].GetTarget() != "decoy:alice" {
		t.Fatal("wind-up did not aim at the decoy", f.Events)
	}
	for ms := 200; ms <= 900; ms += 100 {
		r.Step(at(ms))
	}
	if e.y > 113 || e.x < 140 {
		t.Fatal("hop did not go for the decoy", e.x, e.y)
	}
	echo, _ := content.AbilityFor("echo")
	if p, x, y := r.target(e, origin.UnixMilli()+wholeMs(echo.GetNumbers().GetDurationSeconds())); p == nil || x != 150 || y != 150 {
		t.Fatal("decoy outlived its time", x, y)
	}
}

// Ward-light has no effect on enemies in the client's rules (it mends
// players); the sim answers it and changes nothing.
func TestWardLightLeavesEnemiesAlone(t *testing.T) {
	r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp"}})
	r.Cover(named("alice", 125, 112), origin)
	before := r.enemies[0].row.String()
	rows, later := r.Cast(cast("ward-light", 125, 112, 1, 0, 0), origin)
	if later || rows == nil || len(rows) != 0 || r.enemies[0].row.String() != before || len(r.patches)+len(r.plants)+len(r.decoys) != 0 {
		t.Fatal("ward-light touched the fight")
	}
	if CastRadius("ward-light") != 0 || CastRadius("stand") >= 0 || CastRadius("echo") >= 0 || CastRadius("cleave") <= 0 {
		t.Fatal("cast routing")
	}
}

// A downed caster's cast does nothing, and a leaving socket takes its plant
// and decoy with it.
func TestCastsFromDownOrDepartedCastersDoNothing(t *testing.T) {
	r := campRoom(Camp{ID: "c", X: 120, Y: 112, Kinds: []string{"wisp"}})
	p := named("alice", 125, 112)
	p.Down = true
	r.Cover(p, origin)
	if rows, later := r.Cast(cast("cleave", 125, 112, -1, 0, 9), origin); rows != nil || later {
		t.Fatal("downed caster struck")
	}
	p.Down = false
	r.Cover(p, at(10))
	r.Cast(cast("stand", 125, 112, 1, 0, 0), at(10))
	r.Cast(cast("echo", 125, 112, 1, 0, 0), at(10))
	r.Leave(p.Observer, at(20))
	if len(r.plants)+len(r.decoys) != 0 {
		t.Fatal("left effects behind")
	}
}

// The actor routes a Fingersnap's result to its caller only when the bolt lands.
func TestActorAnswersCastsAndPendingFingersnap(t *testing.T) {
	ticks := make(chan time.Time)
	var ms atomic.Int64
	ms.Store(origin.UnixMilli())
	now := func() time.Time { return time.UnixMilli(ms.Load()) }
	r := campRoom(Camp{ID: "c", X: 150, Y: 112, Kinds: []string{"wisp"}})
	a := Start(r, ActorConfig{Now: now, Ticks: ticks})
	defer func() { a.Stop(); <-a.Done() }()
	p := named("alice", 120, 112)
	a.Submit(Command{Player: &p})
	cleave := make(chan []*wire.FightHitRow, 1)
	c := cast("cleave", 120, 112, 1, 0, 3)
	a.Submit(Command{Cast: &c, Result: cleave})
	if rows := <-cleave; len(rows) != 1 {
		t.Fatal("cleave via actor", rows)
	}
	snap := make(chan []*wire.FightHitRow, 1)
	f := cast("fingersnap", 120, 112, 1, 0, 3)
	f.ID = 5
	a.Submit(Command{Cast: &f, Result: snap})
	select {
	case <-snap:
		t.Fatal("answered before the bolt flew")
	case <-time.After(20 * time.Millisecond):
	}
	ticks <- time.UnixMilli(ms.Add(100))
	if rows := <-snap; len(rows) != 1 {
		t.Fatal("bolt result", rows)
	}
}

// Clear (the dev fixture) is the fight's own path: first aggro scales the
// camp and takes the covering players as witnesses, every row dies with a
// DEATH event, one fall goes out, and a repeat or unknown camp makes nothing.
func TestClearUsesTheFallPath(t *testing.T) {
	r := campRoom(Camp{ID: "c", Cycle: 3, X: 120, Y: 112, Kinds: []string{"wisp", "beetle"}}, Camp{ID: "d", X: 300, Y: 300, Kinds: []string{"wisp"}})
	r.Cover(named("alice", 125, 112), origin)
	r.Cover(named("bob", 130, 112), origin)
	got := r.Clear("c", at(10))
	if !got.Found || !got.Fresh || got.Fall.Cycle != 3 || len(got.Fall.Witnesses) != 2 || len(r.camps[0].members) != 3 {
		t.Fatal("clear", got, len(r.camps[0].members))
	}
	if kinds(r.events, wire.FightEventKind_FIGHT_EVENT_KIND_DEATH) != 3 || len(r.falls) != 1 || r.camps[1].Fallen {
		t.Fatal("deaths or falls", r.events, r.falls)
	}
	r.takeFalls()
	if again := r.Clear("c", at(20)); !again.Found || again.Fresh || len(r.falls) != 0 {
		t.Fatal("repeat clear", again)
	}
	if none := r.Clear("x", at(20)); none.Found {
		t.Fatal("unknown camp")
	}
	f := r.Step(at(100))
	validate(t, f.Delta)
	for _, e := range r.camps[0].members {
		if e.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_DEAD || e.row.Hp != 0 {
			t.Fatal("row stands", e.row.String())
		}
	}
}
