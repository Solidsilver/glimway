package fights

import (
	wire "glimway/server/internal/gen/glimway/v2"
	"google.golang.org/protobuf/proto"
	"sync"
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

type Actor struct {
	input     chan Command
	stop      chan struct{}
	done      chan struct{}
	mu        sync.Mutex
	closed    bool
	members   map[string]*actorMembership
	leaves    map[string]bool
	leaveWake chan struct{}
}
type actorMembership struct{ withdrawn bool }

type ActorConfig struct {
	Now func() time.Time
	// Tests can inject grid ticks and a clock without sleeping.
	Ticks        <-chan time.Time
	Emit         func(Output)
	Closed       func()
	Fall         func(Fall)
	TickDuration func(time.Duration)
}

func Start(r *Room, c ActorConfig) *Actor {
	a := &Actor{input: make(chan Command, 128), stop: make(chan struct{}), done: make(chan struct{}), members: map[string]*actorMembership{}, leaves: map[string]bool{}, leaveWake: make(chan struct{}, 1)}
	if c.Now == nil {
		c.Now = time.Now
	}
	go a.run(r, c)
	return a
}

// Submit never waits for queue space. Exit closes admission under the same
// mutex, then answers every previously admitted command before closing Done.
func (a *Actor) Submit(c Command) bool {
	if c.Leave != "" {
		return a.Leave(c.Leave)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
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
	select {
	case a.input <- c:
		return true
	default:
		if createdMember {
			delete(a.members, c.Player.Observer)
		}
		return false
	}
}

// Leave uses a coalesced control channel, so a saturated combat queue cannot
// retain a departed player or destroy the room. Withdrawn membership pointers
// invalidate older queued covers; a later cover has a fresh membership.
func (a *Actor) Leave(observer string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return false
	}
	if member := a.members[observer]; member != nil {
		member.withdrawn = true
		delete(a.members, observer)
	}
	a.leaves[observer] = true
	select {
	case a.leaveWake <- struct{}{}:
	default:
	}
	return true
}
func (a *Actor) Stop() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.closed {
		a.closed = true
		close(a.stop)
	}
}
func (a *Actor) Done() <-chan struct{} { return a.done }
func (a *Actor) run(r *Room, c ActorConfig) {
	defer close(a.done)
	defer func() {
		if c.Closed != nil {
			c.Closed()
		}
	}()
	// A blow between ticks puts a camp down at once; its fall leaves with
	// the next frame. A room that closes first (stop, its epoch's end, or
	// sleep) still hands it over, so no fall is lost with the room.
	defer func() {
		for _, fall := range r.takeFalls() {
			if c.Fall != nil {
				c.Fall(fall)
			}
		}
	}()
	pending := map[uint64]chan<- []*wire.FightHitRow{}
	answer := func(ch chan<- []*wire.FightHitRow, rows []*wire.FightHitRow) {
		if ch != nil {
			select {
			case ch <- rows:
			default:
			}
		}
	}
	// drop answers a command this room will not judge; a bolt's copy leaves
	// its flight, so the other rooms never wait on it.
	drop := func(cmd Command) {
		answer(cmd.Result, nil)
		if f := cmd.flight(); f != nil {
			f.Withdraw(r.Handle)
		}
	}
	settled := func(results []BoltResult) {
		for _, result := range results {
			answer(pending[result.ID], result.Hits)
			delete(pending, result.ID)
		}
	}
	defer func() {
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
			drop(cmd)
		}
		r.AbandonBolts()
		for _, ch := range pending {
			answer(ch, nil)
		}
	}()
	active := map[string]*actorMembership{}
	applyLeaves := func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		for observer := range a.leaves {
			if member := active[observer]; member == nil || member.withdrawn {
				r.Leave(observer, c.Now())
				delete(active, observer)
			}
		}
		a.leaves = map[string]bool{}
	}
	emit := func(observer string, m proto.Message) {
		if c.Emit != nil {
			c.Emit(Output{Observer: observer, Message: m})
		}
	}
	events := func() {
		for _, e := range r.takeEvents() {
			emit("", e)
		}
	}
	var timer *time.Timer
	ticks := c.Ticks
	if ticks == nil {
		now := c.Now()
		timer = time.NewTimer(time.Duration(100-now.UnixMilli()%100) * time.Millisecond)
		ticks = timer.C
		defer timer.Stop()
	}
	for {
		applyLeaves()
		select {
		case <-a.stop:
			r.event(nil, wire.FightEventKind_FIGHT_EVENT_KIND_ROOM_CLOSED, c.Now().UnixMilli())
			events()
			return
		case <-a.leaveWake:
			applyLeaves()
		case cmd := <-a.input:
			applyLeaves()
			now := c.Now()
			if r.EndsAt > 0 && now.UnixMilli() >= r.EndsAt {
				r.event(nil, wire.FightEventKind_FIGHT_EVENT_KIND_ROOM_CLOSED, now.UnixMilli())
				events()
				drop(cmd)
				return
			}
			a.mu.Lock()
			if a.closed {
				a.mu.Unlock()
				drop(cmd)
				r.event(nil, wire.FightEventKind_FIGHT_EVENT_KIND_ROOM_CLOSED, now.UnixMilli())
				events()
				return
			}
			withdrawn := cmd.membership != nil && cmd.membership.withdrawn
			if withdrawn {
				a.mu.Unlock()
				drop(cmd)
				continue
			}
			fresh := false
			if cmd.Player != nil {
				fresh = r.Cover(*cmd.Player, now)
				active[cmd.Player.Observer] = cmd.membership
			}
			a.mu.Unlock()
			if cmd.Player != nil {
				if fresh || cmd.Join {
					emit(cmd.Player.Observer, r.Join(cmd.Player.Seed))
				}
			}
			if cmd.Attack != nil {
				if cmd.Attack.Swing.Kind == wire.FightSwingKind_FIGHT_SWING_KIND_BOLT {
					if r.StartBolt(*cmd.Attack, now) {
						pending[cmd.Attack.ID] = cmd.Result
					} else {
						drop(cmd)
					}
				} else {
					answer(cmd.Result, r.Slash(*cmd.Attack, now))
				}
				events()
			}
			if cmd.Cast != nil {
				rows, later := r.Cast(*cmd.Cast, now)
				if later {
					pending[cmd.Cast.ID] = cmd.Result
				} else {
					answer(cmd.Result, rows)
					if cmd.Cast.Flight != nil {
						cmd.Cast.Flight.Withdraw(r.Handle)
					}
				}
				events()
			}
			if cmd.Settle {
				settled(r.SettleBolts(now))
				events()
			}
			if cmd.Clear != "" {
				cleared := r.Clear(cmd.Clear, now)
				events()
				// The fall goes to the writer now, not at the next tick.
				for _, fall := range r.takeFalls() {
					if c.Fall != nil {
						c.Fall(fall)
					}
				}
				if cmd.Cleared != nil {
					select {
					case cmd.Cleared <- cleared:
					default:
					}
				}
			}
		case <-ticks:
			applyLeaves()
			began := time.Now()
			now := c.Now()
			grid := time.UnixMilli(now.UnixMilli() / 100 * 100)
			frame := r.Step(grid)
			if c.TickDuration != nil {
				c.TickDuration(time.Since(began))
			}
			for _, e := range frame.Events {
				emit("", e)
			}
			if frame.Delta != nil {
				emit("", frame.Delta)
			}
			settled(frame.Bolts)
			for _, fall := range frame.Falls {
				if c.Fall != nil {
					c.Fall(fall)
				}
			}
			if frame.Closed {
				return
			}
			if timer != nil {
				timer.Reset(time.Duration(100-c.Now().UnixMilli()%100) * time.Millisecond)
			}
		}
	}
}
