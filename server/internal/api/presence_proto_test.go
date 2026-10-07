package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func wsBinaryAuthenticate(t *testing.T, ts *httptest.Server, c *http.Cookie, lease string) *wsClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {c.String()}, "Origin": {ts.URL}}, Subprotocols: []string{presenceProtocol}})
	if err != nil {
		t.Fatal(err)
	}
	if conn.Subprotocol() != presenceProtocol {
		t.Fatal("binary protocol not negotiated")
	}
	w := readPresence(t, conn)
	w.send(map[string]any{"type": "auth", "lease": lease})
	return w
}

func wsBinaryConnect(t *testing.T, ts *httptest.Server, c *http.Cookie, lease string) *wsClient {
	t.Helper()
	w := wsBinaryAuthenticate(t, ts, c, lease)
	w.expect("ready")
	return w
}

func TestPresenceBinaryCloseCodes(t *testing.T) {
	t.Run("unauthorized", func(t *testing.T) {
		x := newRig(t)
		c, s := x.ready("alice")
		ts := startPresence(t, x, presenceTestConfig())
		w := wsBinaryAuthenticate(t, ts, c, s.Lease[:63])
		w.closeStatus(presenceUnauthorized)
	})
	t.Run("superseded", func(t *testing.T) {
		x := newRig(t)
		c, _ := x.ready("alice")
		ts := startPresence(t, x, presenceTestConfig())
		w := wsBinaryAuthenticate(t, ts, c, strings.Repeat("z", 64))
		w.closeStatus(presenceSuperseded)
	})
	t.Run("idle", func(t *testing.T) {
		x := newRig(t)
		c, s := x.ready("alice")
		config := presenceTestConfig()
		config.IdleTimeoutMs = 80
		config.PingIntervalMs = 20
		config.PongTimeoutMs = 10
		ts := startPresence(t, x, config)
		w := wsBinaryConnect(t, ts, c, s.Lease)
		w.closeStatus(presenceIdle)
	})
}

func TestPresenceMixedVersions(t *testing.T) {
	for _, binaryFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "JSON-first", true: "binary-first"}[binaryFirst], func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			bc, b := x.member("bob", s.WorldID)
			ts := startPresence(t, x, presenceTestConfig())
			first, second := wsConnect, wsBinaryConnect
			if binaryFirst {
				first, second = second, first
			}
			a := first(t, ts, c, s.Lease)
			a.join("village")
			bob := second(t, ts, bc, b.Lease)
			if roster := bob.join("village"); len(roster.Players) != 1 || roster.Players[0].Avatar == nil {
				t.Fatal("mixed roster", roster.Raw)
			}
			a.expect("join")
			a.send(positionMessage(10))
			if bob.expect("pos").X != 10 {
				t.Fatal("first position")
			}
			bob.send(positionMessage(20))
			if a.expect("pos").X != 20 {
				t.Fatal("second position")
			}
			a.send(map[string]any{"type": "emote", "id": "wave"})
			bob.expect("emote")
			bob.send(map[string]any{"type": "emote", "id": "nod"})
			a.expect("emote")
			// A new socket in the other format resumes the room and replaces the old.
			replacement := second(t, ts, c, s.Lease)
			a.closeStatus(presenceReplaced)
			replacement.expect("room")
			bob.expect("join")
			replacement.join("woodland")
			bob.expect("leave")
		})
	}
}

func TestPresenceBinaryRejectsMalformedFrames(t *testing.T) {
	cases := []struct {
		name  string
		typ   websocket.MessageType
		bytes []byte
		code  websocket.StatusCode
	}{
		{"text", websocket.MessageText, []byte(`{"type":"heartbeat"}`), websocket.StatusUnsupportedData},
		{"truncated", websocket.MessageBinary, []byte{0x1a, 0x20}, websocket.StatusPolicyViolation},
		{"empty", websocket.MessageBinary, nil, websocket.StatusPolicyViolation},
		{"missing-position", websocket.MessageBinary, []byte{0x1a, 0}, websocket.StatusPolicyViolation},
		{"unknown-envelope", websocket.MessageBinary, []byte{0x2a, 0, 0x78, 1}, websocket.StatusPolicyViolation},
		{"unknown-nested", websocket.MessageBinary, []byte{0x2a, 2, 0x78, 1}, websocket.StatusPolicyViolation},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			ts := startPresence(t, x, presenceTestConfig())
			w := wsBinaryConnect(t, ts, c, s.Lease)
			w.join("village")
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := w.conn.Write(ctx, tt.typ, tt.bytes); err != nil {
				t.Fatal(err)
			}
			w.closeStatus(tt.code)
		})
	}
}

type presenceFixture struct {
	JSON      json.RawMessage `json:"json"`
	BinaryHex string          `json:"binaryHex"`
}

func TestPresenceGolden(t *testing.T) {
	path := "testdata/presence.json"
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []presenceFixture
	if err = json.Unmarshal(b, &fixtures); err != nil {
		t.Fatal(err)
	}
	for i, f := range fixtures {
		if f.BinaryHex == "" {
			t.Fatalf("fixture %d has no binary oracle", i)
		}
		var fields map[string]json.RawMessage
		if err = json.Unmarshal(f.JSON, &fields); err != nil {
			t.Fatal(err)
		}
		var event string
		if err = json.Unmarshal(fields["type"], &event); err != nil {
			t.Fatal(err)
		}
		delete(fields, "type")
		payload, _ := json.Marshal(fields)
		input, _ := json.Marshal(map[string]json.RawMessage{event: payload})
		var envelope contract.PresenceMessage
		if err = protojson.Unmarshal(input, &envelope); err != nil {
			t.Fatal(err)
		}
		flat, err := presenceJSON(&envelope, event != "auth" && event != "heartbeat" && !(event == "join" && envelope.GetJoin().Player == nil))
		if err != nil {
			t.Fatal(err)
		}
		var got, want any
		json.Unmarshal(flat, &got)
		json.Unmarshal(f.JSON, &want)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("fixture %d: got %s want %s", i, flat, f.JSON)
		}
		if f.BinaryHex != "" {
			binary, err := hex.DecodeString(f.BinaryHex)
			if err != nil {
				t.Fatal(err)
			}
			var decoded contract.PresenceMessage
			if err = proto.Unmarshal(binary, &decoded); err != nil {
				t.Fatal(err)
			}
			if !proto.Equal(&decoded, &envelope) {
				t.Fatalf("binary fixture %d disagrees with JSON", i)
			}
		}
	}
}

func TestPresenceEncodedQueueLimits(t *testing.T) {
	for _, binary := range []bool{false, true} {
		h := newPresenceHub(nil)
		ctx, cancel := context.WithCancel(context.Background())
		p := &presencePeer{binary: binary, ctx: ctx, cancel: cancel, queue: make(chan []byte, 1)}
		m := &contract.PresenceReady{HabiticaId: "alice"}
		h.send(p, m)
		b := <-p.queue
		if p.queuedBytes != len(b) {
			t.Fatal("queue byte accounting")
		}
		p.queue <- b
		h.send(p, m)
		if p.closeCode != websocket.StatusTryAgainLater || p.closeReason != "slow-consumer" {
			t.Fatal("queue overflow did not stop peer")
		}
		cancel()
	}
}
