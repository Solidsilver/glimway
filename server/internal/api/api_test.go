package api

import (
	"bytes"
	"context"
	"fmt"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestTokenCookieAndBackup(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.MaxAge != 7*24*3600 {
		t.Fatal("cookie policy")
	}
	p := profile("alice", 2, 5, 30)
	s = x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
	away := s.State
	away.Area = "ruin"
	s = x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
	x.expect("POST", "/api/profile", x.profileBody(s, p, away), c, 409)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	backup := filepath.Join(x.dir, "backup.sqlite")
	if err := x.db.Backup(context.Background(), backup); err != nil {
		t.Fatal(err)
	}
	paths, err := filepath.Glob(filepath.Join(x.dir, "*"))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(b, []byte(secret)) || bytes.Contains(b, []byte(c.Value)) {
			t.Fatalf("credential persisted: %s", path)
		}
	}
	if strings.Contains(x.logs.String(), secret) || strings.Contains(x.logs.String(), c.Value) {
		t.Fatal("credentials logged")
	}
	if strings.Contains(store.JSON(s), secret) {
		t.Fatal("credential response")
	}
	restore, err := store.Open(backup)
	if err != nil {
		t.Fatal(err)
	}
	defer restore.Close()
	tx, _ := restore.DB.Begin()
	restored, err := store.Load(context.Background(), tx, x.account("alice"))
	tx.Rollback()
	if err != nil {
		t.Fatal(err)
	}
	unchanged(t, s.Snapshot, restored)
	for _, db := range []*store.Store{x.db, restore} {
		var sum, earned int
		var rev int64
		if err = db.DB.QueryRow("SELECT COALESCE(SUM(delta),0),COALESCE(SUM(earned_delta),0) FROM ledger WHERE account_id='"+x.account("alice")+"'").Scan(&sum, &earned); err != nil {
			t.Fatal(err)
		}
		if err = db.DB.QueryRow("SELECT version FROM players WHERE account_id='" + x.account("alice") + "'").Scan(&rev); err != nil {
			t.Fatal(err)
		}
		if sum != s.State.Embers || earned != s.State.XPEmbers || rev != s.Version {
			t.Fatal("ledger or rev differs on restore")
		}
	}
	if x.calls.Load() != 1 {
		t.Fatal("server called Habitica outside login")
	}
}
func TestInviteRaceAndWorld(t *testing.T) {
	x := newRig(t)
	owner, _ := x.ready("owner")
	world := x.expect("GET", "/api/state", nil, owner, 200).WorldID
	code, err := x.db.Invite(context.Background(), world, x.now.Load())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, id := range []string{"one", "two"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			status, _, _, _ := x.request("POST", "/api/session", map[string]any{"userId": id, "token": secret, "invite": code}, nil)
			statuses <- status
		}(id)
	}
	wg.Wait()
	close(statuses)
	ok, denied := 0, 0
	for s := range statuses {
		if s == 200 {
			ok++
		}
		if s == 403 {
			denied++
		}
	}
	if ok != 1 || denied != 1 {
		t.Fatalf("race: %d wins %d denials", ok, denied)
	}
	if count(t, x.db, "SELECT count(*) FROM players WHERE world_id=?", world) != 2 || count(t, x.db, "SELECT count(*) FROM invites WHERE used_by IS NOT NULL") != 1 {
		t.Fatal("invite world transaction")
	}
	if count(t, x.db, "SELECT count(*) FROM worlds") != 1 {
		t.Fatal("extra solo world created")
	}
}
func TestAccessAndSessionSliding(t *testing.T) {
	x := newRig(t)
	x.expect("POST", "/api/session", map[string]any{"userId": "no-access", "token": secret}, nil, 403)
	if count(t, x.db, "SELECT count(*) FROM players") != 0 {
		t.Fatal("denied login wrote player")
	}
	c, _ := x.ready("alice")
	advanceActive(x, c, 29*86400)
	code, _, _, renewed := x.request("GET", "/api/state", nil, c)
	if code != 200 || renewed == nil {
		t.Fatal("session renewal")
	}
	x.now.Add(86400)
	x.expect("GET", "/api/state", nil, c, 401)
	c = x.login("alice", "")
	if err := x.db.Allow(context.Background(), "alice", false, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	x.expect("GET", "/api/state", nil, c, 401)
	c = x.login("alice", "")
	x.now.Add(31 * 86400)
	x.expect("GET", "/api/state", nil, c, 401)
	c = x.login("alice", "")
	x.expect("DELETE", "/api/session", nil, c, 200)
	x.expect("GET", "/api/state", nil, c, 401)
}
func TestLeaseTakeoverIdleAndExemptions(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	same := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
	if same.Lease != s.Lease || same.Version != s.Version+1 {
		t.Fatal("lease renew must advance report generation and state version")
	}
	x.expect("POST", "/api/play", map[string]any{"clientId": "tab-b"}, c, 409)
	other := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-b", "takeOver": true}, c, 200)
	if other.Version != same.Version+1 || other.Lease == s.Lease {
		t.Fatal("takeover")
	}
	status, _, code, _ := x.request("POST", "/api/story/mark", body(s, "stale-lease", map[string]any{"mark": "seen:test"}), c)
	if status != 409 || code != "superseded" {
		t.Fatal("old lease accepted")
	}
	x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 2, 1, 30), s.State), c, 409)
	x.expect("POST", "/api/spend", spendBody(s, "rest", "", "x", s.State), c, 409)
	x.now.Add(120)
	idle := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-c"}, c, 200)
	if idle.Lease == other.Lease || idle.Version != other.Version+1 {
		t.Fatal("idle acquisition")
	}
	second := x.login("alice", "")
	x.expect("GET", "/api/state", nil, second, 200)
	status, _, code, _ = x.request("POST", "/api/origin", map[string]any{"choice": "fresh", "key": "second-device"}, second)
	if status != 404 || code != "not-found" {
		t.Fatal("removed origin route accepted")
	}
	x.expect("DELETE", "/api/session", nil, second, 200)
}
func TestSpendGiftedFirstZeroLockAndFailedCarry(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	lease := s.Lease
	s = x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 1, 0, 20), s.State), c, 200)
	s.Lease = lease
	s = x.reportState(c, s, 0, 0, testWhere(s.State))
	before := x.expect("GET", "/api/state", nil, c, 200)
	if _, _, code, _ := x.request("POST", "/api/spend", spendBody(s, "rest", "", "gift-only", s.State), c); code != "needs-earned" {
		t.Fatal(code)
	}
	after := x.expect("GET", "/api/state", nil, c, 200)
	// The fixture's barrier report advances acknowledgment; the refused spend pays nothing.
	if after.State.HP != 0 || after.State.Embers != before.State.Embers {
		t.Fatal("refusal changed vitals or funds")
	}
	x.fund(s.AccountID, 7, 4)
	s = x.reportState(c, s, 0, 0, testWhere(s.State))
	// A fall is the supported recovery operation; its baseline permits a subsequent damage report.
	s = x.expect("POST", "/api/fall", body(s, "recover", map[string]any{}), c, 200)
	s.Lease = lease
	s = x.reportState(c, s, 10, 0, testWhere(s.State))
	rest := x.expect("POST", "/api/spend", spendBody(s, "rest", "", "rest", s.State), c, 200)
	rest.Lease = s.Lease
	if rest.State.XPEmbers != 4 || rest.State.Embers != 8 {
		t.Fatal("ordinary rest did not use gifted first", rest.State)
	}
	rest = x.reportState(c, rest, 0, 0, testWhere(rest.State))
	recovered := x.expect("POST", "/api/spend", spendBody(rest, "rest", "", "zero-rest", rest.State), c, 200)
	recovered.Lease = s.Lease
	if recovered.State.HP != 50 || recovered.State.XPEmbers != 2 || recovered.State.Embers != 6 {
		t.Fatal("zero HP rest provenance", recovered.State)
	}
	doc := recovered.State
	doc.Area = "woodland"
	x.expect("POST", "/api/spend", spendBody(recovered, "rest", "", "away", doc), c, 409)
}
func TestPendingCheckpointSettlementAndFlagging(t *testing.T) {
	for _, verified := range []bool{true, false} {
		t.Run(fmt.Sprint(verified), func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			p := profile("alice", 20, 0, 20)
			sync := x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
			total := int(rules.LifetimeXP(p.Level, 0) / 10)
			if sync.State.XPEmbers != int(rules.E.GetSyncCreditCap()) || sync.Pending != total-int(rules.E.GetSyncCreditCap()) {
				t.Fatalf("cap: %s", store.JSON(sync))
			}
			if verified {
				x.set(p)
			} else {
				x.set(profile("alice", 5, 0, 20))
			}
			c = x.login("alice", "")
			next := x.expect("GET", "/api/state", nil, c, 200)
			if (verified && next.Pending != 0) || (!verified && next.Pending != sync.Pending) {
				t.Fatal("pending settlement/retention")
			}
			if verified {
				if next.State.XPEmbers != total || next.Flagged {
					t.Fatal("verified pending not settled")
				}
			} else if !next.Flagged || next.State.XPEmbers != int(rules.E.GetSyncCreditCap()) {
				t.Fatal("unverified pending not retained/flagged")
			}
			if next.State.EmberXP != sync.State.EmberXP || next.ImportedProfile.HP != sync.ImportedProfile.HP {
				t.Fatal("login consumed gameplay baseline or lowered mark")
			}
			if next.Version != sync.Version+1 {
				t.Fatal("checkpoint economy change did not bump rev")
			}
		})
	}
}
func TestLargeDeathLossIsAcceptedWithoutCredit(t *testing.T) {
	x := newRig(t)
	x.set(profile("alice", 20, 0, 20))
	c, s := x.ready("alice")
	lost := profile("alice", 10, 0, 20)
	after := x.expect("POST", "/api/profile", x.profileBody(s, lost, s.State), c, 200)
	if after.State.EmberXP != s.State.EmberXP || after.State.XPEmbers != 0 {
		t.Fatal("loss changed mark or paid credit")
	}
}
func TestHTTPValidationAndScrubbedLogging(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	for _, body := range []any{map[string]any{}, map[string]any{"version": 1, "area": "village"}, map[string]any{"version": 1, "area": "village", "position": map[string]any{"x": 0, "y": 0}, "quest": "new", "hp": 0, "mana": 0, "playSeconds": 0, "inventory": []string{}, "discoveries": []string{}, "defeatedEnemies": []string{}, "flags": []string{}}} {
		m := map[string]any{"lease": s.Lease, "baseRev": s.Version, "doc": body}
		code, _, _, _ := x.request("PUT", "/api/progress", m, c)
		if code != 404 {
			t.Fatal("retired progress accepted")
		}
	}
	for _, raw := range []string{`{`, strings.Repeat("x", 200001), `{} {}`} {
		r := httptest.NewRequest("POST", "/api/session", strings.NewReader(raw))
		r.Header.Set("X-Glimway-Contract", "5")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal("bad body accepted")
		}
	}
	r := httptest.NewRequest("POST", "/api/play", strings.NewReader(`{"clientId":"tab"}`))
	r.Header.Set("X-Glimway-Contract", "5")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://evil.example")
	r.AddCookie(c)
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin mutation accepted")
	}
	r = httptest.NewRequest("GET", "/unknown/"+secret+"?token="+secret, nil)
	r.Header.Set("X-Api-Key", secret)
	w = httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	if strings.Contains(x.logs.String(), secret) {
		t.Fatal("raw URL/header logged")
	}
}

func TestConcurrentSpendIdempotencyAndDone(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	p := profile("alice", 4, 90, 30)
	credited := x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
	credited.Lease = s.Lease
	chestDoc := credited.State
	chestDoc.Area = "ruin"
	body := spendBody(credited, "chest", "", "same-key", chestDoc)
	var wg sync.WaitGroup
	results := make(chan response, 2)
	statuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, out, _, _ := x.request("POST", "/api/spend", body, c)
			statuses <- status
			results <- out
		}()
	}
	wg.Wait()
	close(statuses)
	for status := range statuses {
		if status != 200 {
			t.Fatal("concurrent duplicate failed")
		}
	}
	a, b := <-results, <-results
	if a.Version != b.Version || a.State.Embers != b.State.Embers || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='spend'") != 1 {
		t.Fatal("duplicate purchase paid twice")
	}
	a.Lease = s.Lease
	status, _, code, _ := x.request("POST", "/api/spend", spendBody(a, "chest", "", "new-key", a.State), c)
	if status != 409 || code != "done" {
		t.Fatal("chest bought twice")
	}
	// A stale body no longer supplies a gameplay document; it cannot restore funds.
	before := x.expect("GET", "/api/state", nil, c, 200)
	x.expect("PUT", "/api/progress", mutation(credited, credited.State), c, 404)
	unchanged(t, before.Snapshot, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
}
func TestLeaseReadHeartbeatAndSevenDayIdempotencyExpiry(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.now.Add(110)
	r := httptest.NewRequest("GET", "/api/state", nil)
	r.Header.Set("X-Glimway-Contract", "5")
	r.AddCookie(c)
	r.Header.Set("X-Play-Lease", s.Lease)
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("heartbeat")
	}
	x.now.Add(15)
	x.expect("POST", "/api/play", map[string]any{"clientId": "tab-b"}, c, 409)
	s1 := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 4, 90, 20), s.State), c, 200)
	s1.Lease = s.Lease
	doc := s1.State
	doc.HP = 10
	s1 = x.reportState(c, s1, doc.HP, doc.Mana, testWhere(doc))
	body := spendBody(s1, "rest", "", "expiring-key", doc)
	paid := x.expect("POST", "/api/spend", body, c, 200)
	paid.Lease = s.Lease
	advanceActive(x, c, 7*86400+1)
	doc = paid.State
	doc.HP = 10
	paid = x.reportState(c, paid, doc.HP, doc.Mana, testWhere(doc))
	again := x.expect("POST", "/api/spend", spendBody(paid, "rest", "", "expiring-key", doc), c, 200)
	if again.Version != paid.Version+2 || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='spend'") != 2 {
		t.Fatal("expired key did not permit a new operation")
	}
}

func TestDeathAtEndOfPreviousLevelIsPlausible(t *testing.T) {
	x := newRig(t)
	p := profile("alice", 20, rules.XPToNextLevel(20)-1, 20)
	x.set(p)
	c, s := x.ready("alice")
	dead := profile("alice", 19, 0, 0)
	after := x.expect("POST", "/api/profile", x.profileBody(s, dead, s.State), c, 200)
	if after.State.HP != 0 || after.State.EmberXP != s.State.EmberXP || after.State.XPEmbers != 0 {
		t.Fatal("death changed XP mark or paid credit")
	}
}
func TestLogoutReleasesThatSessionsLease(t *testing.T) {
	x := newRig(t)
	first, s := x.ready("alice")
	other := x.login("alice", "")
	x.expect("POST", "/api/play", map[string]any{"clientId": "tab-b"}, other, 409)
	// Another session logging out leaves the first session's lease alone.
	x.expect("DELETE", "/api/session", nil, other, 200)
	again := x.login("alice", "")
	x.expect("POST", "/api/play", map[string]any{"clientId": "tab-b"}, again, 409)
	if n := count(t, x.db, "SELECT count(*) FROM players WHERE account_id='"+x.account("alice")+"' AND lease_id=?", s.Lease); n != 1 {
		t.Fatal("foreign logout released the lease")
	}

	// The holder logs out: the lease goes with its session, rev unchanged.
	x.expect("DELETE", "/api/session", nil, first, 200)
	if n := count(t, x.db, "SELECT count(*) FROM players WHERE account_id='"+x.account("alice")+"' AND lease_id IS NULL AND lease_client IS NULL AND lease_seen_at IS NULL"); n != 1 {
		t.Fatal("lease not released on logout")
	}
	back := x.login("alice", "")
	fresh := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, back, 200)
	if fresh.Lease == s.Lease || fresh.Version <= s.Version {
		t.Fatal("re-login should get a new lease and advance version")
	}
	// The released lease is dead for any writer.
	status, _, code, _ := x.request("POST", "/api/story/mark", body(s, "old-lease", map[string]any{"mark": "seen:test"}), back)
	if status != 409 || code != "superseded" {
		t.Fatalf("old lease accepted after logout: %d %s", status, code)
	}
	x.expect("POST", "/api/story/mark", body(fresh, "new-lease", map[string]any{"mark": "seen:test"}), back, 200)

	// Logging out with no cookie, or twice, is still harmless.
	x.expect("DELETE", "/api/session", nil, nil, 200)
	x.expect("DELETE", "/api/session", nil, first, 200)
}
