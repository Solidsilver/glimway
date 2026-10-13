package api

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	contract "glimway/server/internal/gen/glimway/v2"
)

func TestPresenceMaximumAdmittedEventFitsFrameLimit(t *testing.T) {
	const frameLimit = 131072
	h := newPresenceHub(nil, nil)
	encode := func(nameLen int) []byte {
		b, err := encodePresence(&contract.PresenceGift{FromName: string(bytes.Repeat([]byte("g"), nameLen))})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	lo, hi := 0, 131064
	var event []byte
	nameLen := -1
	for lo <= hi {
		mid := lo + (hi-lo)/2
		candidate := encode(mid)
		size := presenceEventSize(candidate)
		if size == frameLimit {
			event = candidate
			nameLen = mid
			break
		}
		if size < frameLimit {
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	if event == nil || presenceEventSize(event) != frameLimit {
		t.Fatal("could not construct an event exactly at the frame limit")
	}

	ctx, cancel := context.WithCancel(context.Background())
	p := &presencePeer{ctx: ctx, cancel: cancel, queue: make(chan []byte, 1)}
	h.mu.Lock()
	h.enqueue(p, event)
	h.mu.Unlock()
	if ctx.Err() != nil {
		t.Fatal("event at the maximum framed size was refused")
	}
	frame, carry, _ := fillPresenceFrame(nil, <-p.queue, p.queue)
	if len(frame) != frameLimit || carry != nil {
		t.Fatalf("maximum admitted event encoded as frame %d (event %d; envelope %d)", len(frame), len(event), presenceEventSize(event))
	}
	cancel()

	ctx, cancel = context.WithCancel(context.Background())
	p = &presencePeer{ctx: ctx, cancel: cancel, queue: make(chan []byte, 1)}
	h.mu.Lock()
	h.enqueue(p, encode(nameLen+1))
	h.mu.Unlock()
	if ctx.Err() == nil || len(p.queue) != 0 {
		t.Fatal("event whose framed size exceeds 128 KiB was admitted")
	}
}

type reviewPingGate struct {
	net.Conn
	entered, closed, release chan struct{}
	once                     sync.Once
}

func (g *reviewPingGate) Write(b []byte) (int, error) {
	if len(b) > 0 && b[0] == 0x89 {
		close(g.entered)
		select {
		case <-g.closed:
			return 0, net.ErrClosed
		case <-g.release:
			return g.Conn.Write(b)
		}
	}
	return g.Conn.Write(b)
}
func (g *reviewPingGate) Close() error {
	g.once.Do(func() { close(g.closed) })
	return g.Conn.Close()
}

type reviewPingHijacker struct {
	http.ResponseWriter
	gate chan *reviewPingGate
}

func (w reviewPingHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, rw, err := w.ResponseWriter.(http.Hijacker).Hijack()
	if err != nil {
		return nil, nil, err
	}
	if err = rw.Writer.Flush(); err != nil {
		return nil, nil, err
	}
	g := &reviewPingGate{Conn: c, entered: make(chan struct{}), closed: make(chan struct{}), release: make(chan struct{})}
	rw.Writer.Reset(g)
	w.gate <- g
	return g, rw, nil
}

func TestPresencePingCancellationPreservesCloseCode(t *testing.T) {
	gates := make(chan *reviewPingGate, 1)
	peers := make(chan *presencePeer, 1)
	h := newPresenceHub(nil, nil)
	a := &Server{presence: h}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(reviewPingHijacker{ResponseWriter: w, gate: gates}, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		p := &presencePeer{ctx: ctx, cancel: cancel, conn: c, queue: make(chan []byte, 1)}
		peers <- p
		_, _, _ = c.Read(context.Background())
	}))
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	p, g := <-peers, <-gates
	pingDone := make(chan struct{})
	go func() { defer close(pingDone); a.pingPeer(p) }()
	<-g.entered // Ping holds the transport write lock while its frame is gated.
	p.stop(presenceReplaced, "replaced")
	go func() {
		select {
		case <-g.closed:
		case <-time.After(50 * time.Millisecond):
		}
		close(g.release)
	}()
	writerDone := make(chan struct{})
	go func() { defer close(writerDone); a.presenceWriter(p) }()
	_, _, err = client.Read(ctx)
	if got := websocket.CloseStatus(err); got != presenceReplaced {
		t.Errorf("close status=%d, expected replaced %d: %v", got, presenceReplaced, err)
	}
	<-pingDone
	<-writerDone
	h.mu.Lock()
	pinging := p.pinging
	h.mu.Unlock()
	if pinging {
		t.Error("ping in-flight flag was not cleared")
	}
	if p.closeCode != presenceReplaced || p.closeReason != "replaced" {
		t.Errorf("close reason changed during ping: %d %q", p.closeCode, p.closeReason)
	}
}
