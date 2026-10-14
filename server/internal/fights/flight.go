package fights

import (
	"glimway/content"
	"glimway/server/internal/rules"
	"math"
	"sync"
)

// BoltSample is the step a bolt is judged at along its flight (px): sample
// k is k·BoltSample past its spawn, reached BoltSample/speed after k-1.
const BoltSample = 3.0

// Flight is one bolt (a basic mage bolt or a Fingersnap) across every room
// it was sent to. Each room flies its own copy against its own enemies; the
// flight lets exactly one of them land. Every copy samples the same points
// (k·BoltSample along the facing, from the same launch instant, up to the
// same Samples), so an impact has one order across rooms: the earliest
// sample, then the nearest enemy, then the lower room handle. A room
// reports how far it has looked and its own first impact; once every other
// room has looked at least that far, the earliest impact wins, and every
// copy is told at once (notify), so the losers answer promptly instead of
// flying on to expiry. It holds no store and no tick of its own.
type Flight struct {
	Launch  int64 // Unix ms the bolt left the caster
	Samples int   // samples it flies before a wall or its lifetime stops it

	mu      sync.Mutex
	sealed  bool
	decided bool
	winner  *boltHit
	rooms   map[uint32]*flightRoom
}
type flightRoom struct {
	through int // samples looked at
	hit     *boltHit
	notify  func()
	gone    bool
}
type boltHit struct {
	k     int
	d2    float64
	room  uint32
	enemy uint32
	x, y  float64
}

func (a *boltHit) before(b *boltHit) bool {
	if a.k != b.k {
		return a.k < b.k
	}
	if a.d2 != b.d2 {
		return a.d2 < b.d2
	}
	return a.room < b.room
}

func NewFlight(launch int64, samples int) *Flight {
	return &Flight{Launch: launch, Samples: max(0, samples), rooms: map[uint32]*flightRoom{}}
}

// BoltSamples is how many samples a bolt cast from the feet at (x, y)
// flies: its lifetime's, cut at the first point clear says is solid.
func BoltSamples(clear func(x, y float64) bool, x, y, fx, fy float64) int {
	t := content.CombatRules.GetAttack()
	sx, sy := rules.FightBoltSpawn(x, y, fx)
	life := int(math.Floor(t.GetBoltSpeed()*t.GetBoltLifetimeSeconds()/BoltSample + 1e-9))
	for k := 1; k <= life; k++ {
		px, py := boltPoint(sx, sy, fx, fy, k)
		if !clear(px, py) {
			return k - 1
		}
	}
	return life
}

// BoltSamples over joined chunks: a chunk the ground does not hold stops it.
func (g Ground) BoltSamples(x, y, fx, fy float64) int {
	return BoltSamples(func(px, py float64) bool {
		for _, c := range g.chunks {
			if c.IsSafe(px, py) {
				return false
			}
		}
		return canStand(g.open, px, py, .1)
	}, x, y, fx, fy)
}

func boltPoint(sx, sy, fx, fy float64, k int) (float64, float64) {
	d := float64(k) * BoltSample
	return sx + float64(fx*d), sy + float64(fy*d)
}

// sampleAt is the last sample the bolt has reached at ms.
func (f *Flight) sampleAt(ms int64) int {
	k := int(math.Floor(float64(ms-f.Launch) * content.CombatRules.GetAttack().GetBoltSpeed() / (1000 * BoltSample)))
	return min(f.Samples, max(0, k))
}

// Join adds a room's copy before Seal; notify (may be nil) wakes its actor
// to settle once the flight decides.
func (f *Flight) Join(room uint32, notify func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rooms[room] = &flightRoom{notify: notify}
}

// Seal: every copy has joined (or withdrawn); the flight may decide.
func (f *Flight) Seal() {
	f.mu.Lock()
	f.sealed = true
	wake := f.decide(0, false)
	f.mu.Unlock()
	run(wake)
}

// Withdraw: a copy that will never report (its room refused or closed).
func (f *Flight) Withdraw(room uint32) {
	f.mu.Lock()
	if r := f.rooms[room]; r != nil {
		r.gone, r.hit = true, nil
	}
	wake := f.decide(room, true)
	f.mu.Unlock()
	run(wake)
}

// report records how far a room's copy has looked and its first impact.
func (f *Flight) report(room uint32, through int, hit *boltHit) {
	f.mu.Lock()
	if r := f.rooms[room]; r != nil && !r.gone {
		r.through, r.hit = through, hit
	}
	wake := f.decide(room, true)
	f.mu.Unlock()
	run(wake)
}

// verdict: whether the flight has decided, and whether this room landed it.
func (f *Flight) verdict(room uint32) (bool, *boltHit) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.decided || f.winner == nil || f.winner.room != room {
		return f.decided, nil
	}
	return true, f.winner
}

// decide runs under f.mu and returns the copies to wake, all but `self`.
func (f *Flight) decide(self uint32, skip bool) []func() {
	if f.decided || !f.sealed {
		return nil
	}
	var best *boltHit
	for _, r := range f.rooms {
		if !r.gone && r.hit != nil && (best == nil || r.hit.before(best)) {
			best = r.hit
		}
	}
	need := f.Samples
	if best != nil {
		need = best.k
	}
	for _, r := range f.rooms {
		if !r.gone && r.hit == nil && r.through < need {
			return nil
		}
	}
	f.decided, f.winner = true, best
	wake := []func(){}
	for id, r := range f.rooms {
		if !r.gone && r.notify != nil && !(skip && id == self) {
			wake = append(wake, r.notify)
		}
	}
	return wake
}
func run(fs []func()) {
	for _, f := range fs {
		f()
	}
}
