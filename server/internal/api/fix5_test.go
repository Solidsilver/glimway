package api

import (
	"context"
	"fmt"
	"glimway/content"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/proto"
	"net/http"
	"slices"
	"testing"
	"time"
)

func TestFix5MailRecallConservesAndReplays(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	sent := x.p5("POST", "/api/mail", body(s, "send", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", Id: "timber", Qty: 50}}), c, 200)
	s.Snapshot = sent.Snapshot
	path := "/api/mail/" + sent.Result.MailID + "/recall"
	x.p5("POST", path, body(b, "not-sender", nil), bc, 403)
	req := body(s, "recall", nil)
	returned := x.p5("POST", path, req, c, 200)
	s.Snapshot = returned.Snapshot
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("alice")+"' AND item_def='timber'") != 1000 || count(t, x.db, "SELECT SUM(delta) FROM ledger WHERE currency='mail:material:timber'") != 0 {
		t.Fatal("recall lost assets")
	}
	replay := x.p5("POST", path, req, c, 200)
	if store.JSON(replay) != store.JSON(returned) {
		t.Fatal("recall replay changed")
	}
	x.p5("POST", path, body(s, "twice", nil), c, 409)
	x.p5("POST", "/api/mail/"+sent.Result.MailID+"/claim", body(b, "claim", nil), bc, 409)
}

func TestFix5MailAutoReturns(t *testing.T) {
	for _, reason := range []string{"expired", "recipient-removed", "missing-allowlist"} {
		t.Run(reason, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.member("bob", s.WorldID)
			x.seedAssets(x.account("alice"))
			s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
			sent := x.p5("POST", "/api/mail", body(s, "send", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", Id: "timber", Qty: 50}}), c, 200)
			if reason == "expired" {
				if _, err := x.db.DB.Exec("UPDATE mail SET sent_at=? WHERE id=?", x.now.Load()-30*86400, sent.Result.MailID); err != nil {
					t.Fatal(err)
				}
			} else if reason == "recipient-removed" {
				if err := x.db.Allow(context.Background(), "bob", false); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := x.db.DB.Exec("DELETE FROM allowlist WHERE habitica_id='bob'"); err != nil {
					t.Fatal(err)
				}
			}
			read := x.p5("GET", "/api/mail", nil, c, 200)
			if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("alice")+"' AND item_def='timber'") != 1000 || count(t, x.db, "SELECT SUM(delta) FROM ledger WHERE currency='mail:material:timber'") != 0 || read.Version <= sent.Version {
				t.Fatal("automatic return did not restore goods/revision")
			}
			x.p5("GET", "/api/mail", nil, c, 200)
			if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("alice")+"' AND item_def='timber'") != 1000 {
				t.Fatal("automatic return paid twice")
			}
		})
	}
}

func TestFix5MailRemovedRecipientRejected(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.member("bob", s.WorldID)
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	if err := x.db.Allow(context.Background(), "bob", false); err != nil {
		t.Fatal(err)
	}
	rejected := x.p5("POST", "/api/mail", body(s, "removed", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", Id: "timber", Qty: 1}}), c, 403)
	if rejected.Error.Code != "recipient-unavailable" || count(t, x.db, "SELECT count(*) FROM mail") != 0 {
		t.Fatal("removed recipient accepted")
	}
}

func seedFix5Mail(t *testing.T, x *rig, world, from, to string, n int, claimed bool) {
	from, to = x.account(from), x.account(to)
	t.Helper()
	for i := 0; i < n; i++ {
		var at any
		if claimed {
			at = x.now.Load()
		}
		if _, err := x.db.DB.Exec("INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,sent_at,claimed_at) VALUES(?,?,?,?,'material','timber',1,?,?)", fmt.Sprintf("seed-%s-%03d", store.Hash(from + to)[:16], i), world, from, to, x.now.Load(), at); err != nil {
			t.Fatal(err)
		}
	}
}
func TestFix5MailOutstandingCaps(t *testing.T) {
	for _, cap := range []string{"sender", "recipient"} {
		t.Run(cap, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.member("bob", s.WorldID)
			x.member("carol", s.WorldID)
			x.seedAssets(x.account("alice"))
			s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
			if cap == "sender" {
				seedFix5Mail(t, x, s.WorldID, "alice", "carol", 50, false)
			} else {
				seedFix5Mail(t, x, s.WorldID, "carol", "bob", 50, false)
			}
			v := x.p5("POST", "/api/mail", body(s, "full", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", Id: "timber", Qty: 1}}), c, 409)
			if v.Error.Code != "mail-"+cap+"-limit" || count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("alice")+"' AND item_def='timber'") != 1000 || count(t, x.db, "SELECT count(*) FROM mail") != 50 {
				t.Fatal("mail capacity not enforced")
			}
		})
	}
}
func TestFix5MailSendRateIsNotResetByClaim(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	for i := 0; i < 10; i++ {
		sent := x.p5("POST", "/api/mail", body(s, fmt.Sprintf("send-%d", i), map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", Id: "timber", Qty: 1}}), c, 200)
		s.Snapshot = sent.Snapshot
		claimed := x.p5("POST", "/api/mail/"+sent.Result.MailID+"/claim", body(b, fmt.Sprintf("claim-%d", i), nil), bc, 200)
		b.Snapshot = claimed.Snapshot
	}
	req := body(s, "limited", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", Id: "timber", Qty: 1}})
	if x.p5("POST", "/api/mail", req, c, 429).Error.Code != "mail-rate-limited" {
		t.Fatal("mail rate")
	}
	if count(t, x.db, "SELECT count(*) FROM idempotency WHERE key='limited'") != 0 {
		t.Fatal("failed send consumed key")
	}
	x.now.Add(60)
	x.p5("POST", "/api/mail", req, c, 200)
}
func TestFix5MailHistoryIsBounded(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.member("bob", s.WorldID)
	seedFix5Mail(t, x, s.WorldID, "alice", "bob", 61, true)
	seedFix5Mail(t, x, s.WorldID, "bob", "alice", 2, false)
	if n := len(x.p5("GET", "/api/mail", nil, c, 200).Mail); n != 52 {
		t.Fatalf("history should be bounded plus pending: got %d want 52", n)
	}
}

func TestFix5ProjectCostsCanBeLowered(t *testing.T) {
	for _, finish := range []string{"contribution", "read"} {
		t.Run(finish, func(t *testing.T) {
			saved := content.ProjectRules
			defer func() { content.ProjectRules = saved }()
			tuned, ok := proto.Clone(saved).(*content.Projects)
			if !ok {
				t.Fatal("clone")
			}
			x := newRig(t)
			c, s := x.ready("alice")
			x.seedAssets(x.account("alice"))
			s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
			amount := map[string]int{"timber": 180}
			if finish == "read" {
				amount["stone"] = 80
			}
			path := "/api/projects/north-bridge/contribute"
			contributed := x.p5("POST", path, body(s, "start", map[string]any{"materials": amount}), c, 200)
			s.Snapshot = contributed.Snapshot
			tuned.Projects[0].Materials["timber"] = 150
			content.ProjectRules = tuned
			var v phase5Response
			if finish == "contribution" {
				if x.p5("POST", path, body(s, "extra-timber", map[string]any{"materials": map[string]int{"timber": 1}}), c, 409).Error.Code != "project-overfilled" {
					t.Fatal("extra timber accepted")
				}
				v = x.p5("POST", path, body(s, "finish", map[string]any{"materials": map[string]int{"stone": 80}}), c, 200)
				if v.Result.Projects[0].Stage != "complete" {
					t.Fatal("project stuck after lowering cost")
				}
			} else {
				v = x.p5("GET", "/api/projects", nil, c, 200)
				if v.Projects[0].Stage != "complete" || v.Version != s.Version {
					t.Fatal("read did not reconcile already-satisfied project")
				}
			}
			final := x.p5("GET", "/api/projects", nil, c, 200)
			if !slices.Contains(final.GrantablePapers, "count-house-tally-book-scrap") || count(t, x.db, "SELECT count(*) FROM project_papers WHERE project_def='north-bridge'") != 1 || count(t, x.db, "SELECT qty FROM project_materials WHERE project_def='north-bridge' AND material='timber'") != 180 {
				t.Fatal("retuning lost contribution or rewards")
			}
		})
	}
}

func TestFix5MailItemsAndDecorationsReturnOriginalGoods(t *testing.T) {
	for _, mode := range []string{"recall", "expiry", "removal"} {
		t.Run(mode, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.member("bob", s.WorldID)
			s = x.openWorkshop(c, s)
			crafted := x.p5("POST", "/api/craft", body(s, "chair", map[string]any{"recipeId": "craft-reading-chair", "qty": 1}), c, 200)
			s.Snapshot = crafted.Snapshot
			instance := crafted.Result.InstanceIDs[0]
			trinket := giftTrinket
			assets := []*content.Asset{{Kind: "item", Id: trinket, Qty: 5}, {Kind: "decoration", Id: "reading-chair", Qty: 1}}
			for i, asset := range assets {
				sent := x.p5("POST", "/api/mail", body(s, fmt.Sprintf("send-%d", i), map[string]any{"toId": x.account("bob"), "asset": asset}), c, 200)
				s.Snapshot = sent.Snapshot
				if mode == "recall" {
					s.Snapshot = x.p5("POST", "/api/mail/"+sent.Result.MailID+"/recall", body(s, fmt.Sprintf("recall-%d", i), nil), c, 200).Snapshot
				}
			}
			if mode == "expiry" {
				if _, err := x.db.DB.Exec("UPDATE mail SET sent_at=?", x.now.Load()-30*86400); err != nil {
					t.Fatal(err)
				}
				n, err := x.db.ReturnDueMail(context.Background(), x.now.Load())
				if err != nil || n != 2 {
					t.Fatal("expiry sweep", n, err)
				}
			}
			if mode == "removal" {
				if err := x.db.Allow(context.Background(), "bob", false); err != nil {
					t.Fatal(err)
				}
			}
			read := x.p5("GET", "/api/mail", nil, c, 200)
			if !slices.Contains(read.State.Inventory, trinket) || count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("alice")+"' AND item_def=?", trinket) != 5 || count(t, x.db, "SELECT COUNT(*) FROM homestead_items WHERE id=? AND account_id='"+x.account("alice")+"' AND location='inventory'", instance) != 1 || count(t, x.db, "SELECT COUNT(*) FROM mail WHERE returned_at IS NOT NULL") != 2 {
				t.Fatal("return changed instance or inventory identity")
			}
			for _, mail := range read.Mail {
				if mail.ReturnedAt == nil || mail.ReturnReason == nil || mail.ClaimedAt != nil {
					t.Fatal("return metadata missing")
				}
			}
			for _, currency := range []string{"mail:item:" + trinket, "mail:decoration:reading-chair"} {
				if count(t, x.db, "SELECT SUM(delta) FROM ledger WHERE account_id='"+x.account("alice")+"' AND currency=?", currency) != 0 {
					t.Fatal("unsettled transit")
				}
			}
			n, err := x.db.ReturnDueMail(context.Background(), x.now.Load())
			if err != nil || n != 0 {
				t.Fatal("return repeated", n, err)
			}
		})
	}
}

func TestFix5MailReturnFailuresRollBack(t *testing.T) {
	for _, mode := range []string{"recall", "removal"} {
		t.Run(mode, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.member("bob", s.WorldID)
			x.seedAssets(x.account("alice"))
			s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
			sent := x.p5("POST", "/api/mail", body(s, "send", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", Id: "timber", Qty: 50}}), c, 200)
			s.Snapshot = sent.Snapshot
			if _, err := x.db.DB.Exec("CREATE TRIGGER fail_return BEFORE INSERT ON ledger WHEN NEW.reason IN ('mail-recall','mail-return') AND NEW.delta<0 BEGIN SELECT RAISE(FAIL,'return failed'); END"); err != nil {
				t.Fatal(err)
			}
			req := body(s, "recall", nil)
			path := "/api/mail/" + sent.Result.MailID + "/recall"
			if mode == "recall" {
				x.p5("POST", path, req, c, 500)
			} else {
				if err := x.db.Allow(context.Background(), "bob", false); err == nil {
					t.Fatal("failed removal committed")
				}
				if count(t, x.db, "SELECT COUNT(*) FROM allowlist WHERE habitica_id='bob'") != 1 || count(t, x.db, "SELECT COUNT(*) FROM access_removals WHERE habitica_id='bob'") != 0 {
					t.Fatal("failed removal revoked recipient")
				}
			}
			if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("alice")+"' AND item_def='timber'") != 950 || count(t, x.db, "SELECT COUNT(*) FROM mail WHERE returned_at IS NOT NULL") != 0 || count(t, x.db, "SELECT COUNT(*) FROM ledger WHERE reason IN ('mail-recall','mail-return')") != 0 || count(t, x.db, "SELECT COUNT(*) FROM idempotency WHERE key='recall'") != 0 {
				t.Fatal("return partly committed")
			}
			unchanged(t, s.Snapshot, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
			if _, err := x.db.DB.Exec("DROP TRIGGER fail_return"); err != nil {
				t.Fatal(err)
			}
			if mode == "recall" {
				x.p5("POST", path, req, c, 200)
			} else {
				if err := x.db.Allow(context.Background(), "bob", false); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestFix5MailRecallRacesClaim(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	sent := x.p5("POST", "/api/mail", body(s, "send", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", Id: "stone", Qty: 7}}), c, 200)
	s.Snapshot = sent.Snapshot
	path := "/api/mail/" + sent.Result.MailID
	statuses := racePhase5(t, x, []struct {
		c    *http.Cookie
		path string
		body any
	}{{c, path + "/recall", body(s, "recall", nil)}, {bc, path + "/claim", body(b, "claim", nil)}})
	if !slices.Equal(statuses, []int{200, 409}) {
		t.Fatal("claim/recall race", statuses)
	}
	if count(t, x.db, "SELECT SUM(qty) FROM item_stacks WHERE location='pack' AND item_def='stone'") != 1000 || count(t, x.db, "SELECT SUM(delta) FROM ledger WHERE currency='mail:material:stone'") != 0 || count(t, x.db, "SELECT COUNT(*) FROM mail WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL") != 1 {
		t.Fatal("double settlement")
	}
}

func TestFix5MailCursorsAndLegacyPendingBounds(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.member("bob", s.WorldID)
	x.member("carol", s.WorldID)
	seedFix5Mail(t, x, s.WorldID, "alice", "bob", 61, true)
	seedFix5Mail(t, x, s.WorldID, "bob", "alice", 2, false)
	first := x.p5("GET", "/api/mail", nil, c, 200)
	if first.NextCursor == nil || first.NextPendingCursor != nil {
		t.Fatal("bad history cursor")
	}
	second := x.p5("GET", "/api/mail?cursor="+*first.NextCursor, nil, c, 200)
	if len(second.Mail) != 13 || second.NextCursor != nil {
		t.Fatal("missing old history")
	}
	seen := map[string]bool{}
	for _, page := range []*phase5Response{&first, &second} {
		for _, m := range page.Mail {
			if m.ClaimedAt != nil {
				if seen[m.ID] {
					t.Fatal("duplicate history")
				}
				seen[m.ID] = true
			}
		}
	}
	if len(seen) != 61 {
		t.Fatal("history gap")
	}
	for _, query := range []string{"cursor=!bad", "pendingCursor=!bad"} {
		if x.p5("GET", "/api/mail?"+query, nil, c, 400).Error.Code != "invalid-mail-cursor" {
			t.Fatal("cursor validation")
		}
	}
	seedFix5Mail(t, x, s.WorldID, "alice", "carol", 120, false)
	first = x.p5("GET", "/api/mail", nil, c, 200)
	if len(first.Mail) != 150 || first.NextPendingCursor == nil {
		t.Fatal("legacy pending list not bounded", len(first.Mail))
	}
	second = x.p5("GET", "/api/mail?pendingCursor="+*first.NextPendingCursor, nil, c, 200)
	seen = map[string]bool{}
	for _, page := range []*phase5Response{&first, &second} {
		for _, m := range page.Mail {
			if m.ClaimedAt == nil {
				if seen[m.ID] {
					t.Fatal("duplicate pending")
				}
				seen[m.ID] = true
			}
		}
	}
	if len(seen) != 122 || second.NextPendingCursor != nil {
		t.Fatal("pending gap", len(seen))
	}
}

func TestFix5MailExpiryBoundaryAndMaintenance(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.member("bob", s.WorldID)
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	sent := x.p5("POST", "/api/mail", body(s, "send", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", Id: "fiber", Qty: 7}}), c, 200)
	if _, err := x.db.DB.Exec("UPDATE mail SET sent_at=?", x.now.Load()-30*86400+1); err != nil {
		t.Fatal(err)
	}
	n, err := x.db.ReturnDueMail(context.Background(), x.now.Load())
	if err != nil || n != 0 {
		t.Fatal("early expiry", n, err)
	}
	x.now.Add(1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); x.api.RunMailMaintenance(ctx) }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(time.Second)
	for count(t, x.db, "SELECT COUNT(*) FROM mail WHERE returned_at IS NOT NULL") == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("alice")+"' AND item_def='fiber'") != 1000 || count(t, x.db, "SELECT version FROM players WHERE account_id='"+x.account("alice")+"'") != int(sent.Version)+1 {
		t.Fatal("unattended maintenance failed")
	}
}
