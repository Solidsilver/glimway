package api

import (
	"context"
	"encoding/json"
	"fmt"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"slices"
	"strings"
	"testing"
	"time"
)

// Generated tx/ty are chunk-local; progress positions are region pixels.
func nearEntity(s response, e entityView) rules.State {
	var cx, cy int
	fmt.Sscanf(e.ID, e.Kind+":%d:%d:", &cx, &cy)
	doc := s.State
	doc.Area = "wilds"
	doc.Position = rules.Position{X: float64((cx*24 + e.TX) * 16), Y: float64((cy*24 + e.TY) * 16)}
	return doc
}
func atLantern(s response) rules.State {
	doc := s.State
	doc.Area = "wilds"
	doc.Position = rules.Position{X: 160, Y: 160}
	return doc
}
func TestFix4ReadOnlyHomeRevisions(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.claimGate(bc, &b, 0)
	v := x.exp("GET", "/api/homestead/gate/0", nil, c, 200)
	if v.Version != s.Version || count(t, x.db, "SELECT version FROM players WHERE account_id='"+x.account("bob")+"'") != int(b.Version) || count(t, x.db, "SELECT count(*) FROM homestead_members WHERE account_id='"+x.account("alice")+"'") != 0 {
		t.Fatal("visitor changed owner")
	}
	if v.Home == nil || v.Home.Member || v.Home.Tier != 0 {
		t.Fatal("visited campsite")
	}
	commons := x.exp("GET", "/api/commons", nil, c, 200)
	if commons.Version != s.Version || commons.Gates[0].HomeID == nil {
		t.Fatal("read bumped revision or omitted member")
	}
	own := x.exp("GET", "/api/homestead/gate/0", nil, bc, 200)
	if own.Version != b.Version {
		t.Fatal("own read bumped revision")
	}
	doc := b.State
	doc.Area = "woodland"
	doc.HP = 12
	doc.Position = rules.Position{X: 900, Y: 700}
	saved := x.expect("PUT", "/api/progress", mutation(b, doc), bc, 200)
	if saved.State.HP != 12 || saved.State.Position != doc.Position {
		t.Fatal("neighbor read made damage stale")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='homestead-deed'") != 1 {
		t.Fatal("deed duplicated")
	}
}
func TestFix4PlacementNeedsTierForIndoors(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fund(x.account("alice"), 30, 0)
	x.claimGate(c, &s, 0)
	v := x.exp("POST", "/api/homestead/buy", body(s, "stool", map[string]any{"itemDef": "wooden-stool"}), c, 200)
	update(&s, v)
	req := body(s, "place", map[string]any{"itemId": v.Result.ItemID, "scene": "indoor", "x": 0, "y": 0, "rotation": 0})
	if x.exp("POST", "/api/homestead/place", req, c, 409).Error.Code != "tier-required" {
		t.Fatal("campsite has no indoors")
	}
	update(&s, x.exp("POST", "/api/homestead/upgrade", body(s, "cottage", map[string]any{"tier": 1}), c, 200))
	req["baseRev"] = s.Version
	x.exp("POST", "/api/homestead/place", req, c, 200)
}
func TestFix4ClaimLocation(t *testing.T) {
	for _, kind := range []string{"node", "camp", "chest", "poi"} {
		t.Run(kind, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			r := x.region(c)
			e := entityKind(t, r, kind)
			req := body(s, "claim", map[string]any{"epoch": r.Epoch.ID, "entityId": e.ID, "cycle": 0})
			if x.exp("POST", "/api/wilds/claim", req, c, 409).Error.Code != "not-in-wilds" {
				t.Fatal("village claim")
			}
			doc := nearEntity(s, e)
			doc.Position.X += 4 * 16
			req["progress"] = doc
			if x.exp("POST", "/api/wilds/claim", req, c, 409).Error.Code != "too-far-away" {
				t.Fatal("distant claim")
			}
			doc = nearEntity(s, e)
			doc.Position.X += 2 * 16
			req["progress"] = doc
			x.exp("POST", "/api/wilds/claim", req, c, 200)
		})
	}
}
func TestFix4RelightLocation(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	r := x.region(c)
	doc := atLantern(s)
	doc.HP = 0
	v := x.exp("POST", "/api/wilds/defeat", body(s, "fall", map[string]any{"epoch": r.Epoch.ID, "x": 10, "y": 10, "progress": doc}), c, 200)
	req := body(b, "light", map[string]any{"epoch": r.Epoch.ID, "ownerId": x.account("alice"), "lanternId": v.Result.LanternID})
	if x.exp("POST", "/api/wilds/lantern", req, bc, 409).Error.Code != "not-in-wilds" {
		t.Fatal("village relight")
	}
	doc = atLantern(b)
	doc.Position.X += 64
	req["progress"] = doc
	if x.exp("POST", "/api/wilds/lantern", req, bc, 409).Error.Code != "too-far-away" {
		t.Fatal("distant relight")
	}
	req["progress"] = atLantern(b)
	x.exp("POST", "/api/wilds/lantern", req, bc, 200)
}
func TestFix4InventoryAuthority(t *testing.T) {
	x := newRig(t)
	_, s := x.ready("alice")
	ctx := context.Background()
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	state, err := store.Load(ctx, tx, s.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	state.State.Inventory = append(state.State.Inventory, "beeswax-candle", "ember-charm", "invented")
	if _, err = tx.Exec("INSERT INTO item_stacks VALUES('pack','" + x.account("alice") + "','beeswax-candle','',1)"); err != nil {
		t.Fatal(err)
	}
	if err = store.Persist(ctx, tx, &state, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	var raw string
	if err = tx.QueryRow("SELECT doc_json FROM progress WHERE account_id='" + x.account("alice") + "'").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var doc rules.State
	json.Unmarshal([]byte(raw), &doc)
	for _, id := range doc.Inventory {
		if !slices.Contains(rules.QuestItems, id) {
			t.Fatal("authoritative inventory copied", id)
		}
	}
	if _, err = tx.Exec("DELETE FROM item_stacks WHERE location='pack' AND owner='" + x.account("alice") + "' AND item_def NOT IN ('timber','stone','fiber','amber')"); err != nil {
		t.Fatal(err)
	}
	// Old documents must also stop reviving revoked items.
	doc.Inventory = append(doc.Inventory, "beeswax-candle")
	if _, err = tx.Exec("UPDATE progress SET doc_json=? WHERE account_id='"+x.account("alice")+"'", store.JSON(doc)); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(ctx, tx, x.account("alice"))
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(loaded.State.Inventory, "beeswax-candle") {
		t.Fatal("legacy document revives revoked loot")
	}
}
func TestFix4VillageHearthOnly(t *testing.T) {
	for _, kind := range []string{"rest", "revive"} {
		t.Run(kind, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.fund(x.account("alice"), 5, 5)
			s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
			doc := s.State
			doc.Area = "commons"
			doc.Position = rules.Position{X: 64, Y: 64}
			doc.HP = 0
			if x.exp("POST", "/api/spend", spendBody(s, kind, "", "hearth", doc), c, 409).Error.Code != "not-at-safe-boundary" {
				t.Fatal("commons hearth rest")
			}
			doc.Area = "village"
			x.exp("POST", "/api/spend", spendBody(s, kind, "", "hearth", doc), c, 200)
		})
	}
}
func TestFix4POIUpdateFailureRollsBack(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	r := x.region(c)
	e := entityKind(t, r, "poi")
	_, err := x.db.DB.Exec("CREATE TRIGGER fail_chart BEFORE UPDATE ON entity_state WHEN NEW.state='charted' BEGIN SELECT RAISE(FAIL,'chart failed'); END")
	if err != nil {
		t.Fatal(err)
	}
	req := body(s, "poi", map[string]any{"epoch": r.Epoch.ID, "entityId": e.ID, "cycle": 0, "progress": nearEntity(s, e)})
	x.exp("POST", "/api/wilds/claim", req, c, 500)
	for _, table := range []string{"personal_claims", "discoveries", "claim_rate"} {
		if count(t, x.db, "SELECT count(*) FROM "+table) != 0 {
			t.Fatal("failed claim committed", table)
		}
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='wilds-claim'") != 0 {
		t.Fatal("failed claim granted loot")
	}
	x.db.DB.Exec("DROP TRIGGER fail_chart")
	x.exp("POST", "/api/wilds/claim", req, c, 200)
}
func TestFix4LanternCreationCap(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	r := x.region(c)
	var last, replay map[string]any
	var before store.Snapshot
	for i := 0; i < 3; i++ {
		doc := atLantern(s)
		doc.HP = 0
		last = body(s, fmt.Sprintf("fall%d", i), map[string]any{"epoch": r.Epoch.ID, "x": 10, "y": 10, "progress": doc})
		status := 200
		if i == 2 {
			status = 429
		}
		v := x.exp("POST", "/api/wilds/defeat", last, c, status)
		if i < 2 {
			replay = last
			update(&s, v)
			before = s.Snapshot
		} else if v.Error.Code != "lantern-creation-limited" {
			t.Fatal(v.Error.Code)
		}
	}
	// Replays don't count, rejection doesn't consume a key, and UTC midnight resets.
	x.exp("POST", "/api/wilds/defeat", replay, c, 200)
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	if count(t, x.db, "SELECT count(*) FROM idempotency WHERE key='fall2'") != 0 {
		t.Fatal("rejection cached")
	}
	if count(t, x.db, "SELECT sum(qty) FROM lantern_creations WHERE account_id='"+x.account("alice")+"'") != 2 {
		t.Fatal("creation counter")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='wilds-defeat'") != 2 {
		t.Fatal("creation cap ledger")
	}
	x.now.Store(time.Unix(x.now.Load(), 0).UTC().Truncate(24 * time.Hour).Add(24 * time.Hour).Unix())
	x.exp("POST", "/api/wilds/defeat", last, c, 200)
}

func TestFix4ClaimStoredLocationAndChunkCoordinates(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	r := x.region(c)
	var e entityView
	for _, candidate := range r.Entities {
		if candidate.Kind == "node" && strings.HasPrefix(candidate.ID, "node:1:1:") {
			e = candidate
			break
		}
	}
	if e.ID == "" {
		t.Fatal("fixture has no distant node")
	}
	doc := nearEntity(s, e)
	// A chunk-local pixel coordinate must not authorize this region-global entity.
	doc.Position = rules.Position{X: float64(e.TX * 16), Y: float64(e.TY * 16)}
	req := body(s, "chunk", map[string]any{"epoch": r.Epoch.ID, "entityId": e.ID, "cycle": 0, "progress": doc})
	x.exp("POST", "/api/wilds/claim", req, c, 409)
	doc = nearEntity(s, e)
	doc.Position.X += 3 * 16
	s.Snapshot = x.expect("PUT", "/api/progress", mutation(s, doc), c, 200).Snapshot
	req = body(s, "stored", map[string]any{"epoch": r.Epoch.ID, "entityId": e.ID, "cycle": 0})
	x.exp("POST", "/api/wilds/claim", req, c, 200)
}
