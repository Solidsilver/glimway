package api

// The one durable fall writer (shared-fights.md 1.2, 1.3). A fight room's
// tick never touches the store: a camp's fall leaves the room through its
// actor's Fall output, is queued here without blocking, and one goroutine
// writes each fall in its own transaction. The queue is unbounded, so a
// burst of falls cannot drop one; a failed write is retried, never skipped;
// shutdown drains it. Until a fall is written it stays readable from the
// queue, so a room that sleeps and wakes again in that gap, or a claim that
// arrives first, still sees it.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"glimway/server/internal/fights"
	"glimway/server/internal/store"
)

// errFallsClosed: the writer has stopped; a fall enqueued now is refused,
// loudly, never queued to be lost.
var errFallsClosed = errors.New("fall writer closed")

// fallClaimWait bounds how long a claim waits for its camp's queued fall
// to be written before it reads the store.
const fallClaimWait = 2 * time.Second

// fallID is a camp cycle as a claim names it (epoch, camp, cycle), before
// its transaction reads the chunk's full identity: the near read's standing
// index and the claim's wait use it. The writer's queue is keyed by the full
// store.FallKey.
type fallID struct {
	epoch, entity string
	cycle         int64
}

// queuedFall is one camp cycle's fall until every copy of it is written.
type queuedFall struct {
	rec     store.FallRecord // witnesses merged across copies
	pending int              // copies queued or in flight
	written chan struct{}    // closed once pending reaches 0
}

type fallWriter struct {
	mu      sync.Mutex
	queue   []store.FallRecord
	falls   map[store.FallKey]*queuedFall // by the room's full identity
	kick    chan struct{}                 // capacity 1: work arrived
	changed chan struct{}                 // closed and replaced whenever the queue shrinks
	started bool
	closed  bool
	stop    context.CancelFunc // aborts a write being retried at shutdown
	done    chan struct{}
	lastErr error
	// write is the store write (Store.InsertFall); tests replace it.
	write func(context.Context, store.FallRecord) (bool, error)
	logf  func(string, ...any)
	// backoff is the first retry delay; it doubles up to a second.
	backoff time.Duration
}

func newFallWriter(write func(context.Context, store.FallRecord) (bool, error), logf func(string, ...any)) *fallWriter {
	return &fallWriter{falls: map[store.FallKey]*queuedFall{}, kick: make(chan struct{}, 1), changed: make(chan struct{}), done: make(chan struct{}), write: write, logf: logf, backoff: 20 * time.Millisecond}
}

// fallRecord maps the sim's output to the store's row.
func fallRecord(f fights.Fall) store.FallRecord {
	witnesses := slices.Clone(f.Witnesses)
	slices.Sort(witnesses)
	witnesses = slices.Compact(witnesses)
	return store.FallRecord{Key: store.FallKey{World: f.Key.World, Realm: f.Key.Realm, Layer: f.Key.Layer, CX: f.Key.CX, CY: f.Key.CY, Epoch: f.Key.Epoch, Entity: f.Camp, Cycle: f.Cycle}, FellAt: f.At, Witnesses: witnesses}
}

func idOf(k store.FallKey) fallID { return fallID{k.Epoch, k.Entity, k.Cycle} }

func (w *fallWriter) enqueue(rec store.FallRecord) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return errFallsClosed
	}
	if !w.started {
		w.started = true
		ctx, cancel := context.WithCancel(context.Background())
		w.stop = cancel
		go w.run(ctx)
	}
	w.queue = append(w.queue, rec)
	q := w.falls[rec.Key]
	if q == nil {
		q = &queuedFall{rec: rec, written: make(chan struct{})}
		q.rec.Witnesses = slices.Clone(rec.Witnesses)
		w.falls[rec.Key] = q
	} else {
		q.rec.Witnesses = slices.Compact(slices.Sorted(slices.Values(append(slices.Clone(q.rec.Witnesses), rec.Witnesses...))))
	}
	q.pending++
	select {
	case w.kick <- struct{}{}:
	default:
	}
	return nil
}

func (w *fallWriter) run(ctx context.Context) {
	defer close(w.done)
	for {
		w.mu.Lock()
		if len(w.queue) == 0 {
			closed := w.closed
			w.mu.Unlock()
			if closed {
				return
			}
			select {
			case <-w.kick:
			case <-ctx.Done():
			}
			continue
		}
		rec := w.queue[0]
		w.mu.Unlock()
		if !w.writeOne(ctx, rec) {
			return // shutdown gave up on it; CloseFalls reports what is left
		}
		w.mu.Lock()
		w.queue = w.queue[1:]
		if q := w.falls[rec.Key]; q != nil {
			if q.pending--; q.pending == 0 {
				close(q.written)
				delete(w.falls, rec.Key)
			}
		}
		w.lastErr = nil
		close(w.changed)
		w.changed = make(chan struct{})
		w.mu.Unlock()
	}
}

// writeOne retries one fall until it is written or shutdown aborts.
func (w *fallWriter) writeOne(ctx context.Context, rec store.FallRecord) bool {
	delay := w.backoff
	for {
		kept, err := w.write(ctx, rec)
		if err == nil {
			if !kept {
				w.logf("fight fall dropped: epoch %s is gone (camp %s cycle %d)", rec.Key.Epoch, rec.Key.Entity, rec.Key.Cycle)
			}
			return true
		}
		w.mu.Lock()
		w.lastErr = err
		w.mu.Unlock()
		w.logf("fight fall write failed, retrying: camp %s cycle %d: %v", rec.Key.Entity, rec.Key.Cycle, err)
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return false
		}
		delay = min(2*delay, time.Second)
	}
}

// queued is a fall still waiting to be written, for its exact key.
func (w *fallWriter) queued(k store.FallKey) (store.FallRecord, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	q := w.falls[k]
	if q == nil {
		return store.FallRecord{}, false
	}
	rec := q.rec
	rec.Witnesses = slices.Clone(q.rec.Witnesses)
	return rec, true
}

// await waits, bounded, for every queued fall of this camp cycle to be
// written (a claim names only epoch, camp and cycle before its transaction
// reads the chunk's identity). It holds no transaction: the store has one
// connection, and the writer needs it.
func (w *fallWriter) await(ctx context.Context, epoch, entity string, cycle int64, limit time.Duration) {
	id := fallID{epoch, entity, cycle}
	w.mu.Lock()
	waits := []chan struct{}{}
	for k, q := range w.falls {
		if idOf(k) == id {
			waits = append(waits, q.written)
		}
	}
	w.mu.Unlock()
	if len(waits) == 0 {
		return
	}
	timer := time.NewTimer(limit)
	defer timer.Stop()
	for _, written := range waits {
		select {
		case <-written:
		case <-timer.C:
			return
		case <-ctx.Done():
			return
		}
	}
}

// drain waits until every fall queued so far is written.
func (w *fallWriter) drain(ctx context.Context) error {
	for {
		w.mu.Lock()
		n, changed := len(w.queue), w.changed
		w.mu.Unlock()
		if n == 0 {
			return nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			w.mu.Lock()
			n, last := len(w.queue), w.lastErr
			w.mu.Unlock()
			if last != nil {
				return fmt.Errorf("%d fight falls not written: %w (last write error: %v)", n, ctx.Err(), last)
			}
			return fmt.Errorf("%d fight falls not written: %w", n, ctx.Err())
		}
	}
}

// close refuses new falls, drains, and stops the goroutine. Falls still
// queued when ctx ends are reported, not silently forgotten.
func (w *fallWriter) close(ctx context.Context) error {
	w.mu.Lock()
	w.closed = true
	started := w.started
	select {
	case w.kick <- struct{}{}:
	default:
	}
	w.mu.Unlock()
	if !started {
		return nil
	}
	err := w.drain(ctx)
	if err != nil {
		w.stop()
		w.logf("fight falls lost at shutdown: %v", err)
	}
	<-w.done
	return err
}

// EnqueueFall hands a camp's fall from the sim to the durable writer. It
// never blocks the room and never drops a fall: the queue is unbounded. It
// errs only once the writer has closed (shutdown), so the caller can log a
// fall that could not be kept.
func (a *Server) EnqueueFall(f fights.Fall) error {
	if a.falls == nil {
		return errFallsClosed
	}
	return a.falls.enqueue(fallRecord(f))
}

// ReadFallInTx is the exact fall of one camp cycle, for a room's wake: a
// fall still in the writer's queue counts, so a room that sleeps and wakes
// before its fall is written cannot raise the fallen camp again. Never
// called from a tick.
func (a *Server) ReadFallInTx(ctx context.Context, tx *sql.Tx, k store.FallKey) (store.FallRecord, bool, error) {
	if a.falls != nil {
		if rec, ok := a.falls.queued(k); ok {
			return rec, true, nil
		}
	}
	return store.ReadFall(ctx, tx, k)
}

// DrainFalls waits until every queued fall is written, or ctx ends.
func (a *Server) DrainFalls(ctx context.Context) error {
	if a.falls == nil {
		return nil
	}
	return a.falls.drain(ctx)
}

// CloseFalls drains and stops the writer; later EnqueueFall calls err.
// ClosePresence calls it once the fight rooms have stopped.
// A Server built without New (some hub tests) has no writer: nothing to do.
func (a *Server) CloseFalls(ctx context.Context) error {
	if a.falls == nil {
		return nil
	}
	return a.falls.close(ctx)
}

// CampWake is a camp's state when its room wakes: the cycle its enemies
// belong to, whether that cycle already fell, and when the camp rises for
// the next cycle (Unix milliseconds; 0 when it has not fallen).
type CampWake struct {
	Cycle     int64
	Fallen    bool
	RespawnAt int64
}

// CampAtWake reads one generated camp for a waking room, inside the wake's
// transaction. The cycle is entity_state's projection (a cleared camp past
// its timer is the next cycle, standing). A cycle is fallen when its fall
// is stored or still queued, or when its row is cleared in that cycle (the
// fall writes the row; rows a 0.8 claim cleared keep their timer).
func (a *Server) CampAtWake(ctx context.Context, tx *sql.Tx, key fights.Key, camp string, now time.Time) (CampWake, error) {
	row, err := readEntityRow(ctx, tx, key.Epoch, camp)
	if err != nil {
		return CampWake{}, err
	}
	row = row.projected("camp", now.Unix())
	k := store.FallKey{World: key.World, Realm: key.Realm, Layer: key.Layer, CX: key.CX, CY: key.CY, Epoch: key.Epoch, Entity: camp, Cycle: row.cycle}
	fall, fell, err := a.ReadFallInTx(ctx, tx, k)
	if err != nil {
		return CampWake{}, err
	}
	out := CampWake{Cycle: row.cycle}
	switch {
	case row.state == "cleared":
		out.Fallen, out.RespawnAt = true, row.availableAt*1000
	case fell:
		out.Fallen, out.RespawnAt = true, store.CampAvailableAt(fall.FellAt)*1000
	}
	return out, nil
}

// CampRespawnAt is when a camp that fell at fellAt (Unix milliseconds, as
// fights.Fall.At) rises for its next cycle, in Unix milliseconds: the same
// boundary the near read and claims project from.
func CampRespawnAt(fellAt int64) int64 { return store.CampAvailableAt(fellAt) * 1000 }
