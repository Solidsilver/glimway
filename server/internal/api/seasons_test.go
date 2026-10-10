package api

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"glimway/content"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
)

// The seasonal materials and the last material sources
// (docs/items/crafting-and-repair.md, "Seasonal materials"). Each material
// turns up only in its season, from the source the doc names; the server
// decides the season from its own clock and the calendar, never the
// client; the day's caps and the ledger hold everywhere.

// jumpTo walks the rig's clock forward (never back) to a day of the named
// mark, wick or festival, and returns the unix it set.
func (x *rig) jumpTo(kind, want string) int64 {
	return x.walkTo(kind, want, false)
}

// jumpToPlain is jumpTo for a day with no festival on it (review finding 4):
// the madder stall stands on Carting Day itself, so a plain Carting-mark day
// and the festival are different answers.
func (x *rig) jumpToPlain(kind, want string) int64 {
	return x.walkTo(kind, want, true)
}

func (x *rig) walkTo(kind, want string, plain bool) int64 {
	x.t.Helper()
	for d := int64(0); d < 12*int64(content.CalendarRules.WickDays); d++ {
		t := x.now.Load() + d*86400 + 3600
		day := content.CalendarAt(content.CalendarRules, t)
		if plain && day.Festival != nil {
			continue
		}
		switch kind {
		case "mark":
			if day.Mark == want {
				x.now.Add(t - x.now.Load())
				return t
			}
		case "wick":
			if day.Wick == want {
				x.now.Add(t - x.now.Load())
				return t
			}
		case "festival":
			if day.Festival != nil && *day.Festival == want {
				x.now.Add(t - x.now.Load())
				return t
			}
		default:
			x.t.Fatal("unknown jump kind", kind)
		}
	}
	x.t.Fatalf("no %s %s ahead", kind, want)
	return 0
}

// jumpToAs walks the rig's clock forward (never back) to a day of the
// named mark, wick or festival, and re-logs the player: the session cookie
// lives seven days of the rig's clock, and a season is longer.
func (x *rig) jumpToAs(id, kind, want string) *http.Cookie {
	x.jumpTo(kind, want)
	return x.login(id, "")
}

// jumpToPlainAs is jumpToAs for a day with no festival on it.
func (x *rig) jumpToPlainAs(id, kind, want string) *http.Cookie {
	x.jumpToPlain(kind, want)
	return x.login(id, "")
}

func TestSeasonalGatherSpots(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	spade := x.instance(s.AccountID, "bench-spade", -1, "")
	pick := x.instance(s.AccountID, "bench-pick", -1, "")
	shore := [2]int{34, 18} // the freshet shore by the village pond
	ice := [2]int{34, 19}   // the frozen pond itself

	// Out of season, a stale client map is refused, not honoured.
	c = x.jumpToAs("alice", "mark", "Carting")
	if x.opRefreshing(c, &s, "gather", gatherIn(s, "village", shore, spade, "dig", "freshet-shore", "v1"), 409).Error.Code != "not-in-season" {
		t.Fatal("swept the shore out of Mudrise")
	}
	c = x.jumpToAs("alice", "wick", "Smoke")
	if x.opRefreshing(c, &s, "gather", gatherIn(s, "village", [2]int{36, 18}, spade, "dig", "bloom-patch", "v1"), 409).Error.Code != "not-in-season" {
		t.Fatal("picked blooms out of the Bloom wick")
	}

	// Mudrise: the freshet shore by the village water sweeps up walnut shells.
	c = x.jumpToAs("alice", "mark", "Mudrise")
	r := x.opRefreshing(c, &s, "gather", gatherIn(s, "village", shore, spade, "dig", "freshet-shore", "v1"), 200)
	if n := stackQty(r.Result.Items, "walnut-shells"); n < 1 || n > 2 {
		t.Fatalf("walnut shells %d", n)
	}
	// The Commons has no freshet shore; the village has no bloom patches.
	if x.opRefreshing(c, &s, "gather", gatherIn(s, "commons", shore, spade, "dig", "freshet-shore", "v1"), 409).Error.Code != "cannot-gather-here" {
		t.Fatal("swept the Commons")
	}

	// Bloom-wick: bloom flowers, in the Commons...
	c = x.jumpToAs("alice", "wick", "Bloom")
	if x.opRefreshing(c, &s, "gather", gatherIn(s, "village", [2]int{36, 18}, spade, "dig", "bloom-patch", "v2"), 409).Error.Code != "cannot-gather-here" {
		t.Fatal("the village offered blooms where none grow")
	}
	r = x.opRefreshing(c, &s, "gather", gatherIn(s, "commons", [2]int{8, 19}, spade, "dig", "bloom-patch", "c1"), 200)
	if n := stackQty(r.Result.Items, "bloom-flowers"); n < 1 || n > 2 {
		t.Fatalf("bloom flowers %d", n)
	}
	// ...and in the Tangle, where a flower patch is picked, not dug, in
	// Bloom. Out of the wick the same patch gives its herbs again.
	c = x.jumpToAs("alice", "mark", "Amberfall")
	r = x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", [2]int{20, 20}, spade, "dig", "herbs", "v2"), 200)
	for _, g := range r.Result.Gathered {
		if g.ItemDef == "bloom-flowers" {
			t.Fatal("herbs in Amberfall gave blooms")
		}
	}

	// The Quiet: the pond freezes, and a pick breaks the ice for frost-glass.
	c = x.jumpToAs("alice", "mark", "Quiet")
	r = x.opRefreshing(c, &s, "gather", gatherIn(s, "village", ice, pick, "break", "pond-ice", "q1"), 200)
	if n := stackQty(r.Result.Items, "frost-glass"); n < 1 || n > 2 {
		t.Fatalf("frost-glass %d", n)
	}
	// A dig at the ice is not the work it wants.
	if x.opRefreshing(c, &s, "gather", gatherIn(s, "village", ice, spade, "dig", "pond-ice", "q1"), 409).Error.Code != "wrong-tool" {
		t.Fatal("dug the ice")
	}
	x.conserved(s.AccountID)
}

func TestAmberfallSapFromTangleTreesOnly(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	axe := x.instance(s.AccountID, "brack-felling-axe", -1, "")
	here := [2]int{20, 20}

	c = x.jumpToAs("alice", "mark", "Amberfall")
	sap := 0
	for i := 0; i < int(content.GatheringRules.GetCaps().GetDay().GetChop()) && sap == 0; i++ {
		r := x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, axe, "chop", "tangle-tree", fmt.Sprintf("v%d", i/int(content.GatheringRules.GetCaps().GetVisit().GetChop()))), 200)
		for _, g := range r.Result.Gathered {
			if g.ItemDef == "amberfall-sap" {
				sap += g.Qty
			}
		}
	}
	if sap == 0 {
		t.Fatal("a season of Tangle trees gave no sap")
	}

	// The woods by the village are not the Tangle: the same season, and
	// their trees give timber only. The day's chop cap is spent, so this
	// waits for tomorrow.
	x.now.Add(86400)
	c = x.login("alice", "")
	for i := 0; i < int(content.GatheringRules.GetCaps().GetDay().GetChop()); i++ {
		r := x.opRefreshing(c, &s, "gather", gatherIn(s, "woodland", here, axe, "chop", "tree", fmt.Sprintf("w%d", i/int(content.GatheringRules.GetCaps().GetVisit().GetChop()))), 200)
		for _, g := range r.Result.Gathered {
			if g.ItemDef == "amberfall-sap" {
				t.Fatal("the village woods gave sap")
			}
		}
	}

	// The outer drift is not the Tangle either: a wilds gather names its
	// region, the Tangle's own trees are refused out there (before any
	// wear or cap), and its plain trees give timber only.
	x.now.Add(86400)
	c = x.login("alice", "")
	if x.opRefreshing(c, &s, "gather", inRegion(gatherIn(s, "wilds", here, axe, "chop", "tangle-tree", "o0"), whitequietRegion), 409).Error.Code != "cannot-gather-here" {
		t.Fatal("a Tangle tree out in the drift")
	}
	for i := 0; i < int(content.GatheringRules.GetCaps().GetDay().GetChop()); i++ {
		r := x.opRefreshing(c, &s, "gather", inRegion(gatherIn(s, "wilds", here, axe, "chop", "tree", fmt.Sprintf("o%d", i/int(content.GatheringRules.GetCaps().GetVisit().GetChop()))), whitequietRegion), 200)
		for _, g := range r.Result.Gathered {
			if g.ItemDef == "amberfall-sap" {
				t.Fatal("the outer drift's trees gave sap")
			}
		}
	}
	x.conserved(s.AccountID)
}

func TestBloomFlowersDryAfterTheirSeason(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	// Fresh in the Bloom wick, and through the rest of its season (the
	// Carting mark: Light-wick, Cart-wick): they "dry after a season".
	c = x.jumpToAs("alice", "wick", "Bloom")
	x.stack(s.AccountID, "bloom-flowers", "", 5)
	v := x.items("GET", "/api/items", nil, c, 200)
	if stackQty(v.Items, "bloom-flowers") != 5 || stackQty(v.Items, "dried-flowers") != 0 {
		t.Fatal("fresh flowers dried in their own wick")
	}
	for _, wick := range []string{"Light", "Cart"} {
		c = x.jumpToAs("alice", "wick", wick)
		v = x.items("GET", "/api/items", nil, c, 200)
		if stackQty(v.Items, "bloom-flowers") != 5 || stackQty(v.Items, "dried-flowers") != 0 {
			t.Fatalf("fresh flowers dried in %s-wick, inside their season", wick)
		}
	}

	// The season turns (Haze-wick, Amberfall): the pack's posies dry, one
	// for one, and the ledger says so.
	c = x.jumpToAs("alice", "wick", "Haze")
	v = x.items("GET", "/api/items", nil, c, 200)
	if stackQty(v.Items, "bloom-flowers") != 0 || stackQty(v.Items, "dried-flowers") != 5 {
		t.Fatalf("drying %d/%d", stackQty(v.Items, "bloom-flowers"), stackQty(v.Items, "dried-flowers"))
	}
	var rows int
	if err := x.db.DB.QueryRow("SELECT count(*) FROM ledger WHERE account_id=? AND reason='dry' AND ref='bloom-season-turned'", s.AccountID).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("drying ledger rows %d (%v)", rows, err)
	}
	// A second read finds nothing left to dry.
	x.items("GET", "/api/items", nil, c, 200)
	x.conserved(s.AccountID)

	// Dried flowers press as well as fresh: the frame takes either.
	x.refresh(c, &s)
	s = x.openWorkshop(c, s)
	x.refresh(c, &s)
	x.stack(s.AccountID, "seasoned-timber", "", 10)
	r := x.p5("POST", "/api/craft", body(s, "press", map[string]any{"recipeId": "craft-pressed-flowers", "qty": 1}), c, 200)
	if r.Result.Output.GetId() != "pressed-flowers" {
		t.Fatalf("frame %+v", r.Result.Output)
	}
	v = x.items("GET", "/api/items", nil, c, 200)
	if stackQty(v.Items, "dried-flowers") != 2 {
		t.Fatal("dried flowers left", stackQty(v.Items, "dried-flowers"))
	}
	// A mixed bill: the fresh ones go first, then the dried stand in.
	c = x.jumpToAs("alice", "wick", "Bloom")
	x.refresh(c, &s)
	x.stack(s.AccountID, "bloom-flowers", "", 1)
	r = x.p5("POST", "/api/craft", body(s, "press-mixed", map[string]any{"recipeId": "craft-pressed-flowers", "qty": 1}), c, 200)
	if r.Result.Output.GetId() != "pressed-flowers" {
		t.Fatalf("frame %+v", r.Result.Output)
	}
	v = x.items("GET", "/api/items", nil, c, 200)
	if stackQty(v.Items, "bloom-flowers") != 0 || stackQty(v.Items, "dried-flowers") != 0 {
		t.Fatalf("mixed press left fresh %d dried %d", stackQty(v.Items, "bloom-flowers"), stackQty(v.Items, "dried-flowers"))
	}
	x.conserved(s.AccountID)
}

// fundEmbers credits the caller's ledger with a purse of embers (embers
// are earned in play; tests buy their purse outright).
func (x *rig) fundEmbers(id string, n int) {
	x.t.Helper()
	ctx := context.Background()
	tx, err := x.db.DB.Begin()
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	s, err := store.Load(ctx, tx, id)
	if err != nil {
		x.t.Fatal(err)
	}
	if err = store.Credit(ctx, tx, &s, n, 0, "test-funding", "", nil, x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if err = store.Persist(ctx, tx, &s, x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		x.t.Fatal(err)
	}
}

// bySeller is the progress of a player standing at a seller's spot.
func bySeller(s response, seller string, now int64) rules.State {
	doc := s.State
	if spot, ok := content.SellerFor(seller); ok {
		area, tx, ty := spot.GetArea(), int(spot.GetTx()), int(spot.GetTy())
		if spot.GetWith() != "" {
			p, _ := content.ResidentAt(spot.GetWith(), float64(now))
			area, tx, ty = p.GetArea(), int(p.GetTx()), int(p.GetTy())
		}
		doc.Area = area
		doc.Position = rules.Position{X: float64(tx*16 + 8), Y: float64(ty*16 + 12)}
	}
	return doc
}

func TestSellersHazelFinnAndTheCartingStall(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fundEmbers(s.AccountID, 10)

	// Standing by the seller: the rig's own position rides along.
	buy := func(seller, good string, status int) itemsResponse {
		return x.opRefreshing(c, &s, "buy", map[string]any{"seller": seller, "good": good, "progress": bySeller(s, seller, x.now.Load())}, status)
	}

	// Hazel sells tallow at her kitchen door, cheap.
	if r := buy("hazels-kitchen", "tallow", 200); stackQty(r.Result.Items, "tallow") != 1 || r.Result.Bought == nil {
		t.Fatal("no tallow")
	}
	if s.State.Embers != 9 {
		t.Fatal("tallow embers", s.State.Embers)
	}
	// Finn sells flour at the mill door.
	if r := buy("finns-mill-door", "flour", 200); stackQty(r.Result.Items, "flour") != 1 {
		t.Fatal("no flour")
	}
	// Not by them, no sale; and the stall sells nothing but its own.
	doc := s.State
	doc.Area = "woodland"
	doc.Position = rules.Position{X: float64(20*16 + 8), Y: float64(20*16 + 12)}
	if x.opRefreshing(c, &s, "buy", map[string]any{"seller": "hazels-kitchen", "good": "tallow", "progress": doc}, 409).Error.Code != "too-far-away" {
		t.Fatal("bought from afar")
	}
	if buy("hazels-kitchen", "flour", 400).Error.Code != "invalid-good" {
		t.Fatal("Hazel sells flour")
	}
	if buy("no-such-seller", "tallow", 400).Error.Code != "invalid-seller" {
		t.Fatal("no such seller")
	}

	// The madder stall stands on Carting Day only: a plain Carting-mark day is
	// not the fair (on Carting Day itself the stall sells, review finding 4).
	c = x.jumpToPlainAs("alice", "mark", "Carting")
	if buy("madder-stall", "madder-scraps", 409).Error.Code != "not-in-season" {
		t.Fatal("the stall stood before the fair")
	}
	c = x.jumpToAs("alice", "festival", "Carting Day")
	for i := 0; i < 4; i++ {
		if r := buy("madder-stall", "madder-scraps", 200); stackQty(r.Result.Items, "madder-scraps") != i+1 {
			t.Fatal("scraps", i)
		}
	}
	// The day's cap: the stall's baskets are empty.
	if buy("madder-stall", "madder-scraps", 409).Error.Code != "sold-out" {
		t.Fatal("bought past the stall's day")
	}
	// Tomorrow — Carting Day has passed, and the stall with it.
	x.now.Add(86400)
	c = x.login("alice", "")
	if buy("madder-stall", "madder-scraps", 409).Error.Code != "not-in-season" {
		t.Fatal("the stall stayed past its day")
	}
	// Embers run out where they run out.
	poor, ps := x.ready("bob")
	if r := x.opRefreshing(poor, &ps, "buy", map[string]any{"seller": "hazels-kitchen", "good": "tallow", "progress": bySeller(ps, "hazels-kitchen", x.now.Load())}, 409); r.Error.Code != "insufficient-embers" {
		t.Fatal("tallow without embers", r.Error.Code)
	}
	x.conserved(s.AccountID)
	x.conserved(ps.AccountID)
}

// Finn sells the rod: a tool is handed over as one instance at full
// condition, never as a stack (the good's kind decides — questGive does the
// same for a story gift).
func TestMarketBuyGrantsAToolInstance(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fundEmbers(s.AccountID, 10)
	buy := func(status int) itemsResponse {
		return x.opRefreshing(c, &s, "buy", map[string]any{"seller": "finns-mill-door", "good": "willow-rod", "progress": bySeller(s, "finns-mill-door", x.now.Load())}, status)
	}
	def, _ := content.ItemFor("willow-rod")
	if !content.ItemInstanced(def) {
		t.Fatal("the rod is a tool")
	}
	r := buy(200)
	if r.Result.Bought == nil || r.Result.Bought.ItemDef != "willow-rod" || r.Result.Bought.Qty != 1 || r.Result.Bought.Embers != 2 {
		t.Fatal("no rod", r.Result.Bought)
	}
	if stackQty(r.Result.Items, "willow-rod") != 0 {
		t.Fatal("a tool came over as a stack")
	}
	var rod *instanceView
	for i := range r.Result.Items.Instances {
		if r.Result.Items.Instances[i].ItemDef == "willow-rod" {
			rod = &r.Result.Items.Instances[i]
		}
	}
	if rod == nil || rod.State != "whole" || rod.Condition != rod.MaxCondition || rod.MaxCondition != content.ItemMaxPoints(def) || rod.UsesLeft != int(def.GetUses()) {
		t.Fatal("the rod came over worn", rod)
	}
	if s.State.Embers != 8 {
		t.Fatal("rod embers", s.State.Embers)
	}
	// A second one comes over the same way, and the purse follows.
	second := buy(200)
	n := 0
	for i := range second.Result.Items.Instances {
		if second.Result.Items.Instances[i].ItemDef == "willow-rod" {
			n++
		}
	}
	if n != 2 || s.State.Embers != 6 {
		t.Fatal("second rod", n, s.State.Embers)
	}
	x.conserved(s.AccountID)
}

// stormFind scans the deterministic storm-drop rolls for player `id`
// (deep-Tangle synthetic entities, week by week) and returns two finds
// in different weeks: the roll is seeded by the player, the entity, the
// week and the tile, so a scan finds the weeks it comes up. `kind` is the
// entity kind the roll runs under (a chest's chance is the fatter one).
func stormFind(id string) (first, second struct {
	entity wilds.Entity
	cx, cy int
	at     int64
}, ok bool) {
	var finds []struct {
		entity wilds.Entity
		cx, cy int
		at     int64
	}
	for week := int64(1); week < 40 && len(finds) < 2; week++ {
		at := week*7*86400 + 3600
	weekDone:
		for kind, chance := range map[string]uint32{"camp": 2, "chest": 5} {
			for cx := 0; cx < 3; cx++ {
				for cy := 0; cy < 3; cy++ {
					if intAbs(cx-1)+intAbs(cy-1) < int(content.WildsRules.GetDeepTangleManhattanDistance()) {
						continue // not deep enough
					}
					for i := 0; i < 60; i++ {
						e := wilds.Entity{ID: fmt.Sprintf("%s:%d:%d:%d", kind, cx, cy, i), Kind: kind, TX: 4, TY: 5}
						if roll := wilds.Hash(id, e.ID, int(week), "storm-drop", cx, cy) % 1000; roll < chance {
							finds = append(finds, struct {
								entity wilds.Entity
								cx, cy int
								at     int64
							}{e, cx, cy, at})
							break weekDone // one find a week, like the cap
						}
					}
				}
			}
		}
	}
	if len(finds) < 2 {
		return first, second, false
	}
	first.entity, first.cx, first.cy, first.at = finds[0].entity, finds[0].cx, finds[0].cy, finds[0].at
	second.entity, second.cx, second.cy, second.at = finds[1].entity, finds[1].cx, finds[1].cy, finds[1].at
	return first, second, true
}

func TestStormGradeDropIsVeryRareAndSpacedOut(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	first, second, ok := stormFind(s.AccountID)
	if !ok {
		t.Skip("no storm-drop weeks seeded for alice")
	}
	// The first find: one drop, deep in the Tangle, on the ledger.
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	found, err := maybeGrantStormDrop(context.Background(), tx, &s.Snapshot, "inner-1", first.entity, first.cx, first.cy, first.at)
	if err != nil {
		t.Fatal(err)
	}
	if !found || tx.Commit() != nil {
		t.Fatalf("the seeded roll did not come up (%v)", found)
	}
	v := x.items("GET", "/api/items", nil, c, 200)
	if stackQty(v.Items, "storm-grade-drop") != 1 {
		t.Fatal("no drop in the pack")
	}
	// Spaced out: the same week's finds are one.
	tx, err = x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	again, err := maybeGrantStormDrop(context.Background(), tx, &s.Snapshot, "inner-1", first.entity, first.cx, first.cy, first.at+3600)
	if err != nil {
		t.Fatal(err)
	}
	if again {
		t.Fatal("a second drop within the week")
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	// A later week gives its own chance.
	tx2, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = maybeGrantStormDrop(context.Background(), tx2, &s.Snapshot, "inner-1", second.entity, second.cx, second.cy, second.at); err != nil {
		t.Fatal(err)
	}
	if err = tx2.Commit(); err != nil {
		t.Fatal(err)
	}
	v = x.items("GET", "/api/items", nil, c, 200)
	if stackQty(v.Items, "storm-grade-drop") != 2 {
		t.Fatal("the second week's drop never landed")
	}
	x.conserved(s.AccountID)
}
