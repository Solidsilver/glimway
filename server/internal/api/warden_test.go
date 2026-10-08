package api

import (
	"context"
	"fmt"
	"glimway/content"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"testing"
	"time"
)

func TestWardenSliverFittingAndSingleCarriedRestriction(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)

	s = x.openWorkshop(c, s)
	b = x.openWorkshop(bc, b)

	axe := x.instance(x.account("alice"), "bench-axe", -1, "")
	pick := x.instance(x.account("alice"), "bench-pick", -1, "")
	sliver1 := x.instance(x.account("alice"), "warden-sliver", -1, "")
	sliver2 := x.instance(x.account("alice"), "warden-sliver", -1, "")

	x.stand(x.account("alice"), s.WorldID, "village", 100, 100)
	x.stand(x.account("bob"), s.WorldID, "village", 120, 100)

	// Fitting first sliver onto the axe succeeds.
	fit1 := x.opRefreshing(c, &s, "fit", map[string]any{"tool": axe, "instance": sliver1}, 200)
	axeView := findInstance(fit1.Result.Items, axe)
	if axeView == nil || !axeView.WardenSet {
		t.Fatal("expected axe to be warden-set")
	}

	// Fitting second sliver onto pick while already carrying a warden tool in pack is refused.
	errFit2 := x.opRefreshing(c, &s, "fit", map[string]any{"tool": pick, "instance": sliver2}, 409)
	if errFit2.Error.Code != "two-wardens-grind" {
		t.Fatalf("expected two-wardens-grind on fitting second warden tool, got %s", errFit2.Error.Code)
	}

	// Deposit the first warden tool into personal chest.
	dep := x.p5("POST", "/api/storage", body(s, "store-axe", map[string]any{
		"direction": "deposit",
		"chest":     "personal",
		"asset":     content.Asset{Kind: "instance", ID: "bench-axe", Qty: 1, Instance: axe},
	}), c, 200)
	s.Snapshot = dep.Snapshot

	// Now that the pack has zero warden-set tools, fitting second sliver onto pick succeeds!
	fit2 := x.opRefreshing(c, &s, "fit", map[string]any{"tool": pick, "instance": sliver2}, 200)
	pickView := findInstance(fit2.Result.Items, pick)
	if pickView == nil || !pickView.WardenSet {
		t.Fatal("expected pick to be warden-set")
	}

	// Withdrawing the first warden tool from storage while carrying the second in pack is refused.
	errWithdraw := x.p5("POST", "/api/storage", body(s, "withdraw-axe", map[string]any{
		"direction": "withdraw",
		"chest":     "personal",
		"asset":     content.Asset{Kind: "instance", ID: "bench-axe", Qty: 1, Instance: axe},
	}), c, 409)
	if errWithdraw.Error.Code != "two-wardens-grind" {
		t.Fatalf("expected two-wardens-grind on withdraw, got %s", errWithdraw.Error.Code)
	}

	// Give a warden tool to Bob when Bob already has a warden tool is refused.
	bobSpade := x.instance(x.account("bob"), "bench-spade", -1, "")
	bobSliver := x.instance(x.account("bob"), "warden-sliver", -1, "")
	x.refresh(bc, &b)
	x.opRefreshing(bc, &b, "fit", map[string]any{"tool": bobSpade, "instance": bobSliver}, 200)

	// Alice tries to give her warden-set pick to Bob: refused with two-wardens-grind.
	errGive := x.opRefreshing(c, &s, "give", map[string]any{
		"toId":  x.account("bob"),
		"asset": content.Asset{Kind: "instance", ID: "bench-pick", Qty: 1, Instance: pick},
	}, 409)
	if errGive.Error.Code != "two-wardens-grind" {
		t.Fatalf("expected two-wardens-grind on give, got %s", errGive.Error.Code)
	}

	x.conserved(x.account("alice"))
	x.conserved(x.account("bob"))
}

func TestWardenSliverMovesBetweenToolsAtBench(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)
	axe := x.instance(x.account("alice"), "bench-axe", -1, "")
	pick := x.instance(x.account("alice"), "bench-pick", -1, "")
	sliver := x.instance(x.account("alice"), "warden-sliver", -1, "")
	x.opRefreshing(c, &s, "fit", map[string]any{"tool": axe, "instance": sliver}, 200)
	moved := x.opRefreshing(c, &s, "fit", map[string]any{"tool": pick, "instance": sliver}, 200)
	if view := findInstance(moved.Result.Items, axe); view == nil || view.WardenSet {
		t.Fatal("expected source axe to release its warden fitting")
	}
	if view := findInstance(moved.Result.Items, pick); view == nil || !view.WardenSet {
		t.Fatal("expected destination pick to receive the warden fitting")
	}
	x.conserved(x.account("alice"))
}

func TestWardenMailReturnsAvoidSecondCarriedTool(t *testing.T) {
	for _, mode := range []string{"recall-to-personal", "expiry-to-personal"} {
		t.Run(mode, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			_, bob := x.member("bob", s.WorldID)
			s = x.openWorkshop(c, s)
			axe := x.instance(x.account("alice"), "bench-axe", -1, "")
			axeSliver := x.instance(x.account("alice"), "warden-sliver", -1, "")
			pick := x.instance(x.account("alice"), "bench-pick", -1, "")
			pickSliver := x.instance(x.account("alice"), "warden-sliver", -1, "")
			x.opRefreshing(c, &s, "fit", map[string]any{"tool": axe, "instance": axeSliver}, 200)
			sent := x.p5("POST", "/api/mail", body(s, "send-warden", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "instance", ID: "bench-axe", Qty: 1, Instance: axe}}), c, 200)
			s.Snapshot = sent.Snapshot
			x.opRefreshing(c, &s, "fit", map[string]any{"tool": pick, "instance": pickSliver}, 200)
			senderRev := count(t, x.db, "SELECT version FROM players WHERE account_id='"+x.account("alice")+"'")
			lastSeen := count(t, x.db, "SELECT last_seen_at FROM players WHERE account_id='"+x.account("alice")+"'")
			// Either way it lands in the personal chest, which comes along on a move.
			expectedLocation, expectedOwner := "personal", x.account("alice")
			if mode == "expiry-to-personal" {
				x.now.Add(60)
				if _, err := x.db.DB.Exec("DELETE FROM homestead_members WHERE account_id='" + x.account("alice") + "'"); err != nil {
					t.Fatal(err)
				}
				if _, err := x.db.DB.Exec("UPDATE mail SET sent_at=? WHERE id=?", x.now.Load()-30*86400, sent.Result.MailID); err != nil {
					t.Fatal(err)
				}
				if n, err := x.db.ReturnDueMail(context.Background(), x.now.Load()); err != nil || n != 1 {
					t.Fatalf("automatic return: %d, %v", n, err)
				}
			} else {
				x.p5("POST", "/api/mail/"+sent.Result.MailID+"/recall", body(s, "recall-warden", nil), c, 200)
			}
			var location, owner string
			if err := x.db.DB.QueryRow("SELECT location,owner FROM item_instances WHERE id=?", axe).Scan(&location, &owner); err != nil {
				t.Fatal(err)
			}
			if location != expectedLocation || owner != expectedOwner {
				t.Fatalf("returned warden tool at %s/%s, want %s/%s", location, owner, expectedLocation, expectedOwner)
			}
			if count(t, x.db, "SELECT count(*) FROM item_instances t WHERE t.location='pack' AND t.owner='"+x.account("alice")+"' AND EXISTS (SELECT 1 FROM item_instances f WHERE f.location='fitted' AND f.owner=t.id AND f.item_def='warden-sliver')") != 1 {
				t.Fatal("return created a second warden-set tool in the pack")
			}
			x.conserved(x.account("alice"))
			if count(t, x.db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE account_id='"+x.account("alice")+"' AND currency='personal:instance:bench-axe'") != 1 || count(t, x.db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE account_id='"+x.account("alice")+"' AND currency='mail:instance:bench-axe'") != 0 {
				t.Fatal("personal/transit audit does not match returned tool")
			}
			if count(t, x.db, "SELECT version FROM players WHERE account_id='"+x.account("alice")+"'") != senderRev+1 || count(t, x.db, "SELECT version FROM players WHERE account_id='"+x.account("bob")+"'") != int(bob.Version) {
				t.Fatal("return must bump only the sender revision, once")
			}
			if mode == "expiry-to-personal" && count(t, x.db, "SELECT last_seen_at FROM players WHERE account_id='"+x.account("alice")+"'") != lastSeen {
				t.Fatal("unattended return changed last-seen time")
			}
		})
	}
}

func TestWardenToolWearDullnessSpeedAndHealing(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)

	axe := x.instance(x.account("alice"), "bench-axe", -1, "")
	sliver := x.instance(x.account("alice"), "warden-sliver", -1, "")
	x.opRefreshing(c, &s, "fit", map[string]any{"tool": axe, "instance": sliver}, 200)

	// Wear axe down to 0 points.
	// Bench-axe has MaxPoints=120, wearCost with warden fitting is ceil(120/40)=3 points/use.
	// At zero, a regular bench tool breaks, but warden-set tool does NOT break; it dulls.
	for i := 0; i < 40; i++ {
		w := x.opRefreshing(c, &s, "use", map[string]any{"instance": axe, "action": "chop"}, 200)
		if w.Result.Wear.Broke {
			t.Fatal("warden-set tool should never break")
		}
	}

	// Read items to verify dull state, dullness fraction, and working speed.
	items := x.items("GET", "/api/items", nil, c, 200)
	axeView := findInstance(items.Items, axe)
	if axeView == nil {
		t.Fatal("axe not found")
	}
	if axeView.Condition != 0 {
		t.Fatalf("expected condition 0, got %d", axeView.Condition)
	}
	if axeView.State != "dull" {
		t.Fatalf("expected state dull, got %s", axeView.State)
	}
	if axeView.Dullness == nil || *axeView.Dullness != 1.0 {
		t.Fatalf("expected dullness 1.0, got %v", axeView.Dullness)
	}
	if axeView.Speed == nil || *axeView.Speed != 0.50 {
		t.Fatalf("expected speed 0.50, got %v", axeView.Speed)
	}

	// Test overnight healing: advance clock to next day.
	x.now.Store(x.now.Load() + 86400)
	healedItems := x.items("GET", "/api/items", nil, c, 200)
	healedAxe := findInstance(healedItems.Items, axe)
	if healedAxe == nil || healedAxe.Condition != healedAxe.MaxCondition {
		t.Fatalf("expected overnight heal to max condition (%d), got %d", healedAxe.MaxCondition, healedAxe.Condition)
	}
	if healedAxe.State != "whole" {
		t.Fatalf("expected state whole after overnight heal, got %s", healedAxe.State)
	}

	// Test tool rack healing in home storage over ~1h (3600s).
	// Wear the axe down again.
	for i := 0; i < 40; i++ {
		x.opRefreshing(c, &s, "use", map[string]any{"instance": axe, "action": "chop"}, 200)
	}

	// alice already has a homestead from openWorkshop. Find its ID.
	var homeID string
	err := x.db.DB.QueryRow("SELECT homestead_id FROM homestead_members WHERE account_id='" + x.account("alice") + "'").Scan(&homeID)
	if err != nil {
		t.Fatal(err)
	}

	// Deposit axe into shared storage.
	dep := x.p5("POST", "/api/storage", body(s, "store-dull-axe", map[string]any{
		"direction": "deposit",
		"chest":     "shared",
		"asset":     content.Asset{Kind: "instance", ID: "bench-axe", Qty: 1, Instance: axe},
	}), c, 200)
	s.Snapshot = dep.Snapshot

	// Place tool-rack on homestead.
	_, err = x.db.DB.Exec("INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES('rack-1','tool-rack','placed',?,'indoor',0,0,0)", homeID)
	if err != nil {
		t.Fatal(err)
	}

	now := x.now.Load()
	// Advance time by 3600 seconds (1 hour).
	x.now.Store(now + 3600)

	// Access workshop storage: healWardensHome should restore axe to full condition.
	ws := x.p5("GET", "/api/storage", nil, c, 200)
	if ws.Storage == nil {
		t.Fatal("expected Storage in workshopView")
	}
	rackAxe := instanceFromList(ws.Storage.Instances, axe)
	if rackAxe == nil || rackAxe.Condition != rackAxe.MaxCondition {
		t.Fatalf("expected tool rack to heal axe to %d, got %v", rackAxe.MaxCondition, rackAxe)
	}

	x.conserved(x.account("alice"))
}

func TestWardenDullingUseCountAcrossToolsAndHold(t *testing.T) {
	hold := []instanceRow{{Def: "loose-road-nail"}}
	for _, tool := range content.ItemsRules.Items {
		if tool.Kind != "tool" || tool.MaxPoints() <= 0 {
			continue
		}
		for _, tc := range []struct {
			name     string
			fittings []instanceRow
			want     int
		}{{"plain", nil, 40}, {"hold", hold, 80}} {
			condition, uses := tool.MaxPoints(), 0
			for condition > 0 {
				condition = wardenWear(tool.MaxPoints(), condition, tc.fittings)
				uses++
				if uses > 100 {
					t.Fatalf("%s/%s never dulled", tool.ID, tc.name)
				}
			}
			if uses != tc.want {
				t.Errorf("%s/%s dulled after %d uses, want %d", tool.ID, tc.name, uses, tc.want)
			}
		}
	}
}

// Settling the Warden is a story beat only (owner's pacing decision): the
// quest gift still lands, but no warden-stone sliver comes with it, then or
// on any later upload. Slivers are deep-country finds.
func TestSettlingTheWardenGrantsNoSliver(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	doc := s.State
	for _, stage := range []string{"guardian-defeated", "complete"} {
		doc.Quest = stage
		res := x.expect("PUT", "/api/progress", mutation(s, doc), c, 200)
		s.Snapshot = res.Snapshot
		items := x.items("GET", "/api/items", nil, c, 200)
		for _, inst := range items.Items.Instances {
			if inst.ItemDef == "warden-sliver" {
				t.Fatalf("%s: settling the Warden granted a sliver", stage)
			}
		}
	}
	if count(t, x.db, "SELECT count(*) FROM outcomes WHERE account_id='"+x.account("alice")+"' AND outcome_id='quest-gift:warden-sliver'") != 0 {
		t.Fatal("a story sliver outcome was recorded")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id='"+x.account("alice")+"' AND currency=?", content.StackCurrency("warden-sliver")) != 0 {
		t.Fatal("a sliver ledger row was written")
	}
	if count(t, x.db, "SELECT count(*) FROM outcomes WHERE account_id='"+x.account("alice")+"' AND outcome_id='quest-gift:defeat-guardian'") != 1 {
		t.Fatal("the quest's ember gift should still land")
	}

	x.conserved(x.account("alice"))
}

func TestUnmooredConsumables(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	x.stack(x.account("alice"), "comfrey-salve", "", 2)
	x.stack(x.account("alice"), "willow-bark-tea", "", 2)

	// Without unmoored flag (not unmoored), using remedy is refused with 409 not-needed.
	errSalve := x.opRefreshing(c, &s, "use", map[string]any{"itemDef": "comfrey-salve"}, 409)
	if errSalve.Error.Code != "not-needed" {
		t.Fatalf("expected not-needed for salve when not unmoored, got %s", errSalve.Error.Code)
	}
	errTea := x.opRefreshing(c, &s, "use", map[string]any{"itemDef": "willow-bark-tea"}, 409)
	if errTea.Error.Code != "not-needed" {
		t.Fatalf("expected not-needed for tea when not unmoored, got %s", errTea.Error.Code)
	}

	// With unmoored: true, using remedies succeeds and consumes one.
	okSalve := x.opRefreshing(c, &s, "use", map[string]any{"itemDef": "comfrey-salve", "unmoored": true}, 200)
	if okSalve.Result.Used != "comfrey-salve" {
		t.Fatalf("expected comfrey-salve used, got %s", okSalve.Result.Used)
	}
	okTea := x.opRefreshing(c, &s, "use", map[string]any{"itemDef": "willow-bark-tea", "unmoored": true}, 200)
	if okTea.Result.Used != "willow-bark-tea" {
		t.Fatalf("expected willow-bark-tea used, got %s", okTea.Result.Used)
	}

	if count(t, x.db, "SELECT qty FROM item_stacks WHERE owner='"+x.account("alice")+"' AND item_def='comfrey-salve'") != 1 {
		t.Fatal("expected 1 comfrey-salve left")
	}
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE owner='"+x.account("alice")+"' AND item_def='willow-bark-tea'") != 1 {
		t.Fatal("expected 1 willow-bark-tea left")
	}

	x.conserved(x.account("alice"))
}

func TestWardenSliverClaimGrantCapReplayAndLedger(t *testing.T) {
	x := newRig(t)
	seedCookie, seed := x.ready("probe")
	v := x.region(seedCookie)
	entryX, entryY := 1, 1
	for _, region := range content.WildsRules.Regions {
		if region.ID == "inner-1" {
			entryX, entryY = region.EntryX, region.EntryY
		}
	}
	deep := []entityView{}
	for _, entity := range v.Entities {
		var cx, cy int
		fmt.Sscanf(entity.ID, entity.Kind+":%d:%d:", &cx, &cy)
		if (entity.Kind == "node" || entity.Kind == "chest") && intAbs(cx-entryX)+intAbs(cy-entryY) >= content.WildsRules.DeepTangleManhattanDistance {
			deep = append(deep, entity)
		}
	}
	if len(deep) < 2 {
		t.Fatal("expected at least two entities in deep Tangle")
	}
	player := "sliver-hunter"
	c, s := x.member(player, seed.WorldID)
	account := x.account(player)
	week := int(x.now.Load() / (7 * 86400))
	first := entityView{}
	for n := 0; n < 10000 && first.ID == ""; n++ {
		for _, entity := range deep {
			var cx, cy int
			fmt.Sscanf(entity.ID, entity.Kind+":%d:%d:", &cx, &cy)
			if wilds.Hash(account, entity.ID, week, "warden-sliver", cx, cy)%1000 < 2 {
				first = entity
				break
			}
		}
		if first.ID == "" {
			week++
		}
	}
	if first.ID == "" {
		t.Fatal("no deterministic rare roll for actual random account")
	}
	x.now.Store(int64(week)*7*86400 + 3600)
	c, s = x.again(player)
	v = x.region(c)
	var second entityView
	for _, e := range deep {
		if e.ID != first.ID {
			second = e
			break
		}
	}
	request := body(s, "rare-find", map[string]any{"epoch": v.Epoch.ID, "entityId": first.ID, "progress": nearEntity(s, first), "cycle": 0})
	grant := x.exp("POST", "/api/wilds/claim", request, c, 200)
	if !grant.Result.WardenSliverFound {
		t.Fatal("expected claim response to report the warden sliver")
	}
	replay := x.exp("POST", "/api/wilds/claim", request, c, 200)
	if store.JSON(replay) != store.JSON(grant) {
		t.Fatal("claim replay changed the response")
	}
	update(&s, grant)
	blocked := x.exp("POST", "/api/wilds/claim", body(s, "weekly-cap", map[string]any{"epoch": v.Epoch.ID, "entityId": second.ID, "progress": nearEntity(s, second), "cycle": 0}), c, 200)
	if blocked.Result.WardenSliverFound || count(t, x.db, "SELECT count(*) FROM warden_finds WHERE account_id=?", account) != 1 {
		t.Fatal("weekly cap granted a second sliver")
	}
	if count(t, x.db, "SELECT count(*) FROM item_instances WHERE location='pack' AND owner=? AND item_def='warden-sliver'", account) != 1 {
		t.Fatal("expected exactly one sliver instance")
	}
	x.conserved(account)
}

func instanceFromList(list []instanceView, id string) *instanceView {
	for i := range list {
		if list[i].ID == id {
			return &list[i]
		}
	}
	return nil
}

var _ = time.Hour
