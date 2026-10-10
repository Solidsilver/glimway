package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"glimway/content"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	contract "glimway/server/internal/gen/glimway/v2"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/structpb"
)

type presenceTestLog struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (l *presenceTestLog) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buffer.Write(b)
}
func (l *presenceTestLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buffer.String()
}

func TestPresenceLogsExcludeSecrets(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	logs := &presenceTestLog{}
	x.api.Config.Logger = log.New(logs, "", 0)
	ts := startPresence(t, x, presenceTestConfig())
	w := wsConnect(t, ts, c, s.Lease)
	w.join("village")
	h := http.Header{"Origin": []string{ts.URL}, "Cookie": []string{c.String()}}
	conn, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws?lease="+s.Lease, &websocket.DialOptions{HTTPHeader: h, Subprotocols: []string{presenceProtocol}})
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil {
		t.Fatal("query accepted")
	}
	x.api.ClosePresence()
	w.closeStatus(websocket.StatusGoingAway)
	deadline := time.Now().Add(time.Second)
	for !strings.Contains(logs.String(), "status=101") && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	logged := logs.String()
	if !strings.Contains(logged, "route=/ws status=101") || !strings.Contains(logged, "route=/ws status=403") || strings.Contains(logged, s.Lease) || strings.Contains(logged, c.Value) || strings.Contains(logged, secret) || strings.Contains(logged, "?lease") {
		t.Fatal("unexpected presence request log", logged)
	}
}

// Fixture views expose field presence and nullable values for assertions.
type presenceAvatar struct {
	Appearance    rules.Appearance   `json:"appearance"`
	Equipped      map[string]*string `json:"equipped"`
	Costume       map[string]*string `json:"costume"`
	UseCostume    bool               `json:"useCostume"`
	SelectedPet   *string            `json:"selectedPet"`
	SelectedMount *string            `json:"selectedMount"`
}
type presencePlayer struct {
	AccountID   string            `json:"accountId"`
	DisplayName string            `json:"displayName"`
	Avatar      *presenceAvatar   `json:"avatar"`
	Pos         *presencePosition `json:"pos"`
}

type wsEvent struct {
	Type      string                 `json:"type"`
	Area      string                 `json:"area"`
	AccountID string                 `json:"accountId"`
	ID        string                 `json:"id"`
	Player    presencePlayer         `json:"player"`
	Players   []presencePlayer       `json:"players"`
	X         float64                `json:"x"`
	Y         float64                `json:"y"`
	Facing    struct{ X, Y float64 } `json:"facing"`
	Moving    bool                   `json:"moving"`
	Binary    []byte                 `json:"-"`
	Raw       string                 `json:"-"`
}

func TestPresenceAvatarIsBoundedVisualData(t *testing.T) {
	p := profile("alice", 1, 0, 20)
	gear := strings.Repeat("a", 128)
	unsafe := strings.Repeat("\x00", 128)
	oversized := strings.Repeat("a", 129)
	p.Equipped["weapon"] = &gear
	p.Equipped["shield"] = &oversized
	p.Equipped["apiToken"] = &unsafe
	p.Costume["head"] = &unsafe
	p.SelectedMount = &oversized
	p.SelectedPet = &unsafe
	p.Appearance.Skin = strings.Repeat("a", 65)
	p.Appearance.Background = "<script>"
	v := visualAvatar(p, store.Companions{})
	if len(v.Equipped) != len(rules.Slots) || len(v.Costume) != len(rules.Slots) || v.Equipped["weapon"].GetStringValue() != gear || v.Equipped["shield"].GetKind() == nil || v.Equipped["shield"].GetStringValue() != "" || v.Costume["head"].GetKind() == nil || v.Costume["head"].GetStringValue() != "" || v.SelectedPet != nil || v.SelectedMount != nil || v.Appearance.Skin != "" || v.Appearance.Background != "" {
		t.Fatal("unsafe or oversized avatar descriptor", store.JSON(v))
	}
	for _, value := range []*structpb.Value{v.Equipped["shield"], v.Costume["head"]} {
		if _, ok := value.Kind.(*structpb.Value_NullValue); !ok {
			t.Fatal("empty equipment slot lost its explicit null")
		}
	}

	if strings.Contains(store.JSON(v), "apiToken") {
		t.Fatal("unknown equipment slot relayed")
	}
}

type wsClient struct {
	t      *testing.T
	conn   *websocket.Conn
	events chan wsEvent
	closed chan error
}

func startPresence(t *testing.T, x *rig, c *content.Presence) *httptest.Server {
	t.Helper()
	cfg := x.api.Config
	cfg.Presence = c
	x.api = New(x.db, x.api.Habitica, cfg)
	// Ward pulses land when the test says so (review finding 12): the hub
	// schedules them on the rig's queue instead of the wall clock.
	x.pulses = &wardPulseQueue{}
	x.api.presence.afterFunc = x.pulses.after
	ts := httptest.NewServer(x.api)
	t.Cleanup(func() { x.api.ClosePresence(); ts.Close() })
	return ts
}
func presenceTestConfig() *content.Presence {
	// A clone: tests mutate their copy, never the shared rules table.
	c := proto.Clone(content.PresenceRules).(*content.Presence)
	c.LeaveGraceMs = 120
	c.JoinCooldownMs = 1
	c.RevalidateMs = 50
	return c
}
func dialPresence(t *testing.T, ts *httptest.Server, c *http.Cookie, origin string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	h := http.Header{}
	if c != nil {
		h.Set("Cookie", c.String())
	}
	if origin != "" {
		h.Set("Origin", origin)
	}
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: h, Subprotocols: []string{presenceProtocol}})
}
func wsAuthenticate(t *testing.T, ts *httptest.Server, c *http.Cookie, lease string) *wsClient {
	t.Helper()
	conn, _, err := dialPresence(t, ts, c, ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	w := readPresence(t, conn)
	w.send(map[string]any{"type": "auth", "lease": lease})
	return w
}
func readPresence(t *testing.T, conn *websocket.Conn) *wsClient {
	t.Helper()
	conn.SetReadLimit(131072)
	w := &wsClient{t: t, conn: conn, events: make(chan wsEvent, 1024), closed: make(chan error, 1)}
	go func() {
		for {
			typ, b, err := conn.Read(context.Background())
			if err != nil {
				w.closed <- err
				return
			}
			if typ != websocket.MessageBinary {
				w.closed <- fmt.Errorf("expected binary response")
				return
			}
			raw := append([]byte(nil), b...)
			var envelope contract.PresenceMessage
			if err = proto.Unmarshal(b, &envelope); err != nil {
				w.closed <- err
				return
			}
			b, err = presenceFixtureJSON(&envelope)
			if err != nil {
				w.closed <- err
				return
			}
			var e wsEvent
			if err = json.Unmarshal(b, &e); err != nil {
				w.closed <- err
				return
			}
			e.Raw = string(b)
			e.Binary = raw
			w.events <- e
		}
	}()
	t.Cleanup(func() { conn.CloseNow() })
	return w
}
func wsConnect(t *testing.T, ts *httptest.Server, c *http.Cookie, lease string) *wsClient {
	t.Helper()
	w := wsAuthenticate(t, ts, c, lease)
	w.expect("ready")
	return w
}
func (w *wsClient) send(v any) {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	b := []byte(store.JSON(v))
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(b, &fields); err != nil {
		w.t.Fatal(err)
	}
	var event string
	if err := json.Unmarshal(fields["type"], &event); err != nil {
		w.t.Fatal(err)
	}
	delete(fields, "type")
	payload, _ := json.Marshal(fields)
	envelopeJSON, _ := json.Marshal(map[string]json.RawMessage{event: payload})
	var envelope contract.PresenceMessage
	if err := protojson.Unmarshal(envelopeJSON, &envelope); err != nil {
		w.t.Fatal(err)
	}
	var err error
	b, err = proto.Marshal(&envelope)
	if err != nil {
		w.t.Fatal(err)
	}
	if err := w.conn.Write(ctx, websocket.MessageBinary, b); err != nil {
		w.t.Fatal(err)
	}
}
func (w *wsClient) expect(typ string) wsEvent {
	w.t.Helper()
	select {
	case e := <-w.events:
		if e.Type != typ {
			w.t.Fatalf("got %s want %s: %s", e.Type, typ, e.Raw)
		}
		return e
	case err := <-w.closed:
		w.t.Fatal(err)
	case <-time.After(2 * time.Second):
		w.t.Fatalf("timed out waiting for %s", typ)
	}
	return wsEvent{}
}
func (w *wsClient) none() {
	w.t.Helper()
	select {
	case e := <-w.events:
		w.t.Fatalf("unexpected message %s", e.Raw)
	case err := <-w.closed:
		w.t.Fatal(err)
	case <-time.After(30 * time.Millisecond):
	}
}
func (w *wsClient) closeStatus(code websocket.StatusCode) {
	w.t.Helper()
	select {
	case err := <-w.closed:
		if got := websocket.CloseStatus(err); got != code {
			w.t.Fatalf("close status got %d want %d: %v", got, code, err)
		}
	case <-time.After(2 * time.Second):
		w.t.Fatal("socket didn't close")
	}
}
func (w *wsClient) join(area string) wsEvent {
	w.t.Helper()
	w.send(map[string]any{"type": "join", "area": area})
	return w.expect("room")
}
func positionMessage(x float64) map[string]any {
	return map[string]any{"type": "pos", "x": x, "y": 20, "facing": map[string]any{"x": 0, "y": 1}, "moving": true}
}

func TestPresenceRoomsAvatarsAndMemoryOnly(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	oc, o := x.ready("outsider")
	ts := startPresence(t, x, presenceTestConfig())
	// Capture persistence after all HTTP setup; sockets must not even slide sessions.
	var expiry, seen int64
	x.db.DB.QueryRow("SELECT expires_at FROM sessions WHERE id_hash=?", store.Hash(c.Value)).Scan(&expiry)
	x.db.DB.QueryRow("SELECT lease_seen_at FROM players WHERE account_id='" + x.account("alice") + "'").Scan(&seen)
	before := s.Snapshot
	ledger := count(t, x.db, "SELECT count(*) FROM ledger")
	a := wsConnect(t, ts, c, s.Lease)
	if len(a.join("village").Players) != 0 {
		t.Fatal("nonempty room")
	}
	bob := wsConnect(t, ts, bc, b.Lease)
	roster := bob.join("village")
	if len(roster.Players) != 1 || roster.Players[0].AccountID != x.account("alice") || roster.Players[0].DisplayName != "Hero" || roster.Players[0].Avatar == nil {
		t.Fatal("roster metadata", roster.Raw)
	}
	joined := a.expect("join")
	if joined.Player.AccountID != x.account("bob") || joined.Player.Avatar == nil {
		t.Fatal("arrival")
	}
	if strings.Contains(joined.Raw, "stats") || strings.Contains(joined.Raw, "maxHp") || strings.Contains(joined.Raw, secret) || strings.Contains(joined.Raw, s.Lease) {
		t.Fatal("private data relayed")
	}
	outsider := wsConnect(t, ts, oc, o.Lease)
	if len(outsider.join("village").Players) != 0 {
		t.Fatal("cross-world roster")
	}
	a.none()
	bob.none()
	a.send(positionMessage(10))
	pos := bob.expect("pos")
	if pos.AccountID != x.account("alice") || pos.X != 10 || strings.Contains(pos.Raw, "avatar") || strings.Contains(pos.Raw, "displayName") {
		t.Fatal("compact position")
	}
	outsider.none()
	a.none()
	a.send(map[string]any{"type": "emote", "id": "wave"})
	if bob.expect("emote").ID != "wave" {
		t.Fatal("emote")
	}
	bob.join("woodland")
	if a.expect("leave").AccountID != x.account("bob") {
		t.Fatal("room leave")
	}
	a.send(map[string]any{"type": "emote", "id": "nod"})
	bob.none()
	if len(a.join("wilds:inner-1:0:0").Players) != 0 {
		t.Fatal("chunk roster")
	}
	if len(bob.join("wilds:inner-1:1:0").Players) != 0 {
		t.Fatal("chunk isolation")
	}
	a.none()
	var afterExpiry, afterSeen int64
	x.db.DB.QueryRow("SELECT expires_at FROM sessions WHERE id_hash=?", store.Hash(c.Value)).Scan(&afterExpiry)
	x.db.DB.QueryRow("SELECT lease_seen_at FROM players WHERE account_id='" + x.account("alice") + "'").Scan(&afterSeen)
	if afterExpiry != expiry || afterSeen != seen || count(t, x.db, "SELECT count(*) FROM ledger") != ledger {
		t.Fatal("presence wrote persistence")
	}
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(context.Background(), tx, x.account("alice"))
	tx.Rollback()
	if err != nil {
		t.Fatal(err)
	}
	unchanged(t, before, loaded)
}
func TestPresenceTakeoverReplacementAndGrace(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	ts := startPresence(t, x, presenceTestConfig())
	a := wsConnect(t, ts, c, s.Lease)
	a.join("village")
	bob := wsConnect(t, ts, bc, b.Lease)
	bob.join("village")
	a.expect("join")
	replacement := wsConnect(t, ts, c, s.Lease)
	replacement.expect("room")
	a.closeStatus(presenceReplaced)
	bob.expect("join")
	bob.none()
	replacement.conn.CloseNow()
	// Reconnect while the peer remains in its grace period; no leave/duplicate.
	resumed := wsConnect(t, ts, c, s.Lease)
	room := resumed.expect("room")
	if len(room.Players) != 1 {
		t.Fatal("resume lost room")
	}
	bob.expect("join")
	bob.none()
	taken := x.expect("POST", "/api/play", map[string]any{"clientId": "new-tab", "takeOver": true}, c, 200)
	resumed.closeStatus(presenceSuperseded)
	if bob.expect("leave").AccountID != x.account("alice") {
		t.Fatal("takeover leave")
	}
	stale := wsAuthenticate(t, ts, c, s.Lease)
	stale.closeStatus(presenceSuperseded)
	next := wsConnect(t, ts, c, taken.Lease)
	if len(next.join("village").Players) != 1 {
		t.Fatal("new lease room")
	}
	bob.expect("join")
	next.conn.CloseNow()
	if bob.expect("leave").AccountID != x.account("alice") {
		t.Fatal("disconnect grace leave")
	}
}
func TestPresenceRateLimitsAndEmotes(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	ts := startPresence(t, x, presenceTestConfig())
	a := wsConnect(t, ts, c, s.Lease)
	a.join("village")
	bob := wsConnect(t, ts, bc, b.Lease)
	bob.join("village")
	a.expect("join")
	start := time.Now()
	for i := 0; i < 40; i++ {
		a.send(positionMessage(float64(i)))
	}
	a.send(map[string]any{"type": "emote", "id": "wave"})
	n := 0
	for {
		e := bob.expectAny()
		if e.Type == "emote" {
			break
		}
		if e.Type != "pos" {
			t.Fatal(e.Raw)
		}
		n++
	}
	limit := 1 + int(math.Ceil(time.Since(start).Seconds()*8))
	if n < 1 || n > limit || n >= 40 {
		t.Fatal("position limiter", n, limit)
	}
	a.send(map[string]any{"type": "emote", "id": "nod"})
	bob.none()
	// Pause beyond one tick to establish that throttling recovers rather than disconnecting.
	time.Sleep(130 * time.Millisecond)
	a.send(positionMessage(123))
	if bob.expect("pos").X != 123 {
		t.Fatal("rate recovery")
	}
	a.send(map[string]any{"type": "emote", "id": "unknown"})
	a.closeStatus(websocket.StatusPolicyViolation)
}
func (w *wsClient) expectAny() wsEvent {
	w.t.Helper()
	select {
	case e := <-w.events:
		return e
	case err := <-w.closed:
		w.t.Fatal(err)
	case <-time.After(2 * time.Second):
		w.t.Fatal("event timed out")
	}
	return wsEvent{}
}

func TestPresenceAuthentication(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	ts := startPresence(t, x, presenceTestConfig())
	for _, tc := range []struct {
		name, origin string
		cookie       *http.Cookie
		status       int
	}{
		{"missing-origin", "", c, 403},
		{"foreign-origin", "https://evil.example", c, 403},
		{"opaque-origin", "null", c, 403},
		{"origin-path", ts.URL + "/path", c, 403},
		{"origin-query", ts.URL + "?x=1", c, 403},
		{"missing-cookie", ts.URL, nil, 401},
		{"unknown-cookie", ts.URL, &http.Cookie{Name: CookieName, Value: strings.Repeat("a", 64)}, 401}} {
		t.Run(tc.name, func(t *testing.T) {
			conn, response, err := dialPresence(t, ts, tc.cookie, tc.origin)
			if conn != nil {
				conn.CloseNow()
			}
			if err == nil || response == nil || response.StatusCode != tc.status {
				t.Fatalf("handshake: %v %v", response, err)
			}
		})
	}
	t.Run("no-query-auth", func(t *testing.T) {
		h := http.Header{"Origin": []string{ts.URL}, "Cookie": []string{c.String()}}
		conn, response, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws?lease="+s.Lease, &websocket.DialOptions{HTTPHeader: h, Subprotocols: []string{presenceProtocol}})
		if conn != nil {
			conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode != 403 {
			t.Fatalf("query handshake: %v %v", response, err)
		}
	})
	for _, message := range []any{
		map[string]any{"type": "join", "area": "village"},
		map[string]any{"type": "auth", "lease": "short"}} {
		conn, _, err := dialPresence(t, ts, c, ts.URL)
		if err != nil {
			t.Fatal(err)
		}
		w := readPresence(t, conn)
		w.send(message)
		w.closeStatus(presenceUnauthorized)
	}
	if _, err := x.db.DB.Exec("UPDATE sessions SET expires_at=? WHERE id_hash=?", x.now.Load()-1, store.Hash(c.Value)); err != nil {
		t.Fatal(err)
	}
	conn, response, err := dialPresence(t, ts, c, ts.URL)
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != 401 {
		t.Fatalf("expired session: %v %v", response, err)
	}
}

func TestPresenceMessageValidation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		message any
		join    bool
	}{
		{"unknown-area", map[string]any{"type": "join", "area": "private-home"}, false},
		{"unknown-region", map[string]any{"type": "join", "area": "wilds:made-up:0:0"}, false},
		{"chunk-bounds", map[string]any{"type": "join", "area": "wilds:inner-1:3:0"}, false},
		{"chunk-canonical", map[string]any{"type": "join", "area": "wilds:inner-1:00:0"}, false},
		{"position-without-room", positionMessage(0), false},
		{"position-bounds", positionMessage(1e7), true},
		{"bad-facing", map[string]any{"type": "pos", "x": 0, "y": 0, "moving": false, "facing": map[string]any{"x": 0, "y": 0}}, true},
		{"missing-moving", map[string]any{"type": "pos", "x": 0, "y": 0, "facing": map[string]any{"x": 0, "y": 1}}, true}} {
		t.Run(tc.name, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			ts := startPresence(t, x, presenceTestConfig())
			w := wsConnect(t, ts, c, s.Lease)
			if tc.join {
				w.join("village")
			}
			w.send(tc.message)
			w.closeStatus(websocket.StatusPolicyViolation)
		})
	}
	for _, tc := range []struct {
		name string
		typ  websocket.MessageType
		data []byte
		code websocket.StatusCode
	}{
		{"oversized", websocket.MessageBinary, make([]byte, 2048), websocket.StatusMessageTooBig},
		{"text", websocket.MessageText, []byte(`{"type":"heartbeat"}`), websocket.StatusUnsupportedData},
		{"truncated", websocket.MessageBinary, []byte{0x2a, 0x20}, websocket.StatusPolicyViolation}} {
		t.Run(tc.name, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			ts := startPresence(t, x, presenceTestConfig())
			w := wsConnect(t, ts, c, s.Lease)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := w.conn.Write(ctx, tc.typ, tc.data); err != nil {
				t.Fatal(err)
			}
			w.closeStatus(tc.code)
		})
	}
}

func TestPresenceConnectionAndRoomBounds(t *testing.T) {
	t.Run("connections", func(t *testing.T) {
		x := newRig(t)
		c, s := x.ready("alice")
		cfg := presenceTestConfig()
		cfg.MaxConnections = 1
		cfg.MaxRoomPlayers = 1
		ts := startPresence(t, x, cfg)
		wsConnect(t, ts, c, s.Lease)
		conn, response, err := dialPresence(t, ts, c, ts.URL)
		if conn != nil {
			conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode != 503 || response.Header.Get("Retry-After") != "5" {
			t.Fatalf("capacity: %v %v", response, err)
		}
	})
	t.Run("rooms", func(t *testing.T) {
		x := newRig(t)
		c, s := x.ready("alice")
		bc, b := x.member("bob", s.WorldID)
		cfg := presenceTestConfig()
		cfg.MaxRoomPlayers = 1
		ts := startPresence(t, x, cfg)
		a := wsConnect(t, ts, c, s.Lease)
		a.join("village")
		bob := wsConnect(t, ts, bc, b.Lease)
		bob.send(map[string]any{"type": "join", "area": "village"})
		bob.closeStatus(websocket.StatusTryAgainLater)
		a.none()
	})
}

func TestPresenceIdleAndHeartbeat(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	cfg := presenceTestConfig()
	cfg.IdleTimeoutMs = 200
	cfg.PingIntervalMs = 30
	cfg.PongTimeoutMs = 80
	ts := startPresence(t, x, cfg)
	idle := wsConnect(t, ts, c, s.Lease)
	// The client read loop automatically answers transport pings; application
	// inactivity still expires, so pong replies cannot keep abandoned tabs alive.
	idle.closeStatus(presenceIdle)
	active := wsConnect(t, ts, c, s.Lease)
	for i := 0; i < 8; i++ {
		active.send(map[string]any{"type": "heartbeat"})
		time.Sleep(40 * time.Millisecond)
	}
	active.join("village")
}

func TestPresencePongTimeout(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	cfg := presenceTestConfig()
	cfg.IdleTimeoutMs = 1000
	cfg.PingIntervalMs = 30
	cfg.PongTimeoutMs = 50
	ts := startPresence(t, x, cfg)
	h := http.Header{"Origin": []string{ts.URL}, "Cookie": []string{c.String()}}
	conn, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: h, Subprotocols: []string{presenceProtocol}, OnPingReceived: func(context.Context, []byte) bool { return false }})
	if err != nil {
		t.Fatal(err)
	}
	w := readPresence(t, conn)
	w.send(map[string]any{"type": "auth", "lease": s.Lease})
	w.expect("ready")
	w.closeStatus(presenceIdle)
}

func TestPresenceRevocationAndShutdown(t *testing.T) {
	for _, action := range []string{"logout", "allowlist", "session-expiry", "shutdown"} {
		t.Run(action, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			ts := startPresence(t, x, presenceTestConfig())
			w := wsConnect(t, ts, c, s.Lease)
			code := presenceUnauthorized
			switch action {
			case "logout":
				x.expect("DELETE", "/api/session", nil, c, 200)
			case "allowlist":
				if err := x.db.Allow(context.Background(), "alice", false, x.now.Load()); err != nil {
					t.Fatal(err)
				}
			case "session-expiry":
				if _, err := x.db.DB.Exec("UPDATE sessions SET expires_at=? WHERE id_hash=?", x.now.Load()-1, store.Hash(c.Value)); err != nil {
					t.Fatal(err)
				}
			case "shutdown":
				code = websocket.StatusGoingAway
				x.api.ClosePresence()
			}
			w.closeStatus(code)
		})
	}
	t.Run("preauth-shutdown", func(t *testing.T) {
		x := newRig(t)
		c, _ := x.ready("alice")
		ts := startPresence(t, x, presenceTestConfig())
		conn, _, err := dialPresence(t, ts, c, ts.URL)
		if err != nil {
			t.Fatal(err)
		}
		w := readPresence(t, conn)
		x.api.ClosePresence()
		w.closeStatus(websocket.StatusGoingAway)
	})
}

func TestPresenceAuthDeadlineAndHTTPDeadlines(t *testing.T) {
	t.Run("auth-deadline", func(t *testing.T) {
		x := newRig(t)
		c, _ := x.ready("alice")
		cfg := presenceTestConfig()
		cfg.AuthTimeoutMs = 50
		ts := startPresence(t, x, cfg)
		conn, _, err := dialPresence(t, ts, c, ts.URL)
		if err != nil {
			t.Fatal(err)
		}
		w := readPresence(t, conn)
		// Read deadline cancellation closes the transport without an application
		// close handshake; no unauthenticated socket can occupy a slot indefinitely.
		select {
		case <-w.closed:
		case <-time.After(time.Second):
			t.Fatal("auth deadline was not enforced")
		}
	})
	t.Run("http-deadlines-cleared", func(t *testing.T) {
		x := newRig(t)
		c, s := x.ready("alice")
		ts := httptest.NewUnstartedServer(x.api)
		ts.Config.ReadTimeout = 50 * time.Millisecond
		ts.Config.WriteTimeout = 50 * time.Millisecond
		ts.Start()
		t.Cleanup(func() { x.api.ClosePresence(); ts.Close() })
		w := wsConnect(t, ts, c, s.Lease)
		time.Sleep(100 * time.Millisecond)
		w.join("village")
	})
	t.Run("origin-required", func(t *testing.T) {
		x := newRig(t)
		c := x.login("alice", "")
		ts := startPresence(t, x, presenceTestConfig())
		conn, response, err := dialPresence(t, ts, c, ts.URL)
		if conn != nil {
			conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode != 409 {
			t.Fatalf("origin setup missing: %v %v", response, err)
		}
	})
}
