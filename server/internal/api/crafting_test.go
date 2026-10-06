package api

import (
	"bytes"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/store"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

type craftingResponse struct {
	store.Snapshot
	Woodpile woodpileView `json:"woodpile"`
	Result struct {
		Output       content.Asset `json:"output"`
		Woodpile     woodpileView  `json:"woodpile"`
		Action       string        `json:"action"`
		CollectedQty int           `json:"collectedQty"`
		PageID       string        `json:"pageId"`
		Qty          int           `json:"qty"`
	} `json:"result"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (x *rig) craftReq(method, path string, b any, c *http.Cookie, status int) craftingResponse {
	x.t.Helper()
	var bodyBuf *bytes.Buffer
	if b != nil {
		bodyBuf = bytes.NewBufferString(store.JSON(b))
	} else {
		bodyBuf = bytes.NewBuffer(nil)
	}
	r := httptest.NewRequest(method, path, bodyBuf)
	if b != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if c != nil {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	v := craftingResponse{}
	_ = json.Unmarshal(w.Body.Bytes(), &v)
	if w.Code != status {
		x.t.Fatalf("%s %s got %d %s want %d", method, path, w.Code, w.Body.String(), status)
	}
	return v
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

	// Buy and place a writing desk
	update(&s, x.exp("POST", "/api/homestead/buy", body(s, "buy-desk", map[string]any{"itemDef": "writing-desk"}), c, 200))
	var deskInstance string
	err := x.db.DB.QueryRow("SELECT id FROM homestead_items WHERE habitica_id='alice' AND item_def='writing-desk' AND location='inventory'").Scan(&deskInstance)
	if err != nil {
		t.Fatalf("failed to query desk instance: %v", err)
	}
	update(&s, x.exp("POST", "/api/homestead/place", body(s, "place-desk", map[string]any{
		"itemId":   deskInstance,
		"scene":    "indoor",
		"x":        2,
		"y":        2,
		"rotation": 0,
	}), c, 200))

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
	err = x.db.DB.QueryRow("SELECT qty FROM item_stacks WHERE owner='alice' AND item_def='recipe-page-tea' AND maker_id='alice' AND location='pack'").Scan(&markedQty)
	if err != nil {
		t.Fatalf("failed to query marked recipe-page-tea: %v", err)
	}
	if markedQty != 2 {
		t.Fatalf("expected 2 marked pages, got %d", markedQty)
	}
}

func TestWoodpileSeasoningRuleAndLedgerConservation(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimFree(c, &s)

	// Without placed woodpile -> woodpile-required
	x.craftReq("POST", "/api/homestead/woodpile", body(s, "stack-early", map[string]any{"action": "stack", "qty": 5}), c, 409)

	// Buy and place woodpile
	x.seedAssets("alice")
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	update(&s, x.exp("POST", "/api/homestead/upgrade", body(s, "tier1-pile", map[string]any{"tier": 1}), c, 200))
	update(&s, x.exp("POST", "/api/homestead/buy", body(s, "buy-pile", map[string]any{"itemDef": "woodpile"}), c, 200))
	var pileInstance string
	err := x.db.DB.QueryRow("SELECT id FROM homestead_items WHERE habitica_id='alice' AND item_def='woodpile' AND location='inventory'").Scan(&pileInstance)
	if err != nil {
		t.Fatalf("failed to query woodpile instance: %v", err)
	}
	// The woodpile is 2x1 outdoors, so it needs two adjacent lit tiles.
	spots := litSpots(x.home(c))
	pileX, pileY := -1, -1
	for _, p := range spots {
		for _, q := range spots {
			if q[0] == p[0]+1 && q[1] == p[1] {
				pileX, pileY = p[0], p[1]
			}
		}
	}
	if pileX < 0 {
		t.Fatal("no adjacent lit tiles for the woodpile")
	}
	update(&s, x.exp("POST", "/api/homestead/place", body(s, "place-pile", map[string]any{
		"itemId":   pileInstance,
		"scene":    "outdoor",
		"x":        pileX,
		"y":        pileY,
		"rotation": 0,
	}), c, 200))

	// Stack 10 timber onto woodpile
	initialTimber := 1000 // from seedAssets
	resStack := x.craftReq("POST", "/api/homestead/woodpile", body(s, "stack-10", map[string]any{"action": "stack", "qty": 10}), c, 200)
	s.Snapshot = resStack.Snapshot

	// Timber in pack should be reduced by 10
	var currentTimber int
	err = x.db.DB.QueryRow("SELECT qty FROM item_stacks WHERE owner='alice' AND item_def='timber' AND location='pack'").Scan(&currentTimber)
	if err != nil {
		t.Fatalf("failed to query timber: %v", err)
	}
	if currentTimber != initialTimber-10 {
		t.Fatalf("expected %d timber, got %d", initialTimber-10, currentTimber)
	}

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

	// Verify ledger entries exist for both stack and collect
	var stackCount, collectCount int
	_ = x.db.DB.QueryRow("SELECT count(*) FROM ledger WHERE reason='woodpile:stack' AND habitica_id='alice'").Scan(&stackCount)
	_ = x.db.DB.QueryRow("SELECT count(*) FROM ledger WHERE reason='woodpile:collect' AND habitica_id='alice'").Scan(&collectCount)
	if stackCount == 0 || collectCount == 0 {
		t.Fatalf("expected ledger entries for stack (%d) and collect (%d)", stackCount, collectCount)
	}
}
