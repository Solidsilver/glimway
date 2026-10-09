package api

import (
	"context"
	"glimway/content"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestFix6PresenceAdmissionCaps(t *testing.T) {
	for _, scope := range []string{"session", "player"} {
		t.Run(scope, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			bc, b := x.ready("bob")
			cookies := []*http.Cookie{c}
			limit := 2
			if scope == "player" {
				cookies = append(cookies, x.login("alice", ""), x.login("alice", ""))
				limit = 4
			}
			ts := startPresence(t, x, presenceTestConfig())
			for i := 0; i < limit; i++ {
				cookie := cookies[0]
				if scope == "player" {
					cookie = cookies[i/2]
				}
				conn, _, err := dialPresence(t, ts, cookie, ts.URL)
				if err != nil {
					t.Fatal(err)
				}
				readPresence(t, conn)
			}
			cookie := cookies[0]
			if scope == "player" {
				cookie = cookies[2]
			}
			conn, response, err := dialPresence(t, ts, cookie, ts.URL)
			if conn != nil {
				conn.CloseNow()
			}
			if err == nil || response == nil || response.StatusCode != 429 || response.Header.Get("Retry-After") == "" {
				t.Fatalf("%s cap not enforced: %v %v", scope, response, err)
			}
			wsConnect(t, ts, bc, b.Lease).join("village")
			_ = s
		})
	}
}
func waitPresenceDBWait(t *testing.T, x *rig, before int64) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for x.db.DB.Stats().WaitCount <= before && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if x.db.DB.Stats().WaitCount <= before {
		t.Fatal("presence query did not wait on held DB")
	}
}
func TestFix6PresenceDBQueriesDoNotHoldHub(t *testing.T) {
	for _, check := range []string{"registration", "notification"} {
		t.Run(check, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			bc, b := x.ready("bob")
			cc, carol := x.member("carol", b.WorldID)
			cfg := presenceTestConfig()
			cfg.RevalidateMs = 120000
			ts := startPresence(t, x, cfg)
			bob := wsConnect(t, ts, bc, b.Lease)
			bob.join("village")
			other := wsConnect(t, ts, cc, carol.Lease)
			other.join("village")
			bob.expect("join")
			conn, _, err := dialPresence(t, ts, c, ts.URL)
			if err != nil {
				t.Fatal(err)
			}
			alice := readPresence(t, conn)
			if check == "notification" {
				alice.send(map[string]any{"type": "auth", "lease": s.Lease})
				alice.expect("ready")
			}
			tx, err := x.db.DB.Begin()
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			defer func() {
				tx.Rollback()
				if check == "notification" {
					<-done
				}
			}()
			before := x.db.DB.Stats().WaitCount
			if check == "registration" {
				alice.send(map[string]any{"type": "auth", "lease": s.Lease})
			} else {
				go func() { defer close(done); x.api.presenceChanged(x.account("alice")) }()
			}
			waitPresenceDBWait(t, x, before)
			bob.send(positionMessage(123))
			if other.expect("pos").X != 123 {
				t.Fatal("unrelated room stalled")
			}
		})
	}
}
func TestFix6PresenceTransientRevalidationKeepsSocket(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	cfg := presenceTestConfig()
	cfg.RevalidateMs = 30
	cfg.WriteTimeoutMs = 50
	ts := startPresence(t, x, cfg)
	alice := wsConnect(t, ts, c, s.Lease)
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	before := x.db.DB.Stats().WaitCount
	waitPresenceDBWait(t, x, before)
	time.Sleep(60 * time.Millisecond)
	tx.Rollback()
	alice.join("village")
	time.Sleep(70 * time.Millisecond)
	if err := x.db.Allow(context.Background(), "alice", false); err != nil {
		t.Fatal(err)
	}
	alice.closeStatus(presenceUnauthorized)
}
func TestFix6PresenceRevalidationDoesNotBlockOutbound(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	cfg := presenceTestConfig()
	cfg.RevalidateMs = 30
	cfg.WriteTimeoutMs = 1000
	ts := startPresence(t, x, cfg)
	alice := wsConnect(t, ts, c, s.Lease)
	alice.join("village")
	bob := wsConnect(t, ts, bc, b.Lease)
	bob.join("village")
	alice.expect("join")
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	before := x.db.DB.Stats().WaitCount
	waitPresenceDBWait(t, x, before)
	alice.send(positionMessage(321))
	if bob.expect("pos").X != 321 {
		t.Fatal("DB revalidation blocked outbound")
	}
}
func fix6IngressConfig(t *testing.T) *content.Presence {
	t.Helper()
	cfg := presenceTestConfig()
	// The pre-fix Go config ignored the shared ingress limits, so this
	// regression compiled and failed behaviorally before fix 6 existed.
	cfg.IncomingMessagesPerSecond = 30
	cfg.IncomingBurst = 4
	cfg.IncomingExcessMs = 120
	return cfg
}
func TestFix6PresenceSustainedIngressExcessCloses(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	ts := startPresence(t, x, fix6IngressConfig(t))
	alice := wsConnect(t, ts, c, s.Lease)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if err := alice.conn.Write(ctx, websocket.MessageBinary, []byte{0x2a, 0}); err != nil {
				return
			}
		}
	}()
	defer func() { cancel(); alice.conn.CloseNow(); <-done }()
	alice.closeStatus(websocket.StatusPolicyViolation)
}

func TestFix6PresenceRegistrationDiscardsStaleDBResult(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	ts := startPresence(t, x, presenceTestConfig())
	conn, _, err := dialPresence(t, ts, c, ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	alice := readPresence(t, conn)
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	before := x.db.DB.Stats().WaitCount
	alice.send(map[string]any{"type": "auth", "lease": s.Lease})
	waitPresenceDBWait(t, x, before)
	h := x.api.presence
	h.mu.Lock()
	// Let the first query finish against the old lease, but hold registration.
	tx.Rollback()
	deadline := time.Now().Add(time.Second)
	for x.db.DB.Stats().InUse != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if x.db.DB.Stats().InUse != 0 {
		h.mu.Unlock()
		t.Fatal("auth query did not release the DB outside the hub lock")
	}
	if _, err = x.db.DB.Exec("UPDATE players SET lease_id=? WHERE account_id='"+x.account("alice")+"'", strings.Repeat("b", 64)); err != nil {
		h.mu.Unlock()
		t.Fatal(err)
	}
	// This is the generation change made by a post-commit play notification.
	h.accounts[x.account("alice")].generation++
	h.mu.Unlock()
	alice.closeStatus(presenceSuperseded)
	if len(alice.events) != 0 {
		t.Fatal("stale auth produced ready before retry")
	}
}

func TestFix6PresenceRevalidationFailureBudget(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	cfg := presenceTestConfig()
	cfg.RevalidateMs = 30
	cfg.WriteTimeoutMs = 20
	cfg.RevalidateFailures = 2
	ts := startPresence(t, x, cfg)
	alice := wsConnect(t, ts, c, s.Lease)
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	alice.closeStatus(websocket.StatusInternalError)
}
func TestFix6PresenceTransientIngressExcessRecovers(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	ts := startPresence(t, x, fix6IngressConfig(t))
	alice := wsConnect(t, ts, c, s.Lease)
	for i := 0; i < 20; i++ {
		alice.send(map[string]any{"type": "heartbeat"})
	}
	time.Sleep(200 * time.Millisecond)
	alice.join("village")
}
func TestFix6PresenceReservationMapsRelease(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	cfg := presenceTestConfig()
	cfg.AuthTimeoutMs = 50
	ts := startPresence(t, x, cfg)
	for i := 0; i < 2; i++ {
		conn, _, err := dialPresence(t, ts, c, ts.URL)
		if err != nil {
			t.Fatal(err)
		}
		w := readPresence(t, conn)
		select {
		case <-w.closed:
		case <-time.After(time.Second):
			t.Fatal("pending auth did not expire")
		}
	}
	deadline := time.Now().Add(time.Second)
	for {
		h := x.api.presence
		h.mu.Lock()
		empty := h.slots == 0 && len(h.accounts) == 0 && len(h.sessions) == 0
		h.mu.Unlock()
		if empty {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("admission maps leaked a reservation")
		}
		time.Sleep(time.Millisecond)
	}
	wsConnect(t, ts, c, s.Lease)
	x.api.ClosePresence()
	h := x.api.presence
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.slots != 0 || len(h.accounts) != 0 || len(h.sessions) != 0 || len(h.peers) != 0 {
		t.Fatal("shutdown leaked presence accounting")
	}
}
