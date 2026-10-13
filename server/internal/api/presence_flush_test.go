package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	contract "glimway/server/internal/gen/glimway/v2"
)

func TestPresenceFlushHoldsEventsAndUrgentResultCarriesQueue(t *testing.T) {
	h := newPresenceHub(nil, nil)
	h.flushMs = 50
	a := &Server{presence: h}
	peers := make(chan *presencePeer, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		p := &presencePeer{ctx: ctx, cancel: cancel, conn: c, queue: make(chan []byte, 8), flushWake: make(chan struct{}, 1), lastActivity: time.Now(), pingAt: time.Now()}
		h.mu.Lock()
		h.peers["peer"] = p
		h.mu.Unlock()
		peers <- p
		<-ctx.Done()
		_ = c.Close(websocket.StatusNormalClosure, "done")
	}))
	defer ts.Close()
	client, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(ts.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	client.SetReadLimit(131072)
	defer client.CloseNow()
	p := <-peers
	frames := make(chan [][]byte, 4)
	readErr := make(chan error, 1)
	go func() {
		for {
			_, frame, err := client.Read(context.Background())
			if err != nil {
				readErr <- err
				return
			}
			events, err := splitPresenceFrame(frame)
			if err != nil {
				readErr <- err
				return
			}
			frames <- events
		}
	}()
	writerDone := make(chan struct{})
	go func() { defer close(writerDone); a.presenceWriter(p) }()
	go func() { defer close(h.sweepDone); a.presenceSweep() }()
	defer func() { close(h.sweepStop); <-h.sweepDone; p.stop(websocket.StatusNormalClosure, "done"); <-writerDone }()
	leave, _ := encodePresence(&contract.PresenceLeave{AccountId: "alice"})
	result, _ := encodePresence(&contract.FightSwingResult{SwingCounter: 4})
	h.mu.Lock()
	h.enqueue(p, leave)
	h.mu.Unlock()
	select {
	case got := <-frames:
		t.Fatalf("nonurgent event flushed early: %x", got)
	case err := <-readErr:
		t.Fatal(err)
	case <-time.After(15 * time.Millisecond):
	}
	h.mu.Lock()
	h.enqueue(p, result)
	h.mu.Unlock()
	select {
	case got := <-frames:
		if len(got) != 2 || string(got[0]) != string(leave) || string(got[1]) != string(result) {
			t.Fatalf("urgent frame order/content: %x", got)
		}
	case err := <-readErr:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("urgent swing result waited for shared flush")
	}

	// A normal queued event is released by the one hub sweep without a peer timer.
	emote, _ := encodePresence(&contract.PresenceEmote{Id: "wave"})
	h.mu.Lock()
	h.enqueue(p, emote)
	h.mu.Unlock()
	select {
	case got := <-frames:
		if len(got) != 1 || string(got[0]) != string(emote) {
			t.Fatalf("sweep frame: %x", got)
		}
	case err := <-readErr:
		t.Fatal(err)
	case <-time.After(300 * time.Millisecond):
		t.Fatal("shared sweep did not wake queued writer")
	}

	// A held batch preserves the 64 KiB frame cap; a lone event may still use
	// the configured 128 KiB single-event limit.
	largeA, _ := encodePresence(&contract.PresenceEmote{Id: strings.Repeat("a", 40000)})
	largeB, _ := encodePresence(&contract.PresenceEmote{Id: strings.Repeat("b", 40000)})
	h.mu.Lock()
	h.enqueue(p, largeA)
	h.enqueue(p, largeB)
	h.mu.Unlock()
	p.flushWake <- struct{}{}
	for i := 0; i < 2; i++ {
		select {
		case got := <-frames:
			if len(got) != 1 {
				t.Fatalf("oversized batch frame contained %d events", len(got))
			}
		case err := <-readErr:
			t.Fatal(err)
		case <-time.After(time.Second):
			t.Fatal("capped backlog did not emit multiple frames")
		}
	}
	oversized, _ := encodePresence(&contract.PresenceEmote{Id: strings.Repeat("c", 100000)})
	h.mu.Lock()
	h.enqueue(p, oversized)
	h.mu.Unlock()
	p.flushWake <- struct{}{}
	select {
	case got := <-frames:
		if len(got) != 1 || len(got[0]) != len(oversized) {
			t.Fatalf("single oversized event frame: events=%d bytes=%d", len(got), len(got[0]))
		}
	case err := <-readErr:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("single event over frame cap was not emitted")
	}
}
