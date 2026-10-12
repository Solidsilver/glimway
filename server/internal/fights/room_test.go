package fights

import (
	"bytes"
	"encoding/json"
	"fmt"
	"glimway/content"
	"glimway/server/internal/chunks"
	chunkwire "glimway/server/internal/gen/glimway/v1"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"math"
	"sync/atomic"
	"testing"
	"time"

	"buf.build/go/protovalidate"
	"google.golang.org/protobuf/proto"
)

var origin = time.UnixMilli(100000)

func testGeometry() Geometry {
	g := Geometry{Size: 24, Open: make([]bool, 24*24)}
	for i := range g.Open {
		g.Open[i] = true
	}
	return g
}
func testRoom(count int) *Room {
	return NewRoom(Key{World: "world", Realm: "hearthwick", Epoch: "epoch"}, 1, testGeometry(), []Camp{{ID: "camp:0:0:0", X: 120, Y: 112, Count: count}}, 42, origin, 0)
}
func player(x, y float64) Player {
	return Player{ID: "alice", Observer: "socket-a", Seed: 123, X: x, Y: y, Kit: rules.CombatKitFor(nil, "", 0)}
}
func slash(x, y float64, counter uint32, tick uint32, predicted ...*wire.FightTarget) *wire.FightSwing {
	return &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, X: x, Y: y, Facing: &wire.FightFacing{X: 1}, SwingCounter: counter, SeenTick: tick, Predicted: predicted}
}
func validate(t *testing.T, m proto.Message) {
	t.Helper()
	if err := protovalidate.Validate(m); err != nil {
		t.Fatalf("invalid output %s: %v", m, err)
	}
}

func TestWispWindupLockHopAndInterruptedHop(t *testing.T) {
	r := testRoom(1)
	r.enemies[0].readyAt = 0
	r.Cover(player(145, 112), origin)
	f := r.Step(origin.Add(100 * time.Millisecond))
	if len(f.Events) != 1 || f.Events[0].Kind != wire.FightEventKind_FIGHT_EVENT_KIND_WINDUP_START || f.Events[0].Tick != 1001 {
		t.Fatal(f)
	}
	for n := 2; n <= 3; n++ {
		r.Step(origin.Add(time.Duration(n) * 100 * time.Millisecond))
	}
	f = r.Step(origin.Add(400 * time.Millisecond))
	if len(f.Events) != 1 || f.Events[0].Kind != wire.FightEventKind_FIGHT_EVENT_KIND_AIM_LOCK || f.Events[0].Tick != 1004 || f.Events[0].GetTarget() != "alice" {
		t.Fatal(f)
	}
	r.Cover(player(120, 145), origin.Add(450*time.Millisecond))
	r.Step(origin.Add(500 * time.Millisecond))
	r.Step(origin.Add(600 * time.Millisecond))
	if r.enemies[0].row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE {
		t.Fatal("hop did not launch")
	}
	r.Step(origin.Add(700 * time.Millisecond))
	r.Step(origin.Add(800 * time.Millisecond))
	r.Step(origin.Add(900 * time.Millisecond))
	e := r.enemies[0]
	if math.Abs(e.x-162) > 1e-9 || e.y != 112 || e.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER {
		t.Fatal("lock direction or hop distance", e.x, e.y, e.row.State)
	}
	// A landed blow breaks a wisp's telegraph/lunge and supplies a bounded shove.
	e.row.State = wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE
	r.Cover(player(e.x-15, e.y), origin.Add(time.Second))
	r.Slash(Attack{Player: "socket-a", Swing: slash(e.x-15, e.y, 0, 1010), Damage: 1}, origin.Add(time.Second))
	if e.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER || e.knockLeft <= 0 {
		t.Fatal("hop survived the hit")
	}
}
func TestWispRetargetsNearestPlayerBetweenAttacks(t *testing.T) {
	r := testRoom(1)
	e := r.enemies[0]
	a := player(160, 112)
	b := player(180, 112)
	b.ID, b.Observer = "bob", "socket-b"
	r.Cover(a, origin)
	r.Cover(b, origin)
	if got := r.target(e); got == nil || got.ID != "alice" {
		t.Fatal("did not acquire nearest player", got)
	}
	b.X = 125
	r.Cover(b, origin.Add(time.Second))
	if got := r.target(e); got == nil || got.ID != "bob" {
		t.Fatal("closer player did not take attention", got)
	}
	a.X = 121
	r.Cover(a, origin.Add(2*time.Second))
	for _, state := range []wire.FightEnemyState{wire.FightEnemyState_FIGHT_ENEMY_STATE_TELEGRAPH, wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE} {
		e.row.State = state
		if got := r.target(e); got == nil || got.ID != "bob" {
			t.Fatal("attack changed target during its tell or hop", state, got)
		}
	}
	e.row.State = wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER
	if got := r.target(e); got == nil || got.ID != "alice" {
		t.Fatal("did not reconsider nearest player after hop", got)
	}
	a.Down = true
	r.Cover(a, origin.Add(3*time.Second))
	if got := r.target(e); got == nil || got.ID != "bob" {
		t.Fatal("down player kept attention", got)
	}
	r.Leave(b.Observer, origin.Add(4*time.Second))
	if got := r.target(e); got != nil {
		t.Fatal("departed player kept attention", got)
	}
}

func TestRoomDiffsIdleDeathWitnessAndLateJoin(t *testing.T) {
	r := testRoom(1)
	p := player(105, 112)
	r.Cover(p, origin)
	q := player(300, 300)
	q.ID = "bob"
	q.Observer = "socket-b"
	r.Cover(q, origin)
	initial := r.Join(p.Seed)
	validate(t, initial)
	r.Slash(Attack{Player: p.Observer, Swing: slash(p.X, p.Y, 9, 1000), Damage: 11}, origin)
	events := r.takeEvents()
	if len(events) != 1 || events[0].Kind != wire.FightEventKind_FIGHT_EVENT_KIND_DEATH {
		t.Fatal(events)
	}
	validate(t, events[0])
	frame := r.Step(origin.Add(100 * time.Millisecond))
	if frame.Delta == nil || len(frame.Falls) != 1 || fmt.Sprint(frame.Falls[0].Witnesses) != "[alice bob]" {
		t.Fatal(frame)
	}
	validate(t, frame.Delta)
	row := r.Join(999).Enemies[0]
	if row.Hp != 0 || row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_DEAD {
		t.Fatal("late join resurrected", row)
	}
	if r.Step(origin.Add(200*time.Millisecond)).Delta != nil {
		t.Fatal("idle room sent a delta")
	}
	// A predicted already-dead enemy gets a row; an unpredicted one does not.
	hit := r.Slash(Attack{Player: p.Observer, Swing: slash(p.X, p.Y, 10, 1002, &wire.FightTarget{Room: 1, Enemy: 0}), Damage: 10}, origin.Add(200*time.Millisecond))
	if len(hit) != 1 || hit[0].RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_ALREADY_DEAD {
		t.Fatal(hit)
	}
	if hits := r.Slash(Attack{Player: p.Observer, Swing: slash(p.X, p.Y, 11, 1002), Damage: 10}, origin.Add(200*time.Millisecond)); len(hits) != 0 {
		t.Fatal("dead enemy returned unsolicited row")
	}
}
func TestRewindOffsetCapHistoryAndWrap(t *testing.T) {
	now := origin.Add(time.Second)
	tick, offset := rules.FightTickAt(now.UnixMilli())
	cases := []struct {
		tick, offset uint32
		want         int64
	}{{tick, offset, now.UnixMilli()}, {tick - 2, 50, now.UnixMilli() - 150}, {tick - 2, 0, now.UnixMilli() - 200}, {tick - 3, 99, now.UnixMilli() - 201}, {tick - 3, 0, now.UnixMilli() - 250}, {tick - 100, 0, now.UnixMilli() - 250}, {tick + 1, 0, now.UnixMilli()}}
	for _, c := range cases {
		if got := RewindAt(now, c.tick, c.offset); got != c.want {
			t.Fatal(c, got)
		}
	}
	wrap := time.UnixMilli((int64(math.MaxUint32)+1)*100 + 50)
	if RewindAt(wrap, math.MaxUint32, 0) != wrap.UnixMilli()-150 {
		t.Fatal("rewind wrap")
	}
	for _, seen := range []uint32{1007, 0} {
		r := testRoom(1)
		r.Cover(player(100, 112), origin)
		e := r.enemies[0]
		e.x = 300
		e.history = []sample{{now.UnixMilli() - 1000, 50, 112}, {now.UnixMilli() - 250, 120, 112}, {now.UnixMilli(), 300, 112}}
		hits := r.Slash(Attack{Player: "socket-a", Swing: slash(100, 112, 0, seen, &wire.FightTarget{Room: 1, Enemy: 0}), Damage: 1}, now)
		if len(hits) != 1 || hits[0].RefusedReason != 0 {
			t.Fatal("capped rewind refused", seen, hits)
		}
	}
	e := &enemy{history: []sample{{0, 0, 0}, {100, 10, 20}}}
	x, y := e.at(50)
	if x != 5 || y != 10 {
		t.Fatal("offset interpolation", x, y)
	}
	r := testRoom(1)
	for n := 1; n <= 40; n++ {
		r.Step(origin.Add(time.Duration(n) * 100 * time.Millisecond))
	}
	h := r.enemies[0].history
	if len(h) > 12 || h[0].ms > r.lastMS-HistoryMillis {
		t.Fatal("history not bounded or missing the left sample", len(h), h[0].ms)
	}
}
func TestPositionReportsAndAttackShareMovementCap(t *testing.T) {
	r := testRoom(1)
	p := player(0, 0)
	r.Cover(p, origin)
	p.X = 1000
	r.Cover(p, origin)
	if r.players[p.Observer].X != 40 {
		t.Fatal("first cap")
	}
	p.X = 2000
	r.Cover(p, origin.Add(99*time.Millisecond))
	if r.players[p.Observer].X != 40 {
		t.Fatal("extra reports minted movement")
	}
	r.Slash(Attack{Player: p.Observer, Swing: slash(1000, 0, 0, 1000), Damage: 1}, origin.Add(99*time.Millisecond))
	if r.players[p.Observer].X != 40 {
		t.Fatal("swing minted movement")
	}
	r.Cover(p, origin.Add(100*time.Millisecond))
	if r.players[p.Observer].X != 80 {
		t.Fatal("new tick cap")
	}
	p.Down = true
	r.Cover(p, origin.Add(200*time.Millisecond))
	if r.target(r.enemies[0]) != nil {
		t.Fatal("fallen player targeted")
	}
}
func TestCircleCollisionFrozenGeometryAndLeash(t *testing.T) {
	chunk := &chunkwire.WildsChunk{Size: 24, Solid: make([]byte, 72)}
	chunk.Solid[(7*24+8)/8] |= 1 << uint((7*24+8)%8)
	eff := chunks.NewEffective(chunk, nil)
	g := GeometryAtWake(eff)
	chunk.Solid[(7*24+8)/8] = 0
	if g.CanStand(136, 120, 6) {
		t.Fatal("geometry was not frozen at wake")
	}
	x, y := g.Move(120, 120, 100, 0)
	if x > 122.01 || y != 120 {
		t.Fatal("shove tunnelled through tile", x, y)
	}
	x, _ = testGeometry().Move(370, 120, 100, 0)
	if x > 378 {
		t.Fatal("left owning chunk", x)
	}
	g.Safe = func(x, y float64) bool { return x >= 100 }
	if g.CanStand(110, 110, 6) {
		t.Fatal("safe ground did not leash")
	}
}
func TestBoltFlightMissDeathAndAcrossChunkEdge(t *testing.T) {
	for _, hit := range []bool{true, false} {
		r := testRoom(1)
		p := player(80, 112)
		r.Cover(p, origin)
		s := slash(p.X, p.Y, 3, 1000)
		s.Kind = wire.FightSwingKind_FIGHT_SWING_KIND_BOLT
		if !hit {
			s.Facing.X = -1
		}
		if !r.StartBolt(Attack{ID: 7, Player: p.Observer, Swing: s, Damage: 11}, origin) {
			t.Fatal("bolt refused")
		}
		count := 0
		for n := 1; n <= 13; n++ {
			f := r.Step(origin.Add(time.Duration(n) * 100 * time.Millisecond))
			for _, v := range f.Bolts {
				count++
				if (len(v.Hits) == 1) != hit {
					t.Fatal(hit, v)
				}
			}
		}
		if count != 1 {
			t.Fatal("bolt did not resolve once", count)
		}
	}
	r := testRoom(1)
	r.enemies[0].x, r.enemies[0].homeX = 10, 10
	p := player(-50, 112)
	r.Cover(p, origin)
	s := slash(p.X, p.Y, 0, 1000)
	s.Kind = wire.FightSwingKind_FIGHT_SWING_KIND_BOLT
	r.StartBolt(Attack{ID: 1, Player: p.Observer, Swing: s, Damage: 11}, origin)
	resolved := false
	for n := 1; n <= 4; n++ {
		if len(r.Step(origin.Add(time.Duration(n)*100*time.Millisecond)).Bolts) > 0 {
			resolved = true
		}
	}
	if !resolved || r.enemies[0].row.Hp != 0 {
		t.Fatal("bolt could not enter from adjacent chunk")
	}
}
func TestSleepFreshWakeAndTurning(t *testing.T) {
	r := testRoom(1)
	p := player(100, 112)
	r.Cover(p, origin)
	r.Slash(Attack{Player: p.Observer, Swing: slash(p.X, p.Y, 0, 1000), Damage: 1}, origin)
	r.Leave(p.Observer, origin)
	if r.ShouldClose(origin.Add(SleepAfter - time.Millisecond)) {
		t.Fatal("slept early")
	}
	r.Cover(p, origin.Add(SleepAfter-time.Millisecond))
	if r.ShouldClose(origin.Add(SleepAfter)) {
		t.Fatal("return did not cancel sleep")
	}
	r.Leave(p.Observer, origin.Add(SleepAfter))
	frame := r.Step(origin.Add(2 * SleepAfter))
	if !frame.Closed || len(frame.Events) != 1 || frame.Events[0].Kind != wire.FightEventKind_FIGHT_EVENT_KIND_ROOM_CLOSED {
		t.Fatal(frame)
	}
	fresh := NewRoom(r.Key, 2, testGeometry(), r.camps, 43, origin.Add(2*SleepAfter), 0)
	if fresh.enemies[0].row.Hp != content.EnemyRules.GetWisp().GetHp() || fresh.Handle == r.Handle {
		t.Fatal("wake did not reset live fight/handle")
	}
	r = testRoom(1)
	r.Cover(p, origin)
	r.EndsAt = origin.Add(time.Second).UnixMilli()
	if !r.Step(origin.Add(time.Second)).Closed {
		t.Fatal("turning did not close with a viewer")
	}
}
func TestLatencyRigReplaysWholeFight(t *testing.T) {
	replay := func(delay, jitter time.Duration, loss float64) []byte {
		r := testRoom(3)
		rig := NewRig(99, delay, jitter, loss)
		var trace bytes.Buffer
		for n := 0; n < 60; n++ {
			at := origin.Add(time.Duration(n) * 100 * time.Millisecond)
			p := player(105, 112)
			rig.Send(at, func(r *Room, delivered time.Time) { r.Cover(p, delivered) })
			if n%6 == 0 {
				tick, _ := rules.FightTickAt(at.UnixMilli())
				a := Attack{Player: p.Observer, Swing: slash(p.X, p.Y, uint32(n), tick), Crit: rules.FightCrit(p.Seed, uint32(n), p.Kit.CritChance), Damage: 1}
				rig.Send(at, func(r *Room, delivered time.Time) {
					hits := r.Slash(a, delivered)
					b, _ := json.Marshal(hits)
					trace.Write(b)
				})
			}
			f := rig.Advance(r, at)
			if f.Delta != nil {
				b, _ := proto.Marshal(f.Delta)
				trace.Write(b)
			}
			for _, e := range f.Events {
				b, _ := proto.Marshal(e)
				trace.Write(b)
			}
		}
		return trace.Bytes()
	}
	for _, setting := range []struct {
		delay, jitter time.Duration
		loss          float64
	}{{0, 0, 0}, {150 * time.Millisecond, 50 * time.Millisecond, 0}, {300 * time.Millisecond, 100 * time.Millisecond, .1}} {
		a, b := replay(setting.delay, setting.jitter, setting.loss), replay(setting.delay, setting.jitter, setting.loss)
		if len(a) == 0 || !bytes.Equal(a, b) {
			t.Fatal("non-deterministic replay", setting)
		}
	}
	rig := NewRig(1, 0, 0, 1)
	if rig.Send(origin, func(*Room, time.Time) { t.Fatal("lost input delivered") }) {
		t.Fatal("100% loss accepted input")
	}
	rig.Advance(testRoom(1), origin.Add(time.Second))
}
func TestActorInjectedClockJoinAndShutdownResolvesBolt(t *testing.T) {
	var ms atomic.Int64
	ms.Store(origin.UnixMilli())
	ticks := make(chan time.Time)
	out := make(chan Output, 20)
	a := Start(testRoom(1), ActorConfig{Now: func() time.Time { return time.UnixMilli(ms.Load()) }, Ticks: ticks, Emit: func(o Output) { out <- o }})
	p := player(80, 112)
	if !a.Submit(Command{Player: &p}) {
		t.Fatal("cover not queued")
	}
	select {
	case o := <-out:
		validate(t, o.Message)
		if o.Observer != p.Observer {
			t.Fatal(o)
		}
	case <-time.After(time.Second):
		t.Fatal("no join")
	}
	s := slash(p.X, p.Y, 0, 1000)
	s.Kind = wire.FightSwingKind_FIGHT_SWING_KIND_BOLT
	reply := make(chan []*wire.FightHitRow, 1)
	if !a.Submit(Command{Attack: &Attack{ID: 7, Player: p.Observer, Swing: s, Damage: 1}, Result: reply}) {
		t.Fatal("bolt not queued")
	}
	// FIFO barrier: a forced join is processed after the bolt.
	a.Submit(Command{Player: &p, Join: true})
	<-out
	a.Stop()
	select {
	case <-a.Done():
	case <-time.After(time.Second):
		t.Fatal("actor did not stop")
	}
	select {
	case <-reply:
	default:
		t.Fatal("shutdown stranded a pending bolt")
	}
	if a.Submit(Command{Player: &p}) {
		t.Fatal("closed actor took input")
	}
}
func BenchmarkRoomTick(b *testing.B) {
	r := NewRoom(Key{World: "world", Realm: "hearthwick", Epoch: "epoch"}, 1, testGeometry(), []Camp{{ID: "camp-a", X: 100, Y: 112, Count: 3}, {ID: "camp-b", X: 180, Y: 112, Count: 2}}, 1, origin, 0)
	for i := range 3 {
		p := player(float64(130+i*8), 112)
		p.ID = fmt.Sprint(i)
		p.Observer = p.ID
		r.Cover(p, origin)
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		r.Step(origin.Add(time.Duration(n+1) * 100 * time.Millisecond))
	}
}

// A cast between grid ticks still traverses the last fraction of its life.
func TestBoltSweepsFinalPartialTick(t *testing.T) {
	r := testRoom(1)
	r.enemies[0].x, r.enemies[0].homeX = 330, 330
	p := player(20, 112)
	r.Cover(p, origin)
	s := slash(p.X, p.Y, 0, 1000)
	s.Kind = wire.FightSwingKind_FIGHT_SWING_KIND_BOLT
	r.StartBolt(Attack{ID: 1, Player: p.Observer, Swing: s, Damage: 11}, origin.Add(42*time.Millisecond))
	count := 0
	for n := 1; n <= 13; n++ {
		f := r.Step(origin.Add(time.Duration(n) * 100 * time.Millisecond))
		for _, result := range f.Bolts {
			count++
			if len(result.Hits) != 1 {
				t.Fatal("lost final segment", result)
			}
		}
	}
	if count != 1 || r.enemies[0].row.Hp != 0 {
		t.Fatal("bolt did not land once at end", count)
	}
}
