package api

import (
	"glimway/content"
	"glimway/server/internal/store"
	"net/http"
	"slices"
	"testing"
)

type craftingResponse struct {
	store.Snapshot
	Woodpile woodpileView `json:"woodpile"`
	Result   struct {
		Output       content.Asset `json:"output"`
		Woodpile     woodpileView  `json:"woodpile"`
		Action       string        `json:"action"`
		CollectedQty int           `json:"collectedQty"`
		PageID       string        `json:"pageId"`
		Qty          int           `json:"qty"`
		InstanceIDs  []string      `json:"instanceIds"`
	} `json:"result"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (x *rig) craftReq(method, path string, b any, c *http.Cookie, status int) craftingResponse {
	x.t.Helper()
	v, _ := httpResponse[craftingResponse](x, method, path, b, c, status)
	return v
}

// craftAndPlace makes a decoration at the bench and sets it out. Pieces made
// here are craft-only: Silas doesn't sell them.
func (x *rig) craftAndPlace(c *http.Cookie, s *response, piece, key string) {
	x.t.Helper()
	v := x.craftReq("POST", "/api/craft", body(*s, key, map[string]any{"recipeId": "craft-" + piece, "qty": 1}), c, 200)
	s.Snapshot = v.Snapshot
	if len(v.Result.InstanceIDs) != 1 {
		x.t.Fatalf("no %s instance in the craft answer", piece)
	}
	id := v.Result.InstanceIDs[0]
	scene, size := "indoor", 1
	if piece == "woodpile" {
		scene, size = "outdoor", 2
	}
	px, py := 2, 2
	if size == 2 {
		spots := litSpots(x.home(c))
		px, py = -1, -1
		for _, p := range spots {
			for _, q := range spots {
				if q[0] == p[0]+1 && q[1] == p[1] {
					px, py = p[0], p[1]
				}
			}
		}
		if px < 0 {
			x.t.Fatal("no adjacent lit tiles for the woodpile")
		}
	}
	update(s, x.exp("POST", "/api/homestead/place", body(*s, "place-"+key, map[string]any{
		"itemId": id, "scene": scene, "x": px, "y": py, "rotation": 0,
	}), c, 200))
}

func TestHearthCraftingGatingAndMakerMarks(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimFree(c, &s)

	// Tier 0 (Campsite) - hearth crafting must be rejected (tier-required).
	x.craftReq("POST", "/api/hearth/craft", body(s, "hearth-0", map[string]any{"recipeId": "hearth-saltings-tea", "qty": 1}), c, 409)

	// Upgrade to Tier 1 (Cottage)
	x.seedAssets("alice")
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	up := x.exp("POST", "/api/homestead/upgrade", body(s, "cottage", map[string]any{"tier": 1}), c, 200)
	update(&s, up)
	if up.Result.Home.Tier != 1 {
		t.Fatal("expected cottage tier 1")
	}

	// Insufficient materials for Saltings tea (wild-thyme: 2, water: 1)
	x.craftReq("POST", "/api/hearth/craft", body(s, "hearth-poor", map[string]any{"recipeId": "hearth-saltings-tea", "qty": 1}), c, 409)

	// A found recipe is unknown until its page is held, starting recipe or not.
	x.craftReq("POST", "/api/hearth/craft", body(s, "hearth-locked", map[string]any{"recipeId": "hearth-wax-seal", "qty": 1}), c, 409)

	// Fund Alice with ingredients for Saltings tea
	x.give("alice", "wild-thyme", 10)
	x.give("alice", "water", 10)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot

	// Craft 2 batches of Saltings tea (output is 2*2 = 4 saltings-tea)
	req := body(s, "craft-tea", map[string]any{"recipeId": "hearth-saltings-tea", "qty": 2})
	v := x.craftReq("POST", "/api/hearth/craft", req, c, 200)
	s.Snapshot = v.Snapshot

	if v.Result.Output.Qty != 4 || v.Result.Output.ID != "saltings-tea" {
		t.Fatalf("unexpected output: %+v", v.Result.Output)
	}
	if !slices.Contains(v.State.Inventory, "saltings-tea") {
		t.Fatal("saltings-tea not in snapshot inventory")
	}

	// Check maker mark in database: item_stacks must record maker_id = alice
	var makerID string
	var stackQty int
	err := x.db.DB.QueryRow("SELECT maker_id, qty FROM item_stacks WHERE owner='alice' AND item_def='saltings-tea' AND location='pack'").Scan(&makerID, &stackQty)
	if err != nil {
		t.Fatalf("failed to query saltings-tea stack: %v", err)
	}
	if makerID != "alice" {
		t.Fatalf("expected maker_id='alice', got %q", makerID)
	}
	if stackQty != 4 {
		t.Fatalf("expected stack qty 4, got %d", stackQty)
	}

	// Idempotent replay with same key produces identical response
	replay := x.craftReq("POST", "/api/hearth/craft", req, c, 200)
	if store.JSON(v) != store.JSON(replay) {
		t.Fatal("craft replay mismatch")
	}

	// With the wax-seal page held, the found recipe opens (and its seals are marked).
	x.give("alice", "recipe-page-wax-seal", 1)
	x.give("alice", "beeswax", 2)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	seals := x.craftReq("POST", "/api/hearth/craft", body(s, "craft-seals", map[string]any{"recipeId": "hearth-wax-seal", "qty": 1}), c, 200)
	s.Snapshot = seals.Snapshot
	if seals.Result.Output.Qty != 2 || seals.Result.Output.ID != "wax-seal" {
		t.Fatalf("unexpected seal output: %+v", seals.Result.Output)
	}
	var sealMaker string
	if err = x.db.DB.QueryRow("SELECT maker_id FROM item_stacks WHERE owner='alice' AND item_def='wax-seal' AND location='pack'").Scan(&sealMaker); err != nil || sealMaker != "alice" {
		t.Fatalf("seal maker mark: %q %v", sealMaker, err)
	}
	x.conserved("alice")
}

func TestWritingDeskCopyingAndGating(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimFree(c, &s)

	// Upgrade to cottage
	x.seedAssets("alice")
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	update(&s, x.exp("POST", "/api/homestead/upgrade", body(s, "tier1", map[string]any{"tier": 1}), c, 200))

	// Desk not placed yet - copying must fail with desk-required
	x.craftReq("POST", "/api/desk/copy", body(s, "copy-early", map[string]any{"pageId": "recipe-page-tea", "qty": 1}), c, 409)

	// Silas doesn't sell the desk (it's made at the bench).
	x.seedAssets("alice")
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	if got := x.exp("POST", "/api/homestead/buy", body(s, "buy-desk", map[string]any{"itemDef": "writing-desk"}), c, 409); got.Error.Code != "craft-only" {
		t.Fatal("buying a craft-only piece:", got.Error.Code)
	}

	// The Workshop, then the bench: the desk, and place it.
	update(&s, x.exp("POST", "/api/homestead/upgrade", body(s, "tier2", map[string]any{"tier": 2}), c, 200))
	x.craftAndPlace(c, &s, "writing-desk", "desk")

	// Desk is now placed. Alice does not hold recipe-page-tea -> page-not-held
	x.craftReq("POST", "/api/desk/copy", body(s, "copy-unheld", map[string]any{"pageId": "recipe-page-tea", "qty": 1}), c, 409)

	// Give Alice 1 unmarked recipe-page-tea and 5 fiber
	x.give("alice", "recipe-page-tea", 1)
	x.give("alice", "fiber", 5)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot

	// Copy 2 pages
	req := body(s, "copy-2", map[string]any{"pageId": "recipe-page-tea", "qty": 2})
	v := x.craftReq("POST", "/api/desk/copy", req, c, 200)
	s.Snapshot = v.Snapshot

	// Check Alice now has the original unmarked page (qty 1) + 2 copied pages marked by alice (qty 2)
	var markedQty int
	err := x.db.DB.QueryRow("SELECT qty FROM item_stacks WHERE owner='alice' AND item_def='recipe-page-tea' AND maker_id='alice' AND location='pack'").Scan(&markedQty)
	if err != nil {
		t.Fatalf("failed to query marked recipe-page-tea: %v", err)
	}
	if markedQty != 2 {
		t.Fatalf("expected 2 marked pages, got %d", markedQty)
	}

	// A replay with the same key is the same answer, not a second copy.
	replay := x.craftReq("POST", "/api/desk/copy", req, c, 200)
	if store.JSON(v) != store.JSON(replay) {
		t.Fatal("desk replay mismatch")
	}
	x.conserved("alice")
}

func TestWoodpileSeasoningRuleAndLedgerConservation(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimFree(c, &s)

	// Without placed woodpile -> woodpile-required
	x.craftReq("POST", "/api/homestead/woodpile", body(s, "stack-early", map[string]any{"action": "stack", "qty": 5}), c, 409)

	// The woodpile is bench-made: the Workshop, the bench, then place it.
	x.seedAssets("alice")
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	update(&s, x.exp("POST", "/api/homestead/upgrade", body(s, "tier1-pile", map[string]any{"tier": 1}), c, 200))
	update(&s, x.exp("POST", "/api/homestead/upgrade", body(s, "tier2-pile", map[string]any{"tier": 2}), c, 200))
	x.craftAndPlace(c, &s, "woodpile", "pile")

	// The woodpile read says the pile is placed.
	if r := x.craftReq("GET", "/api/homestead/woodpile", nil, c, 200); !r.Woodpile.Placed {
		t.Fatal("woodpile read says not placed")
	}

	// Stack 10 timber onto woodpile (the pack's timber after the workshop
	// build and the craft; seedAssets funded 1000 of everything).
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	initialTimber := 0
	if err := x.db.DB.QueryRow("SELECT qty FROM item_stacks WHERE owner='alice' AND item_def='timber' AND location='pack'").Scan(&initialTimber); err != nil {
		x.t.Fatal(err)
	}
	req := body(s, "stack-10", map[string]any{"action": "stack", "qty": 10})
	resStack := x.craftReq("POST", "/api/homestead/woodpile", req, c, 200)
	s.Snapshot = resStack.Snapshot

	// Timber in pack should be reduced by 10
	var currentTimber int
	err := x.db.DB.QueryRow("SELECT qty FROM item_stacks WHERE owner='alice' AND item_def='timber' AND location='pack'").Scan(&currentTimber)
	if err != nil {
		t.Fatalf("failed to query timber: %v", err)
	}
	if currentTimber != initialTimber-10 {
		t.Fatalf("expected %d timber, got %d", initialTimber-10, currentTimber)
	}
	// The pile's own currency shows the timber on it (+10 on the stacker's ledger).
	if n := pileLedgerSum(x, ""); n != 10 {
		t.Fatalf("pile currency sum %d, want 10", n)
	}
	x.conserved("alice")

	// Try to collect immediately: should fail with nothing-ready
	x.craftReq("POST", "/api/homestead/woodpile", body(s, "collect-early", map[string]any{"action": "collect"}), c, 409)

	// Advance time by 86,400 seconds (1 full real day)
	x.now.Add(86400)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot

	// Read woodpile: should show 10 ready timber
	r := x.craftReq("GET", "/api/homestead/woodpile", nil, c, 200)
	if r.Woodpile.ReadyCount != 10 {
		t.Fatalf("expected 10 ready timber, got %d", r.Woodpile.ReadyCount)
	}

	// Collect seasoned timber
	res := x.craftReq("POST", "/api/homestead/woodpile", body(s, "collect-now", map[string]any{"action": "collect"}), c, 200)
	s.Snapshot = res.Snapshot

	// Alice now has 10 seasoned timber credited to her pack
	var seasonedTimber int
	err = x.db.DB.QueryRow("SELECT qty FROM item_stacks WHERE owner='alice' AND item_def='seasoned-timber' AND location='pack'").Scan(&seasonedTimber)
	if err != nil {
		t.Fatalf("failed to query seasoned-timber: %v", err)
	}
	// Initial was 1000 from seedAssets, + 10 collected = 1010
	if seasonedTimber != 1010 {
		t.Fatalf("expected 1010 seasoned-timber, got %d", seasonedTimber)
	}
	// The pile's ledger currency is back to zero: what went on came off.
	if n := pileLedgerSum(x, ""); n != 0 {
		t.Fatalf("pile currency sum %d, want 0", n)
	}
	x.conserved("alice")

	// A replay with the same key is the same answer, not a second stack.
	replay := x.craftReq("POST", "/api/homestead/woodpile", req, c, 200)
	if store.JSON(resStack) != store.JSON(replay) {
		t.Fatal("woodpile replay mismatch")
	}
}

// pileLedgerSum sums the woodpile currency across players (empty id: all).
func pileLedgerSum(x *rig, id string) int {
	x.t.Helper()
	q := "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE currency='woodpile:material:timber'"
	if id != "" {
		q += " AND habitica_id='" + id + "'"
	}
	var n int
	if err := x.db.DB.QueryRow(q).Scan(&n); err != nil {
		x.t.Fatal(err)
	}
	return n
}

func TestWoodpileCollectsAcrossMembersAndWritesOffLostDeeds(t *testing.T) {
	x := newRig(t)
	ca, sa := x.ready("alice")
	x.claimFree(ca, &sa)

	// The Workshop, the bench, the pile on the land.
	x.seedAssets("alice")
	sa.Snapshot = x.expect("GET", "/api/state", nil, ca, 200).Snapshot
	update(&sa, x.exp("POST", "/api/homestead/upgrade", body(sa, "tier1-a", map[string]any{"tier": 1}), ca, 200))
	update(&sa, x.exp("POST", "/api/homestead/upgrade", body(sa, "tier2-a", map[string]any{"tier": 2}), ca, 200))
	x.craftAndPlace(ca, &sa, "woodpile", "pile")

	// Alice stacks 6 green timber.
	x.craftReq("POST", "/api/homestead/woodpile", body(sa, "stack-6", map[string]any{"action": "stack", "qty": 6}), ca, 200)

	// Bob signs onto the deed (in Alice's world); a day later he collects
	// Alice's stack.
	cb, sb := x.member("bob", sa.WorldID)
	x.seedAssets("bob")
	x.share(ca, &sa, cb, &sb)
	x.now.Add(86400)
	res := x.craftReq("POST", "/api/homestead/woodpile", body(sb, "collect-b", map[string]any{"action": "collect"}), cb, 200)
	sb.Snapshot = res.Snapshot
	if res.Result.CollectedQty != 6 {
		t.Fatalf("bob collected %d", res.Result.CollectedQty)
	}
	// Bob's pack has the seasoned timber; the pile's ledger is level again
	// (+6 on Alice's stack row, −6 on Bob's collect row), and both packs read.
	if pileLedgerSum(x, "") != 0 {
		t.Fatal("pile currency not level after a cross-member collect")
	}
	x.conserved("alice")
	x.conserved("bob")

	// Bob stacks and leaves; then Alice leaves too (the last leaving marks
	// the deed vacant).
	x.craftReq("POST", "/api/homestead/woodpile", body(sb, "stack-b", map[string]any{"action": "stack", "qty": 4}), cb, 200)
	sb.Snapshot = x.expect("GET", "/api/state", nil, cb, 200).Snapshot
	x.craftReq("POST", "/api/homestead/leave", body(sb, "leave-b", nil), cb, 200)
	sa.Snapshot = x.expect("GET", "/api/state", nil, ca, 200).Snapshot
	x.craftReq("POST", "/api/homestead/leave", body(sa, "leave-a", nil), ca, 200)

	// Past the deed-lost period, the world settles the deed without a 500 —
	// and the pile's timber is written off on the last member's ledger.
	x.now.Add(int64(content.HomeRules.Desolation.DeedLostAfterDays) * 86400)
	// The players went away with the deed; the session idled out over the
	// fortnight: sign in again.
	x.stand("alice", sa.WorldID, "", 0, 0)
	x.stand("bob", sa.WorldID, "", 0, 0)
	ca = x.login("alice", "")
	x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, ca, 200)
	x.expect("GET", "/api/commons", nil, ca, 200)
	if n := pileLedgerSum(x, ""); n != 0 {
		t.Fatalf("pile currency sum %d after the write-off, want 0", n)
	}
	var gone int
	if err := x.db.DB.QueryRow("SELECT count(*) FROM woodpile_stacks").Scan(&gone); err != nil || gone != 0 {
		t.Fatalf("woodpile stacks left: %d %v", gone, err)
	}
	var home int
	if err := x.db.DB.QueryRow("SELECT count(*) FROM homesteads").Scan(&home); err != nil || home != 0 {
		t.Fatalf("homesteads left: %d %v", home, err)
	}
	x.conserved("alice")
	x.conserved("bob")
}
