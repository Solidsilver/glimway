package api

import (
	"context"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"slices"
	"testing"
)

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
	saved := x.reportState(bc, b, doc.HP, doc.Mana, testWhere(doc))
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
	req["op"].(map[string]any)["key"] = "place-after-upgrade"
	x.exp("POST", "/api/homestead/place", req, c, 200)
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
	var docs int
	tx.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='progress'").Scan(&docs)
	if docs != 0 {
		t.Fatal("document survived")
	}
	if _, err = tx.Exec("DELETE FROM item_stacks WHERE location='pack' AND owner=? AND item_def='beeswax-candle'", s.AccountID); err != nil {
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
	for _, kind := range []string{"rest"} {
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
			x.exp("POST", "/api/spend", spendBody(s, kind, "", "hearth-village", doc), c, 200)
		})
	}
}
