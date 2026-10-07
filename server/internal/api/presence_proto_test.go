package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
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

func TestPresenceRequiresProtocol(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	ts := startPresence(t, x, presenceTestConfig())
	for _, protocols := range [][]string{nil, {"glimway.presence.future"}} {
		conn, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {c.String()}, "Origin": {ts.URL}}, Subprotocols: protocols})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, _, err = conn.Read(ctx)
		cancel()
		conn.CloseNow()
		if websocket.CloseStatus(err) != presenceReload || !strings.Contains(err.Error(), "reload-needed") {
			t.Fatalf("protocol rejection: %v", err)
		}
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
	for name, payload := range map[string]proto.Message{
		"server-join-player":  &contract.PresenceJoin{Area: "village", Player: &contract.PresencePlayer{HabiticaId: "bob"}},
		"server-position-id":  &contract.PresencePosition{HabiticaId: proto.String("bob"), X: proto.Float64(0), Y: proto.Float64(0), Facing: &contract.PresenceFacing{X: proto.Float64(0), Y: proto.Float64(1)}, Moving: proto.Bool(false)},
		"server-emote-id":     &contract.PresenceEmote{Id: "wave", HabiticaId: proto.String("bob")},
		"server-ready":        &contract.PresenceReady{HabiticaId: "bob"},
		"non-finite-position": &contract.PresencePosition{X: proto.Float64(math.NaN()), Y: proto.Float64(0), Facing: &contract.PresenceFacing{X: proto.Float64(0), Y: proto.Float64(1)}, Moving: proto.Bool(false)},
	} {
		b, err := encodePresence(payload)
		if err != nil {
			t.Fatal(err)
		}
		cases = append(cases, struct {
			name  string
			typ   websocket.MessageType
			bytes []byte
			code  websocket.StatusCode
		}{name, websocket.MessageBinary, b, websocket.StatusPolicyViolation})
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
		flat, err := presenceFixtureJSON(&envelope)
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
	{
		h := newPresenceHub(nil)
		ctx, cancel := context.WithCancel(context.Background())
		p := &presencePeer{ctx: ctx, cancel: cancel, queue: make(chan []byte, 1)}
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

// Test-only JSON projection makes fixture keys observable without adding a JSON
// presence path to the server. Optional zero/false fields are never synthesized.
func presenceFixtureJSON(envelope *contract.PresenceMessage) ([]byte, error) {
	b, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(envelope)
	if err != nil {
		return nil, err
	}
	var fields map[string]map[string]any
	if err = json.Unmarshal(b, &fields); err != nil {
		return nil, err
	}
	for event, payload := range fields {
		if event == "join" && envelope.GetJoin().Player == nil {
			delete(payload, "player")
		}
		payload["type"] = event
		return json.Marshal(payload)
	}
	return nil, fmt.Errorf("missing event")
}

func TestPresenceBinaryAuthRejectsUnknownFields(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	ts := startPresence(t, x, presenceTestConfig())
	conn, _, err := dialPresence(t, ts, c, ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	w := readPresence(t, conn)
	auth := &contract.PresenceAuth{Lease: s.Lease}
	auth.ProtoReflect().SetUnknown([]byte{0x78, 1})
	b, err := encodePresence(auth)
	if err != nil {
		t.Fatal(err)
	}
	if err = conn.Write(context.Background(), websocket.MessageBinary, b); err != nil {
		t.Fatal(err)
	}
	w.closeStatus(presenceUnauthorized)
}
