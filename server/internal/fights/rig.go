package fights

import (
	"math/rand/v2"
	"sort"
	"time"
)

// Rig injects deterministic one-way delay, uniform jitter, and loss into a
// replay's inputs. Advance on the same 100 ms world grid as the real actor;
// delivery order is stable for simultaneous inputs. It never sleeps.
type Rig struct {
	Delay, Jitter time.Duration
	Loss          float64
	rng           *rand.Rand
	next          uint64
	inputs        []scheduled
}
type scheduled struct {
	at    time.Time
	order uint64
	input func(*Room, time.Time)
}

func NewRig(seed uint64, delay, jitter time.Duration, loss float64) *Rig {
	return &Rig{Delay: delay, Jitter: jitter, Loss: loss, rng: rand.New(rand.NewPCG(seed, seed+1))}
}
func (r *Rig) Send(at time.Time, input func(*Room, time.Time)) bool {
	if r.rng.Float64() < r.Loss {
		return false
	}
	delay := r.Delay
	if r.Jitter > 0 {
		// Integer nanoseconds keep the latency schedule identical on both CPUs.
		delay += time.Duration(r.rng.Int64N(2*int64(r.Jitter)+1) - int64(r.Jitter))
	}
	delay = max(0, delay)
	r.next++
	r.inputs = append(r.inputs, scheduled{at: at.Add(delay), order: r.next, input: input})
	sort.SliceStable(r.inputs, func(i, j int) bool { return r.inputs[i].at.Before(r.inputs[j].at) })
	return true
}
func (r *Rig) Advance(room *Room, at time.Time) Frame {
	for len(r.inputs) > 0 && !r.inputs[0].at.After(at) {
		v := r.inputs[0]
		r.inputs = r.inputs[1:]
		v.input(room, v.at)
	}
	return room.Step(at)
}
