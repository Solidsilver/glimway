package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
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
	s = x.expect("POST", "/api/sync", syncBody(s, p, s.State), c, 200)
	away := s.State
	away.Area = "ruin"
	s = x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
	x.expect("POST", "/api/sync", syncBody(s, p, away), c, 409)
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
	code, err := x.db.Invite(context.Background(), world)
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
	if err := x.db.Allow(context.Background(), "alice", false); err != nil {
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
	status, _, code, _ := x.request("PUT", "/api/progress", mutation(s, s.State), c)
	if status != 409 || code != "superseded" {
		t.Fatal("old lease accepted")
	}
	x.expect("POST", "/api/sync", syncBody(s, profile("alice", 2, 1, 30), s.State), c, 409)
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
func TestProgressCurrentStaleAndServerAuthority(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	doc := s.State
	doc.Area = "woodland"
	doc.Position = rules.Position{X: 12, Y: 34}
	doc.HP = 8
	doc.Mana = 3
	doc.Quest = "guardian-defeated"
	doc.Inventory = append(doc.Inventory, "warden-seal", rules.E.CharmItem, "future-purchase")
	doc.Discoveries = []string{"marker"}
	doc.DefeatedEnemies = []string{"warden"}
	doc.Flags = []string{"story:yes", "embers:welcome", "lit:road-1", "opened:" + rules.E.ChestID}
	doc.PlaySeconds = 200
	doc.Embers = 999
	doc.XPEmbers = 999
	doc.EmberXP = 999999
	doc.MaxHP = 999
	doc.MaxMana = 999
	current := x.expect("PUT", "/api/progress", mutation(s, doc), c, 200)
	if current.Status != "current" || current.State.HP != 8 || current.State.Area != "woodland" || current.State.Embers != 2 || current.State.XPEmbers != 0 || current.State.EmberXP != 0 || current.State.MaxHP != 50 || slices.Contains(current.State.Inventory, rules.E.CharmItem) || slices.Contains(current.State.Flags, "lit:road-1") {
		t.Fatalf("owned upload admitted: %s", store.JSON(current))
	}
	offline := doc
	offline.HP = 0
	offline.Mana = 0
	offline.Area = "ruin"
	offline.Quest = "complete"
	offline.Position = rules.Position{X: 999, Y: 999}
	offline.Discoveries = []string{"offline"}
	offline.PlaySeconds = 300
	stale := x.expect("PUT", "/api/progress", mutation(s, offline), c, 200)
	if stale.Status != "stale" || stale.State.HP != 8 || stale.State.Mana != 3 || stale.State.Area != "woodland" || stale.State.Position != current.State.Position || stale.State.Quest != "complete" || stale.State.Embers != 5 || len(stale.State.Discoveries) != 2 {
		t.Fatal("stale progress merge")
	}
	repeat := x.expect("PUT", "/api/progress", mutation(s, offline), c, 200)
	if repeat.State.Embers != 5 || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='quest'") != 2 {
		t.Fatal("quest gift repeated")
	}
	future := mutation(s, offline)
	future["baseRev"] = repeat.Version + 1
	x.expect("PUT", "/api/progress", future, c, 409)
}
func TestSyncRejectsAtomicallyAndCreditsOnce(t *testing.T) {
	x := newRig(t)
	x.set(profile("alice", 2, 10, 20))
	c, s := x.ready("alice")
	doc := s.State
	doc.HP = 5
	doc.Mana = 2
	doc.Quest = "complete"
	p := profile("alice", 2, 30, 30)
	for _, kind := range []string{"area", "account", "lease", "revision", "hp", "exp", "fractional-level", "death-loss", "missing-exp"} {
		body := syncBody(s, p, doc)
		bad := p
		d := doc
		switch kind {
		case "area":
			d.Area = "ruin"
			body["progress"] = d
		case "account":
			bad.ID = "bob"
			body["profile"] = bad
		case "lease":
			body["lease"] = "old"
		case "revision":
			body["baseRev"] = s.Version - 1
		case "hp":
			bad.HP = 51
			body["profile"] = bad
		case "mp":
			bad.MP = bad.MaxMP + 1
			body["profile"] = bad
		case "exp":
			n := rules.XPToNextLevel(bad.Level)
			bad.Exp = &n
			body["profile"] = bad
		case "fractional-level":
			bad.Level = 2.5
			body["profile"] = bad
		case "death-loss":
			bad.Level = 1
			exp := 0.
			bad.Exp = &exp
			bad.MaxMP = 30
			bad.Stats.Int = 0
			body["profile"] = bad
		case "missing-exp":
			bad.Exp = nil
			body["profile"] = bad
		}
		// At low levels a drop to level one is within the one-death allowance.
		if kind == "death-loss" {
			continue
		}
		before := x.expect("GET", "/api/state", nil, c, 200)
		status, _, _, _ := x.request("POST", "/api/sync", body, c)
		if status == 200 {
			t.Fatalf("%s accepted", kind)
		}
		after := x.expect("GET", "/api/state", nil, c, 200)
		unchanged(t, before.Snapshot, after.Snapshot)
		if count(t, x.db, "SELECT count(*) FROM ledger") != 0 {
			t.Fatal("failed sync paid quest gifts")
		}
	}
	synced := x.expect("POST", "/api/sync", syncBody(s, p, doc), c, 200)
	if synced.State.HP != 15 || synced.State.Mana != 2 || synced.State.Embers != 10 || synced.State.XPEmbers != 2 || synced.State.EmberXP != 55 {
		t.Fatalf("sync rules: %s", store.JSON(synced))
	}
	synced.Lease = s.Lease
	damage := synced.State
	damage.HP = 3
	again := x.expect("POST", "/api/sync", syncBody(synced, p, damage), c, 200)
	if again.State.HP != 3 || again.State.Embers != 10 {
		t.Fatal("identical sync recredited")
	}
	// An old baseRev cannot consume a newer healing delta.
	healed := profile("alice", 2, 40, 40)
	x.expect("POST", "/api/sync", syncBody(synced, healed, damage), c, 409)
	again.Lease = s.Lease
	latest := x.expect("POST", "/api/sync", syncBody(again, healed, again.State), c, 200)
	if latest.State.HP != 13 || latest.State.XPEmbers != 3 {
		t.Fatal("retry lost healing/XP")
	}
}
func TestStaleAfterSyncRestRevivePurchaseAndIdempotency(t *testing.T) {
	for _, kind := range []string{"sync", "rest", "revive", "road-lantern", "chest"} {
		t.Run(kind, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			p := profile("alice", 4, 99, 30)
			s1 := x.expect("POST", "/api/sync", syncBody(s, p, s.State), c, 200)
			s1.Lease = s.Lease
			doc := s1.State
			doc.HP = 5
			doc.Mana = 1
			if kind == "revive" {
				doc.HP = 0
			}
			if kind == "sync" {
				p.HP = 40
				p.MP = 20
				p.Exp = func() *float64 { n := 100.; return &n }()
				p.Level = 5
				p.MaxMP = 34
				p.Stats.Int = 2
			}
			var bought response
			if kind == "sync" {
				bought = x.expect("POST", "/api/sync", syncBody(s1, p, doc), c, 200)
			} else {
				target := ""
				if kind == "road-lantern" {
					target = "road-1"
				}
				body := spendBody(s1, kind, target, "purchase", doc)
				bought = x.expect("POST", "/api/spend", body, c, 200)
				duplicate := x.expect("POST", "/api/spend", body, c, 200)
				if duplicate.Version != bought.Version || duplicate.State.Embers != bought.State.Embers {
					t.Fatal("duplicate changed balance")
				}
				body["target"] = "other"
				status, _, code, _ := x.request("POST", "/api/spend", body, c)
				if status != 409 || code != "idempotency-mismatch" {
					t.Fatal("key mismatch accepted")
				}
			}
			staleDoc := doc
			staleDoc.Area = "ruin"
			staleDoc.Position = rules.Position{X: 2, Y: 2}
			staleDoc.HP = 0
			staleDoc.Mana = 0
			staleDoc.Quest = "complete"
			stale := x.expect("PUT", "/api/progress", mutation(s1, staleDoc), c, 200)
			if stale.Status != "stale" || stale.State.HP != bought.State.HP || stale.State.Mana != bought.State.Mana || stale.State.Area != bought.State.Area || stale.State.Position != bought.State.Position {
				t.Fatalf("stale undid %s", kind)
			}
			if kind == "chest" && (!slices.Contains(stale.State.Inventory, rules.E.CharmItem) || !slices.Contains(stale.State.Flags, "opened:"+rules.E.ChestID)) {
				t.Fatal("lost purchase")
			}
			if kind == "road-lantern" && !slices.Contains(stale.State.Flags, "lit:road-1") {
				t.Fatal("lost lantern")
			}
		})
	}
}
func TestSpendGiftedFirstZeroLockAndFailedCarry(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s1 := x.expect("POST", "/api/sync", syncBody(s, profile("alice", 1, 0, 20), s.State), c, 200)
	s1.Lease = s.Lease
	doc := s1.State
	doc.HP = 0
	before := x.expect("GET", "/api/state", nil, c, 200)
	status, _, code, _ := x.request("POST", "/api/spend", spendBody(s1, "rest", "", "gift-only", doc), c)
	if status != 409 || code != "needs-earned" {
		t.Fatal("gift revived")
	}
	after := x.expect("GET", "/api/state", nil, c, 200)
	unchanged(t, before.Snapshot, after.Snapshot)
	p := profile("alice", 2, 15, 20)
	s2 := x.expect("POST", "/api/sync", syncBody(s1, p, s1.State), c, 200)
	s2.Lease = s.Lease
	doc = s2.State
	doc.HP = 10
	rest := x.expect("POST", "/api/spend", spendBody(s2, "rest", "", "rest", doc), c, 200)
	if rest.State.XPEmbers != 4 || rest.State.Embers != 5 {
		t.Fatal("ordinary spend did not use gifted first")
	}
	rest.Lease = s.Lease
	doc = rest.State
	doc.HP = 0
	revived := x.expect("POST", "/api/spend", spendBody(rest, "revive", "", "revive", doc), c, 200)
	if revived.State.HP != 50 || revived.State.XPEmbers != 2 || revived.State.Embers != 3 {
		t.Fatal("revive provenance")
	}
	revived.Lease = s.Lease
	doc = revived.State
	doc.Area = "woodland"
	x.expect("POST", "/api/spend", spendBody(revived, "rest", "", "away", doc), c, 409)
}
func TestPendingCheckpointSettlementAndFlagging(t *testing.T) {
	for _, verified := range []bool{true, false} {
		t.Run(fmt.Sprint(verified), func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			p := profile("alice", 20, 0, 20)
			sync := x.expect("POST", "/api/sync", syncBody(s, p, s.State), c, 200)
			total := int(rules.LifetimeXP(p.Level, 0) / 10)
			if sync.State.XPEmbers != rules.E.SyncCreditCap || sync.Pending != total-rules.E.SyncCreditCap {
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
			} else if !next.Flagged || next.State.XPEmbers != rules.E.SyncCreditCap {
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
	after := x.expect("POST", "/api/sync", syncBody(s, lost, s.State), c, 200)
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
		if bodyMap := body.(map[string]any); len(bodyMap) > 5 {
			if code != 200 {
				t.Fatal("valid zero vital upload rejected")
			}
		} else if code != 400 {
			t.Fatal("missing progress accepted")
		}
	}
	for _, raw := range []string{`{`, strings.Repeat("x", 200001), `{} {}`} {
		r := httptest.NewRequest("POST", "/api/session", strings.NewReader(raw))
		r.Header.Set("X-Glimway-Contract", "3")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal("bad body accepted")
		}
	}
	r := httptest.NewRequest("POST", "/api/play", strings.NewReader(`{"clientId":"tab"}`))
	r.Header.Set("X-Glimway-Contract", "3")
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
	credited := x.expect("POST", "/api/sync", syncBody(s, p, s.State), c, 200)
	credited.Lease = s.Lease
	body := spendBody(credited, "chest", "", "same-key", credited.State)
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
	staleDoc := credited.State
	staleDoc.Quest = "complete"
	before := x.expect("GET", "/api/state", nil, c, 200)
	x.expect("POST", "/api/spend", spendBody(credited, "rest", "", "stale-spend", staleDoc), c, 409)
	after := x.expect("GET", "/api/state", nil, c, 200)
	unchanged(t, before.Snapshot, after.Snapshot)
}
func TestLeaseReadHeartbeatAndSevenDayIdempotencyExpiry(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.now.Add(110)
	r := httptest.NewRequest("GET", "/api/state", nil)
	r.Header.Set("X-Glimway-Contract", "3")
	r.AddCookie(c)
	r.Header.Set("X-Play-Lease", s.Lease)
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("heartbeat")
	}
	x.now.Add(15)
	x.expect("POST", "/api/play", map[string]any{"clientId": "tab-b"}, c, 409)
	s1 := x.expect("POST", "/api/sync", syncBody(s, profile("alice", 4, 90, 20), s.State), c, 200)
	s1.Lease = s.Lease
	doc := s1.State
	doc.HP = 10
	body := spendBody(s1, "rest", "", "expiring-key", doc)
	paid := x.expect("POST", "/api/spend", body, c, 200)
	paid.Lease = s.Lease
	advanceActive(x, c, 7*86400+1)
	doc = paid.State
	doc.HP = 10
	again := x.expect("POST", "/api/spend", spendBody(paid, "rest", "", "expiring-key", doc), c, 200)
	if again.Version != paid.Version+1 || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='spend'") != 2 {
		t.Fatal("expired key did not permit a new operation")
	}
}

func TestDeathAtEndOfPreviousLevelIsPlausible(t *testing.T) {
	x := newRig(t)
	p := profile("alice", 20, rules.XPToNextLevel(20)-1, 20)
	x.set(p)
	c, s := x.ready("alice")
	dead := profile("alice", 19, 0, 0)
	after := x.expect("POST", "/api/sync", syncBody(s, dead, s.State), c, 200)
	if after.State.HP != 0 || after.State.EmberXP != s.State.EmberXP || after.State.XPEmbers != 0 {
		t.Fatal("death changed XP mark or paid credit")
	}
}
func TestOwnedUploadTypesAreIgnoredAndUnknownCredentialsStripped(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	doc := map[string]any{}
	_ = json.Unmarshal([]byte(store.JSON(s.State)), &doc)
	doc["maxHp"] = secret
	doc["maxMana"] = map[string]string{"token": secret}
	doc["embers"] = -999
	doc["xpEmbers"] = "forged"
	doc["emberXp"] = secret
	doc["apiToken"] = secret
	p := map[string]any{}
	_ = json.Unmarshal([]byte(store.JSON(profile("alice", 2, 15, 20))), &p)
	p["apiToken"] = secret
	p["equipped"].(map[string]any)["apiToken"] = secret
	body := map[string]any{"lease": s.Lease, "baseRev": s.Version, "profile": p, "progress": doc, "token": secret}
	result := x.expect("POST", "/api/sync", body, c, 200)
	if strings.Contains(store.JSON(result), secret) {
		t.Fatal("credential field returned")
	}
	result.Lease = s.Lease
	rawState := result.State
	rawState.Mana = 30
	newProfile := profile("alice", 1, 0, 20)
	newProfile.MP = 10
	changed := x.expect("POST", "/api/sync", syncBody(result, newProfile, rawState), c, 200)
	changed.Lease = s.Lease
	old := result.State
	old.Mana = 32
	stale := x.expect("PUT", "/api/progress", mutation(result, old), c, 200)
	if stale.State.Mana != changed.State.Mana || stale.State.MaxMana != 30 {
		t.Fatal("stale vitals above new maximum were not ignored")
	}
	backup := filepath.Join(x.dir, "scrubbed.sqlite")
	if err := x.db.Backup(context.Background(), backup); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(secret)) {
		t.Fatal("unknown credentials persisted")
	}
}

// Logout releases the play lease held through that session (and only that
// one), so signing straight back in on the same device can play at once.
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
	status, _, code, _ := x.request("PUT", "/api/progress", mutation(s, s.State), back)
	if status != 409 || code != "superseded" {
		t.Fatalf("old lease accepted after logout: %d %s", status, code)
	}
	x.expect("PUT", "/api/progress", mutation(fresh, fresh.State), back, 200)

	// Logging out with no cookie, or twice, is still harmless.
	x.expect("DELETE", "/api/session", nil, nil, 200)
	x.expect("DELETE", "/api/session", nil, first, 200)
}
