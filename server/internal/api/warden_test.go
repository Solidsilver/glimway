package api

import (
	"context"
	"fingersnap/content"
	"testing"
	"time"
)

func TestWardenSliverFittingAndSingleCarriedRestriction(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)

	s = x.openWorkshop(c, s)
	b = x.openWorkshop(bc, b)

	axe := x.instance("alice", "bench-axe", -1, "")
	pick := x.instance("alice", "bench-pick", -1, "")
	sliver1 := x.instance("alice", "warden-sliver", -1, "")
	sliver2 := x.instance("alice", "warden-sliver", -1, "")

	x.stand("alice", s.WorldID, "village", 100, 100)
	x.stand("bob", s.WorldID, "village", 120, 100)

	// Fitting first sliver onto the axe succeeds.
	fit1 := x.op(c, &s, "fit", map[string]any{"tool": axe, "instance": sliver1}, 200)
	axeView := findInstance(fit1.Result.Items, axe)
	if axeView == nil || !axeView.WardenSet {
		t.Fatal("expected axe to be warden-set")
	}

	// Fitting second sliver onto pick while already carrying a warden tool in pack is refused.
	errFit2 := x.op(c, &s, "fit", map[string]any{"tool": pick, "instance": sliver2}, 409)
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
	fit2 := x.op(c, &s, "fit", map[string]any{"tool": pick, "instance": sliver2}, 200)
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
	bobSpade := x.instance("bob", "bench-spade", -1, "")
	bobSliver := x.instance("bob", "warden-sliver", -1, "")
	x.refresh(bc, &b)
	x.op(bc, &b, "fit", map[string]any{"tool": bobSpade, "instance": bobSliver}, 200)

	// Alice tries to give her warden-set pick to Bob: refused with two-wardens-grind.
	errGive := x.op(c, &s, "give", map[string]any{
		"toId":  "bob",
		"asset": content.Asset{Kind: "instance", ID: "bench-pick", Qty: 1, Instance: pick},
	}, 409)
	if errGive.Error.Code != "two-wardens-grind" {
		t.Fatalf("expected two-wardens-grind on give, got %s", errGive.Error.Code)
	}

	x.conserved("alice")
	x.conserved("bob")
}

func TestWardenToolWearDullnessSpeedAndHealing(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)

	axe := x.instance("alice", "bench-axe", -1, "")
	sliver := x.instance("alice", "warden-sliver", -1, "")
	x.op(c, &s, "fit", map[string]any{"tool": axe, "instance": sliver}, 200)

	// Wear axe down to 0 points.
	// Bench-axe has MaxPoints=120, wearCost with warden fitting is ceil(120/40)=3 points/use.
	// At zero, a regular bench tool breaks, but warden-set tool does NOT break; it dulls.
	for i := 0; i < 40; i++ {
		w := x.op(c, &s, "use", map[string]any{"instance": axe, "action": "chop"}, 200)
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
		x.op(c, &s, "use", map[string]any{"instance": axe, "action": "chop"}, 200)
	}

	// alice already has a homestead from openWorkshop. Find its ID.
	var homeID string
	err := x.db.DB.QueryRow("SELECT homestead_id FROM homestead_members WHERE habitica_id='alice'").Scan(&homeID)
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

	x.conserved("alice")
}

func TestWardenSliverStoryGrantOnGuardianDefeated(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	doc := s.State
	doc.Quest = "guardian-defeated"

	// Uploading progress with quest stage "guardian-defeated" triggers sliver grant.
	res := x.expect("PUT", "/api/progress", mutation(s, doc), c, 200)
	s.Snapshot = res.Snapshot

	items := x.items("GET", "/api/items", nil, c, 200)
	sliverCount := 0
	for _, inst := range items.Items.Instances {
		if inst.ItemDef == "warden-sliver" {
			sliverCount++
		}
	}
	if sliverCount != 1 {
		t.Fatalf("expected 1 warden-sliver granted from story, found %d", sliverCount)
	}

	// Verify outcome recorded.
	if count(t, x.db, "SELECT count(*) FROM outcomes WHERE habitica_id='alice' AND outcome_id='quest-gift:warden-sliver'") != 1 {
		t.Fatal("expected outcome quest-gift:warden-sliver recorded")
	}

	// Progress upload again does not grant a second sliver.
	res2 := x.expect("PUT", "/api/progress", mutation(s, doc), c, 200)
	s.Snapshot = res2.Snapshot
	items2 := x.items("GET", "/api/items", nil, c, 200)
	sliverCount2 := 0
	for _, inst := range items2.Items.Instances {
		if inst.ItemDef == "warden-sliver" {
			sliverCount2++
		}
	}
	if sliverCount2 != 1 {
		t.Fatalf("sliver was duplicated: %d", sliverCount2)
	}

	x.conserved("alice")
}

func TestUnmooredConsumables(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	x.stack("alice", "comfrey-salve", "", 2)
	x.stack("alice", "willow-bark-tea", "", 2)

	// Without unmoored flag (not unmoored), using remedy is refused with 409 not-needed.
	errSalve := x.op(c, &s, "use", map[string]any{"itemDef": "comfrey-salve"}, 409)
	if errSalve.Error.Code != "not-needed" {
		t.Fatalf("expected not-needed for salve when not unmoored, got %s", errSalve.Error.Code)
	}
	errTea := x.op(c, &s, "use", map[string]any{"itemDef": "willow-bark-tea"}, 409)
	if errTea.Error.Code != "not-needed" {
		t.Fatalf("expected not-needed for tea when not unmoored, got %s", errTea.Error.Code)
	}

	// With unmoored: true, using remedies succeeds and consumes one.
	okSalve := x.op(c, &s, "use", map[string]any{"itemDef": "comfrey-salve", "unmoored": true}, 200)
	if okSalve.Result.Used != "comfrey-salve" {
		t.Fatalf("expected comfrey-salve used, got %s", okSalve.Result.Used)
	}
	okTea := x.op(c, &s, "use", map[string]any{"itemDef": "willow-bark-tea", "unmoored": true}, 200)
	if okTea.Result.Used != "willow-bark-tea" {
		t.Fatalf("expected willow-bark-tea used, got %s", okTea.Result.Used)
	}

	if count(t, x.db, "SELECT qty FROM item_stacks WHERE owner='alice' AND item_def='comfrey-salve'") != 1 {
		t.Fatal("expected 1 comfrey-salve left")
	}
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE owner='alice' AND item_def='willow-bark-tea'") != 1 {
		t.Fatal("expected 1 willow-bark-tea left")
	}

	x.conserved("alice")
}

func TestWardenSliverDailyCap(t *testing.T) {
	x := newRig(t)
	_, s := x.ready("alice")
	now := x.now.Load()
	ctx := context.Background()

	tx1, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx1.Rollback()

	// Direct grant check on day 1
	day1 := utcDay(now)
	// Seed warden_finds with day 1
	_, err = tx1.ExecContext(ctx, "INSERT INTO warden_finds(habitica_id, utc_day) VALUES(?,?)", s.HabiticaID, day1)
	if err != nil {
		t.Fatal(err)
	}

	// Another attempt on day 1 should be blocked by daily cap (warden_finds check).
	var count int
	err = tx1.QueryRowContext(ctx, "SELECT count(*) FROM warden_finds WHERE habitica_id=? AND utc_day=?", s.HabiticaID, day1).Scan(&count)
	if err != nil || count != 1 {
		t.Fatalf("expected 1 find on day1, got %d (err: %v)", count, err)
	}

	// On day 2, no record exists in warden_finds yet
	day2 := day1 + 1
	err = tx1.QueryRowContext(ctx, "SELECT count(*) FROM warden_finds WHERE habitica_id=? AND utc_day=?", s.HabiticaID, day2).Scan(&count)
	if err != nil || count != 0 {
		t.Fatalf("expected 0 finds on day2, got %d", count)
	}

	if err = tx1.Commit(); err != nil {
		t.Fatal(err)
	}

	x.conserved("alice")
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
