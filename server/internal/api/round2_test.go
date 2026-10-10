package api

import (
	"context"
	"fmt"
	"glimway/server/internal/habitica"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRound2ALossReferenceAndMultipleDeaths(t *testing.T) {
	x := newRig(t)
	x.set(profile("alice", 20, 0, 20))
	c, s := x.ready("alice")
	held := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 30, 0, 30), s.State), c, 200)
	for _, level := range []float64{29, 28} {
		x.set(profile("alice", level, 0, 20))
		c = x.login("alice", "")
		now := x.expect("GET", "/api/state", nil, c, 200)
		if now.Flagged || now.Pending != held.Pending || now.ImportedProfile.Level != 30 {
			t.Fatal("verified deaths must advance loss reference without consuming vitals or pending")
		}
	}
	s = x.expect("POST", "/api/play", map[string]any{"clientId": "new", "takeOver": true}, c, 200)
	s2 := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 28, 0, 20), s.State), c, 200)
	s2.Lease = s.Lease
	s3 := x.expect("POST", "/api/profile", x.profileBody(s2, profile("alice", 24, 0, 20), s2.State), c, 200)
	if s3.State.GlimXP != held.State.GlimXP || s3.State.XPGlims != held.State.XPGlims || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='xp-loss'") != 1 {
		t.Fatal("large loss must be accepted and noted without credit")
	}
	x.set(profile("alice", 22, 0, 20))
	c = x.login("alice", "")
	if x.expect("GET", "/api/state", nil, c, 200).Flagged {
		t.Fatal("two deaths must not flag")
	}
}
func TestRound2AFlagRetainsPendingAndExpiresAt90Days(t *testing.T) {
	x := newRig(t)
	x.set(profile("alice", 5, 0, 20))
	c, s := x.ready("alice")
	held := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 40, 0, 20), s.State), c, 200)
	c = x.login("alice", "")
	flagged := x.expect("GET", "/api/state", nil, c, 200)
	if !flagged.Flagged || flagged.Pending != held.Pending {
		t.Fatal("forgery signal must flag without dropping pending")
	}
	if _, err := x.db.DB.Exec("UPDATE pending_credits SET created_at=?", x.now.Load()-90*86400); err != nil {
		t.Fatal(err)
	}
	c = x.login("alice", "")
	expired := x.expect("GET", "/api/state", nil, c, 200)
	if expired.Pending != 0 || expired.State.XPGlims != held.State.XPGlims || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='pending-expired'") != 1 {
		t.Fatal("pending expiry must be audited without changing paid balances")
	}
}
func TestRound2BDailyCeilingAndAbsoluteSession(t *testing.T) {
	t.Run("daily", func(t *testing.T) {
		x := newRig(t)
		c, s := x.ready("alice")
		for day := int64(1); day <= 29; day++ {
			x.now.Add(86400)
			// Level 30 has room for 29*150 XP across the unchanged level curve.
			xp := float64(day * 150)
			level := float64(1)
			for xp >= rules.XPToNextLevel(level) {
				xp -= rules.XPToNextLevel(level)
				level++
			}
			next := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", level, xp, 20), s.State), c, 200)
			next.Lease = s.Lease
			s = next
		}
		if s.State.XPGlims != 435 || s.Pending != 0 {
			t.Fatalf("regular credit stranded: earned=%d pending=%d", s.State.XPGlims, s.Pending)
		}
		if x.calls.Load() != 1 {
			t.Fatal("sync must never send a token upstream")
		}
	})
	t.Run("session", func(t *testing.T) {
		x := newRig(t)
		c, _ := x.ready("alice")
		created := x.now.Load()
		for day := int64(1); day < 30; day++ {
			x.now.Store(created + day*86400)
			status, _, _, cookie := x.request("GET", "/api/state", nil, c)
			if status != 200 {
				t.Fatal("premature expiry")
			}
			if cookie.Expires.Unix() > created+30*86400 || cookie.MaxAge > int((30-day)*86400) {
				t.Fatal("sliding cookie exceeds absolute lifetime")
			}
		}
		x.now.Store(created + 30*86400)
		x.expect("GET", "/api/state", nil, c, 401)
		c = x.login("alice", "")
		x.expect("GET", "/api/state", nil, c, 200)
	})
}
func TestRound2CRemovalCannotBeUndoneByPlayerInvite(t *testing.T) {
	x := newRig(t)
	owner := x.login("owner", "")
	banned := x.login("banned", "")
	ownCode := inviteReq(t, x, "POST", "/api/invites", banned, 200)
	if err := x.db.Allow(context.Background(), "banned", false, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	if count(t, x.db, "SELECT count(*) FROM invites WHERE code_hash=? AND revoked_at IS NOT NULL", ownCode.ID) != 1 {
		t.Fatal("removal left outstanding invite valid")
	}
	foreign := inviteReq(t, x, "POST", "/api/invites", owner, 200)
	calls := x.calls.Load()
	x.expect("POST", "/api/session", map[string]any{"userId": "banned", "token": secret, "invite": foreign.Code}, nil, 403)
	if x.calls.Load() != calls {
		t.Fatal("removed account went upstream with player invite")
	}
	cli, err := x.db.Invite(context.Background(), "", x.now.Load())
	if err != nil {
		t.Fatal(err)
	}
	x.expect("POST", "/api/session", map[string]any{"userId": "banned", "token": secret, "invite": cli}, nil, 200)
	x.expect("POST", "/api/session", map[string]any{"userId": "new", "token": secret, "invite": foreign.Code}, nil, 200)
}
func TestRound2DInviteLifetimeBudgetAndFlagRestriction(t *testing.T) {
	x := newRig(t)
	c := x.login("alice", "")
	for i := 0; i < 5; i++ {
		v := inviteReq(t, x, "POST", "/api/invites", c, 200)
		inviteReq(t, x, "DELETE", "/api/invites/"+v.ID, c, 200)
	}
	inviteReq(t, x, "POST", "/api/invites", c, 409)
	other := x.login("other", "")
	if _, err := x.db.DB.Exec("UPDATE players SET flagged_at=? WHERE account_id='"+x.account("other")+"'", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	inviteReq(t, x, "POST", "/api/invites", other, 403)
}
func loginFrom(x *rig, id, remote string) int {
	r := httptest.NewRequest("POST", "/api/session", strings.NewReader(store.JSON(map[string]any{"userId": id, "token": secret})))
	r.Header.Set("X-Glimway-Contract", "7")
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = remote
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	return w.Code
}
func TestRound2EPrecheckIPv6EvictionAndGlobalRate(t *testing.T) {
	t.Run("precheck", func(t *testing.T) {
		x := newRig(t)
		for i := 0; i < 4097; i++ {
			if loginFrom(x, "junk", fmt.Sprintf("[2001:db8::%x]:1", i)) != 403 {
				t.Fatal("ineligible login consumed limiter")
			}
		}
		if len(x.api.loginLimit.buckets) != 0 {
			t.Fatal("junk filled limiter")
		}
		x.login("alice", "")
	})
	t.Run("ipv6", func(t *testing.T) {
		x := newRig(t)
		if err := x.db.Allow(context.Background(), "alice", true, x.now.Load()); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 11; i++ {
			want := 200
			if i == 10 {
				want = 429
			}
			if loginFrom(x, "alice", fmt.Sprintf("[2001:db8::%x]:1", i)) != want {
				t.Fatal("IPv6 rotation bypassed /64 limit")
			}
		}
	})
	t.Run("eviction", func(t *testing.T) {
		l := loginLimiter{buckets: map[string]loginBucket{}, rate: 1, window: time.Minute}
		now := time.Now()
		for i := 0; i < 4097; i++ {
			if !l.allow(fmt.Sprint(i), now.Add(time.Duration(i))) {
				t.Fatal("full map denied new client")
			}
		}
		if len(l.buckets) != 4096 {
			t.Fatal("map bound")
		}
		if _, ok := l.buckets["0"]; ok {
			t.Fatal("oldest not evicted")
		}
	})
	t.Run("global", func(t *testing.T) {
		x := newRig(t)
		if err := x.db.Allow(context.Background(), "alice", true, x.now.Load()); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 61; i++ {
			want := 200
			if i == 60 {
				want = 429
			}
			if loginFrom(x, "alice", fmt.Sprintf("198.51.100.%d:1", i)) != want {
				t.Fatal("missing global login-call limit")
			}
		}
		if x.calls.Load() != 60 {
			t.Fatal("unexpected upstream count")
		}
		x.now.Add(60)
		if loginFrom(x, "alice", "198.51.100.200:1") != 200 {
			t.Fatal("global rate did not reset")
		}
	})
}
func TestRound2GRebirthRequiresVerifiedHistory(t *testing.T) {
	for _, level := range []float64{1, 5} {
		t.Run(fmt.Sprint(level), func(t *testing.T) {
			x := newRig(t)
			x.set(profile("alice", level, 0, 20))
			c, s := x.ready("alice")
			held := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 40, 0, 20), s.State), c, 200)
			x.set(profile("alice", 1, 0, 20))
			c = x.login("alice", "")
			now := x.expect("GET", "/api/state", nil, c, 200)
			if now.Flagged != (level == 1) || now.Pending != held.Pending {
				t.Fatal("rebirth trusted only client-reported history or dropped pending")
			}
		})
	}
}
func TestRound2HUsedInviteMetadataAndUpstreamLogClass(t *testing.T) {
	t.Run("used", func(t *testing.T) {
		x := newRig(t)
		c := x.login("owner", "")
		v := inviteReq(t, x, "POST", "/api/invites", c, 200)
		x.login("new", v.Code)
		list := inviteReq(t, x, "GET", "/api/invites", c, 200)
		if len(list.Invites) != 1 || !list.Invites[0].Used || list.Invites[0].ID != v.ID {
			t.Fatal("used code missing from hash-only list")
		}
	})
	t.Run("upstream", func(t *testing.T) {
		x := newRig(t)
		x.set(profile("alice", 10001, 0, 20))
		if err := x.db.Allow(context.Background(), "alice", true, x.now.Load()); err != nil {
			t.Fatal(err)
		}
		x.expect("POST", "/api/session", map[string]any{"userId": "alice", "token": secret}, nil, 502)
		if !strings.Contains(x.logs.String(), "status=502 error_class=upstream") || strings.Contains(x.logs.String(), secret) {
			t.Fatal("upstream logged as internal or leaked token")
		}
	})
}

func TestRound2BCeilingFullDayBoundariesAndMaximum(t *testing.T) {
	for _, tc := range []struct {
		age int64
		cap int
	}{{0, 200}, {86399, 200}, {86400, 300}, {28 * 86400, 3000}, {29 * 86400, 3000}} {
		t.Run(fmt.Sprint(tc.age), func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			advanceActive(x, c, tc.age)
			p := profile("alice", 100, 0, 20)
			next := x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
			if next.State.XPGlims != tc.cap || next.Pending != int(rules.LifetimeXP(100, 0)/10)-tc.cap {
				t.Fatal("time allowance boundary")
			}
			next.Lease = s.Lease
			p = profile("alice", 101, 0, 20)
			last := x.expect("POST", "/api/profile", x.profileBody(next, p, next.State), c, 200)
			if last.State.XPGlims != tc.cap {
				t.Fatal("repeating sync refreshed time allowance")
			}
		})
	}
}
func TestRound2ERetrySharesGlobalUpstreamBudget(t *testing.T) {
	x := newRig(t)
	if err := x.db.Allow(t.Context(), "alice", true, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		x.calls.Add(1)
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(429)
	}))
	defer up.Close()
	x.api = New(x.db, habitica.New(up.URL, "tag"), Config{LoginGlobalRate: 1, Now: x.api.Config.Now, Logger: x.api.Config.Logger})
	status, _, code, _ := x.request("POST", "/api/session", map[string]any{"userId": "alice", "token": secret}, nil)
	if status != 429 || code != "login-global-rate-limited" || x.calls.Load() != 1 {
		t.Fatal("retry bypassed global budget")
	}
}
func TestRound2CRemovalIsRecheckedAfterProof(t *testing.T) {
	x := newRig(t)
	owner := x.login("owner", "")
	code := inviteReq(t, x, "POST", "/api/invites", owner, 200)
	entered := make(chan struct{})
	release := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		fmt.Fprint(w, `{"success":true,"data":{"_id":"new","profile":{"name":"Hero"},"flags":{"classSelected":false},"stats":{"lvl":1,"exp":0,"hp":20,"mp":10,"str":0,"int":0,"con":0,"per":0}}}`)
	}))
	defer up.Close()
	x.api = New(x.db, habitica.New(up.URL, "tag"), Config{Now: x.api.Config.Now, Logger: x.api.Config.Logger})
	done := make(chan int, 1)
	go func() {
		status, _, _, _ := x.request("POST", "/api/session", map[string]any{"userId": "new", "token": secret, "invite": code.Code}, nil)
		done <- status
	}()
	<-entered
	err := x.db.Allow(t.Context(), "new", false, x.now.Load())
	close(release)
	status := <-done
	if err != nil {
		t.Fatal(err)
	}
	if status != 403 || count(t, x.db, "SELECT count(*) FROM allowlist WHERE habitica_id='new'") != 0 || count(t, x.db, "SELECT count(*) FROM invites WHERE used_by IS NOT NULL") != 0 {
		t.Fatal("removal during proof bypassed transactional guard")
	}
}
func TestRound2HInviteRequiresJSONBody(t *testing.T) {
	x := newRig(t)
	c := x.login("owner", "")
	x.expect("POST", "/api/invites", nil, c, 400)
	r := httptest.NewRequest("POST", "/api/invites", strings.NewReader(`{}`))
	r.Header.Set("X-Glimway-Contract", "7")
	r.AddCookie(c)
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	if w.Code != 415 {
		t.Fatal("missing JSON content type accepted")
	}
	inviteReq(t, x, "POST", "/api/invites", c, 200)
}
