package fights

import (
	wire "glimway/server/internal/gen/glimway/v2"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A scheduler steps every room on shared workers and hands each pass's
// outputs over in one Emit. These guard what the hub relies on: per-room
// command order and output order, a join before its deltas, Closed after
// the room's last outputs, a bolt settling across rooms on one worker
// without a deadlock, and one room's stop never stalling another.

type schedRig struct {
	t       *testing.T
	ms      atomic.Int64
	ticks   chan time.Time
	s       *Scheduler
	mu      sync.Mutex
	batches [][]Emitted
	closed  []uint32
}

func newSchedRig(t *testing.T, workers int) *schedRig {
	r := &schedRig{t: t, ticks: make(chan time.Time)}
	r.ms.Store(origin.UnixMilli())
	r.s = NewScheduler(SchedulerConfig{Workers: workers, Now: r.now, Ticks: r.ticks, Emit: func(batch []Emitted) {
		r.mu.Lock()
		r.batches = append(r.batches, append([]Emitted(nil), batch...))
		r.mu.Unlock()
	}})
	t.Cleanup(r.s.Stop)
	return r
}
func (r *schedRig) now() time.Time { return time.UnixMilli(r.ms.Load()) }
func (r *schedRig) room(handle uint32) *Room {
	return NewRoom(Key{World: "world", Realm: "hearthwick", Epoch: "epoch", CX: int32(handle)}, handle, testGeometry(), []Camp{{ID: "camp", X: 120, Y: 112, Kinds: wisps(1)}}, 42, origin, 0)
}
func (r *schedRig) start(room *Room) *Actor {
	return r.s.Start(room, ActorConfig{Tag: room.Handle, Closed: func() {
		r.mu.Lock()
		r.closed = append(r.closed, room.Handle)
		r.mu.Unlock()
	}})
}

// tick advances the clock one grid step and delivers a tick.
func (r *schedRig) tick() {
	r.ms.Add(100)
	r.ticks <- r.now()
}

// outputs of one room, in order, across every batch so far (waiting until
// at least n have arrived).
func (r *schedRig) outputs(handle uint32, n int) []Output {
	deadline := time.Now().Add(2 * time.Second)
	for {
		r.mu.Lock()
		var out []Output
		for _, batch := range r.batches {
			for _, e := range batch {
				if e.Tag.(uint32) == handle {
					out = append(out, e.Output)
				}
			}
		}
		r.mu.Unlock()
		if len(out) >= n || time.Now().After(deadline) {
			return out
		}
		time.Sleep(time.Millisecond)
	}
}
func (r *schedRig) batchCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.batches)
}
func outputKinds(out []Output) []string {
	var names []string
	for _, o := range out {
		switch m := o.Message.(type) {
		case *wire.FightJoin:
			names = append(names, "join")
		case *wire.FightDelta:
			names = append(names, "delta")
		case *wire.FightEvent:
			names = append(names, "event:"+m.Kind.String())
		default:
			names = append(names, "other")
		}
	}
	return names
}
func awaitDone(t *testing.T, a *Actor) {
	t.Helper()
	select {
	case <-a.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("room did not exit")
	}
}

// Two rooms on one worker: each room's commands apply in submit order,
// output stays in order across flushes, and one tick's outputs are handed
// over in one Emit, rooms in order, with each room's join before its delta.
func TestSchedulerKeepsOrderAndFlushesOncePerTick(t *testing.T) {
	r := newSchedRig(t, 1)
	a, b := r.start(r.room(1)), r.start(r.room(2))
	pa, pb := player(105, 112), player(105, 112)
	pb.Observer = "socket-b"
	if !a.Submit(Command{Player: &pa}) || !b.Submit(Command{Player: &pb}) {
		t.Fatal("covers refused")
	}
	if got := outputKinds(r.outputs(1, 1)); len(got) != 1 || got[0] != "join" {
		t.Fatal("room 1 join", got)
	}
	if got := outputKinds(r.outputs(2, 1)); len(got) != 1 || got[0] != "join" {
		t.Fatal("room 2 join", got)
	}
	reply := make(chan []*wire.FightHitRow, 1)
	if !a.Submit(Command{Attack: &Attack{ID: 1, Player: pa.Observer, Swing: slash(pa.X, pa.Y, 0, 1000, &wire.FightTarget{Room: 1, Enemy: 0}), Damage: 11}, Result: reply}) {
		t.Fatal("slash refused")
	}
	rows := <-reply
	if len(rows) != 1 || rows[0].RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_UNSPECIFIED {
		t.Fatal("the slash", rows)
	}
	out := r.outputs(1, 2)
	if got := outputKinds(out); len(got) != 2 || got[0] != "join" || got[1] != "event:FIGHT_EVENT_KIND_DEATH" {
		t.Fatal("room 1 output order", got)
	}
	before := r.batchCount()
	r.tick()
	// Both rooms' players stand in aggro range: each moves an enemy, so
	// each room has a delta, and the tick's pass is one Emit.
	da, db := r.outputs(1, len(out)+1), r.outputs(2, 2)
	if outputKinds(da)[len(da)-1] != "delta" || outputKinds(db)[len(db)-1] != "delta" {
		t.Fatal("deltas", outputKinds(da), outputKinds(db))
	}
	if n := r.batchCount(); n != before+1 {
		t.Fatalf("a tick's outputs come in one Emit: %d batches for one tick", n-before)
	}
	r.mu.Lock()
	last := r.batches[len(r.batches)-1]
	r.mu.Unlock()
	if len(last) != 2 || last[0].Tag.(uint32) != 1 || last[1].Tag.(uint32) != 2 {
		t.Fatal("one batch, rooms in order", last)
	}
}

// A bolt sent to two rooms on one worker: the flight decides inside one
// room's step and wakes the other by Submit (re-entrant, same worker); both
// answer, exactly one lands, and nothing deadlocks.
func TestSchedulerSettlesBoltAcrossRoomsOnOneWorker(t *testing.T) {
	r := newSchedRig(t, 1)
	near, far := r.room(1), r.room(2)
	// Room 2's enemy stands far down the flight; room 1's at the camp.
	far.enemies[0].x, far.enemies[0].homeX = 330, 330
	a, b := r.start(near), r.start(far)
	p := player(20, 112)
	if !a.Submit(Command{Player: &p}) || !b.Submit(Command{Player: &p}) {
		t.Fatal("covers refused")
	}
	r.outputs(1, 1)
	r.outputs(2, 1)
	s := slash(p.X, p.Y, 0, 1000)
	s.Kind = wire.FightSwingKind_FIGHT_SWING_KIND_BOLT
	flight := NewFlight(r.now().UnixMilli(), 96)
	flight.Join(1, func() { a.Submit(Command{Settle: true}) })
	flight.Join(2, func() { b.Submit(Command{Settle: true}) })
	ra, rb := make(chan []*wire.FightHitRow, 1), make(chan []*wire.FightHitRow, 1)
	if !a.Submit(Command{Attack: &Attack{ID: 1, Player: p.Observer, Swing: s, Damage: 1, Flight: flight}, Result: ra}) {
		t.Fatal("bolt refused by room 1")
	}
	if !b.Submit(Command{Attack: &Attack{ID: 1, Player: p.Observer, Swing: s, Damage: 1, Flight: flight}, Result: rb}) {
		t.Fatal("bolt refused by room 2")
	}
	flight.Seal()
	var hitsA, hitsB []*wire.FightHitRow
	gotA, gotB := false, false
	for n := 0; n < 14 && !(gotA && gotB); n++ {
		r.tick()
		select {
		case hitsA = <-ra:
			gotA = true
		case <-time.After(50 * time.Millisecond):
		}
		select {
		case hitsB = <-rb:
			gotB = true
		case <-time.After(50 * time.Millisecond):
		}
	}
	if !gotA || !gotB {
		t.Fatal("both rooms answer the bolt", gotA, gotB)
	}
	if len(hitsA)+len(hitsB) != 1 || len(hitsA) != 1 {
		t.Fatal("exactly one room lands it, the nearer", hitsA, hitsB)
	}
}

// Closed runs after the room's last outputs reached Emit: a stopped room
// says ROOM_CLOSED first; so does one whose epoch ends on a tick. One
// room's stop never stalls the other room on its worker.
func TestSchedulerClosedAfterLastOutputsAndNeverStallsNeighbours(t *testing.T) {
	r := newSchedRig(t, 1)
	a, b := r.start(r.room(1)), r.start(r.room(2))
	pa, pb := player(100, 112), player(100, 112)
	pb.Observer = "socket-b"
	a.Submit(Command{Player: &pa})
	b.Submit(Command{Player: &pb})
	r.outputs(1, 1)
	r.outputs(2, 1)
	a.Stop()
	awaitDone(t, a)
	out := outputKinds(r.outputs(1, 2))
	if out[len(out)-1] != "event:FIGHT_EVENT_KIND_ROOM_CLOSED" {
		t.Fatal("ROOM_CLOSED is the last output", out)
	}
	r.mu.Lock()
	closedFirst := len(r.closed) == 1 && r.closed[0] == 1
	// The closing event was flushed in a batch before Closed ran: it is in
	// the batches already recorded when Closed appended.
	r.mu.Unlock()
	if !closedFirst {
		t.Fatal("Closed once, for room 1", r.closed)
	}
	// Room 2 keeps answering at once.
	reply := make(chan []*wire.FightHitRow, 1)
	if !b.Submit(Command{Attack: &Attack{ID: 2, Player: pb.Observer, Swing: slash(pb.X, pb.Y, 0, 1000, &wire.FightTarget{Room: 2, Enemy: 0}), Damage: 1}, Result: reply}) {
		t.Fatal("room 2 refused")
	}
	select {
	case rows := <-reply:
		if len(rows) != 1 {
			t.Fatal("room 2 slash", rows)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("room 2 stalled behind room 1's stop")
	}
	// An epoch ending on a tick closes room 2 the same way.
	r.mu.Lock()
	before := len(r.batches)
	r.mu.Unlock()
	rb := r.room(3)
	rb.EndsAt = r.now().Add(50 * time.Millisecond).UnixMilli()
	c := r.start(rb)
	pc := player(100, 112)
	c.Submit(Command{Player: &pc})
	r.outputs(3, 1)
	r.tick()
	awaitDone(t, c)
	out = outputKinds(r.outputs(3, 2))
	if out[len(out)-1] != "event:FIGHT_EVENT_KIND_ROOM_CLOSED" {
		t.Fatal("epoch end: ROOM_CLOSED is the last output", out)
	}
	r.mu.Lock()
	closedAll := len(r.closed) == 2 && r.closed[1] == 3 && len(r.batches) > before
	r.mu.Unlock()
	if !closedAll {
		t.Fatal("Closed after the epoch's last outputs", r.closed)
	}
	if a.Submit(Command{Player: &pa}) || c.Submit(Command{Player: &pc}) {
		t.Fatal("closed rooms take no input")
	}
}

// A stopped room on a shared worker answers what it had queued and keeps no
// bolt pending (the private-actor exit tests, on a shared worker).
func TestSchedulerExitAnswersQueuedOnSharedWorker(t *testing.T) {
	r := newSchedRig(t, 2)
	a := r.start(r.room(1))
	p := player(100, 112)
	a.Submit(Command{Player: &p})
	r.outputs(1, 1)
	s := slash(p.X, p.Y, 0, 1000)
	s.Kind = wire.FightSwingKind_FIGHT_SWING_KIND_BOLT
	reply := make(chan []*wire.FightHitRow, 1)
	if !a.Submit(Command{Attack: &Attack{ID: 7, Player: p.Observer, Swing: s, Damage: 1}, Result: reply}) {
		t.Fatal("bolt refused")
	}
	a.Submit(Command{Player: &p, Join: true})
	r.outputs(1, 2)
	a.Stop()
	awaitDone(t, a)
	select {
	case <-reply:
	default:
		t.Fatal("exit stranded a pending bolt")
	}
}

// Ticks a busy worker could not take do not pile up: the clock drops what
// the worker's one-deep tick buffer cannot hold, and a late worker steps
// once for them (Room.Step is idempotent within a grid tick).
func TestSchedulerCoalescesTicksForABusyWorker(t *testing.T) {
	var ms atomic.Int64
	ms.Store(origin.UnixMilli())
	ticks := make(chan time.Time)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var steps atomic.Int32
	s := NewScheduler(SchedulerConfig{Workers: 1, Now: func() time.Time { return time.UnixMilli(ms.Load()) }, Ticks: ticks, Emit: func(batch []Emitted) {
		for _, e := range batch {
			if _, ok := e.Message.(*wire.FightJoin); ok {
				once.Do(func() { close(entered); <-release })
			}
		}
	}, Ticked: func(ds []time.Duration) { steps.Add(int32(len(ds))) }})
	t.Cleanup(s.Stop)
	a := s.Start(testRoom(1), ActorConfig{})
	p := player(100, 112)
	a.Submit(Command{Player: &p})
	<-entered
	// The worker is stuck in the join's flush: five grid ticks go by.
	for range 5 {
		ms.Add(100)
		ticks <- time.UnixMilli(ms.Load())
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for steps.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	if n := steps.Load(); n == 0 || n > 2 {
		t.Fatalf("a late worker steps once or twice for five ticks, not %d", n)
	}
	before := steps.Load()
	ms.Add(100)
	ticks <- time.UnixMilli(ms.Load())
	deadline = time.Now().Add(time.Second)
	for steps.Load() == before && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if steps.Load() != before+1 {
		t.Fatal("the next tick steps once more")
	}
}

// After Stop a scheduler starts nothing: the actor is closed from the
// start, Done is closed, Closed never runs.
func TestSchedulerStartAfterStop(t *testing.T) {
	s := NewScheduler(SchedulerConfig{Workers: 1, Ticks: make(chan time.Time)})
	s.Stop()
	closed := false
	a := s.Start(testRoom(1), ActorConfig{Closed: func() { closed = true }})
	p := player(100, 112)
	if a.Submit(Command{Player: &p}) || a.Leave("x") || closed {
		t.Fatal("a stopped scheduler's actor is closed")
	}
	awaitDone(t, a)
	// Stop again is harmless; Stop with rooms still open closes them.
	s.Stop()
	s2 := NewScheduler(SchedulerConfig{Workers: PerRoomWorkers, Ticks: make(chan time.Time)})
	b := s2.Start(testRoom(1), ActorConfig{})
	c := s2.Start(testRoom(1), ActorConfig{})
	s2.Stop()
	awaitDone(t, b)
	awaitDone(t, c)
}
