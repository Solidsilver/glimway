package api

import (
	"bytes"
	"context"
	"fmt"
	"glimway/content"
	"glimway/server/internal/store"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"slices"
	"sync"
	"testing"
)

type phase5Response struct {
	store.Snapshot
	workshopView
	projectsView
	Mail              []mailView `json:"mail"`
	NextCursor        *string    `json:"nextCursor"`
	NextPendingCursor *string    `json:"nextPendingCursor"`
	Result            struct {
		workshopView
		projectsView
		Mail              []mailView     `json:"mail"`
		NextCursor        *string        `json:"nextCursor"`
		NextPendingCursor *string        `json:"nextPendingCursor"`
		MailID            string         `json:"mailId"`
		InstanceIDs       []string       `json:"instanceIds"`
		Output            *content.Asset `json:"output"`
		Materials         map[string]int `json:"materials"`
	}
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (x *rig) p5(method, path string, b any, c *http.Cookie, status int) phase5Response {
	x.t.Helper()
	v, _ := httpResponse[phase5Response](x, method, path, b, c, status)
	return v
}
func (x *rig) seedAssets(id string) {
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
	if err = store.Credit(ctx, tx, &s, 200, 100, "test-funding", "", nil, x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	for _, m := range content.WildsRules.Materials {
		if err = materialChange(ctx, tx, id, m, 1000, "test-funding", "", x.now.Load()); err != nil {
			x.t.Fatal(err)
		}
	}
	if err = materialChange(ctx, tx, id, "seasoned-timber", 1000, "test-funding", "", x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if err = itemChange(ctx, tx, &s, giftTrinket, 5, "test-funding", "", x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if err = store.Persist(ctx, tx, &s, x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		x.t.Fatal(err)
	}
}

// claimFree claims the first unclaimed gate on the caller's lane.
func (x *rig) claimFree(c *http.Cookie, s *response) homeView {
	x.t.Helper()
	for _, g := range x.exp("GET", "/api/commons", nil, c, 200).Gates {
		if g.HomeID == nil {
			return x.claimGate(c, s, g.Gate)
		}
	}
	x.t.Fatal("no free gate")
	return homeView{}
}
func (x *rig) openWorkshop(c *http.Cookie, s response) response {
	x.t.Helper()
	x.seedAssets(s.AccountID)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	x.claimFree(c, &s)
	for _, tier := range []int{1, 2} {
		v := x.exp("POST", "/api/homestead/upgrade", body(s, fmt.Sprintf("tier%d", tier), map[string]any{"tier": tier}), c, 200)
		update(&s, v)
	}
	return s
}
func TestPhase5WorkshopCostsGatingCraftingAndRollback(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	if x.p5("POST", "/api/craft", body(s, "homeless", map[string]any{"recipeId": "craft-wooden-stool", "qty": 1}), c, 409).Error.Code != "not-a-member" {
		t.Fatal("homeless craft")
	}
	if v := x.p5("GET", "/api/storage", nil, c, 200); v.Shared != "not-a-member" || v.Storage != nil {
		t.Fatal("homeless storage read")
	}
	x.fund(x.account("alice"), 100, 0)
	x.claimFree(c, &s)
	if x.p5("POST", "/api/craft", body(s, "early", map[string]any{"recipeId": "craft-wooden-stool", "qty": 1}), c, 409).Error.Code != "tier-required" {
		t.Fatal("ungated craft")
	}
	if v := x.p5("GET", "/api/storage", nil, c, 200); v.Shared != "tier-required" || v.Storage != nil {
		t.Fatal("shared chest before the workshop")
	}
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	update(&s, x.exp("POST", "/api/homestead/upgrade", body(s, "cottage", map[string]any{"tier": 1}), c, 200))
	before := s.Snapshot
	if x.exp("POST", "/api/homestead/upgrade", body(s, "workshop", map[string]any{"tier": 2}), c, 409).Error.Code != "insufficient-materials" {
		t.Fatal("free materials upgrade")
	}
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	req := body(s, "workshop-funded", map[string]any{"tier": 2})
	up := x.exp("POST", "/api/homestead/upgrade", req, c, 200)
	update(&s, up)
	if up.Result.Home.Tier != 2 {
		t.Fatal("workshop tier")
	}
	for m, n := range content.HomeRules.GetTiers()[2].GetMaterials() {
		if int(up.Result.Materials[m]) != 1000-int(n) {
			t.Fatal("material upgrade cost", m)
		}
	}
	if up.State.Embers != before.State.Embers+200-int(content.HomeRules.GetTiers()[2].GetGlims()) {
		t.Fatal("ember upgrade cost")
	}
	x.exp("POST", "/api/homestead/upgrade", req, c, 200)
	x.exp("POST", "/api/homestead/upgrade", body(s, "garden", map[string]any{"tier": 3}), c, 409)
	x.give(x.account("alice"), "beeswax", 50)
	x.give(x.account("alice"), "wooden-peg", 50)
	x.give(x.account("alice"), "lamp-head", 50)
	x.give(x.account("alice"), "hearth-oil", 50)
	x.give(x.account("alice"), "bloom-flowers", 50)
	x.give(x.account("alice"), "walnut-shells", 50)
	x.give(x.account("alice"), "candle-oil", 50)
	x.give(x.account("alice"), "madder-scraps", 50)
	x.give(x.account("alice"), "amberfall-sap", 50)
	x.give(x.account("alice"), "frost-glass", 50)
	x.give(x.account("alice"), "lamp-wick", 50)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	for i, recipe := range content.CraftingRules.Recipes {
		req = body(s, recipe.GetId(), map[string]any{"recipeId": recipe.GetId(), "qty": 2})
		v := x.p5("POST", "/api/craft", req, c, 200)
		s.Snapshot = v.Snapshot
		if v.Result.Output.GetQty() != recipe.Output.GetQty()*2 || v.Result.Output.GetId() != recipe.Output.GetId() {
			t.Fatal("craft output")
		}
		if recipe.Output.GetKind() == "instance" && len(v.Result.InstanceIDs) != 2 {
			t.Fatal("crafted instances")
		}
		if recipe.Output.GetKind() == "item" && !slices.Contains(v.State.Inventory, recipe.Output.GetId()) {
			t.Fatal("utility not in snapshot")
		}
		replay := x.p5("POST", "/api/craft", req, c, 200)
		if store.JSON(v) != store.JSON(replay) {
			t.Fatal("craft replay", i)
		}
	}
	before = s.Snapshot
	ledger := count(t, x.db, "SELECT count(*) FROM ledger")
	x.p5("POST", "/api/craft", body(s, "missing", map[string]any{"recipeId": "missing", "qty": 1}), c, 400)
	x.p5("POST", "/api/craft", body(s, "bulk", map[string]any{"recipeId": "craft-wooden-stool", "qty": 101}), c, 400)
	// First ingredient is debited before a missing second ingredient; everything rolls back.
	if _, err := x.db.DB.Exec("DELETE FROM item_stacks WHERE location='pack' AND owner='" + x.account("alice") + "' AND item_def='amber'"); err != nil {
		t.Fatal(err)
	}
	x.p5("POST", "/api/craft", body(s, "poor", map[string]any{"recipeId": "craft-amber-sconce", "qty": 1}), c, 409)
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	if count(t, x.db, "SELECT count(*) FROM ledger") != ledger {
		t.Fatal("failed craft ledger")
	}
	if count(t, x.db, "SELECT count(*) FROM idempotency WHERE key='poor'") != 1 {
		t.Fatal("terminal craft refusal missing")
	}
}
func TestPhase5StorageConservationAndPlacement(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)
	crafted := x.p5("POST", "/api/craft", body(s, "stools", map[string]any{"recipeId": "craft-wooden-stool", "qty": 2}), c, 200)
	s.Snapshot = crafted.Snapshot
	ids := crafted.Result.InstanceIDs
	spot := litSpots(*crafted.Result.Home)[0]
	place := body(s, "place", map[string]any{"itemId": ids[0], "scene": "outdoor", "x": spot[0], "y": spot[1], "rotation": 0})
	update(&s, x.exp("POST", "/api/homestead/place", place, c, 200))
	assets := []*content.Asset{{Kind: "material", Id: "timber", Qty: 7}, {Kind: "item", Id: giftTrinket, Qty: 5}, {Kind: "decoration", Id: "wooden-stool", Qty: 1}}
	original := x.p5("GET", "/api/storage", nil, c, 200)
	for i, v := range assets {
		req := body(s, fmt.Sprintf("put%d", i), map[string]any{"direction": "deposit", "asset": v})
		deposited := x.p5("POST", "/api/storage", req, c, 200)
		s.Snapshot = deposited.Snapshot
		replay := x.p5("POST", "/api/storage", req, c, 200)
		if store.JSON(replay) != store.JSON(deposited) {
			t.Fatal("storage replay")
		}
		if v.GetKind() == "item" && slices.Contains(s.State.Inventory, v.GetId()) {
			t.Fatal("stored trinket still carried")
		}
		if v.GetKind() == "decoration" {
			x.exp("POST", "/api/homestead/place", body(s, "stored-place", map[string]any{"itemId": ids[1], "scene": "outdoor", "x": 1, "y": 0, "rotation": 0}), c, 404)
		}
		out := x.p5("POST", "/api/storage", body(s, fmt.Sprintf("get%d", i), map[string]any{"direction": "withdraw", "asset": v}), c, 200)
		s.Snapshot = out.Snapshot
	}
	final := x.p5("GET", "/api/storage", nil, c, 200)
	if !reflect.DeepEqual(original.Inventory, final.Inventory) || !reflect.DeepEqual(original.Storage, final.Storage) {
		t.Fatal("storage didn't conserve", store.JSON(final))
	}
	if count(t, x.db, "SELECT count(*) FROM homestead_items") != 2 || count(t, x.db, "SELECT count(*) FROM homestead_items WHERE location='placed'") != 1 {
		t.Fatal("duplicated instances")
	}
	x.p5("POST", "/api/storage", body(s, "both", map[string]any{"direction": "deposit", "asset": content.Asset{Kind: "decoration", Id: "wooden-stool", Qty: 2}}), c, 409)
	x.p5("POST", "/api/storage", body(s, "empty", map[string]any{"direction": "withdraw", "asset": assets[0]}), c, 409)
	x.p5("POST", "/api/storage", body(s, "quest-item", map[string]any{"direction": "deposit", "asset": content.Asset{Kind: "item", Id: "field-journal", Qty: 1}}), c, 400)
	for _, v := range assets {
		if count(t, x.db, "SELECT COALESCE(sum(delta),0) FROM ledger WHERE account_id='"+x.account("alice")+"' AND currency='storage:"+v.GetKind()+":"+v.GetId()+"'") != 0 {
			t.Fatal("storage ledger")
		}
	}
}

func TestPhase5MailAssetsWorldScopeAndReplay(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)
	bc, b := x.member("bob", s.WorldID)
	oc, o := x.ready("outsider")
	crafted := x.p5("POST", "/api/craft", body(s, "chair", map[string]any{"recipeId": "craft-reading-chair", "qty": 1}), c, 200)
	s.Snapshot = crafted.Snapshot
	chair := crafted.Result.InstanceIDs[0]
	// Placed goods are unavailable for shipping.
	update(&s, x.exp("POST", "/api/homestead/place", body(s, "place-chair", map[string]any{"itemId": chair, "scene": "indoor", "x": 0, "y": 0, "rotation": 0}), c, 200))
	deco := &content.Asset{Kind: "decoration", Id: "reading-chair", Qty: 1}
	x.p5("POST", "/api/mail", body(s, "placed", map[string]any{"toId": x.account("bob"), "asset": deco}), c, 409)
	update(&s, x.exp("POST", "/api/homestead/remove", body(s, "remove-chair", map[string]any{"itemId": chair}), c, 200))
	for i, asset := range []*content.Asset{{Kind: "material", Id: "timber", Qty: 9}, {Kind: "item", Id: giftTrinket, Qty: 5}, deco} {
		req := body(s, fmt.Sprintf("send%d", i), map[string]any{"toId": x.account("bob"), "asset": asset})
		beforeRecipient := x.expect("GET", "/api/state", nil, bc, 200).Snapshot
		sent := x.p5("POST", "/api/mail", req, c, 200)
		s.Snapshot = sent.Snapshot
		unchanged(t, beforeRecipient, x.expect("GET", "/api/state", nil, bc, 200).Snapshot)
		replay := x.p5("POST", "/api/mail", req, c, 200)
		if store.JSON(sent) != store.JSON(replay) {
			t.Fatal("mail send replay")
		}
		if asset.GetKind() == "item" && slices.Contains(s.State.Inventory, asset.GetId()) {
			t.Fatal("mail left trinket usable")
		}
		id := sent.Result.MailID
		path := "/api/mail/" + id + "/claim"
		x.p5("POST", path, body(s, "sender-claim", nil), c, 403)
		x.p5("POST", path, body(o, "other-world", nil), oc, 403)
		if len(x.p5("GET", "/api/mail", nil, oc, 200).Mail) != 0 {
			t.Fatal("cross-world list")
		}
		beforeSender := s.Snapshot
		claimReq := body(b, fmt.Sprintf("claim%d", i), nil)
		claimed := x.p5("POST", path, claimReq, bc, 200)
		b.Snapshot = claimed.Snapshot
		unchanged(t, beforeSender, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
		replay = x.p5("POST", path, claimReq, bc, 200)
		if store.JSON(claimed) != store.JSON(replay) {
			t.Fatal("mail claim replay")
		}
		x.p5("POST", path, body(b, "claim-again", nil), bc, 409)
		if count(t, x.db, "SELECT sum(delta) FROM ledger WHERE account_id='"+x.account("alice")+"' AND currency='mail:"+asset.GetKind()+":"+asset.GetId()+"'") != 0 {
			t.Fatal("transit conservation")
		}
	}
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("bob")+"' AND item_def='timber'") != 9 || count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("bob")+"' AND item_def='"+giftTrinket+"'") != 5 {
		t.Fatal("mail balances")
	}
	if count(t, x.db, "SELECT count(*) FROM homestead_items WHERE id=? AND account_id='"+x.account("bob")+"' AND location='inventory'", chair) != 1 {
		t.Fatal("decoration identity lost")
	}
	x.p5("POST", "/api/mail", body(s, "cross-world", map[string]any{"toId": x.account("outsider"), "asset": &content.Asset{Kind: "material", Id: "timber", Qty: 1}}), c, 403)
	x.p5("POST", "/api/mail", body(s, "self", map[string]any{"toId": x.account("alice"), "asset": deco}), c, 400)
	x.p5("POST", "/api/mail", body(s, "missing", map[string]any{"toId": "missing", "asset": deco}), c, 404)
	x.p5("POST", "/api/mail", body(s, "forged", map[string]any{"toId": x.account("bob"), "asset": &content.Asset{Kind: "item", Id: "lamp-wick", Qty: 1}}), c, 409)
	x.p5("POST", "/api/mail", body(s, "bound", map[string]any{"toId": x.account("bob"), "asset": &content.Asset{Kind: "item", Id: "ember-charm", Qty: 1}}), c, 409)
}

// Independent connections exercise the SQLite transaction boundary, not just
// the single Store connection's in-process scheduling.
func racePhase5(t *testing.T, x *rig, requests []struct {
	c    *http.Cookie
	path string
	body any
}) []int {
	t.Helper()
	other, err := store.Open(filepath.Join(x.dir, "game.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	api2 := New(other, x.api.Habitica, x.api.Config)
	start := make(chan struct{})
	statuses := make(chan int, len(requests))
	var wg sync.WaitGroup
	for i, v := range requests {
		wg.Add(1)
		go func(i int, v struct {
			c    *http.Cookie
			path string
			body any
		}) {
			defer wg.Done()
			<-start
			r := httptest.NewRequest("POST", v.path, bytes.NewBufferString(store.JSON(v.body)))
			r.Header.Set("X-Glimway-Contract", "7")
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(v.c)
			w := httptest.NewRecorder()
			server := x.api
			if i%2 == 1 {
				server = api2
			}
			server.ServeHTTP(w, r)
			statuses <- w.Code
		}(i, v)
	}
	close(start)
	wg.Wait()
	close(statuses)
	out := []int{}
	for n := range statuses {
		out = append(out, n)
	}
	slices.Sort(out)
	return out
}
func TestPhase5MailClaimRaces(t *testing.T) {
	for _, sameKey := range []bool{false, true} {
		t.Run(fmt.Sprintf("sameKey=%v", sameKey), func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			bc, b := x.member("bob", s.WorldID)
			x.seedAssets(x.account("alice"))
			s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
			sent := x.p5("POST", "/api/mail", body(s, "send", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", Id: "stone", Qty: 7}}), c, 200)
			path := "/api/mail/" + sent.Result.MailID + "/claim"
			key2 := "claim-b"
			if sameKey {
				key2 = "claim-a"
			}
			statuses := racePhase5(t, x, []struct {
				c    *http.Cookie
				path string
				body any
			}{{bc, path, body(b, "claim-a", nil)}, {bc, path, body(b, key2, nil)}})
			expected := []int{200, 409}
			if sameKey {
				expected = []int{200, 200}
			}
			if !slices.Equal(statuses, expected) {
				t.Fatal("mail race", statuses)
			}
			if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("bob")+"' AND item_def='stone'") != 7 || count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id='"+x.account("bob")+"' AND reason='mail-claim'") != 1 {
				t.Fatal("mail paid twice")
			}
		})
	}
}
func TestPhase5ProjectStagesPapersAndWorlds(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	cc, _ := x.member("carol", s.WorldID)
	oc, _ := x.ready("outsider")
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	x.seedAssets(x.account("bob"))
	b.Snapshot = x.expect("GET", "/api/state", nil, bc, 200).Snapshot
	first := x.p5("GET", "/api/projects", nil, c, 200)
	if len(first.Projects) != 6 || first.Projects[0].Stage != "open" || len(first.WorldFlags) != 0 {
		t.Fatal("project catalog")
	}
	path := "/api/projects/north-bridge/contribute"
	req := body(s, "start", map[string]any{"materials": map[string]int{"timber": 1}})
	v := x.p5("POST", path, req, c, 200)
	s.Snapshot = v.Snapshot
	if v.Result.Projects[0].Stage != "in-progress" || len(v.Result.GrantablePapers) != 0 {
		t.Fatal("project start")
	}
	replay := x.p5("POST", path, req, c, 200)
	if store.JSON(v) != store.JSON(replay) {
		t.Fatal("project replay")
	}
	before := s.Snapshot
	ledger := count(t, x.db, "SELECT count(*) FROM ledger")
	x.p5("POST", path, body(s, "over", map[string]any{"materials": map[string]int{"timber": 200}}), c, 409)
	x.p5("POST", path, body(s, "invalid", map[string]any{"materials": map[string]int{"amber": 1}}), c, 400)
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	if count(t, x.db, "SELECT count(*) FROM ledger") != ledger {
		t.Fatal("failed contribution spent")
	}
	v = x.p5("POST", path, body(b, "finish", map[string]any{"materials": map[string]int{"timber": 199, "stone": 80}}), bc, 200)
	b.Snapshot = v.Snapshot
	paper := "count-house-tally-book-scrap"
	if v.Result.Projects[0].Stage != "complete" || v.Result.Projects[0].CompletedAt == nil || !slices.Contains(v.Result.GrantablePapers, paper) || !slices.Contains(v.Result.WorldFlags, "project:north-bridge:complete") {
		t.Fatal("project completion")
	}
	// Completion doesn't silently change earlier contributors' snapshots/revisions.
	aRead := x.p5("GET", "/api/projects", nil, c, 200)
	unchanged(t, s.Snapshot, aRead.Snapshot)
	if !slices.Contains(aRead.GrantablePapers, paper) {
		t.Fatal("earlier contributor omitted")
	}
	nonContributor := x.p5("GET", "/api/projects", nil, cc, 200)
	if len(nonContributor.GrantablePapers) != 0 || len(nonContributor.WorldFlags) != 1 {
		t.Fatal("non-contributor reward")
	}
	outsider := x.p5("GET", "/api/projects", nil, oc, 200)
	if len(outsider.WorldFlags) != 0 || outsider.Projects[0].Stage != "open" {
		t.Fatal("cross-world projects")
	}
	x.p5("POST", path, body(s, "late", map[string]any{"materials": map[string]int{"timber": 1}}), c, 409)
	// Every authored village-project paper is earnable through its project's completion.
	for _, def := range content.ProjectRules.Projects[1:] {
		v = x.p5("POST", "/api/projects/"+def.GetId()+"/contribute", body(s, def.GetId(), map[string]any{"materials": def.Materials}), c, 200)
		s.Snapshot = v.Snapshot
		for _, id := range def.Papers {
			if !slices.Contains(v.Result.GrantablePapers, id) {
				t.Fatal("missing paper", id)
			}
		}
	}
	final := x.p5("GET", "/api/projects", nil, c, 200)
	if len(final.WorldFlags) != 6 || len(final.GrantablePapers) != 6 {
		t.Fatal("completed project set")
	}
}
func TestPhase5ProjectContributionRace(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	for _, id := range []string{"alice", "bob"} {
		x.seedAssets(x.account(id))
	}
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	b.Snapshot = x.expect("GET", "/api/state", nil, bc, 200).Snapshot
	path := "/api/projects/north-bridge/contribute"
	amount := map[string]int{"timber": 200, "stone": 80}
	statuses := racePhase5(t, x, []struct {
		c    *http.Cookie
		path string
		body any
	}{{c, path, body(s, "race", map[string]any{"materials": amount})}, {bc, path, body(b, "race", map[string]any{"materials": amount})}})
	if !slices.Equal(statuses, []int{200, 409}) {
		t.Fatal("contribution race", statuses)
	}
	if count(t, x.db, "SELECT sum(qty) FROM project_materials") != 280 || count(t, x.db, "SELECT count(*) FROM contributions") != 2 || count(t, x.db, "SELECT count(*) FROM project_papers") != 1 {
		t.Fatal("project overfilled")
	}
	if count(t, x.db, "SELECT sum(qty) FROM item_stacks WHERE location='pack' AND item_def='timber'") != 1800 || count(t, x.db, "SELECT sum(qty) FROM item_stacks WHERE location='pack' AND item_def='stone'") != 1920 {
		t.Fatal("both players debited")
	}
}
func TestPhase5BackupRestore(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)
	bc, b := x.member("bob", s.WorldID)
	out := x.p5("POST", "/api/storage", body(s, "store", map[string]any{"direction": "deposit", "asset": content.Asset{Kind: "material", Id: "timber", Qty: 3}}), c, 200)
	s.Snapshot = out.Snapshot
	sent := x.p5("POST", "/api/mail", body(s, "mail", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "item", Id: giftTrinket, Qty: 1}}), c, 200)
	s.Snapshot = sent.Snapshot
	claimed := x.p5("POST", "/api/mail/"+sent.Result.MailID+"/claim", body(b, "claim", nil), bc, 200)
	b.Snapshot = claimed.Snapshot
	complete := x.p5("POST", "/api/projects/north-bridge/contribute", body(s, "project", map[string]any{"materials": map[string]int{"timber": 200, "stone": 80}}), c, 200)
	s.Snapshot = complete.Snapshot
	x.exp("GET", "/api/wilds/region/outer-1", nil, c, 200)
	backup := filepath.Join(x.dir, "phase5-backup.sqlite")
	if err := x.db.Backup(context.Background(), backup); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(backup)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	for _, table := range []string{"item_stacks", "homestead_items", "mail", "projects", "project_materials", "contributions", "project_papers", "region_epochs", "ledger", "idempotency"} {
		if count(t, x.db, "SELECT count(*) FROM "+table) != count(t, restored, "SELECT count(*) FROM "+table) {
			t.Fatal("backup", table)
		}
	}
	tx, err := restored.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	snapshot, err := store.Load(context.Background(), tx, x.account("alice"))
	if err != nil {
		t.Fatal(err)
	}
	unchanged(t, s.Snapshot, snapshot)
}

func TestPhase5MailClaimDatabaseFailureRollsBack(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	sent := x.p5("POST", "/api/mail", body(s, "send", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "item", Id: giftTrinket, Qty: 2}}), c, 200)
	if _, err := x.db.DB.Exec("CREATE TRIGGER fail_mail BEFORE UPDATE ON mail WHEN NEW.claimed_at IS NOT NULL BEGIN SELECT RAISE(FAIL,'claim failed'); END"); err != nil {
		t.Fatal(err)
	}
	path := "/api/mail/" + sent.Result.MailID + "/claim"
	req := body(b, "claim", nil)
	x.p5("POST", path, req, bc, 500)
	unchanged(t, b.Snapshot, x.expect("GET", "/api/state", nil, bc, 200).Snapshot)
	if count(t, x.db, "SELECT count(*) FROM item_stacks WHERE location='pack' AND owner='"+x.account("bob")+"' AND item_def NOT IN ('timber','stone','fiber','amber')") != 0 || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='mail-claim'") != 0 || count(t, x.db, "SELECT count(*) FROM mail WHERE claimed_at IS NOT NULL") != 0 {
		t.Fatal("failed claim committed")
	}
	if _, err := x.db.DB.Exec("DROP TRIGGER fail_mail"); err != nil {
		t.Fatal(err)
	}
	x.p5("POST", path, req, bc, 200)
}
func TestPhase5ContributionFailureAndMutationGuards(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	if _, err := x.db.DB.Exec("DELETE FROM item_stacks WHERE location='pack' AND owner='" + x.account("alice") + "' AND item_def='stone'"); err != nil {
		t.Fatal(err)
	}
	path := "/api/projects/north-bridge/contribute"
	req := body(s, "partial-failure", map[string]any{"materials": map[string]int{"timber": 1, "stone": 1}})
	before := s.Snapshot
	ledger := count(t, x.db, "SELECT count(*) FROM ledger")
	if x.p5("POST", path, req, c, 409).Error.Code != "insufficient-materials" {
		t.Fatal("contribution didn't check funds")
	}
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='"+x.account("alice")+"' AND item_def='timber'") != 1000 || count(t, x.db, "SELECT count(*) FROM contributions") != 0 || count(t, x.db, "SELECT count(*) FROM projects") != 0 || count(t, x.db, "SELECT count(*) FROM ledger") != ledger {
		t.Fatal("partial contribution committed")
	}
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	for _, path := range []string{"/api/storage", "/api/craft", "/api/mail", "/api/mail/missing/claim", "/api/projects/north-bridge/contribute"} {
		for _, invalid := range []string{"lease", "missing-op", "old-upload"} {
			req := body(s, "guard", map[string]any{})
			status := 400
			switch invalid {
			case "lease":
				req["op"].(map[string]any)["lease"] = "bad"
				status = 409
			case "missing-op":
				delete(req, "op")
			case "old-upload":
				req["baseRev"] = s.Version
			}
			x.p5("POST", path, req, c, status)
		}
	}
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
}

// The client shows "your contribution" and what you can send without a Workshop.
func TestPhase5ProjectsShowMyShareAndMailShowsCarriedCounts(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	x.seedAssets(x.account("bob"))
	b.Snapshot = x.expect("GET", "/api/state", nil, bc, 200).Snapshot
	path := "/api/projects/well-canopy/contribute"
	v := x.p5("POST", path, body(s, "a1", map[string]any{"materials": map[string]int{"timber": 7, "fiber": 2}}), c, 200)
	s.Snapshot = v.Snapshot
	v = x.p5("POST", path, body(s, "a2", map[string]any{"materials": map[string]int{"timber": 3}}), c, 200)
	x.p5("POST", path, body(b, "b1", map[string]any{"materials": map[string]int{"stone": 5}}), bc, 200)
	mine := x.p5("GET", "/api/projects", nil, c, 200).Projects[1]
	if mine.ID != "well-canopy" || mine.Mine["timber"] != 10 || mine.Mine["fiber"] != 2 || mine.Mine["stone"] != 0 || mine.Contributed["stone"] != 5 {
		t.Fatalf("my share %+v", mine)
	}
	if theirs := x.p5("GET", "/api/projects", nil, bc, 200).Projects[1]; theirs.Mine["stone"] != 5 || theirs.Mine["timber"] != 0 {
		t.Fatalf("their share %+v", theirs)
	}
	m := x.p5("GET", "/api/mail", nil, c, 200)
	if m.Inventory.Materials["timber"] != 990 || m.Inventory.Items[giftTrinket] != 5 {
		t.Fatalf("mail carried counts %+v", m.Inventory)
	}
}

// giftTrinket is a keepsake that may be posted and handed over (the story
// keepsakes, like the whittled fox, stay with whoever holds them).
const giftTrinket = "river-glass-bead"

// give puts unmarked stacks straight into a pack (test funding).
func (x *rig) give(id, def string, n int) {
	x.t.Helper()
	tx, err := x.db.DB.Begin()
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	if err = materialChange(context.Background(), tx, id, def, n, "test-funding", "", x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		x.t.Fatal(err)
	}
}
