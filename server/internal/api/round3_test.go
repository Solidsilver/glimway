package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"glimway/server/internal/habitica"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Simulate ongoing successful reads without creating another verified checkpoint.
func advanceActive(x *rig, c *http.Cookie, seconds int64) {
	for seconds > 6*86400 {
		x.now.Add(6 * 86400)
		x.expect("GET", "/api/state", nil, c, 200)
		seconds -= 6 * 86400
	}
	x.now.Add(seconds)
}
func TestRound3HighestCreditDetectsHiddenForgery(t *testing.T) {
	for _, scenario := range []string{"one-big-drop", "step-down"} {
		t.Run(scenario, func(t *testing.T) {
			x := newRig(t)
			x.set(profile("alice", 20, 0, 20))
			c, s := x.ready("alice")
			advanceActive(x, c, 10*86400)
			high := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 60, 0, 20), s.State), c, 200)
			high.Lease = s.Lease
			if high.State.XPGlims != 1200 || high.Pending == 0 {
				t.Fatal("review reproduction missing paid/held forgery")
			}
			s = high
			levels := []float64{20}
			if scenario == "step-down" {
				levels = nil
				for level := float64(59); level >= 20; level-- {
					levels = append(levels, level)
				}
			}
			for _, level := range levels {
				next := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", level, 0, 20), s.State), c, 200)
				next.Lease = s.Lease
				s = next
			}
			if scenario == "step-down" && count(t, x.db, "SELECT count(*) FROM ledger WHERE reason IN ('xp-loss','rebirth')") != 0 {
				t.Fatal("step-down control unexpectedly audited")
			}
			before := s
			x.set(profile("alice", 20, 0, 20))
			c = x.login("alice", "")
			flagged := x.expect("GET", "/api/state", nil, c, 200)
			if !flagged.Flagged || flagged.Pending != high.Pending || flagged.State.XPGlims != high.State.XPGlims || flagged.Version != before.Version+1 {
				t.Fatal("highest credit did not flag without confiscation")
			}
			if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='checkpoint-flag' AND ref='highest-credit'") != 1 {
				t.Fatal("highest-credit audit")
			}
		})
	}
}
func TestRound3CheckpointCursorExcludesReviewedSameSecondCredit(t *testing.T) {
	x := newRig(t)
	x.set(profile("alice", 20, 0, 20))
	c, s := x.ready("alice")
	high := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 30, 0, 20), s.State), c, 200)
	x.set(profile("alice", 30, 0, 20))
	c = x.login("alice", "")
	verified := x.expect("GET", "/api/state", nil, c, 200)
	if verified.Flagged || verified.Pending != 0 || verified.State.XPGlims < high.State.XPGlims {
		t.Fatal("verified credit")
	}
	// Several later deaths have no new credit; the reviewed peak must not recur.
	x.set(profile("alice", 20, 0, 20))
	c = x.login("alice", "")
	if x.expect("GET", "/api/state", nil, c, 200).Flagged {
		t.Fatal("same-second checkpoint counted old credit again")
	}
	if count(t, x.db, "SELECT checkpoint_ledger_id FROM sync_baselines WHERE account_id='"+x.account("alice")+"'") != count(t, x.db, "SELECT max(id) FROM ledger WHERE account_id='"+x.account("alice")+"'") {
		t.Fatal("cursor not advanced")
	}
}
func TestRound3HighestCreditUsesLegacyPending(t *testing.T) {
	x := newRig(t)
	x.ready("alice")
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	snapshot, err := store.Load(context.Background(), tx, x.account("alice"))
	if err != nil {
		t.Fatal(err)
	}
	// Legacy pending can retain a high report with no modern matching ledger row.
	at := snapshot.CheckpointAt + 1
	xp := rules.LifetimeXP(60, 0)
	if _, err = tx.Exec("INSERT INTO pending_credits VALUES('"+x.account("alice")+"',?,1,?)", xp, at); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec("UPDATE sync_baselines SET pending=1 WHERE account_id='" + x.account("alice") + "'"); err != nil {
		t.Fatal(err)
	}
	got, when, err := highestCredit(context.Background(), tx, &snapshot)
	if err != nil || got != xp || when != at {
		t.Fatal("pending maximum", got, when, err)
	}
	tx.Rollback()
}
func TestRound3SessionIdleSlidingAbsoluteAndRollback(t *testing.T) {
	t.Run("idle boundary", func(t *testing.T) {
		x := newRig(t)
		c, _ := x.ready("alice")
		if c.MaxAge != int(SessionIdleTTL.Seconds()) {
			t.Fatal("initial idle cookie")
		}
		x.now.Add(int64(SessionIdleTTL.Seconds()))
		x.expect("GET", "/api/state", nil, c, 401)
	})
	t.Run("slide within absolute", func(t *testing.T) {
		x := newRig(t)
		c, _ := x.ready("alice")
		start := x.now.Load()
		x.now.Add(6 * 86400)
		status, _, _, renewed := x.request("GET", "/api/state", nil, c)
		if status != 200 || renewed.Expires.Unix() != start+13*86400 || renewed.MaxAge != 7*86400 {
			t.Fatal("idle renewal")
		}
		x.now.Add(7 * 86400)
		x.expect("GET", "/api/state", nil, c, 401)
	})
	t.Run("failed write rolls back renewal", func(t *testing.T) {
		x := newRig(t)
		c, s := x.ready("alice")
		expiry := count(t, x.db, "SELECT expires_at FROM sessions WHERE id_hash=?", store.Hash(c.Value))
		x.now.Add(86400)
		doc := s.State
		doc.HP = 9999
		x.expect("PUT", "/api/progress", mutation(s, doc), c, 404)
		if count(t, x.db, "SELECT expires_at FROM sessions WHERE id_hash=?", store.Hash(c.Value)) != expiry {
			t.Fatal("failed transaction renewed session")
		}
	})
}
func proofRequest(x *rig, id, token, remote string) (int, string, string) {
	r := httptest.NewRequest("POST", "/api/session", bytes.NewBufferString(store.JSON(map[string]any{"userId": id, "token": token})))
	r.Header.Set("X-Glimway-Contract", "7")
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = remote
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	var v struct{ Error struct{ Code string } }
	_ = json.Unmarshal(testSnapshotJSON(w.Body.Bytes()), &v)
	return w.Code, v.Error.Code, w.Header().Get("Retry-After")
}
func proofUpstream(x *rig, handler func(http.ResponseWriter, *http.Request)) *httptest.Server {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { x.calls.Add(1); handler(w, r) }))
	x.api.Habitica = habitica.New(up.URL, "tag")
	return up
}
func validProof(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, `{"success":true,"data":{"_id":%q,"profile":{"name":"Hero"},"flags":{"classSelected":false},"stats":{"lvl":1,"exp":0,"hp":20,"mp":10,"str":0,"int":0,"con":0,"per":0}}}`, r.Header.Get("X-Api-User"))
}
func TestRound3FailedProofsPerClaimedUser(t *testing.T) {
	x := newRig(t)
	for _, id := range []string{"alice", "bob"} {
		if err := x.db.Allow(t.Context(), id, true, x.now.Load()); err != nil {
			t.Fatal(err)
		}
	}
	up := proofUpstream(x, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") != secret {
			w.WriteHeader(401)
			return
		}
		validProof(w, r)
	})
	defer up.Close()
	for i := 0; i < proofFailureLimit; i++ {
		status, code, _ := proofRequest(x, "alice", "invalid", fmt.Sprintf("[2001:db8:%x::1]:1", i))
		if status != 401 || code != "habitica-auth" {
			t.Fatal("failed proof", status, code)
		}
	}
	status, code, retry := proofRequest(x, "alice", secret, "198.51.100.30:1")
	if status != 429 || code != "login-user-rate-limited" || retry != "900" || x.calls.Load() != 5 {
		t.Fatal("failed proof quota", status, code, retry, x.calls.Load())
	}
	if status, _, _ := proofRequest(x, "bob", secret, "198.51.100.31:1"); status != 200 {
		t.Fatal("unrelated user exhausted")
	}
	x.now.Add(int64(proofFailureWindow.Seconds()))
	if status, _, _ := proofRequest(x, "alice", secret, "198.51.100.32:1"); status != 200 {
		t.Fatal("failed proof expiry")
	}
	for i := 0; i < 6; i++ {
		if status, _, _ := proofRequest(x, "alice", secret, fmt.Sprintf("198.51.100.%d:1", 40+i)); status != 200 {
			t.Fatal("successful proofs charged")
		}
	}
}
func TestRound3ConcurrentFailedProofReservations(t *testing.T) {
	x := newRig(t)
	if err := x.db.Allow(t.Context(), "alice", true, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	x.api = New(x.db, x.api.Habitica, Config{LoginConcurrency: 10, Now: x.api.Config.Now, Logger: x.api.Config.Logger})
	entered := make(chan struct{}, 5)
	release := make(chan struct{})
	up := proofUpstream(x, func(w http.ResponseWriter, r *http.Request) { entered <- struct{}{}; <-release; w.WriteHeader(403) })
	defer up.Close()
	var wg sync.WaitGroup
	statuses := make(chan int, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			status, _, _ := proofRequest(x, "alice", "invalid", fmt.Sprintf("198.51.100.%d:1", i))
			statuses <- status
		}(i)
	}
	for range 5 {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			close(release)
			wg.Wait()
			t.Fatal("proof did not start")
		}
	}
	status, code, _ := proofRequest(x, "alice", "invalid", "198.51.100.80:1")
	close(release)
	wg.Wait()
	close(statuses)
	if status != 429 || code != "login-user-rate-limited" || x.calls.Load() != 5 {
		t.Fatal("inflight quota bypass")
	}
	for status := range statuses {
		if status != 401 {
			t.Fatal("proof status", status)
		}
	}
}
func TestRound3ProofQuotaIgnoresUpstreamAndGlobalFailures(t *testing.T) {
	x := newRig(t)
	if err := x.db.Allow(t.Context(), "alice", true, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	up := proofUpstream(x, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) })
	defer up.Close()
	for i := 0; i < 6; i++ {
		status, _, _ := proofRequest(x, "alice", secret, fmt.Sprintf("198.51.100.%d:1", i))
		if status != 502 {
			t.Fatal("upstream outage charged as bad proof")
		}
	}
	if len(x.api.loginProofs.buckets) != 0 {
		t.Fatal("upstream outage retained failed proofs")
	}
	x.api = New(x.db, x.api.Habitica, Config{LoginGlobalRate: 1, Now: x.api.Config.Now, Logger: x.api.Config.Logger})
	proofRequest(x, "alice", secret, "198.51.100.80:1")
	status, code, _ := proofRequest(x, "alice", secret, "198.51.100.81:1")
	if status != 429 || code != "login-global-rate-limited" || len(x.api.loginProofs.buckets) != 0 {
		t.Fatal("global rejection charged proof quota")
	}
}
func TestRound3ProofBucketsBoundedWithoutEvictingInflight(t *testing.T) {
	l := proofLimiter{buckets: map[string]*proofBucket{}}
	now := time.Now()
	held, _, ok := l.begin("held", now)
	if !ok {
		t.Fatal("reservation")
	}
	for i := 0; i < proofBucketLimit; i++ {
		done, _, ok := l.begin(fmt.Sprint(i), now.Add(time.Duration(i+1)))
		if !ok {
			t.Fatal("bucket admission")
		}
		done(true)
	}
	if len(l.buckets) != proofBucketLimit || l.buckets["held"] == nil || l.buckets["0"] != nil {
		t.Fatal("bucket eviction")
	}
	held(false)
}
func TestRound3StateLeaseActivityAndDisplayName(t *testing.T) {
	x := newRig(t)
	p := profile("alice", 1, 0, 20)
	p.Name = "Lantern Keeper"
	x.set(p)
	if err := x.db.Allow(t.Context(), "alice", true, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	status, s, _, c := x.request("POST", "/api/session", map[string]any{"userId": "alice", "token": secret}, nil)
	if status != 200 || s.DisplayName != p.Name {
		t.Fatal("pre-origin display name")
	}
	read := func(lease string, want bool) response {
		r := httptest.NewRequest("GET", "/api/state", nil)
		r.Header.Set("X-Glimway-Contract", "7")
		r.AddCookie(c)
		if lease != "" {
			r.Header.Set("X-Play-Lease", lease)
		}
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, r)
		var doc struct {
			response
			LeaseActive *bool `json:"leaseActive"`
		}
		if err := json.Unmarshal(testSnapshotJSON(w.Body.Bytes()), &doc); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || doc.LeaseActive == nil || *doc.LeaseActive != want || doc.DisplayName != p.Name {
			t.Fatal("state lease/display contract", w.Body.String())
		}
		return doc.response
	}
	read("", false)
	s = x.expect("POST", "/api/play", map[string]any{"clientId": "first"}, c, 200)
	before := s.Snapshot
	x.now.Add(60)
	got := read(s.Lease, true)
	unchanged(t, before, got.Snapshot)
	takeover := x.expect("POST", "/api/play", map[string]any{"clientId": "second", "takeOver": true}, c, 200)
	seen := count(t, x.db, "SELECT lease_seen_at FROM players WHERE account_id='"+x.account("alice")+"'")
	x.now.Add(1)
	read(s.Lease, false)
	if count(t, x.db, "SELECT lease_seen_at FROM players WHERE account_id='"+x.account("alice")+"'") != seen {
		t.Fatal("old header refreshed active lease")
	}
	read(takeover.Lease, true)
	read("", false)
	p.Name = "Renamed Keeper"
	x.set(p)
	c = x.login("alice", "")
	read(takeover.Lease, true)
}
func TestRound3InviteListQuotasAndReadableCodeLifecycle(t *testing.T) {
	x := newRig(t)
	c := x.login("owner", "")
	list := func(remaining, entries int) {
		r := httptest.NewRequest("GET", "/api/invites", nil)
		r.Header.Set("X-Glimway-Contract", "7")
		r.AddCookie(c)
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, r)
		var doc struct {
			Invites          []InviteMetadata
			Remaining        int
			OutstandingLimit int
		}
		if err := json.Unmarshal(testSnapshotJSON(w.Body.Bytes()), &doc); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || doc.Remaining != remaining || doc.OutstandingLimit != int(rules.E.GetOutstandingInvites()) || len(doc.Invites) != entries {
			t.Fatal("invite quota contract", w.Body.String())
		}
	}
	list(5, 0)
	a := inviteReq(t, x, "POST", "/api/invites", c, 200)
	b := inviteReq(t, x, "POST", "/api/invites", c, 200)
	inviteReq(t, x, "POST", "/api/invites", c, 200)
	list(2, 3)
	if len(strings.Split(a.Code, "-")) != 7 || store.Hash(a.Code) != a.ID {
		t.Fatal("readable player invite")
	}
	inviteReq(t, x, "DELETE", "/api/invites/"+a.ID, c, 200)
	list(2, 2)
	formatted := "  " + strings.ReplaceAll(strings.ToUpper(b.Code), "-", " -\t ") + " "
	x.login("friend", formatted)
	list(2, 2)
	inviteReq(t, x, "POST", "/api/invites", c, 200)
	list(1, 3)
	if _, err := x.db.DB.Exec("UPDATE invites SET expires_at=? WHERE created_by='"+x.account("owner")+"' AND used_by IS NULL", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	list(1, 1)
	inviteReq(t, x, "POST", "/api/invites", c, 200)
	list(0, 2)
	inviteReq(t, x, "POST", "/api/invites", c, 409)
	// A readable CLI invite accepts alternate separators and remains single-use.
	cli, err := x.db.Invite(t.Context(), "", x.now.Load())
	if err != nil {
		t.Fatal(err)
	}
	x.login("cli-friend", strings.ReplaceAll(strings.ToUpper(cli), "-", " "))
	x.expect("POST", "/api/session", map[string]any{"userId": "second-friend", "token": secret, "invite": cli}, nil, 403)
	if count(t, x.db, "SELECT count(*) FROM invites WHERE code_hash=? AND used_by IS NOT NULL", store.Hash(cli)) != 1 {
		t.Fatal("CLI code not redeemed")
	}
	for _, raw := range []string{a.Code, b.Code, cli} {
		if strings.Contains(x.logs.String(), raw) {
			t.Fatal("raw code logged")
		}
		if count(t, x.db, "SELECT count(*) FROM invites WHERE code_hash=?", raw) != 0 {
			t.Fatal("raw code stored")
		}
	}
}
func TestRound3LegacyInviteNormalizationAndExpiry(t *testing.T) {
	x := newRig(t)
	legacy := strings.Repeat("ab", 32)
	if _, err := x.db.DB.Exec("INSERT INTO invites(code_hash,created_by,created_at,expires_at) VALUES(?,'cli',?,?)", store.Hash(legacy), x.now.Load(), x.now.Load()+InviteTTL); err != nil {
		t.Fatal(err)
	}
	formatted := strings.ToUpper(legacy[:32]) + " - " + strings.ToUpper(legacy[32:])
	x.login("legacy-friend", formatted)
	x.expect("POST", "/api/session", map[string]any{"userId": "legacy-second", "token": secret, "invite": legacy}, nil, 403)
	expired := strings.Repeat("cd", 32)
	if _, err := x.db.DB.Exec("INSERT INTO invites(code_hash,created_by,created_at,expires_at) VALUES(?,'cli',?,?)", store.Hash(expired), x.now.Load()-InviteTTL, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	before := x.calls.Load()
	x.expect("POST", "/api/session", map[string]any{"userId": "expired-friend", "token": secret, "invite": strings.ToUpper(expired)}, nil, 403)
	if x.calls.Load() != before {
		t.Fatal("expired code consumed upstream proof")
	}
}
