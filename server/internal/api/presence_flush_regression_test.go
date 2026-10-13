package api

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	contract "glimway/server/internal/gen/glimway/v2"
	"google.golang.org/protobuf/proto"
)

type flushTestGate struct {
	net.Conn
	armed                    atomic.Bool
	fail                     atomic.Bool
	entered, release, closed chan struct{}
	once                     sync.Once
}

func (g *flushTestGate) Write(b []byte) (int, error) {
	if len(b) > 0 && b[0]&15 == 2 && g.armed.CompareAndSwap(true, false) {
		close(g.entered)
		select {
		case <-g.release:
		case <-g.closed:
			return 0, net.ErrClosed
		}
		if g.fail.Load() {
			_ = g.Close()
			return 0, net.ErrClosed
		}
	}
	return g.Conn.Write(b)
}
func (g *flushTestGate) Close() error { g.once.Do(func() { close(g.closed) }); return g.Conn.Close() }

type flushTestHijacker struct {
	http.ResponseWriter
	gates chan *flushTestGate
}

func (w flushTestHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, rw, e := w.ResponseWriter.(http.Hijacker).Hijack()
	if e != nil {
		return nil, nil, e
	}
	if e = rw.Writer.Flush(); e != nil {
		return nil, nil, e
	}
	g := &flushTestGate{Conn: c, entered: make(chan struct{}), release: make(chan struct{}), closed: make(chan struct{})}
	rw.Writer.Reset(g)
	w.gates <- g
	return g, rw, nil
}

type flushTestRig struct {
	h      *presenceHub
	a      *Server
	p      *presencePeer
	g      *flushTestGate
	frames chan []byte
	errs   chan error
	done   chan struct{}
}

func flushTestNew(t *testing.T, ms, capacity int, beforeWriter ...func(*flushTestRig)) *flushTestRig {
	t.Helper()
	h := newPresenceHub(nil, nil)
	h.flushMs = ms
	r := &flushTestRig{h: h, a: &Server{presence: h}, frames: make(chan []byte, 16), errs: make(chan error, 1), done: make(chan struct{})}
	peers := make(chan *presencePeer, 1)
	gates := make(chan *flushTestGate, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		c, e := websocket.Accept(flushTestHijacker{w, gates}, req, nil)
		if e != nil {
			return
		}
		defer c.CloseNow()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		p := &presencePeer{ctx: ctx, cancel: cancel, conn: c, queue: make(chan []byte, capacity), flushWake: make(chan struct{}, 1), lastActivity: time.Now(), pingAt: time.Now()}
		h.mu.Lock()
		h.peers["peer"] = p
		h.mu.Unlock()
		peers <- p
		c.Read(context.Background()) // like production, do not close merely on p.ctx cancellation
	}))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client, _, e := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http"), nil)
	if e != nil {
		ts.Close()
		t.Fatal(e)
	}
	client.SetReadLimit(131072)
	r.p, r.g = <-peers, <-gates
	go func() {
		for {
			_, b, e := client.Read(context.Background())
			if e != nil {
				r.errs <- e
				return
			}
			r.frames <- b
		}
	}()
	for _, setup := range beforeWriter {
		setup(r)
	}
	go func() { defer close(r.done); r.a.presenceWriter(r.p) }()
	t.Cleanup(func() {
		r.p.stop(websocket.StatusNormalClosure, "cleanup")
		client.CloseNow()
		r.p.conn.CloseNow()
		select {
		case <-r.done:
		case <-time.After(time.Second):
			t.Error("writer failed cleanup")
		}
		ts.Close()
	})
	return r
}
func (r *flushTestRig) enqueue(t *testing.T, b []byte) {
	t.Helper()
	r.h.mu.Lock()
	r.h.enqueue(r.p, b)
	r.h.mu.Unlock()
}
func flushTestEncode(t *testing.T, m proto.Message) []byte {
	t.Helper()
	b, e := encodePresence(m)
	if e != nil {
		t.Fatal(e)
	}
	return b
}

// With no sweep and only nonurgent events, an empty channel means the writer
// received the event into its held backlog; nothing can enter a frame yet.
func flushTestHeld(t *testing.T, r *flushTestRig) {
	t.Helper()
	flushTestUntil(t, func() bool { return len(r.p.queue) == 0 })
}
func flushTestFrame(t *testing.T, r *flushTestRig) [][]byte {
	t.Helper()
	select {
	case b := <-r.frames:
		es, e := splitPresenceFrame(b)
		if e != nil {
			t.Fatal(e)
		}
		return es
	case e := <-r.errs:
		t.Fatal(e)
	case <-time.After(time.Second):
		t.Fatal("frame never arrived")
	}
	return nil
}

// The fixture's server reader stays alive after application cancellation, as
// production does. Only the writer can send the selected close to this client.
func TestPresenceFlushStopDuringFlushSendsClose(t *testing.T) {
	for _, ms := range []int{0, 50, 100} {
		for _, trigger := range []string{"ready", "result", "sweep"} {
			t.Run(strconv.Itoa(ms)+"/"+trigger, func(t *testing.T) {
				r := flushTestNew(t, ms, 8)
				r.g.armed.Store(true)
				var event proto.Message
				switch trigger {
				case "ready":
					event = &contract.PresenceReady{AccountId: "alice"}
				case "result":
					event = &contract.FightSwingResult{SwingCounter: 3}
				case "sweep":
					event = &contract.PresenceLeave{AccountId: "alice"}
				}
				r.enqueue(t, flushTestEncode(t, event))
				if trigger == "sweep" && ms > 0 {
					flushTestHeld(t, r)
					r.p.flushWake <- struct{}{}
				}
				flushTestSignal(t, r.g.entered, "write did not start")
				r.p.stop(presenceReplaced, "replaced")
				close(r.g.release)
				flushTestFrame(t, r) // Allow the bounded in-flight data write to finish.
				flushTestClose(t, r, presenceReplaced, "replaced")
				flushTestSignal(t, r.done, "writer did not exit")
			})
		}
	}
}

func flushTestClose(t *testing.T, r *flushTestRig, code websocket.StatusCode, reason string) {
	t.Helper()
	select {
	case err := <-r.errs:
		var closeErr websocket.CloseError
		if !errors.As(err, &closeErr) || closeErr.Code != code || closeErr.Reason != reason {
			t.Fatalf("close=%v, want %d %q", err, code, reason)
		}
	case <-time.After(time.Second):
		t.Fatal("writer failed to send selected close")
	}
}

func TestPresenceFlushHeldMessageLimit(t *testing.T) {
	for _, ms := range []int{50, 100} {
		t.Run(strconv.Itoa(ms), func(t *testing.T) {
			r := flushTestNew(t, ms, 64)
			b := flushTestEncode(t, &contract.PresenceLeave{AccountId: "alice"})
			for range 64 {
				r.enqueue(t, b)
				flushTestHeld(t, r)
			}
			if r.p.ctx.Err() != nil {
				t.Fatal("stopped before QueueMessages limit")
			}
			if r.h.writeCalls.Load() != 0 {
				t.Fatal("held backlog entered a frame")
			}
			r.enqueue(t, b)
			if r.p.ctx.Err() == nil {
				t.Fatalf("admitted 65 unflushed events despite QueueMessages=64: channel=%d chargedBytes=%d", len(r.p.queue), r.p.queuedBytes.Load())
			}
			if r.p.closeReason != "slow-consumer" {
				t.Fatalf("wrong stop: %q", r.p.closeReason)
			}
		})
	}
}
func TestPresenceFlushModesUrgentOrderCapAndAccounting(t *testing.T) {
	for _, ms := range []int{0, 50, 100} {
		t.Run(strconv.Itoa(ms), func(t *testing.T) {
			r := flushTestNew(t, ms, 8)
			first := flushTestEncode(t, &contract.PresenceEmote{Id: strings.Repeat("a", 40000)})
			second := flushTestEncode(t, &contract.PresenceEmote{Id: strings.Repeat("b", 40000)})
			if ms == 0 {
				r.enqueue(t, first)
				got := flushTestFrame(t, r)
				if len(got) != 1 || !bytes.Equal(got[0], first) {
					t.Fatal("immediate output without sweep")
				}
				return
			}
			r.enqueue(t, first)
			flushTestHeld(t, r)
			r.enqueue(t, second)
			flushTestHeld(t, r)
			if r.p.queuedBytes.Load() != int64(len(first)+len(second)) {
				t.Fatal("held bytes not charged")
			}
			select {
			case <-r.frames:
				t.Fatal("normal backlog escaped without sweep")
			default:
			}
			urgent := flushTestEncode(t, &contract.FightSwingResult{SwingCounter: 3})
			r.enqueue(t, urgent)
			var events [][]byte
			for len(events) < 3 {
				events = append(events, flushTestFrame(t, r)...)
			}
			if len(events) != 3 || !bytes.Equal(events[0], first) || !bytes.Equal(events[1], second) || !bytes.Equal(events[2], urgent) {
				t.Fatal("urgent backlog lost or reordered")
			}
			if r.p.queuedBytes.Load() != 0 || r.p.queuedMessages.Load() != 0 {
				t.Fatal("flushed bytes still charged")
			}
			// No sweep, so Ready must release a later held backlog by itself too.
			r.enqueue(t, first)
			flushTestHeld(t, r)
			ready := flushTestEncode(t, &contract.PresenceReady{AccountId: "alice"})
			r.enqueue(t, ready)
			got := flushTestFrame(t, r)
			if len(got) != 2 || !bytes.Equal(got[0], first) || !bytes.Equal(got[1], ready) {
				t.Fatal("Ready failed ordered bypass")
			}
		})
	}
}
func TestPresenceFlushConfig(t *testing.T) {
	for _, ms := range []int{-1, 0, 1, 49, 50, 51, 99, 100, 101} {
		func() {
			defer func() {
				e := recover()
				valid := ms == 0 || ms == 50 || ms == 100
				if (e == nil) != valid {
					t.Errorf("validation mismatch for %d: %v", ms, e)
				}
			}()
			a := newServer(nil, nil, Config{PresenceFlushMs: ms, Now: time.Now})
			if a.presence.flushMs != ms {
				t.Fatal("configuration not applied")
			}
		}()
	}
}

func flushTestUntil(t *testing.T, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatal("condition did not settle")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestPresenceFlushSweepCoalescedWakeDoesNotLoseBacklog(t *testing.T) {
	for _, ms := range []int{50, 100} {
		t.Run(strconv.Itoa(ms), func(t *testing.T) {
			r := flushTestNew(t, ms, 8)
			first := flushTestEncode(t, &contract.PresenceLeave{AccountId: "first"})
			second := flushTestEncode(t, &contract.PresenceLeave{AccountId: "second"})
			third := flushTestEncode(t, &contract.PresenceLeave{AccountId: "third"})
			r.enqueue(t, first)
			flushTestHeld(t, r)
			r.g.armed.Store(true)
			r.p.flushWake <- struct{}{}
			flushTestSignal(t, r.g.entered, "write did not start")
			go func() { defer close(r.h.sweepDone); r.a.presenceSweep() }()
			defer func() { close(r.h.sweepStop); <-r.h.sweepDone }()
			r.enqueue(t, second)
			flushTestUntil(t, func() bool { return len(r.p.flushWake) == 1 && !r.p.flushPending.Load() })
			r.enqueue(t, third)
			// The next sweep consumes the dirty flag but drops its redundant send:
			// the buffered wake remains sufficient to drain both later arrivals.
			flushTestUntil(t, func() bool { return !r.p.flushPending.Load() })
			if len(r.p.flushWake) != 1 {
				t.Fatal("expected one coalesced wake while writer busy")
			}
			close(r.g.release)
			var all [][]byte
			for len(all) < 3 {
				all = append(all, flushTestFrame(t, r)...)
			}
			if len(all) != 3 || !bytes.Equal(all[0], first) || !bytes.Equal(all[1], second) || !bytes.Equal(all[2], third) {
				t.Fatal("sweep lost or reordered backlog")
			}
			if r.p.queuedBytes.Load() != 0 || r.p.queuedMessages.Load() != 0 {
				t.Fatal("sweep charged already-written bytes")
			}
			writes := r.h.writeCalls.Load()
			time.Sleep(time.Duration(2*ms) * time.Millisecond)
			if r.h.writeCalls.Load() != writes {
				t.Fatal("idle sweep emitted empty frames")
			}
		})
	}
}
func TestPresenceFlushHeldByteBudgetAndCloseWithoutWake(t *testing.T) {
	for _, ms := range []int{50, 100} {
		t.Run(strconv.Itoa(ms), func(t *testing.T) {
			r := flushTestNew(t, ms, 8)
			big := flushTestEncode(t, &contract.PresenceGift{FromName: strings.Repeat("g", 131060)})
			if len(big) != 131068 {
				t.Fatal("unexpected maximum-event size")
			}
			for range 2 {
				r.enqueue(t, big)
				flushTestHeld(t, r)
			}
			if r.p.queuedBytes.Load() != 262136 {
				t.Fatal("held bytes escaped slow-consumer budget")
			}
			r.enqueue(t, flushTestEncode(t, &contract.PresenceLeave{AccountId: "alice"}))
			if r.p.ctx.Err() == nil || r.p.closeReason != "slow-consumer" {
				t.Fatal("held-byte overflow not refused")
			}
			// No sweep was started: cancellation of a held, idle writer must close.
			select {
			case e := <-r.errs:
				if websocket.CloseStatus(e) != websocket.StatusTryAgainLater {
					t.Fatal(e)
				}
			case <-time.After(time.Second):
				t.Fatal("held idle close waited on sweep")
			}
		})
	}
}

func flushTestSignal(t *testing.T, ch <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal(message)
	}
}

// One event enters the first frame. The other oversized events stay charged
// while that write is blocked, even though they are no longer in the channel.
func TestPresenceFlushMessageCreditsReturnPerFrame(t *testing.T) {
	for _, ms := range []int{50, 100} {
		t.Run(strconv.Itoa(ms), func(t *testing.T) {
			for _, trigger := range []string{"urgent", "sweep"} {
				t.Run(trigger, func(t *testing.T) {
					r := flushTestNew(t, ms, 4)
					big := flushTestEncode(t, &contract.PresenceEmote{Id: strings.Repeat("a", 40000)})
					small := flushTestEncode(t, &contract.PresenceLeave{AccountId: "alice"})
					for range 3 {
						r.enqueue(t, big)
						flushTestHeld(t, r)
					}
					r.g.armed.Store(true)
					fourth := small
					if trigger == "urgent" {
						fourth = flushTestEncode(t, &contract.PresenceReady{AccountId: "alice"})
						r.enqueue(t, fourth)
					} else {
						r.enqueue(t, small)
						flushTestHeld(t, r)
						r.p.flushWake <- struct{}{}
					}
					flushTestSignal(t, r.g.entered, "write did not start")
					if got := r.p.queuedMessages.Load(); got != 3 {
						t.Fatalf("outstanding messages=%d, want 3", got)
					}
					r.enqueue(t, small) // The first frame returned exactly one message credit.
					if r.p.ctx.Err() != nil {
						t.Fatal("in-flight frame did not return its credit")
					}
					if got := r.p.queuedMessages.Load(); got != 4 {
						t.Fatalf("outstanding messages=%d, want 4", got)
					}
					if got := r.p.queuedBytes.Load(); got != int64(2*len(big)+len(fourth)+len(small)) {
						t.Fatalf("outstanding bytes=%d", got)
					}
					r.enqueue(t, small)
					if r.p.ctx.Err() == nil {
						t.Fatal("pending frames and channel bypassed message limit")
					}
					close(r.g.release)
					flushTestFrame(t, r)
					flushTestClose(t, r, websocket.StatusTryAgainLater, "slow-consumer")
					flushTestSignal(t, r.done, "writer did not exit")
				})
			}
		})
	}
}

func TestPresenceFlushQueuedMessageLimitMatchesImmediate(t *testing.T) {
	for _, ms := range []int{0, 50, 100} {
		t.Run(strconv.Itoa(ms), func(t *testing.T) {
			h := newPresenceHub(nil, nil)
			h.flushMs = ms
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			p := &presencePeer{ctx: ctx, cancel: cancel, queue: make(chan []byte, 64)}
			b := flushTestEncode(t, &contract.PresenceLeave{AccountId: "alice"})
			h.mu.Lock()
			defer h.mu.Unlock()
			for range 64 {
				h.enqueue(p, b)
			}
			if p.ctx.Err() != nil {
				t.Fatal("stopped before QueueMessages limit")
			}
			h.enqueue(p, b)
			if p.ctx.Err() == nil || p.closeReason != "slow-consumer" {
				t.Fatal("queue overflow did not stop peer")
			}
			if len(p.queue) != 64 || p.queuedBytes.Load() != int64(64*len(b)) {
				t.Fatal("rejected event was charged or admitted")
			}
		})
	}
}

// Cancel after the outer loop's precheck, just as the selected branch starts
// flushing. This forces the no-write cancellation return from flush().
type flushTestCancelContext struct {
	context.Context
	checks           atomic.Int64
	stopAt, pauseAt  int64
	entered, release chan struct{}
	stop             func()
}

func (c *flushTestCancelContext) Err() error {
	check := c.checks.Add(1)
	if check == c.pauseAt {
		close(c.entered)
		select {
		case <-c.release:
		case <-c.Context.Done():
		}
	}
	if check == c.stopAt {
		c.stop()
	}
	return c.Context.Err()
}
func TestPresenceFlushStopBeforeFrameSendsClose(t *testing.T) {
	for _, ms := range []int{0, 50, 100} {
		for _, trigger := range []string{"urgent", "sweep"} {
			t.Run(strconv.Itoa(ms)+"/"+trigger, func(t *testing.T) {
				cancelCtx := &flushTestCancelContext{stopAt: 2, entered: make(chan struct{}), release: make(chan struct{})}
				if trigger == "sweep" && ms > 0 {
					cancelCtx.pauseAt = 2
					cancelCtx.stopAt = 3
				}
				r := flushTestNew(t, ms, 8, func(r *flushTestRig) {
					var message proto.Message = &contract.PresenceReady{AccountId: "alice"}
					if trigger == "sweep" {
						message = &contract.PresenceLeave{AccountId: "alice"}
					}
					r.enqueue(t, flushTestEncode(t, message))
					cancelCtx.Context = r.p.ctx
					cancelCtx.stop = func() { r.p.stop(presenceReplaced, "replaced") }
					r.p.ctx = cancelCtx
				})
				if cancelCtx.pauseAt != 0 {
					flushTestSignal(t, cancelCtx.entered, "writer did not hold event")
					r.p.flushWake <- struct{}{}
					close(cancelCtx.release)
				}
				flushTestClose(t, r, presenceReplaced, "replaced")
				flushTestSignal(t, r.done, "writer did not exit")
				if r.h.writeCalls.Load() != 0 {
					t.Fatal("started a data frame after cancellation")
				}
			})
		}
	}
}

// A failed websocket write closes the transport itself. The writer must still
// select slow-consumer and finish through its shared close path.
func TestPresenceFlushWriteErrorStopsWriter(t *testing.T) {
	for _, ms := range []int{0, 50, 100} {
		for _, trigger := range []string{"urgent", "sweep"} {
			t.Run(strconv.Itoa(ms)+"/"+trigger, func(t *testing.T) {
				r := flushTestNew(t, ms, 8)
				r.g.armed.Store(true)
				r.g.fail.Store(true)
				var message proto.Message = &contract.PresenceReady{AccountId: "alice"}
				if trigger == "sweep" {
					message = &contract.PresenceLeave{AccountId: "alice"}
				}
				r.enqueue(t, flushTestEncode(t, message))
				if trigger == "sweep" && ms > 0 {
					flushTestHeld(t, r)
					r.p.flushWake <- struct{}{}
				}
				flushTestSignal(t, r.g.entered, "write did not start")
				close(r.g.release)
				flushTestSignal(t, r.done, "writer did not exit after write error")
				if r.p.ctx.Err() == nil || r.p.closeCode != websocket.StatusTryAgainLater || r.p.closeReason != "slow-consumer" {
					t.Fatal("write error did not select slow-consumer")
				}
				select {
				case <-r.errs:
				case <-time.After(time.Second):
					t.Fatal("transport remained open after write error")
				}
			})
		}
	}
}
