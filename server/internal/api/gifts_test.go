package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"glimway/content"
	"glimway/server/internal/store"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestGiftPhrasePreservesMakersArticlesAndNamedPieces(t *testing.T) {
	for _, tc := range []struct{ name, want string }{
		{"Finn's oatcakes", "Finn's oatcakes"},
		{"A pinch of Blue Moss", "a pinch of blue moss"},
		{"The Empty Chair", "the Empty Chair"}} {
		if got := giftPhrase(tc.name, 1); got != tc.want {
			t.Errorf("giftPhrase(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func (x *rig) decoration(owner, def string) string {
	x.t.Helper()
	id, err := store.Random()
	if err != nil {
		x.t.Fatal(err)
	}
	tx, err := x.db.DB.Begin()
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec("INSERT INTO homestead_items(id,item_def,location,account_id) VALUES(?,?,'inventory',?)", id, def, owner); err != nil {
		x.t.Fatal(err)
	}
	if err = currency(context.Background(), tx, owner, "decoration:"+def, 1, "test-funding", "", x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		x.t.Fatal(err)
	}
	return id
}

type shelfViewResponse struct {
	store.Snapshot
	Shelf shelfView `json:"shelf"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

type shelfActionRes struct {
	store.Snapshot
	Result struct {
		Shelf     shelfView      `json:"shelf"`
		Inventory assetCounts    `json:"inventory"`
		Taken     *content.Asset `json:"taken,omitempty"`
		Line      string         `json:"line,omitempty"`
	} `json:"result"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (x *rig) getShelf(c *http.Cookie, gate int, status int) shelfViewResponse {
	x.t.Helper()
	req := httptest.NewRequest("GET", fmt.Sprintf("/api/homestead/shelf?gate=%d", gate), nil)
	req.Header.Set("X-Glimway-Contract", "3")
	if c != nil {
		req.AddCookie(c)
	}
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, req)
	var v shelfViewResponse
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		x.t.Fatal(err)
	}
	if w.Code != status {
		x.t.Fatalf("GET /api/homestead/shelf?gate=%d status %d != %d body=%s", gate, w.Code, status, w.Body.String())
	}
	return v
}

func (x *rig) shelfOp(c *http.Cookie, s *response, fields map[string]any, status int) shelfActionRes {
	x.t.Helper()
	x.refresh(c, s)
	key := fmt.Sprintf("shelf-%d-%d-%d", s.Version, x.now.Load(), keySeq())
	b := body(*s, key, fields)
	req := httptest.NewRequest("POST", "/api/homestead/shelf", bytes.NewBufferString(store.JSON(b)))
	req.Header.Set("X-Glimway-Contract", "3")
	req.Header.Set("Content-Type", "application/json")
	if c != nil {
		req.AddCookie(c)
	}
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, req)
	var v shelfActionRes
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		x.t.Fatal(err)
	}
	if w.Code != status {
		x.t.Fatalf("POST /api/homestead/shelf status %d != %d body=%s", w.Code, status, w.Body.String())
	}
	if status == 200 {
		s.Snapshot = v.Snapshot
	}
	return v
}

func TestGateShelfPlacementAndStock(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	h := x.claimGate(ac, &a, 0)
	x.db.DB.Exec("UPDATE homesteads SET tier=1 WHERE gate=0")

	// Before shelf is placed, checking shelf returns HasShelf: false
	sh := x.getShelf(ac, 0, 200)
	if sh.Shelf.HasShelf {
		t.Fatal("expected no shelf placed yet")
	}

	// Alice has a gate-shelf in inventory
	shelfItem := x.decoration(x.account("alice"), "gate-shelf")
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": shelfItem, "scene": "gate"}, 200)

	// Now shelf is placed
	sh = x.getShelf(ac, 0, 200)
	if !sh.Shelf.HasShelf {
		t.Fatal("expected shelf to be placed")
	}

	// Trying to place a second shelf fails with placement-overlap
	shelf2 := x.decoration(x.account("alice"), "gate-shelf")
	errResp := x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": shelf2, "scene": "gate"}, 409)
	if errResp.Error.Code != "placement-overlap" {
		t.Fatalf("expected placement-overlap got %s", errResp.Error.Code)
	}

	// Bob is not a member of Alice's homestead, tries to stock: 403 not-a-member
	x.stack(x.account("bob"), "comfrey-salve", x.account("bob"), 2)
	x.shelfOp(bc, &b, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 0,
		"asset": map[string]any{
			"kind": "item",
			"id":   "comfrey-salve",
			"qty":  1}}, 403)

	// Alice tries to stock non-giveable items:
	// 1. Heirloom tool
	heirloom := x.instance(x.account("alice"), "brack-felling-axe", -1, "")
	x.shelfOp(ac, &a, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 0,
		"asset": map[string]any{
			"kind":     "instance",
			"id":       "brack-felling-axe",
			"qty":      1,
			"instance": heirloom}}, 409)

	// 2. Door fox (decoration that cannot be given)
	_ = x.decoration(x.account("alice"), "door-fox")
	x.shelfOp(ac, &a, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 0,
		"asset": map[string]any{
			"kind": "decoration",
			"id":   "door-fox",
			"qty":  1}}, 409)

	// One slot holds one takeable item, preserving decoration IDs and maker marks.
	x.stack(x.account("alice"), "comfrey-salve", x.account("alice"), 10)
	qtyErr := x.shelfOp(ac, &a, map[string]any{
		"op": "stock", "gate": 0, "slot": 0,
		"asset": map[string]any{"kind": "item", "id": "comfrey-salve", "qty": 2}}, 400)
	if qtyErr.Error.Code != "invalid-quantity" {
		t.Fatalf("expected invalid-quantity, got %s", qtyErr.Error.Code)
	}

	// Alice stocks a valid item: comfrey salve
	stockRes := x.shelfOp(ac, &a, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 0,
		"asset": map[string]any{
			"kind": "item",
			"id":   "comfrey-salve",
			"qty":  1}}, 200)

	if len(stockRes.Result.Shelf.Slots) != 1 || stockRes.Result.Shelf.Slots[0].ItemDef != "comfrey-salve" {
		t.Fatal("expected slot 0 to have comfrey-salve")
	}

	// Slot is now occupied: stocking slot 0 again fails
	x.shelfOp(ac, &a, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 0,
		"asset": map[string]any{
			"kind": "item",
			"id":   "comfrey-salve",
			"qty":  1}}, 409)

	// Stock slots 1..5
	for i := 1; i < 6; i++ {
		x.shelfOp(ac, &a, map[string]any{
			"op":   "stock",
			"gate": 0,
			"slot": i,
			"asset": map[string]any{
				"kind": "item",
				"id":   "comfrey-salve",
				"qty":  1}}, 200)
	}

	// 7th slot attempt or slot >= 6 fails with invalid-slot
	x.shelfOp(ac, &a, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 6,
		"asset": map[string]any{
			"kind": "item",
			"id":   "comfrey-salve",
			"qty":  1}}, 400)

	// Removing the shelf while stocked fails with shelf-not-empty
	remErr := x.homeOpRefreshing(ac, &a, "remove", map[string]any{"itemId": shelfItem}, 409)
	if remErr.Error.Code != "shelf-not-empty" {
		t.Fatalf("expected shelf-not-empty, got %s", remErr.Error.Code)
	}

	// Check commons lane view shows shelf and shelfStocked
	lane := x.exp("GET", "/api/commons", nil, ac, 200)
	if !lane.Gates[h.Gate].Shelf || !lane.Gates[h.Gate].ShelfStocked {
		t.Fatalf("expected shelf=true and shelfStocked=true, got %+v", lane.Gates[h.Gate])
	}

	x.conserved(x.account("alice"))
}

func TestGateShelfTakeAndDailyLimit(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	_ = x.claimGate(ac, &a, 0)
	x.db.DB.Exec("UPDATE homesteads SET tier=1 WHERE gate=0")

	shelfItem := x.decoration(x.account("alice"), "gate-shelf")
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": shelfItem, "scene": "gate"}, 200)

	// Alice stocks a comfrey-salve crafted by Alice
	x.stack(x.account("alice"), "comfrey-salve", x.account("alice"), 1)
	x.shelfOp(ac, &a, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 0,
		"asset": map[string]any{
			"kind": "item",
			"id":   "comfrey-salve",
			"qty":  1}}, 200)

	// Also stock slot 1 with a bench-axe tool
	axe := x.instance(x.account("alice"), "bench-axe", 90, x.account("alice"))
	x.shelfOp(ac, &a, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 1,
		"asset": map[string]any{
			"kind":     "instance",
			"id":       "bench-axe",
			"qty":      1,
			"instance": axe}}, 200)

	// Bob looks at the shelf
	sh := x.getShelf(bc, 0, 200)
	if len(sh.Shelf.Slots) != 2 {
		t.Fatalf("expected 2 slots, got %d", len(sh.Shelf.Slots))
	}
	if sh.Shelf.Slots[0].Maker == nil || sh.Shelf.Slots[0].Maker.ID != x.account("alice") {
		t.Fatal("expected maker mark for alice on comfrey-salve")
	}
	if sh.Shelf.Slots[1].Maker == nil || sh.Shelf.Slots[1].Maker.ID != x.account("alice") {
		t.Fatal("expected maker mark for alice on bench-axe")
	}

	// Bob takes slot 0 (comfrey salve)
	takeRes := x.shelfOp(bc, &b, map[string]any{
		"op":   "take",
		"gate": 0,
		"slot": 0}, 200)

	expectedLine := fmt.Sprintf("You took a comfrey salve from %s’s shelf.", a.DisplayName)
	if takeRes.Result.Line != expectedLine {
		t.Fatalf("unexpected line: %q (expected %q)", takeRes.Result.Line, expectedLine)
	}

	// Verify Bob now has comfrey-salve in pack with maker Alice
	bItems := x.items("GET", "/api/items", nil, bc, 200)
	if stackQty(bItems.Items, "comfrey-salve") != 1 {
		t.Fatal("bob missing comfrey salve")
	}

	// Bob tries to take slot 1 on the same day: fails with already-taken-today
	takeErr := x.shelfOp(bc, &b, map[string]any{
		"op":   "take",
		"gate": 0,
		"slot": 1}, 409)
	if takeErr.Error.Code != "already-taken-today" {
		t.Fatalf("expected already-taken-today, got %s", takeErr.Error.Code)
	}

	// Another player Charlie takes slot 1 on the same day: succeeds!
	cc, c := x.member("charlie", a.WorldID)
	takeAxe := x.shelfOp(cc, &c, map[string]any{
		"op":   "take",
		"gate": 0,
		"slot": 1}, 200)
	if takeAxe.Result.Taken == nil || takeAxe.Result.Taken.Kind != "instance" || takeAxe.Result.Taken.ID != "bench-axe" {
		t.Fatal("expected charlie to take bench-axe instance")
	}

	// A home good travels by its definition; the server moves its individual
	// decoration row into and back out of the shelf.
	desk := x.decoration(x.account("alice"), "writing-desk")
	x.shelfOp(ac, &a, map[string]any{
		"op": "stock", "gate": 0, "slot": 2,
		"asset": map[string]any{"kind": "decoration", "id": "writing-desk", "qty": 1}}, 200)
	dc, d := x.member("dave", a.WorldID)
	deskTake := x.shelfOp(dc, &d, map[string]any{"op": "take", "gate": 0, "slot": 2}, 200)
	if deskTake.Result.Taken == nil || deskTake.Result.Taken.Kind != "decoration" || deskTake.Result.Taken.ID != "writing-desk" {
		t.Fatal("expected dave to take the writing desk")
	}
	if count(t, x.db, "SELECT COUNT(*) FROM homestead_items WHERE id='"+desk+"' AND location='inventory' AND account_id='"+x.account("dave")+"'") != 1 {
		t.Fatal("dave did not receive the decoration instance")
	}

	// Advancing day allows Bob to take again tomorrow
	x.now.Add(86400)
	// Alice stocks another salve in slot 0
	x.stack(x.account("alice"), "comfrey-salve", x.account("alice"), 1)
	x.shelfOp(ac, &a, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 0,
		"asset": map[string]any{
			"kind": "item",
			"id":   "comfrey-salve",
			"qty":  1}}, 200)

	x.shelfOp(bc, &b, map[string]any{
		"op":   "take",
		"gate": 0,
		"slot": 0}, 200)

	x.conserved(x.account("alice"))
	x.conserved(x.account("bob"))
	x.conserved(x.account("charlie"))
	x.conserved(x.account("dave"))
}

func TestGateShelfTakeReplayIsConserved(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	x.claimGate(ac, &a, 0)
	x.db.DB.Exec("UPDATE homesteads SET tier=1 WHERE gate=0")
	shelfItem := x.decoration(x.account("alice"), "gate-shelf")
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": shelfItem, "scene": "gate"}, 200)
	x.stack(x.account("alice"), "comfrey-salve", x.account("alice"), 1)
	x.shelfOp(ac, &a, map[string]any{
		"op": "stock", "gate": 0, "slot": 0,
		"asset": map[string]any{"kind": "item", "id": "comfrey-salve", "qty": 1}}, 200)

	// Retry the exact keyed take after a lost response. The second call must
	// replay the result without moving the item or writing ledger rows again.
	fields := map[string]any{"op": "take", "gate": 0, "slot": 0}
	payload := store.JSON(body(b, "shelf-take-replay", fields))
	var first, second shelfActionRes
	for i, dst := range []*shelfActionRes{&first, &second} {
		req := httptest.NewRequest("POST", "/api/homestead/shelf", bytes.NewBufferString(payload))
		req.Header.Set("X-Glimway-Contract", "3")
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(bc)
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("shelf take attempt %d failed: %d %s", i+1, w.Code, w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), dst); err != nil {
			t.Fatal(err)
		}
	}
	if first.Result.Taken == nil || second.Result.Taken == nil || first.Result.Taken.ID != second.Result.Taken.ID {
		t.Fatal("retry did not replay the taken item")
	}
	if count(t, x.db, "SELECT COUNT(*) FROM item_stacks WHERE location='pack' AND owner='"+x.account("bob")+"' AND item_def='comfrey-salve'") != 1 {
		t.Fatal("replayed take duplicated the gift")
	}
	ledgerRows := count(t, x.db, "SELECT COUNT(*) FROM ledger WHERE account_id='"+x.account("bob")+"' AND reason='shelf-take'")
	if ledgerRows != 2 {
		t.Fatalf("replayed take should write two balanced ledger rows once; got %d", ledgerRows)
	}
	x.conserved(x.account("alice"))
	x.conserved(x.account("bob"))
}

func TestConcurrentGateShelfTakesSerializeOneAvailableSlot(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	cc, c := x.member("charlie", a.WorldID)
	x.claimGate(ac, &a, 0)
	x.db.DB.Exec("UPDATE homesteads SET tier=1 WHERE gate=0")
	shelfItem := x.decoration(x.account("alice"), "gate-shelf")
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": shelfItem, "scene": "gate"}, 200)
	x.stack(x.account("alice"), "comfrey-salve", x.account("alice"), 1)
	x.shelfOp(ac, &a, map[string]any{
		"op": "stock", "gate": 0, "slot": 0,
		"asset": map[string]any{"kind": "item", "id": "comfrey-salve", "qty": 1}}, 200)

	type result struct {
		status int
		body   shelfActionRes
	}
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for _, taker := range []struct {
		cookie   *http.Cookie
		snapshot *response
	}{{bc, &b}, {cc, &c}} {
		wg.Add(1)
		go func(cookie *http.Cookie, snapshot *response) {
			defer wg.Done()
			x.refresh(cookie, snapshot)
			fields := map[string]any{"op": "take", "gate": 0, "slot": 0}
			payload := body(*snapshot, fmt.Sprintf("parallel-take-%s", snapshot.AccountID), fields)
			req := httptest.NewRequest("POST", "/api/homestead/shelf", bytes.NewBufferString(store.JSON(payload)))
			req.Header.Set("X-Glimway-Contract", "3")
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(cookie)
			w := httptest.NewRecorder()
			x.api.ServeHTTP(w, req)
			var v shelfActionRes
			_ = json.Unmarshal(w.Body.Bytes(), &v)
			results <- result{status: w.Code, body: v}
		}(taker.cookie, taker.snapshot)
	}
	wg.Wait()
	close(results)
	status := map[int]int{}
	for r := range results {
		status[r.status]++
		if r.status != 200 && (r.status != 404 || r.body.Error.Code != "slot-empty") {
			t.Fatalf("unexpected concurrent take response: status=%d code=%s", r.status, r.body.Error.Code)
		}
	}
	if status[200] != 1 || status[404] != 1 {
		t.Fatalf("expected one take and one slot-empty refusal, got statuses %+v", status)
	}
}

func TestGateShelfLostDeedWriteOff(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	x.claimGate(ac, &a, 0)
	x.db.DB.Exec("UPDATE homesteads SET tier=1 WHERE gate=0")

	shelfItem := x.decoration(x.account("alice"), "gate-shelf")
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": shelfItem, "scene": "gate"}, 200)

	// Stock an item and an instance
	x.stack(x.account("alice"), "comfrey-salve", x.account("alice"), 1)
	x.shelfOp(ac, &a, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 0,
		"asset": map[string]any{
			"kind": "item",
			"id":   "comfrey-salve",
			"qty":  1}}, 200)

	axe := x.instance(x.account("alice"), "bench-axe", 90, x.account("alice"))
	x.shelfOp(ac, &a, map[string]any{
		"op":   "stock",
		"gate": 0,
		"slot": 1,
		"asset": map[string]any{
			"kind":     "instance",
			"id":       "bench-axe",
			"qty":      1,
			"instance": axe}}, 200)

	_ = x.decoration(x.account("alice"), "writing-desk")
	x.shelfOp(ac, &a, map[string]any{
		"op": "stock", "gate": 0, "slot": 2,
		"asset": map[string]any{"kind": "decoration", "id": "writing-desk", "qty": 1}}, 200)

	// Alice leaves the homestead
	x.homeOpRefreshing(ac, &a, "leave", nil, 200)

	// Fast-forward past deed loss window
	lostDays := int64(content.HomeRules.Desolation.DeedLostAfterDays) + 1
	x.now.Add(lostDays * 86400)

	// Alice signs in again because session expired over the fortnight
	ac = x.login("alice", "")
	_ = x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, ac, 200)

	// Settle homes triggered by visiting commons
	x.exp("GET", "/api/commons", nil, ac, 200)

	// Homestead should be cleared and deleted
	if count(t, x.db, "SELECT count(*) FROM homesteads WHERE gate=0") != 0 {
		t.Fatal("homestead still exists")
	}
	if count(t, x.db, "SELECT count(*) FROM gate_shelf_slots") != 0 {
		t.Fatal("gate shelf slots still exist")
	}

	// Verify ledger conservation
	x.conserved(x.account("alice"))
}

func TestMakerThankYouMail(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)

	// Bob has a keepers-twists made by Alice
	x.stack(x.account("bob"), "keepers-twists", x.account("alice"), 2)

	// Injure Bob so keepers-twists can be consumed
	if _, err := x.db.DB.Exec("UPDATE progress SET doc_json=json_set(doc_json,'$.hp',20) WHERE account_id='" + x.account("bob") + "'"); err != nil {
		t.Fatal(err)
	}

	// Alice is offline/away. Bob uses the twists
	x.opRefreshing(bc, &b, "use", map[string]any{
		"itemDef": "keepers-twists",
		"maker":   x.account("alice")}, 200)

	// Alice checks her mail: should have a 'thanks' mail from Bob
	req := httptest.NewRequest("GET", "/api/mail", nil)
	req.Header.Set("X-Glimway-Contract", "3")
	req.AddCookie(ac)
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, req)
	var mailList struct {
		Mail []mailView `json:"mail"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &mailList); err != nil {
		t.Fatal(err)
	}

	if len(mailList.Mail) != 1 {
		t.Fatalf("expected 1 mail, got %d", len(mailList.Mail))
	}
	m := mailList.Mail[0]
	if m.Asset.Kind != "thanks" || m.Asset.ID != "keepers-twists" || m.FromID != x.account("bob") {
		t.Fatalf("unexpected mail: %+v", m)
	}

	// Bob uses another twists made by Alice on the same day:
	// Rate limit: Alice should NOT receive a second thank-you note
	if _, err := x.db.DB.Exec("UPDATE progress SET doc_json=json_set(doc_json,'$.hp',20) WHERE account_id='" + x.account("bob") + "'"); err != nil {
		t.Fatal(err)
	}

	x.opRefreshing(bc, &b, "use", map[string]any{
		"itemDef": "keepers-twists",
		"maker":   x.account("alice")}, 200)

	w = httptest.NewRecorder()
	x.api.ServeHTTP(w, req)
	json.Unmarshal(w.Body.Bytes(), &mailList)
	if len(mailList.Mail) != 1 {
		t.Fatalf("rate limit failed, expected 1 mail, got %d", len(mailList.Mail))
	}

	// Alice claims the thank-you mail
	claimB := body(a, "claim-key", nil)
	claimReq := httptest.NewRequest("POST", fmt.Sprintf("/api/mail/%s/claim", m.ID), bytes.NewBufferString(store.JSON(claimB)))
	claimReq.Header.Set("X-Glimway-Contract", "3")
	claimReq.Header.Set("Content-Type", "application/json")
	claimReq.AddCookie(ac)
	claimW := httptest.NewRecorder()
	x.api.ServeHTTP(claimW, claimReq)
	if claimW.Code != 200 {
		t.Fatalf("claim failed: %d %s", claimW.Code, claimW.Body.String())
	}

	// Now test presence: Bob and Alice standing together in the same room within 6 tiles
	// Next day so rate limit is reset
	x.now.Add(86400)
	x.stand(x.account("alice"), a.WorldID, "commons", 100, 100)
	x.stand(x.account("bob"), b.WorldID, "commons", 100, 110) // within 10px, 6 tiles is 96px

	x.stack(x.account("bob"), "keepers-twists", x.account("alice"), 1)
	if _, err := x.db.DB.Exec("UPDATE progress SET doc_json=json_set(doc_json,'$.hp',20) WHERE account_id='" + x.account("bob") + "'"); err != nil {
		t.Fatal(err)
	}

	x.opRefreshing(bc, &b, "use", map[string]any{
		"itemDef": "keepers-twists",
		"maker":   x.account("alice")}, 200)

	// Since they are together, NO thank-you mail is sent!
	w = httptest.NewRecorder()
	x.api.ServeHTTP(w, req)
	json.Unmarshal(w.Body.Bytes(), &mailList)
	pendingCount := 0
	for _, it := range mailList.Mail {
		if it.ClaimedAt == nil && it.ReturnedAt == nil {
			pendingCount++
		}
	}
	if pendingCount != 0 {
		t.Fatalf("expected 0 pending mail when together, got %d", pendingCount)
	}
}

func TestToolWearOutThankYouMail(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)

	// Bob has a cheap bench-axe made by Alice with condition 1 (one use left)
	axe := x.instance(x.account("bob"), "bench-axe", 1, x.account("alice"))

	// Alice is offline. Bob uses the tool: it breaks at condition 0
	res := x.opRefreshing(bc, &b, "use", map[string]any{
		"instance": axe}, 200)

	if res.Result.Wear == nil || !res.Result.Wear.Broke {
		t.Fatal("expected tool to break")
	}

	// Alice receives thank-you mail for the tool she made!
	req := httptest.NewRequest("GET", "/api/mail", nil)
	req.Header.Set("X-Glimway-Contract", "3")
	req.AddCookie(ac)
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, req)
	var mailList struct {
		Mail []mailView `json:"mail"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &mailList); err != nil {
		t.Fatal(err)
	}
	if len(mailList.Mail) != 1 {
		t.Fatalf("expected 1 mail, got %d", len(mailList.Mail))
	}
	if mailList.Mail[0].Asset.Kind != "thanks" || mailList.Mail[0].Asset.ID != "bench-axe" {
		t.Fatalf("unexpected thank-you mail: %+v", mailList.Mail[0])
	}
}

func TestWardenDullingDoesNotThankMaker(t *testing.T) {
	x := newRig(t)
	_, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	axe := x.instance(x.account("bob"), "bench-axe", 1, x.account("alice"))
	sliver := x.instance(x.account("bob"), "warden-sliver", -1, "")
	if _, err := x.db.DB.Exec("UPDATE item_instances SET location='fitted',owner=? WHERE id=?", axe, sliver); err != nil {
		t.Fatal(err)
	}
	if _, err := x.db.DB.Exec("UPDATE item_instances SET worn_day=? WHERE id=?", utcDay(x.now.Load()), axe); err != nil {
		t.Fatal(err)
	}
	used := x.opRefreshing(bc, &b, "use", map[string]any{"instance": axe}, 200)
	if used.Result.Wear == nil || used.Result.Wear.Broke || used.Result.Wear.Condition != 0 {
		t.Fatalf("expected the warden-set axe to dull at zero: %+v", used.Result.Wear)
	}
	if count(t, x.db, "SELECT COUNT(*) FROM mail WHERE kind='thanks' AND from_id='"+x.account("bob")+"' AND to_id='"+x.account("alice")+"'") != 0 {
		t.Fatal("dulling a warden-set tool sent a thank-you")
	}
}

func TestThanksNeverReturnOrBumpSenderRevision(t *testing.T) {
	x := newRig(t)
	_, a := x.ready("alice")
	x.member("bob", a.WorldID)
	before := count(t, x.db, "SELECT version FROM players WHERE account_id='"+x.account("alice")+"'")
	if _, err := x.db.DB.Exec("INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at)\nVALUES('thanks-old',?,'"+x.account("alice")+"','"+x.account("bob")+"','thanks','comfrey-salve',0,'[]','[]',?)", a.WorldID, x.now.Load()-60*86400); err != nil {
		t.Fatal(err)
	}
	if err := x.db.Allow(context.Background(), "bob", false); err != nil {
		t.Fatal(err)
	}
	n, err := x.db.ReturnDueMail(context.Background(), x.now.Load())
	if err != nil || n != 0 {
		t.Fatalf("thank-you should stay in the mailbox: returned=%d err=%v", n, err)
	}
	if got := count(t, x.db, "SELECT version FROM players WHERE account_id='"+x.account("alice")+"'"); got != before {
		t.Fatalf("thank-you changed sender revision: before=%d after=%d", before, got)
	}
	if count(t, x.db, "SELECT COUNT(*) FROM mail WHERE id='thanks-old' AND returned_at IS NULL") != 1 {
		t.Fatal("thank-you was marked returned")
	}
}
