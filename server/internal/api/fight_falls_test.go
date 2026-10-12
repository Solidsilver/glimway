package api

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/fights"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// campFell records a camp's fall the way a fight room does: the sim's Fall
// through the durable writer, drained before it returns. Witnesses are
// account ids; the fall happens now.
func (x *rig) campFell(world, epoch string, e *contract.WildsEntity, cycle int64, witnesses ...string) {
	x.t.Helper()
	a := x.api
	if err := a.EnqueueFall(campFall(world, epoch, e, cycle, x.now.Load()*1000, witnesses...)); err != nil {
		x.t.Fatal(err)
	}
	x.t.Cleanup(func() { closeFalls(x.t, a) })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.DrainFalls(ctx); err != nil {
		x.t.Fatal(err)
	}
}

func campFall(world, epoch string, e *contract.WildsEntity, cycle, at int64, witnesses ...string) fights.Fall {
	cx, cy := entityChunkOf(e)
	return fights.Fall{Key: fights.Key{World: world, Realm: content.WildsRules.GetRealm(), CX: int32(cx), CY: int32(cy), Epoch: epoch}, Camp: e.Id, Cycle: cycle, At: at, Witnesses: witnesses}
}

func closeFalls(t *testing.T, a *Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.CloseFalls(ctx); err != nil {
		t.Error(err)
	}
}

// gateFalls holds the server's fall writes until the gate opens.
func gateFalls(a *Server) chan struct{} {
	gate := make(chan struct{})
	write := a.falls.write
	a.falls.write = func(ctx context.Context, f store.FallRecord) (bool, error) {
		select {
		case <-gate:
		case <-ctx.Done():
			return false, ctx.Err()
		}
		return write(ctx, f)
	}
	return gate
}

func campWake(t *testing.T, a *Server, world, epoch string, e *contract.WildsEntity, now time.Time) CampWake {
	t.Helper()
	cx, cy := entityChunkOf(e)
	tx, err := a.beginTx(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	w, err := a.CampAtWake(context.Background(), tx, fights.Key{World: world, Realm: content.WildsRules.GetRealm(), CX: int32(cx), CY: int32(cy), Epoch: epoch}, e.Id, now)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

// A burst cannot drop a fall, a failing write is retried in order, and a
// drain waits for the last one.
func TestFallWriterKeepsEveryFallThroughBurstsAndFailures(t *testing.T) {
	var mu sync.Mutex
	var written []int64
	var calls atomic.Int32
	var logs atomic.Int32
	w := newFallWriter(func(_ context.Context, f store.FallRecord) (bool, error) {
		if n := calls.Add(1); n%7 == 3 {
			return false, errors.New("database is locked")
		}
		mu.Lock()
		written = append(written, f.Key.Cycle)
		mu.Unlock()
		return true, nil
	}, func(string, ...any) { logs.Add(1) })
	w.backoff = time.Millisecond
	if w.started {
		t.Fatal("a writer nobody used started a goroutine")
	}
	const n = 2000
	for i := range n {
		if err := w.enqueue(store.FallRecord{Key: store.FallKey{Epoch: "e", Entity: fmt.Sprintf("camp:0:0:%d", i%5), Cycle: int64(i)}}); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := w.drain(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(written) != n {
		t.Fatal("lost falls", len(written))
	}
	for i, c := range written {
		if c != int64(i) {
			t.Fatal("out of order", i, c)
		}
	}
	mu.Unlock()
	if logs.Load() == 0 || len(w.falls) != 0 {
		t.Fatal("failures not logged, or pending falls left", logs.Load(), len(w.falls))
	}
	if err := w.close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := w.enqueue(store.FallRecord{}); !errors.Is(err, errFallsClosed) {
		t.Fatal("a closed writer took a fall", err)
	}
}

// Shutdown with a write that cannot succeed reports the fall it could not
// keep, and the goroutine still ends.
func TestFallWriterShutdownReportsUnwrittenFalls(t *testing.T) {
	var logged strings.Builder
	var mu sync.Mutex
	w := newFallWriter(func(context.Context, store.FallRecord) (bool, error) { return false, errors.New("disk I/O error") }, func(f string, v ...any) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprintf(&logged, f+"\n", v...)
	})
	w.backoff = time.Millisecond
	if err := w.enqueue(store.FallRecord{Key: store.FallKey{Epoch: "e", Entity: "camp:0:0:0"}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := w.close(ctx)
	if err == nil || !strings.Contains(err.Error(), "1 fight falls not written") || !strings.Contains(err.Error(), "disk I/O error") {
		t.Fatal(err)
	}
	select {
	case <-w.done:
	default:
		t.Fatal("writer goroutine still running")
	}
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(logged.String(), "fight falls lost at shutdown") {
		t.Fatal(logged.String())
	}
}

// Until its fall is written, a fallen camp stays fallen for a room that
// wakes (no resurrection across sleep), and a claim waits for the write
// instead of being refused.
func TestQueuedFallIsReadAtWakeAndAwaitedByClaim(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "tangle")
	camp := v.kind(t, "camp")
	now := time.Unix(x.now.Load(), 0)
	if w := campWake(t, x.api, s.WorldID, v.Epoch.Id, camp, now); w != (CampWake{}) {
		t.Fatal("standing camp", w)
	}
	gate := gateFalls(x.api)
	defer closeFalls(t, x.api)
	fellAt := now.UnixMilli() + 400
	if err := x.api.EnqueueFall(campFall(s.WorldID, v.Epoch.Id, camp, 0, fellAt, x.account("alice"))); err != nil {
		t.Fatal(err)
	}
	respawn := CampRespawnAt(fellAt)
	if respawn != (now.Unix()+int64(content.WildsRules.Timers.CampRespawnSeconds))*1000 {
		t.Fatal("respawn boundary", respawn)
	}
	if w := campWake(t, x.api, s.WorldID, v.Epoch.Id, camp, now); !w.Fallen || w.Cycle != 0 || w.RespawnAt != respawn {
		t.Fatal("queued fall unseen at wake", w)
	}
	done := make(chan string, 1)
	go func() {
		_, code := x.claim(c, s, "early", v.Epoch.Id, camp, 0, at(camp, 0), 200)
		done <- code
	}()
	select {
	case code := <-done:
		t.Fatal("claim did not wait for the queued fall", code)
	case <-time.After(50 * time.Millisecond):
	}
	close(gate)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("claim never settled")
	}
	// Written: the wake reads the store, the same answer.
	if w := campWake(t, x.api, s.WorldID, v.Epoch.Id, camp, now); !w.Fallen || w.Cycle != 0 || w.RespawnAt != respawn {
		t.Fatal("stored fall at wake", w)
	}
	// At the boundary the camp rises for its next cycle, standing.
	if w := campWake(t, x.api, s.WorldID, v.Epoch.Id, camp, time.UnixMilli(respawn)); w.Fallen || w.Cycle != 1 {
		t.Fatal("respawn", w)
	}
}

// A fall written before a restart is read by the next server; the old
// server's writer refuses falls after it closed; ClosePresence drains.
func TestFallsSurviveRestartAndPresenceShutdownDrains(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "tangle")
	camp := v.kind(t, "camp")
	now := time.Unix(x.now.Load(), 0)
	first := x.api
	gate := gateFalls(first)
	if err := first.EnqueueFall(campFall(s.WorldID, v.Epoch.Id, camp, 0, now.UnixMilli(), x.account("alice"))); err != nil {
		t.Fatal(err)
	}
	time.AfterFunc(30*time.Millisecond, func() { close(gate) })
	first.ClosePresence()
	if err := first.EnqueueFall(campFall(s.WorldID, v.Epoch.Id, camp, 1, now.UnixMilli(), x.account("alice"))); !errors.Is(err, errFallsClosed) {
		t.Fatal("closed writer took a fall", err)
	}
	restarted := New(x.db, first.Habitica, first.Config)
	if restarted.falls.started {
		t.Fatal("an unused writer started")
	}
	if w := campWake(t, restarted, s.WorldID, v.Epoch.Id, camp, now); !w.Fallen || w.Cycle != 0 {
		t.Fatal("fall lost across restart", w)
	}
	x.api = restarted
	x.claim(c, s, "after-restart", v.Epoch.Id, camp, 0, at(camp, 0), 200)
	if restarted.falls.started {
		t.Fatal("a claim started the writer")
	}
}
