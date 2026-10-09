package api

import (
	"context"
	"fmt"
	"glimway/server/internal/habitica"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestHighLevelsAndHugeReportBound(t *testing.T) {
	x := newRig(t)
	x.set(profile("alice", 120, 10, 20))
	c, s := x.ready("alice")
	if s.ImportedProfile.Level != 120 || s.State.MaxMana != 130 {
		t.Fatal("high-level login or stat cap")
	}
	p := profile("alice", 121, 0, 30)
	after := x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
	after.Lease = s.Lease
	p.Level = 1e12
	before := x.expect("GET", "/api/state", nil, c, 200)
	x.expect("POST", "/api/profile", x.profileBody(after, p, after.State), c, 422)
	unchanged(t, before.Snapshot, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	x.set(profile("alice", 10001, 0, 20))
	x.expect("POST", "/api/session", map[string]any{"userId": "alice", "token": secret}, nil, 502)
}
func TestPendingSurvivesDeathAndSettlesAtOriginalXP(t *testing.T) {
	x := newRig(t)
	x.set(profile("alice", 20, 0, 20))
	c, s := x.ready("alice")
	p := profile("alice", 30, 0, 30)
	held := x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
	if held.Pending <= 0 {
		t.Fatal("no pending")
	}
	x.set(profile("alice", 29, 0, 20))
	c = x.login("alice", "")
	dead := x.expect("GET", "/api/state", nil, c, 200)
	if dead.Flagged || dead.Pending != held.Pending || dead.State.XPEmbers != held.State.XPEmbers {
		t.Fatal("death dropped/flagged earned pending")
	}
	if dead.ImportedProfile.Level != 30 {
		t.Fatal("login consumed gameplay baseline")
	}
	x.set(p)
	c = x.login("alice", "")
	confirmed := x.expect("GET", "/api/state", nil, c, 200)
	if confirmed.Flagged || confirmed.Pending != 0 || confirmed.State.XPEmbers != held.State.XPEmbers+held.Pending {
		t.Fatal("pending not settled at original reported XP")
	}
}
func TestPendingRecordsSettleIndependently(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	p := profile("alice", 30, 0, 20)
	first := x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
	first.Lease = s.Lease
	p = profile("alice", 30, 100, 20)
	second := x.expect("POST", "/api/profile", x.profileBody(first, p, first.State), c, 200)
	if second.Pending != first.Pending+10 || second.State.XPEmbers != 200 || count(t, x.db, "SELECT count(*) FROM pending_credits") != 2 {
		t.Fatal("pending checkpoints not retained per report")
	}
	x.set(profile("alice", 30, 0, 20))
	c = x.login("alice", "")
	partial := x.expect("GET", "/api/state", nil, c, 200)
	if partial.Flagged || partial.Pending != 10 || partial.State.XPEmbers != 200+first.Pending {
		t.Fatal("unconfirmed report settled or dropped")
	}
	x.set(p)
	c = x.login("alice", "")
	last := x.expect("GET", "/api/state", nil, c, 200)
	if last.Pending != 0 || last.State.XPEmbers != partial.State.XPEmbers+10 {
		t.Fatal("remaining pending did not settle")
	}
}
func TestRepeatedDeathsRebirthAndRegainedXP(t *testing.T) {
	x := newRig(t)
	x.set(profile("alice", 20, 100, 20))
	c, s := x.ready("alice")
	mark := s.State.EmberXP
	for _, level := range []float64{19, 18, 17, 1} {
		p := profile("alice", level, 0, 0)
		s2 := x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
		s2.Lease = s.Lease
		s = s2
		if s.State.EmberXP != mark || s.State.XPEmbers != 0 {
			t.Fatal("loss changed high-water credit")
		}
	}
	x.set(profile("alice", 1, 0, 0))
	c = x.login("alice", "")
	s = x.expect("POST", "/api/play", map[string]any{"clientId": "after-login", "takeOver": true}, c, 200)
	if s.Flagged || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='rebirth'") < 1 {
		t.Fatal("rebirth not audited or incorrectly flagged")
	}
	heal := profile("alice", 1, 10, 20)
	s = x.expect("POST", "/api/profile", x.profileBody(s, heal, s.State), c, 200)
	if s.State.HP != 20 || s.State.XPEmbers != 0 || s.State.EmberXP != mark {
		t.Fatal("rebirth locked healing or repaid XP")
	}
}
func TestMPAboveComputedMaximumClampsAndHPStillRejects(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	p := profile("alice", 2, 10, 20)
	p.MP = p.MaxMP + 4
	after := x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
	if after.State.Mana != p.MaxMP || after.ImportedProfile.MP != p.MaxMP {
		t.Fatal("reported MP not clamped")
	}
	after.Lease = s.Lease
	p.HP = 51
	x.expect("POST", "/api/profile", x.profileBody(after, p, after.State), c, 422)
}
func TestRepeatedSyncsCannotBypassUnverifiedCap(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	for _, level := range []float64{30, 40, 50, 60} {
		p := profile("alice", level, 0, 20)
		next := x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
		next.Lease = s.Lease
		s = next
		if s.State.XPEmbers != int(rules.E.GetSyncCreditCap()) {
			t.Fatal("sync bypassed checkpoint credit ceiling")
		}
	}
	if s.Pending != int(rules.LifetimeXP(60, 0)/10)-200 {
		t.Fatal("held amount differs")
	}
	x.set(profile("alice", 60, 0, 20))
	c = x.login("alice", "")
	s = x.expect("POST", "/api/play", map[string]any{"clientId": "verified", "takeOver": true}, c, 200)
	earned := s.State.XPEmbers
	if s.Pending != 0 || s.Flagged {
		t.Fatal("valid checkpoint failed")
	}
	next := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 70, 0, 20), s.State), c, 200)
	if next.State.XPEmbers != earned+200 {
		t.Fatal("new checkpoint did not open the next bounded allowance")
	}
}
func TestLoginPrecheckAndPerIPRateLimit(t *testing.T) {
	x := newRig(t)
	for i := 0; i < 11; i++ {
		x.expect("POST", "/api/session", map[string]any{"userId": "no-access", "token": secret}, nil, 403)
	}
	if x.calls.Load() != 0 || len(x.api.loginLimit.buckets) != 0 {
		t.Fatal("ineligible login consumed upstream or bucket")
	}
	if err := x.db.Allow(context.Background(), "alice", true); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		x.expect("POST", "/api/session", map[string]any{"userId": "alice", "token": secret}, nil, 200)
	}
	status, _, code, _ := x.request("POST", "/api/session", map[string]any{"userId": "alice", "token": secret}, nil)
	if status != 429 || code != "login-rate-limited" || x.calls.Load() != 10 {
		t.Fatal("eligible per-IP limit missing")
	}
	x.now.Add(60)
	x.expect("POST", "/api/session", map[string]any{"userId": "alice", "token": secret}, nil, 200)
}
func TestTrustedProxyLastHopAndUntrustedSpoofing(t *testing.T) {
	x := newRig(t)
	if err := x.db.Allow(context.Background(), "alice", true); err != nil {
		t.Fatal(err)
	}
	x.api = New(x.db, x.api.Habitica, Config{TrustedProxies: []string{"127.0.0.1"}, LoginRate: 2, Now: x.api.Config.Now, Logger: x.api.Config.Logger})
	attempt := func(remote, xff string) int {
		r := httptest.NewRequest("POST", "/api/session", strings.NewReader(`{"userId":"alice","token":"secret"}`))
		r.Header.Set("X-Glimway-Contract", "4")
		r.RemoteAddr = remote
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", xff)
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, r)
		return w.Code
	}
	if attempt("198.51.100.2:1", "1.1.1.1") != 200 || attempt("198.51.100.2:1", "2.2.2.2") != 200 || attempt("198.51.100.2:1", "3.3.3.3") != 429 {
		t.Fatal("untrusted forwarded IP bypass")
	}
	if attempt("127.0.0.1:1", "1.1.1.1, 203.0.113.2") != 200 || attempt("127.0.0.1:1", "2.2.2.2, 203.0.113.2") != 200 || attempt("127.0.0.1:1", "3.3.3.3, 203.0.113.2") != 429 || attempt("127.0.0.1:1", "203.0.113.3") != 200 {
		t.Fatal("proxy did not use the last hop")
	}
	if x.calls.Load() != 5 {
		t.Fatal("unexpected proxy rate-limit call count")
	}
}
func TestGlobalLoginConcurrencyAndTransactionalRecheck(t *testing.T) {
	x := newRig(t)
	code, err := x.db.Invite(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if err = x.db.Allow(context.Background(), "bob", true); err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		_, _ = fmt.Fprintf(w, `{"success":true,"data":{"_id":%q,"profile":{"name":"Hero"},"flags":{"classSelected":false},"stats":{"lvl":1,"exp":0,"hp":20,"mp":10,"str":0,"int":0,"con":0,"per":0}}}`, r.Header.Get("X-Api-User"))
	}))
	defer up.Close()
	x.api = New(x.db, habitica.New(up.URL, "tag"), Config{LoginConcurrency: 1, Now: x.api.Config.Now, Logger: x.api.Config.Logger})
	done := make(chan int, 1)
	go func() {
		status, _, _, _ := x.request("POST", "/api/session", map[string]any{"userId": "alice", "token": secret, "invite": code}, nil)
		done <- status
	}()
	<-entered
	status, _, reason, _ := x.request("POST", "/api/session", map[string]any{"userId": "bob", "token": secret}, nil)
	if status != 429 || reason != "login-busy" {
		close(release)
		<-done
		t.Fatal("global login cap missing")
	}
	if _, err = x.db.DB.Exec("UPDATE invites SET revoked_at=? WHERE code_hash=?", x.now.Load(), store.Hash(code)); err != nil {
		close(release)
		<-done
		t.Fatal(err)
	}
	close(release)
	if <-done != 403 || count(t, x.db, "SELECT count(*) FROM players") != 0 {
		t.Fatal("revoked invite admitted after proof")
	}
}
func TestReplaySpendUnderNewLease(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	credited := x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 4, 90, 20), s.State), c, 200)
	credited.Lease = s.Lease
	doc := credited.State
	doc.Area = "ruin"
	body := spendBody(credited, "chest", "", "lost-response", doc)
	paid := x.expect("POST", "/api/spend", body, c, 200)
	next := x.expect("POST", "/api/play", map[string]any{"clientId": "other", "takeOver": true}, c, 200)
	body["op"].(map[string]any)["lease"] = next.Lease
	replay := x.expect("POST", "/api/spend", body, c, 200)
	if replay.Version != next.Version || replay.State.Embers != paid.State.Embers || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='spend'") != 1 {
		t.Fatal("new lease replay must carry current state and the original result")
	}
	body["kind"] = "road-lantern"
	x.expect("POST", "/api/spend", body, c, 409)
}
func TestInternalStatusLogsAreScrubbed(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	x.db.Close()
	status, _, code, _ := x.request("GET", "/api/state?token="+secret, nil, c)
	if status != 500 || code != "internal" || !strings.Contains(x.logs.String(), "status=500 error_class=internal") {
		t.Fatal("internal failure not logged")
	}
	if strings.Contains(x.logs.String(), secret) || strings.Contains(x.logs.String(), "database is closed") {
		t.Fatal("error detail leaked into logs")
	}
}
func TestLoginPartyAndNegativeXP(t *testing.T) {
	x := newRig(t)
	party := "party-one"
	p := profile("alice", 120, -1, 20)
	p.PartyID = &party
	x.set(p)
	c, s := x.ready("alice")
	if s.HabiticaPartyID == nil || *s.HabiticaPartyID != party || *s.ImportedProfile.Exp != 0 {
		t.Fatal("login lost party or rejected/clamped XP incorrectly")
	}
	var worldParty string
	if err := x.db.DB.QueryRow("SELECT habitica_party_id FROM worlds WHERE id=?", s.WorldID).Scan(&worldParty); err != nil || worldParty != party {
		t.Fatal("solo owner's party not recorded")
	}
	other := "party-two"
	p.PartyID = &other
	x.set(p)
	c = x.login("alice", "")
	after := x.expect("GET", "/api/state", nil, c, 200)
	if after.WorldID != s.WorldID || *after.HabiticaPartyID != other {
		t.Fatal("party change moved world or failed to update player")
	}
}

type inviteResponse struct {
	InviteMetadata
	Code    string           `json:"code"`
	Invites []InviteMetadata `json:"invites"`
}

func inviteReq(t *testing.T, x *rig, method, path string, c *http.Cookie, status int) inviteResponse {
	t.Helper()
	v, w := httpResponse[inviteResponse](x, method, path, map[string]any{}, c, status)
	if method == "GET" && status == 200 && strings.Contains(w.Body.String(), `"code"`) {
		t.Fatal("invite raw code listed")
	}
	return v
}
func TestPlayerInviteLifecycleLimitExpiryAndWorlds(t *testing.T) {
	x := newRig(t)
	inviteReq(t, x, "POST", "/api/invites", nil, 401)
	owner := x.login("owner", "")
	baseline := x.expect("GET", "/api/state", nil, owner, 200)
	created := []inviteResponse{}
	for i := 0; i < 3; i++ {
		v := inviteReq(t, x, "POST", "/api/invites", owner, 200)
		if v.Code == "" || store.Hash(v.Code) != v.ID || v.ExpiresAt-v.CreatedAt != InviteTTL {
			t.Fatal("invite creation contract")
		}
		created = append(created, v)
	}
	inviteReq(t, x, "POST", "/api/invites", owner, 409)
	listed := inviteReq(t, x, "GET", "/api/invites", owner, 200)
	if len(listed.Invites) != 3 {
		t.Fatal("outstanding list")
	}
	other := x.login("outsider", "")
	inviteReq(t, x, "DELETE", "/api/invites/"+created[0].ID, other, 404)
	inviteReq(t, x, "DELETE", "/api/invites/"+created[0].ID, owner, 200)
	x.expect("POST", "/api/session", map[string]any{"userId": "revoked", "token": secret, "invite": created[0].Code}, nil, 403)
	inviteReq(t, x, "POST", "/api/invites", owner, 200)
	recipient := x.login("new-member", created[1].Code)
	joined := x.expect("GET", "/api/state", nil, recipient, 200)
	if joined.WorldID != baseline.WorldID {
		t.Fatal("invite recipient didn't join caller's world")
	}
	inviteReq(t, x, "DELETE", "/api/invites/"+created[1].ID, owner, 409)
	x.expect("POST", "/api/session", map[string]any{"userId": "repeat", "token": secret, "invite": created[1].Code}, nil, 403)
	existingWorld := x.expect("GET", "/api/state", nil, other, 200).WorldID
	other = x.login("outsider", created[2].Code)
	if x.expect("GET", "/api/state", nil, other, 200).WorldID != existingWorld {
		t.Fatal("existing player moved via invite")
	}
	x.now.Add(InviteTTL)
	inviteReq(t, x, "GET", "/api/invites", owner, 401)
	owner = x.login("owner", "")
	history := inviteReq(t, x, "GET", "/api/invites", owner, 200).Invites
	if len(history) != 1 || !history[0].Used {
		t.Fatal("used history missing or expired unused listed")
	}
	x.expect("POST", "/api/session", map[string]any{"userId": "expired", "token": secret, "invite": created[2].Code}, nil, 403)
	if x.expect("GET", "/api/state", nil, owner, 200).Version != baseline.Version+1 {
		t.Fatal("invites bumped gameplay rev")
	}
	var raw string
	if err := x.db.DB.QueryRow("SELECT code_hash FROM invites LIMIT 1").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	for _, v := range created {
		if raw == v.Code {
			t.Fatal("raw invite stored")
		}
	}
}
func TestPlayerInviteConcurrentCreationAndRedemption(t *testing.T) {
	x := newRig(t)
	owner := x.login("owner", "")
	var wg sync.WaitGroup
	statuses := make(chan int, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, _, _, _ := x.request("POST", "/api/invites", map[string]any{}, owner)
			statuses <- status
		}()
	}
	wg.Wait()
	close(statuses)
	wins := 0
	for status := range statuses {
		if status == 200 {
			wins++
		} else if status != 409 {
			t.Fatal("unexpected invite race status")
		}
	}
	if wins != 3 || count(t, x.db, "SELECT count(*) FROM invites") != 3 {
		t.Fatal("invite outstanding limit raced")
	}
	listed := inviteReq(t, x, "GET", "/api/invites", owner, 200)
	for _, v := range listed.Invites {
		inviteReq(t, x, "DELETE", "/api/invites/"+v.ID, owner, 200)
	}
	created := inviteReq(t, x, "POST", "/api/invites", owner, 200)
	results := make(chan int, 2)
	for _, id := range []string{"one", "two"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			status, _, _, _ := x.request("POST", "/api/session", map[string]any{"userId": id, "token": secret, "invite": created.Code}, nil)
			results <- status
		}(id)
	}
	wg.Wait()
	close(results)
	wins = 0
	for status := range results {
		if status == 200 {
			wins++
		}
	}
	if wins != 1 {
		t.Fatal("player invite redeemed twice")
	}
}

func TestLoginRateLimitWindow(t *testing.T) {
	l := loginLimiter{buckets: map[string]loginBucket{}, rate: 1, window: time.Minute}
	now := time.Now()
	if !l.allow("a", now) || l.allow("a", now) || !l.allow("a", now.Add(time.Minute)) {
		t.Fatal("login window reset")
	}
}

func TestPendingLotsSurviveBackupRestore(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	p := profile("alice", 30, 0, 20)
	held := x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
	path := filepath.Join(x.dir, "pending-backup.sqlite")
	if err := x.db.Backup(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	x.api = New(restored, x.api.Habitica, x.api.Config)
	before := x.expect("GET", "/api/state", nil, c, 200)
	unchanged(t, held.Snapshot, before.Snapshot)
	if count(t, restored, "SELECT COALESCE(SUM(embers),0) FROM pending_credits") != held.Pending {
		t.Fatal("pending lots not backed up")
	}
	x.set(p)
	c = x.login("alice", "")
	after := x.expect("GET", "/api/state", nil, c, 200)
	if after.Pending != 0 || after.State.XPEmbers != held.State.XPEmbers+held.Pending {
		t.Fatal("restored pending failed settlement")
	}
}
