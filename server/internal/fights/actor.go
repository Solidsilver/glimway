package fights

import (
	wire "glimway/server/internal/gen/glimway/v2"
	"google.golang.org/protobuf/proto"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// Output is immutable after delivery. Empty Observer broadcasts to the room's
// current viewers; other outputs address a particular socket lifetime.
type Output struct {
	Observer string
	Message  proto.Message
}
type Command struct {
	Player *Player
	Leave  string
	Join   bool
	Attack *Attack
	Cast   *Cast
	Result chan<- []*wire.FightHitRow
	// Clear is a dev fixture's camp id (Room.Clear); Cleared gets its answer.
	Clear   string
	Cleared chan<- Cleared
	// Settle: a bolt's flight decided; answer the copies it settled.
	Settle     bool
	membership *actorMembership
}

// flight is the bolt flight a command carries, if any.
func (c Command) flight() *Flight {
	if c.Attack != nil {
		return c.Attack.Flight
	}
	if c.Cast != nil {
		return c.Cast.Flight
	}
	return nil
}

// An Actor is one room's mailbox and its place on a scheduler's worker. The
// worker applies its commands in order as they arrive (a submit wakes it)
// and steps it on the shared 100 ms grid; the room itself runs on no
// goroutine of its own. Submit never waits, Leave is coalesced, Stop
// closes admission and the worker exits the room, Done closes after its
// Closed callback. Emit, Fall, Closed and TickDuration run on the worker,
// so they must never block: a worker that waits stalls every room it owns.
type Actor struct {
	r     *Room
	c     ActorConfig
	w     *worker
	input chan Command
	done  chan struct{}
	mu    sync.Mutex
	// closed: admission is over (Stop, or the room exited). stopping: Stop
	// asked and the worker has yet to exit the room.
	closed, stopping bool
	members          map[string]*actorMembership
	leaves           map[string]bool
	// queued (under the worker's mutex): on its dirty list.
	queued bool
	// Worker-owned, never touched elsewhere.
	pending map[uint64]chan<- []*wire.FightHitRow
	active  map[string]*actorMembership
	exited  bool
}
type actorMembership struct{ withdrawn bool }

type ActorConfig struct {
	Now func() time.Time
	// Tests can inject grid ticks and a clock without sleeping (Start only;
	// a shared scheduler has one clock for all its rooms).
	Ticks <-chan time.Time
	// Emit takes one output at once. A scheduler with its own Emit batches
	// instead and never calls this.
	Emit   func(Output)
	Closed func()
	Fall   func(Fall)
	// TickDuration takes one step's duration. A scheduler with Ticked
	// batches instead and never calls this.
	TickDuration func(time.Duration)
	// Tag names the room to a scheduler's batched Emit (the hub's room).
	Tag any
}

// Start runs one room on a private scheduler: its own worker, its own
// clock (or the injected Ticks). The single-room model, for tests and
// fixtures; the hub runs its rooms on one shared Scheduler.
func Start(r *Room, c ActorConfig) *Actor {
	s := newScheduler(SchedulerConfig{Workers: PerRoomWorkers, Now: c.Now, Ticks: c.Ticks}, true)
	return s.Start(r, c)
}

// Submit never waits for queue space. Exit closes admission under the same
// mutex, then answers every previously admitted command before closing Done.
func (a *Actor) Submit(c Command) bool {
	if c.Leave != "" {
		return a.Leave(c.Leave)
	}
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return false
	}
	createdMember := false
	if c.Player != nil {
		member := a.members[c.Player.Observer]
		if member == nil {
			member = &actorMembership{}
			a.members[c.Player.Observer] = member
			createdMember = true
		}
		c.membership = member
	} else if c.Attack != nil {
		c.membership = a.members[c.Attack.Player]
	} else if c.Cast != nil {
		c.membership = a.members[c.Cast.Player]
	}
	admitted := false
	select {
	case a.input <- c:
		admitted = true
	default:
		if createdMember {
			delete(a.members, c.Player.Observer)
		}
	}
	a.mu.Unlock()
	if admitted {
		a.w.mark(a)
	}
	return admitted
}

// Leave uses a coalesced control channel, so a saturated combat queue cannot
// retain a departed player or destroy the room. Withdrawn membership pointers
// invalidate older queued covers; a later cover has a fresh membership.
func (a *Actor) Leave(observer string) bool {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return false
	}
	if member := a.members[observer]; member != nil {
		member.withdrawn = true
		delete(a.members, observer)
	}
	a.leaves[observer] = true
	a.mu.Unlock()
	a.w.mark(a)
	return true
}

// Stop closes admission; the worker exits the room on its next pass and
// Done closes after Closed.
func (a *Actor) Stop() {
	a.mu.Lock()
	stop := !a.closed
	if stop {
		a.closed, a.stopping = true, true
	}
	a.mu.Unlock()
	if stop {
		a.w.mark(a)
	}
}
func (a *Actor) Done() <-chan struct{} { return a.done }

// applyLeaves runs on the worker, before every command and every step.
func (a *Actor) applyLeaves() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.leaves) == 0 {
		return
	}
	for observer := range a.leaves {
		if member := a.active[observer]; member == nil || member.withdrawn {
			a.r.Leave(observer, a.c.Now())
			delete(a.active, observer)
		}
	}
	a.leaves = map[string]bool{}
}
func answer(ch chan<- []*wire.FightHitRow, rows []*wire.FightHitRow) {
	if ch != nil {
		select {
		case ch <- rows:
		default:
		}
	}
}

// drop answers a command this room will not judge; a bolt's copy leaves
// its flight, so the other rooms never wait on it.
func (a *Actor) drop(cmd Command) {
	answer(cmd.Result, nil)
	if f := cmd.flight(); f != nil {
		f.Withdraw(a.r.Handle)
	}
}
func (a *Actor) settled(results []BoltResult) {
	// A settled bolt can be the blow that drops a camp. Hand it to the
	// durable writer before the attack result tells the client it landed.
	a.falls(a.r.takeFalls())
	for _, result := range results {
		answer(a.pending[result.ID], result.Hits)
		delete(a.pending, result.ID)
	}
}
func (a *Actor) falls(falls []Fall) {
	for _, fall := range falls {
		if a.c.Fall != nil {
			a.c.Fall(fall)
		}
	}
}

// closeRoom ends a room from a command or a stop: the closing event, then
// the exit.
func (a *Actor) closeRoom(w *worker, now time.Time) {
	a.r.event(nil, wire.FightEventKind_FIGHT_EVENT_KIND_ROOM_CLOSED, now.UnixMilli())
	w.events(a)
	a.exit(w)
}

// exit is the room's end, on the worker: admission closes, what was queued
// is answered as not judged, bolts and pending results are abandoned, the
// falls it still holds go to the writer, its last outputs are flushed,
// then Closed and Done. Nothing here waits.
func (a *Actor) exit(w *worker) {
	a.mu.Lock()
	a.closed = true
	queued := []Command{}
drain:
	for {
		select {
		case cmd := <-a.input:
			queued = append(queued, cmd)
		default:
			break drain
		}
	}
	a.mu.Unlock()
	for _, cmd := range queued {
		a.drop(cmd)
	}
	a.r.AbandonBolts()
	for _, ch := range a.pending {
		answer(ch, nil)
	}
	a.pending = map[uint64]chan<- []*wire.FightHitRow{}
	// A blow between ticks puts a camp down at once; its fall leaves with
	// the next frame. A room that closes first (stop, its epoch's end, or
	// sleep) still hands it over, so no fall is lost with the room.
	a.falls(a.r.takeFalls())
	a.exited = true
	w.flush()
	if a.c.Closed != nil {
		a.c.Closed()
	}
	w.remove(a)
	close(a.done)
}

// apply runs one admitted command on the worker. No actor or worker lock is
// held while the room judges it or a callback runs, so a callback (a bolt
// flight deciding, a Settle for another room on this worker) may Submit.
func (a *Actor) apply(w *worker, cmd Command) {
	a.applyLeaves()
	r := a.r
	now := a.c.Now()
	if r.EndsAt > 0 && now.UnixMilli() >= r.EndsAt {
		a.drop(cmd)
		a.closeRoom(w, now)
		return
	}
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		a.drop(cmd)
		a.closeRoom(w, now)
		return
	}
	if cmd.membership != nil && cmd.membership.withdrawn {
		a.mu.Unlock()
		a.drop(cmd)
		return
	}
	fresh := false
	if cmd.Player != nil {
		fresh = r.Cover(*cmd.Player, now)
		a.active[cmd.Player.Observer] = cmd.membership
	}
	a.mu.Unlock()
	if cmd.Player != nil {
		if fresh || cmd.Join {
			w.emit(a, cmd.Player.Observer, r.Join(cmd.Player.Seed))
		}
	}
	if cmd.Attack != nil {
		if cmd.Attack.Swing.Kind == wire.FightSwingKind_FIGHT_SWING_KIND_BOLT {
			if r.StartBolt(*cmd.Attack, now) {
				a.pending[cmd.Attack.ID] = cmd.Result
			} else {
				a.drop(cmd)
			}
		} else {
			rows := r.Slash(*cmd.Attack, now)
			a.falls(r.takeFalls())
			answer(cmd.Result, rows)
		}
		w.events(a)
	}
	if cmd.Cast != nil {
		rows, later := r.Cast(*cmd.Cast, now)
		if later {
			a.pending[cmd.Cast.ID] = cmd.Result
		} else {
			a.falls(r.takeFalls())
			answer(cmd.Result, rows)
			if cmd.Cast.Flight != nil {
				cmd.Cast.Flight.Withdraw(r.Handle)
			}
		}
		w.events(a)
	}
	if cmd.Settle {
		a.settled(r.SettleBolts(now))
		w.events(a)
	}
	if cmd.Clear != "" {
		cleared := r.Clear(cmd.Clear, now)
		w.events(a)
		// The fall goes to the writer now, not at the next tick.
		a.falls(r.takeFalls())
		if cmd.Cleared != nil {
			select {
			case cmd.Cleared <- cleared:
			default:
			}
		}
	}
}

// step runs one grid tick on the worker.
func (a *Actor) step(w *worker) {
	a.applyLeaves()
	began := time.Now()
	now := a.c.Now()
	grid := time.UnixMilli(now.UnixMilli() / 100 * 100)
	frame := a.r.Step(grid)
	w.ticked(a, time.Since(began))
	// Step can both complete a camp and produce its completion event. Queue
	// durable fall writes before exposing either the event or settled hits.
	a.falls(frame.Falls)
	a.settled(frame.Bolts)
	for _, e := range frame.Events {
		w.emit(a, "", e)
	}
	if frame.Delta != nil {
		w.emit(a, "", frame.Delta)
	}
	if frame.Closed {
		a.exit(w)
	}
}

// Emitted is one room's output as a scheduler's batched Emit gets it: Tag
// is the room's ActorConfig.Tag.
type Emitted struct {
	Tag any
	Output
}

// PerRoomWorkers gives every room its own worker goroutine (the one-room
// model with a shared clock), for Start and for measurement.
const PerRoomWorkers = -1

type SchedulerConfig struct {
	// Workers steps the rooms: 0 means one per GOMAXPROCS, PerRoomWorkers
	// one per room.
	Workers int
	Now     func() time.Time
	// Ticks: injected grid ticks (tests); nil runs one timer on Now's 100 ms
	// grid for every worker.
	Ticks <-chan time.Time
	// Emit takes every output a worker produced in one pass (a drain of
	// commands, or a tick), rooms in the order stepped, each room's outputs
	// in order. The slice is the worker's buffer: not kept. Nil: each room's
	// own ActorConfig.Emit, one output at a time.
	Emit func([]Emitted)
	// Ticked takes one worker's step durations for one tick. Nil: each
	// room's own ActorConfig.TickDuration.
	Ticked func([]time.Duration)
}

// A Scheduler runs rooms on a fixed set of worker goroutines sharing one
// clock. Each tick a worker steps the rooms it owns in a loop and hands
// their outputs over in one Emit; a Submit wakes the owning worker, which
// applies the room's queued commands at once (commands never wait for the
// tick) and flushes. Per room, commands stay in submit order and outputs
// in the order the room produced them.
type Scheduler struct {
	c       SchedulerConfig
	single  bool // Start's: one room, the worker's exit ends the clock
	mu      sync.Mutex
	workers []*worker
	stopped bool
	stop    chan struct{}
	halt    sync.Once
	wg      sync.WaitGroup
	// beforeAdopt is a deterministic lifecycle-race test seam. It runs after
	// worker selection and before publication of the actor.
	beforeAdopt func()
}

func NewScheduler(c SchedulerConfig) *Scheduler { return newScheduler(c, false) }

func newScheduler(c SchedulerConfig, single bool) *Scheduler {
	if c.Now == nil {
		c.Now = time.Now
	}
	s := &Scheduler{c: c, single: single, stop: make(chan struct{})}
	n := c.Workers
	if n == 0 {
		n = runtime.GOMAXPROCS(0)
	}
	for i := 0; i < n; i++ {
		s.addWorker(false)
	}
	// Start's one room selects on its injected ticks directly, so a test's
	// send returns once the worker took the tick, as it did from an actor.
	if !(single && c.Ticks != nil) {
		s.wg.Add(1)
		go s.clock()
	}
	return s
}

// Stop ends the clock and the workers; rooms still owned are closed. The
// hub stops every room and waits for it first.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	s.stopped = true
	s.mu.Unlock()
	s.halt.Do(func() { close(s.stop) })
	s.wg.Wait()
}

// Start gives r to the least loaded worker (or its own, PerRoomWorkers).
// After Stop the actor is already closed: Submit refuses, Done is closed,
// Closed is never called.
func (s *Scheduler) Start(r *Room, c ActorConfig) *Actor {
	if c.Now == nil {
		c.Now = s.c.Now
	}
	a := &Actor{r: r, c: c, input: make(chan Command, 128), done: make(chan struct{}), members: map[string]*actorMembership{}, leaves: map[string]bool{}, pending: map[uint64]chan<- []*wire.FightHitRow{}, active: map[string]*actorMembership{}}
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		a.closed, a.exited = true, true
		close(a.done)
		return a
	}
	var w *worker
	if s.c.Workers == PerRoomWorkers {
		w = s.addWorker(true)
	} else {
		for _, candidate := range s.workers {
			if w == nil || candidate.load.Load() < w.load.Load() {
				w = candidate
			}
		}
	}
	w.load.Add(1)
	a.w = w
	if s.beforeAdopt != nil {
		s.beforeAdopt()
	}
	w.adopt(a)
	s.mu.Unlock()
	return a
}

// addWorker runs a new worker; callers of the per-room kind hold s.mu.
func (s *Scheduler) addWorker(perRoom bool) *worker {
	w := &worker{s: s, ticks: make(chan time.Time, 1), wake: make(chan struct{}, 1), perRoom: perRoom}
	w.in = w.ticks
	if s.single && s.c.Ticks != nil {
		w.in = s.c.Ticks
	}
	if !perRoom {
		s.mu.Lock()
	}
	s.workers = append(s.workers, w)
	if !perRoom {
		s.mu.Unlock()
	}
	s.wg.Add(1)
	go w.run()
	return w
}

// retireIfEmpty uses the same lifecycle lock order as Start (scheduler,
// then worker). A selected worker with an adoption in progress cannot retire:
// Start holds s.mu through load reservation and room publication, and the
// load check protects any reserved adoption if that sequence changes later.
func (s *Scheduler) retireIfEmpty(w *worker) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.rooms) != 0 || w.load.Load() != 0 {
		return false
	}
	for i, candidate := range s.workers {
		if candidate == w {
			s.workers = append(s.workers[:i], s.workers[i+1:]...)
			break
		}
	}
	return true
}
func untilGrid(now time.Time) time.Duration {
	return time.Duration(100-now.UnixMilli()%100) * time.Millisecond
}

// clock is the one tick source: the injected ticks, or a timer reset to
// the next grid boundary. A tick goes to every worker without waiting; a
// worker still busy with the last one steps once for both (Room.Step is
// idempotent within a tick), as a late actor did.
func (s *Scheduler) clock() {
	defer s.wg.Done()
	ticks := s.c.Ticks
	var timer *time.Timer
	if ticks == nil {
		timer = time.NewTimer(untilGrid(s.c.Now()))
		defer timer.Stop()
		ticks = timer.C
	}
	for {
		select {
		case <-s.stop:
			return
		case t, ok := <-ticks:
			if !ok {
				return
			}
			s.mu.Lock()
			workers := append([]*worker(nil), s.workers...)
			s.mu.Unlock()
			for _, w := range workers {
				select {
				case w.ticks <- t:
				default:
				}
			}
			if timer != nil {
				timer.Reset(untilGrid(s.c.Now()))
			}
		}
	}
}

// A worker owns rooms. Its goroutine alone touches them (and their
// worker-owned actor state); the dirty list is the one thing a submitter
// shares with it.
type worker struct {
	s       *Scheduler
	ticks   chan time.Time
	in      <-chan time.Time
	wake    chan struct{}
	perRoom bool
	load    atomic.Int32
	mu      sync.Mutex
	dirty   []*Actor
	// rooms is replaced, never edited in place, under mu (adopt, remove),
	// so a tick walks a snapshot without holding it.
	rooms     []*Actor
	out       []Emitted
	durations []time.Duration
}

// mark puts a on the dirty list and wakes the worker. From anywhere,
// including the worker itself mid-pass (a flight settling a neighbour, a
// room's own callback): the room is simply serviced again next pass.
func (w *worker) mark(a *Actor) {
	w.mu.Lock()
	if !a.queued {
		a.queued = true
		w.dirty = append(w.dirty, a)
	}
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}
func (w *worker) adopt(a *Actor) {
	w.mu.Lock()
	w.rooms = append(append([]*Actor(nil), w.rooms...), a)
	w.mu.Unlock()
	w.mark(a)
}
func (w *worker) remove(a *Actor) {
	w.mu.Lock()
	rooms := make([]*Actor, 0, len(w.rooms))
	for _, r := range w.rooms {
		if r != a {
			rooms = append(rooms, r)
		}
	}
	w.rooms = rooms
	w.mu.Unlock()
	w.load.Add(-1)
}
func (w *worker) take() []*Actor {
	w.mu.Lock()
	dirty := w.dirty
	w.dirty = nil
	for _, a := range dirty {
		a.queued = false
	}
	w.mu.Unlock()
	return dirty
}
func (w *worker) snapshot() []*Actor {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.rooms
}
func (w *worker) emit(a *Actor, observer string, m proto.Message) {
	if w.s.c.Emit != nil {
		w.out = append(w.out, Emitted{Tag: a.c.Tag, Output: Output{Observer: observer, Message: m}})
		return
	}
	if a.c.Emit != nil {
		a.c.Emit(Output{Observer: observer, Message: m})
	}
}
func (w *worker) events(a *Actor) {
	for _, e := range a.r.takeEvents() {
		w.emit(a, "", e)
	}
}
func (w *worker) ticked(a *Actor, d time.Duration) {
	if w.s.c.Ticked != nil {
		w.durations = append(w.durations, d)
		return
	}
	if a.c.TickDuration != nil {
		a.c.TickDuration(d)
	}
}

// flush hands the pass's outputs over, once.
func (w *worker) flush() {
	if len(w.out) == 0 {
		return
	}
	w.s.c.Emit(w.out)
	clear(w.out)
	w.out = w.out[:0]
}

// service applies a dirty room's queued commands, in order, until its
// queue is empty, it stopped, or it exited.
func (w *worker) service(a *Actor) {
	for !a.exited {
		a.applyLeaves()
		a.mu.Lock()
		stopping := a.stopping
		a.mu.Unlock()
		if stopping {
			a.closeRoom(w, a.c.Now())
			return
		}
		select {
		case cmd := <-a.input:
			a.apply(w, cmd)
		default:
			return
		}
	}
}
func (w *worker) drain() {
	for _, a := range w.take() {
		w.service(a)
	}
	w.flush()
}
func (w *worker) tick() {
	w.durations = w.durations[:0]
	for _, a := range w.snapshot() {
		if !a.exited {
			a.step(w)
		}
	}
	if w.s.c.Ticked != nil && len(w.durations) > 0 {
		w.s.c.Ticked(w.durations)
	}
	w.flush()
}
func (w *worker) run() {
	defer w.s.wg.Done()
	for {
		select {
		case <-w.s.stop:
			for _, a := range w.snapshot() {
				if !a.exited {
					a.closeRoom(w, a.c.Now())
				}
			}
			w.flush()
			return
		case <-w.wake:
			w.drain()
		case <-w.in:
			w.drain()
			w.tick()
		}
		if w.perRoom && len(w.snapshot()) == 0 {
			if !w.s.retireIfEmpty(w) {
				continue
			}
			if w.s.single {
				w.s.halt.Do(func() { close(w.s.stop) })
			}
			return
		}
	}
}
