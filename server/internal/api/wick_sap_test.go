package api

import (
	"glimway/content"
	"glimway/server/internal/rules"
	"testing"
)

// byWickTree is the progress doc standing at the Wick Tree's tapping spot.
func byWickTree(s response) rules.State {
	r := content.HomeRules.GetWickSap()
	return atContentTile(s.State, r.GetArea(), int(r.GetTx()), int(r.GetTy()), 12)
}

// The sap's content hangs together: a real item, oil and refiner, and one
// sap refines into at least one lot lantern's weekly upkeep (one wick).
func TestWickSapContent(t *testing.T) {
	r := content.HomeRules.GetWickSap()
	if _, ok := content.ItemFor(r.GetItem()); !ok {
		t.Fatal("sap item", r.GetItem())
	}
	if _, ok := content.ItemFor(r.GetOil()); !ok || r.GetOil() != content.HomeRules.GetLotLantern().GetOil() {
		t.Fatal("sap oil", r.GetOil())
	}
	if _, ok := content.SellerFor(r.GetRefiner()); !ok {
		t.Fatal("refiner", r.GetRefiner())
	}
	if r.GetQty()*r.GetOilQty()*content.HomeRules.GetLotLantern().GetWicksPerOil() < 1 {
		t.Fatal("a wick's sap doesn't keep a lot lantern a wick")
	}
}

// Anyone taps the tree once a wick, lantern or none; a second tap that
// wick is refused gently; the next wick taps again; a missed wick is not
// saved up.
func TestWickSapOneTapAWick(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	sap := content.HomeRules.GetWickSap().GetItem()
	tap := func(status int) itemsResponse {
		return x.opRefreshing(c, &s, "tap", map[string]any{"progress": byWickTree(s)}, status)
	}

	// Not by the tree, no sap.
	far := s.State
	far.Area = "woodland"
	far.Position = rules.Position{X: float64(20*16 + 8), Y: float64(20*16 + 12)}
	if x.opRefreshing(c, &s, "tap", map[string]any{"progress": far}, 409).Error.Code != "too-far-away" {
		t.Fatal("tapped from afar")
	}

	r := tap(200)
	if r.Result.Tapped == nil || r.Result.Tapped.ItemDef != sap || r.Result.Tapped.Qty != 1 || !r.Result.FirstTap || stackQty(r.Result.Items, sap) != 1 {
		t.Fatalf("first tap: %+v", r.Result)
	}
	if code := tap(409).Error.Code; code != "already-tapped" {
		t.Fatal("tapped twice in a wick", code)
	}
	if x.packQty(s.AccountID, sap) != 1 {
		t.Fatal("second tap gave sap")
	}

	// The turning: a new wick, a new tap (not a first).
	x.turn()
	c, s = x.again("alice")
	if r = tap(200); r.Result.FirstTap || stackQty(r.Result.Items, sap) != 2 {
		t.Fatalf("next wick: %+v", r.Result)
	}
	// Two wicks missed are two taps gone: one tap now, not three.
	x.turn()
	x.turn()
	c, s = x.again("alice")
	tap(200)
	if code := tap(409).Error.Code; code != "already-tapped" || x.packQty(s.AccountID, sap) != 3 {
		t.Fatal("missed wicks carried over", code, x.packQty(s.AccountID, sap))
	}
	x.conserved(s.AccountID)
}

// A tap retried with the same key answers as the first did and gives no
// second sap.
func TestWickSapTapReplaySafe(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	sap := content.HomeRules.GetWickSap().GetItem()
	x.refresh(c, &s)
	req := body(s, "tap-once", map[string]any{"progress": byWickTree(s)})
	first := x.items("POST", "/api/items/tap", req, c, 200)
	again := x.items("POST", "/api/items/tap", req, c, 200)
	if first.Result.Tapped == nil || again.Result.Tapped == nil || !again.Result.FirstTap || x.packQty(s.AccountID, sap) != 1 {
		t.Fatalf("replay: %+v / %+v, %d sap", first.Result, again.Result, x.packQty(s.AccountID, sap))
	}
}

// The chandler refines sap into hearth oil for nothing; buying oil there
// still costs its glims, capped a day, as before.
func TestWickSapRefineAndBuyAtTheChandler(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	r := content.HomeRules.GetWickSap()
	sap, oil := r.GetItem(), r.GetOil()
	x.fundGlims(s.AccountID, 20)
	refine := func(status int) itemsResponse {
		return x.opRefreshing(c, &s, "refine", map[string]any{"progress": bySeller(s, r.GetRefiner(), x.now.Load())}, status)
	}

	// No sap, nothing to refine.
	if code := refine(409).Error.Code; code != "insufficient-items" {
		t.Fatal("refined nothing", code)
	}
	x.opRefreshing(c, &s, "tap", map[string]any{"progress": byWickTree(s)}, 200)
	// Not by the chandler, no refining.
	if code := x.opRefreshing(c, &s, "refine", map[string]any{"progress": byWickTree(s)}, 409).Error.Code; code != "too-far-away" {
		t.Fatal("refined from afar", code)
	}
	glims := s.State.Glims
	out := refine(200)
	if out.Result.Refined == nil || out.Result.Refined.ItemDef != oil || out.Result.Refined.Qty != int(r.GetOilQty()) || stackQty(out.Result.Items, sap) != 0 || stackQty(out.Result.Items, oil) != int(r.GetOilQty()) {
		t.Fatalf("refine: %+v", out.Result)
	}
	if s.State.Glims != glims {
		t.Fatal("refining cost glims", glims, s.State.Glims)
	}
	if code := refine(409).Error.Code; code != "insufficient-items" {
		t.Fatal("refined the same sap twice", code)
	}

	// Buying is unchanged: 4 glims a flask, 3 a day.
	buy := func(status int) itemsResponse {
		return x.opRefreshing(c, &s, "buy", map[string]any{"seller": "chandler", "good": oil, "progress": bySeller(s, "chandler", x.now.Load())}, status)
	}
	for i := 0; i < 3; i++ {
		if b := buy(200); b.Result.Bought == nil || b.Result.Bought.Glims != 4 {
			t.Fatalf("buy %d: %+v", i, b.Result)
		}
	}
	if code := buy(409).Error.Code; code != "sold-out" {
		t.Fatal("bought past the day's cap", code)
	}
	if s.State.Glims != glims-12 || x.packQty(s.AccountID, oil) != int(r.GetOilQty())+3 {
		t.Fatal("bought oil", s.State.Glims, x.packQty(s.AccountID, oil))
	}
	x.conserved(s.AccountID)
}
