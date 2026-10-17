package api

import (
	"fmt"
	"net/http"
	"testing"

	"glimway/content"
	"glimway/server/internal/chunks"
)

// The trowel is made at the bench like the other bench tools, from one
// timber and one stone, and lands in the pack as a marked instance.
func TestTrowelIsCraftedAtTheBench(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)
	x.refresh(c, &s)
	before := x.items("GET", "/api/items", nil, c, 200).Items
	crafted := x.p5("POST", "/api/craft", body(s, "trowel", map[string]any{"recipeId": "craft-bench-trowel", "qty": 1}), c, 200)
	if len(crafted.Result.InstanceIDs) != 1 {
		t.Fatal("no trowel")
	}
	v := x.items("GET", "/api/items", nil, c, 200).Items
	trowel := findInstance(v, crafted.Result.InstanceIDs[0])
	if trowel == nil || trowel.ItemDef != "bench-trowel" || trowel.Maker == nil || trowel.Maker.ID != s.AccountID {
		t.Fatalf("crafted trowel %+v", trowel)
	}
	if stackQty(before, "timber")-stackQty(v, "timber") != 1 || stackQty(before, "stone")-stackQty(v, "stone") != 1 {
		t.Fatalf("cost: timber %d→%d stone %d→%d", stackQty(before, "timber"), stackQty(v, "timber"), stackQty(before, "stone"), stackQty(v, "stone"))
	}
	x.conserved(s.AccountID)
}

// At home, only the trowel digs a plant up, and only for whoever may plant
// there (a member, ownLand): the plant goes, its seed comes back.
func TestTrowelDigsUpAtHome(t *testing.T) {
	x := newRig(t)
	c, s, h := x.homePlayer("alice")
	area := fmt.Sprintf("home:%d", h.Gate)
	x.stack(s.AccountID, "birch-sapling", "", 1)
	var tile [2]int
	for _, candidate := range litSpots(h) {
		if plantGround(h)[candidate] {
			tile = candidate
			break
		}
	}
	if tile == [2]int{} {
		t.Fatal("no lit planting ground")
	}
	p := x.opRefreshing(c, &s, "plant", map[string]any{"itemDef": "birch-sapling", "tile": tile, "progress": standAt(s, area, tile[0], tile[1])}, 200).Result.Plant
	if p == nil {
		t.Fatal("not planted")
	}
	dig := func(c2 *http.Cookie, s2 *response, at [2]int, status int) itemsResponse {
		t.Helper()
		return x.opRefreshing(c2, s2, "uproot", map[string]any{"target": p.ID, "progress": standAt(*s2, area, at[0], at[1])}, status)
	}

	// No trowel, no digging.
	if dig(c, &s, tile, 409).Error.Code != "wrong-tool" {
		t.Fatal("dug without a trowel")
	}
	x.instance(s.AccountID, "bench-trowel", -1, "")
	if dig(c, &s, [2]int{tile[0] + 5, tile[1]}, 409).Error.Code != "too-far-away" {
		t.Fatal("dug from afar")
	}
	// A neighbour with a trowel of their own still may not.
	bc, b := x.member("bob", s.WorldID)
	x.claimGate(bc, &b, 1-h.Gate)
	x.instance(b.AccountID, "bench-trowel", -1, "")
	if dig(bc, &b, tile, 409).Error.Code != "not-your-land" {
		t.Fatal("dug a neighbour's plant")
	}

	r := dig(c, &s, tile, 200)
	if stackQty(r.Result.Items, "birch-sapling") != 1 || len(x.home(c).Plants) != 0 {
		t.Fatalf("after: sapling %d, plants %v", stackQty(r.Result.Items, "birch-sapling"), x.home(c).Plants)
	}
	// One dig, one use of the trowel's thirty.
	if w := r.Result.Wear; w == nil || w.ItemDef != "bench-trowel" || w.UsesLeft != 29 || w.Broke {
		t.Fatalf("the trowel's wear: %+v", w)
	}
	if dig(c, &s, tile, 409).Error.Code != "not-placed" {
		t.Fatal("dug twice")
	}
	x.conserved(s.AccountID)
	x.conserved(b.AccountID)
}

// In a lot's lit backland the trowel works as on the lot: the member digs,
// a visitor can't.
func TestTrowelDigsUpInTheBackland(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimGate(c, &s, 0)
	x.fund(s.AccountID, 200, 0)
	x.stack(s.AccountID, "hearth-oil", "", 2)
	ox, oy := chunks.LotOrigin(0)
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	spots := x.backlandSpots(s.WorldID, 0)
	if len(spots) < 3 {
		t.Fatalf("backland spots: %d", len(spots))
	}
	at := spots[2]
	stand := standAt(s, "outdoors", ox+at[0], oy+at[1])
	x.stack(s.AccountID, "birch-sapling", "", 1)
	p := x.opRefreshing(c, &s, "plant", map[string]any{"itemDef": "birch-sapling", "tile": [2]int{ox + at[0], oy + at[1]}, "progress": stand}, 200).Result.Plant
	if p == nil {
		t.Fatal("not planted")
	}
	if x.opRefreshing(c, &s, "uproot", map[string]any{"target": p.ID, "progress": stand}, 409).Error.Code != "wrong-tool" {
		t.Fatal("dug without a trowel")
	}
	x.instance(s.AccountID, "bench-trowel", -1, "")
	bc, b := x.member("bob", s.WorldID)
	x.instance(b.AccountID, "bench-trowel", -1, "")
	if x.opRefreshing(bc, &b, "uproot", map[string]any{"target": p.ID, "progress": standAt(b, "outdoors", ox+at[0], oy+at[1])}, 409).Error.Code != "not-your-land" {
		t.Fatal("a visitor dug the backland")
	}
	r := x.opRefreshing(c, &s, "uproot", map[string]any{"target": p.ID, "progress": stand}, 200)
	if stackQty(r.Result.Items, "birch-sapling") != 1 || len(x.home(c).Plants) != 0 {
		t.Fatalf("after: sapling %d, plants %v", stackQty(r.Result.Items, "birch-sapling"), x.home(c).Plants)
	}
	x.conserved(s.AccountID)
}

// Each dig is one use of the trowel, through the same wear as any tool:
// the keener of two trowels wears first, and one on its last use gives out
// as a cheap tool does, gone from the pack, so the next dig is refused.
func TestTrowelWearsAndBreaks(t *testing.T) {
	x := newRig(t)
	c, s, h := x.homePlayer("alice")
	area := fmt.Sprintf("home:%d", h.Gate)
	tiles := [][2]int{}
	for _, candidate := range litSpots(h) {
		if plantGround(h)[candidate] {
			tiles = append(tiles, candidate)
		}
	}
	if len(tiles) < 2 {
		t.Fatal("lit planting ground")
	}
	x.stack(s.AccountID, "wild-thyme", "", 3)
	plantAt := func(tile [2]int) string {
		t.Helper()
		p := x.opRefreshing(c, &s, "plant", map[string]any{"itemDef": "wild-thyme", "tile": tile, "progress": standAt(s, area, tile[0], tile[1])}, 200).Result.Plant
		if p == nil {
			t.Fatal("not planted")
		}
		return p.ID
	}
	dig := func(id string, tile [2]int, status int) itemsResponse {
		t.Helper()
		return x.opRefreshing(c, &s, "uproot", map[string]any{"target": id, "progress": standAt(s, area, tile[0], tile[1])}, status)
	}
	last := int(content.ItemsRules.Rules.Wear.GetPointsPerUse())
	worn := x.instance(s.AccountID, "bench-trowel", last, "")
	fresh := x.instance(s.AccountID, "bench-trowel", -1, "")

	// The fresh trowel wears first, as the belt holds it.
	w := dig(plantAt(tiles[0]), tiles[0], 200).Result.Wear
	if w == nil || w.UsesLeft != 29 || w.Broke {
		t.Fatalf("first dig: %+v", w)
	}
	v := x.items("GET", "/api/items", nil, c, 200).Items
	if findInstance(v, worn) == nil || findInstance(v, fresh) == nil || findInstance(v, fresh).UsesLeft != 29 || findInstance(v, worn).UsesLeft != 1 {
		t.Fatal("the wrong trowel wore", findInstance(v, fresh), findInstance(v, worn))
	}

	// With only the worn one left, its last use digs, then it gives out.
	if _, err := x.db.DB.Exec("DELETE FROM item_instances WHERE id=?", fresh); err != nil {
		t.Fatal(err)
	}
	r := dig(plantAt(tiles[1]), tiles[1], 200)
	if w = r.Result.Wear; w == nil || !w.Broke || w.ItemDef != "bench-trowel" || stackQty(r.Result.Items, "wild-thyme") != 3 {
		t.Fatalf("last dig: %+v thyme %d", w, stackQty(r.Result.Items, "wild-thyme"))
	}
	if findInstance(x.items("GET", "/api/items", nil, c, 200).Items, worn) != nil {
		t.Fatal("the broken trowel is still in the pack")
	}
	if dig(plantAt(tiles[0]), tiles[0], 409).Error.Code != "wrong-tool" {
		t.Fatal("dug with a broken trowel")
	}
}
