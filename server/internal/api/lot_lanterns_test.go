package api

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
)

// lanternOp fills a lot's lantern standing at (tx, ty), world tiles.
func (x *rig) lanternOp(c *http.Cookie, s *response, gate, tx, ty, status int) expansionResponse {
	x.t.Helper()
	x.refresh(c, s)
	return x.exp("POST", "/api/homestead/lantern", body(*s, fmt.Sprintf("lantern-%d-%d", x.now.Load(), keySeq()), map[string]any{"gate": gate, "progress": standAt(*s, "outdoors", tx, ty)}), c, status)
}

// atStake is the tile in front of a lot's lantern stake (world tiles).
func atStake(gate int) (int, int) {
	ox, oy := chunks.LotOrigin(gate)
	sx, sy := chunks.LanternStake(gate)
	return ox + sx, oy + sy + 1
}

func (x *rig) lanternOf(gate int, world string) lotLantern {
	x.t.Helper()
	tx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	var home string
	if err = tx.QueryRow("SELECT id FROM homesteads WHERE world_id=? AND gate=?", world, gate).Scan(&home); err != nil {
		x.t.Fatal(err)
	}
	l, err := lanternOf(context.Background(), tx, home, world, gate)
	if err != nil {
		x.t.Fatal(err)
	}
	return l
}

// backlandSpots are open lot-local backland tiles (the server's buildable),
// away from the chunk's edges, in reading order.
func (x *rig) backlandSpots(world string, gate int) [][2]int {
	x.t.Helper()
	tx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	b, err := x.api.backlandOf(context.Background(), tx, world, gate, x.now.Load())
	if err != nil || b == nil {
		x.t.Fatalf("backland: %v %v", b, err)
	}
	out := [][2]int{}
	for y := 2; y < 22; y++ {
		for lx := 2; lx < 22; lx++ {
			if b.buildable(b.x0+lx, y) {
				out = append(out, [2]int{b.x0 + lx, y})
			}
		}
	}
	return out
}

func (x *rig) turn() {
	day := content.CalendarAt(content.CalendarRules, x.now.Load())
	x.now.Store(day.NextTurning + 60)
}

// A member lights the lantern (one hearth oil, holding this wick's
// backland); anyone tops it up; the store holds three wicks; a dark
// lantern is a member's to light, and only from beside its stake.
func TestLotLanternFillAndTopUp(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimGate(c, &s, 0)
	bc, bs := x.member("bob", s.WorldID)
	x.stack(s.AccountID, "hearth-oil", "", 5)
	x.stack(bs.AccountID, "hearth-oil", "", 5)
	sx, sy := atStake(0)
	if v := x.lanternOp(bc, &bs, 0, sx, sy, 409); v.Error.Code != "not-a-member" {
		t.Fatalf("a visitor lit a dark lantern: %v", v.Error.Code)
	}
	if v := x.lanternOp(c, &s, 0, sx+8, sy, 409); v.Error.Code != "too-far-away" {
		t.Fatalf("filled from across the lot: %v", v.Error.Code)
	}
	if v := x.lanternOp(c, &s, 1, sx, sy, 409); v.Error.Code != "too-far-away" && v.Error.Code != "no-home" {
		t.Fatalf("filled another lot's lantern: %v", v.Error.Code)
	}
	v := x.lanternOp(c, &s, 0, sx, sy, 200)
	if l := v.Result.Home.Lantern; !l.Lit || l.Oil != 1 || l.Dimming {
		t.Fatalf("lit: %+v", l)
	}
	cx, cy := chunks.BacklandChunk(0)
	dbtx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	h, err := x.api.Config.Chunks.(*store.Chunks).HoldAt(context.Background(), dbtx, s.WorldID, int32(cx), int32(cy))
	dbtx.Rollback()
	if err != nil || h == nil || h.HolderKind != lotLanternKind || h.HolderID != "0" {
		t.Fatalf("hold: %+v %v", h, err)
	}
	// Anyone keeps it burning.
	x.lanternOp(bc, &bs, 0, sx, sy, 200)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	if l := x.lanternOf(0, s.WorldID); l.Oil != 3 {
		t.Fatalf("topped up: %+v", l)
	}
	if v := x.lanternOp(bc, &bs, 0, sx, sy, 409); v.Error.Code != "lantern-full" {
		t.Fatalf("over-filled: %v", v.Error.Code)
	}
	var left int
	if err := x.db.DB.QueryRow("SELECT COALESCE(SUM(qty),0) FROM item_stacks WHERE location='pack' AND owner=? AND item_def='hearth-oil'", bs.AccountID).Scan(&left); err != nil || left != 4 {
		t.Fatalf("bob's oil: %d %v", left, err)
	}
	// Visitors see it on the lot's read.
	if l := x.exp("GET", "/api/homestead/gate/0", nil, bc, 200).Home.Lantern; !l.Lit || l.Oil != 3 {
		t.Fatalf("visitor's read: %+v", l)
	}
}

// While lit, the backland joins the lot's service bounds: members set
// pieces and plants out there (stored lot-local past the lot); a dark
// backland refuses; non-members can't change its ground.
func TestBacklandBuildsOnlyWhileLit(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimGate(c, &s, 0)
	x.fund(s.AccountID, 200, 0)
	x.stack(s.AccountID, "hearth-oil", "", 2)
	ox, oy := chunks.LotOrigin(0)
	stool := x.homeOpRefreshing(c, &s, "buy", map[string]any{"itemDef": "wooden-stool"}, 200).Result.ItemID
	// Dark: nothing goes out there.
	if v := x.homeOpRefreshing(c, &s, "place", map[string]any{"itemId": stool, "scene": "outdoor", "x": -10, "y": 10, "rotation": 0}, 409); v.Error.Code != "unlit" {
		t.Fatalf("placed in a dark backland: %v", v.Error.Code)
	}
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	spots := x.backlandSpots(s.WorldID, 0)
	if len(spots) < 3 {
		t.Fatalf("backland spots: %d", len(spots))
	}
	at, stand := spots[0], spots[1]
	where := standAt(s, "outdoors", ox+stand[0], oy+stand[1])
	x.homeOpRefreshing(c, &s, "place", map[string]any{"itemId": stool, "scene": "outdoor", "x": at[0], "y": at[1], "rotation": 0, "progress": where}, 200)
	h := x.home(c)
	placed := false
	for _, it := range h.Items {
		if it.ID == stool && it.X != nil && *it.X == at[0] && *it.Y == at[1] {
			placed = true
		}
	}
	if !placed {
		t.Fatal("the stool isn't in the backland")
	}
	// Posts stay on the lot.
	for _, m := range []string{"timber", "stone", "fiber", "amber"} {
		x.give(s.AccountID, m, 20)
	}
	post := x.homeOpRefreshing(c, &s, "buy", map[string]any{"itemDef": content.HomeRules.GetLanternPosts().GetItem()}, 200).Result.ItemID
	if v := x.homeOpRefreshing(c, &s, "place", map[string]any{"itemId": post, "scene": "outdoor", "x": spots[2][0], "y": spots[2][1], "rotation": 0, "name": "Out There", "progress": where}, 409); v.Error.Code != "land-blocked" {
		t.Fatalf("a post in the backland: %v", v.Error.Code)
	}
	// A plant at the feet.
	x.stack(s.AccountID, "birch-sapling", "", 1)
	plantAt := spots[2]
	p := x.opRefreshing(c, &s, "plant", map[string]any{"itemDef": "birch-sapling", "tile": [2]int{ox + plantAt[0], oy + plantAt[1]}, "progress": standAt(s, "outdoors", ox+plantAt[0], oy+plantAt[1])}, 200)
	if p.Result.Plant == nil || p.Result.Plant.X != plantAt[0] || !p.Result.Plant.Lit {
		t.Fatalf("backland plant: %+v %v", p.Result.Plant, p.Error.Code)
	}
	// A visitor may walk the backland, not lay its ground.
	bc, bs := x.member("bob", s.WorldID)
	x.give(bs.AccountID, "stone", 2)
	tile := spots[len(spots)-1]
	if _, code := x.pathOp(bc, bs, "lay", "bob-lay", ox+tile[0], oy+tile[1], ox+tile[0], oy+tile[1], "stone", 409); code != "not-your-land" {
		t.Fatalf("a visitor laid the backland: %v", code)
	}
}

// Judged once at each turning: a wick burns; out of oil the lantern dims
// for a wick (still held, the pinned land served); still empty it goes
// dark, the backland turns, the pieces out there go to home storage and
// the plants to the archive with their seed back in the chest.
func TestLotLanternBurnsDimsAndLapses(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimGate(c, &s, 0)
	x.fund(s.AccountID, 200, 0)
	x.stack(s.AccountID, "hearth-oil", "", 2)
	ox, oy := chunks.LotOrigin(0)
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	cx, cy := chunks.BacklandChunk(0)
	pinned := x.near(c, cx, cy, 200).Wick.Id
	spots := x.backlandSpots(s.WorldID, 0)
	where := standAt(s, "outdoors", ox+spots[1][0], oy+spots[1][1])
	stool := x.homeOpRefreshing(c, &s, "buy", map[string]any{"itemDef": "wooden-stool"}, 200).Result.ItemID
	x.homeOpRefreshing(c, &s, "place", map[string]any{"itemId": stool, "scene": "outdoor", "x": spots[0][0], "y": spots[0][1], "rotation": 0, "progress": where}, 200)
	x.stack(s.AccountID, "birch-sapling", "", 1)
	plantAt := spots[2]
	x.opRefreshing(c, &s, "plant", map[string]any{"itemDef": "birch-sapling", "tile": [2]int{ox + plantAt[0], oy + plantAt[1]}, "progress": standAt(s, "outdoors", ox+plantAt[0], oy+plantAt[1])}, 200)

	// Turning 1: the wick of oil burns; the backland holds.
	x.turn()
	c, s = x.again("alice")
	if l := x.lanternOf(0, s.WorldID); !l.Lit || l.Oil != 0 || l.Dimming {
		t.Fatalf("turning 1: %+v", l)
	}
	n := x.near(c, cx, cy, 200)
	if got := nearChunkAt(n, cx, cy); got.Source != location.SourceHeld.String() || got.Epoch != pinned || n.Wick.Id == pinned {
		t.Fatalf("turning 1: the backland isn't served pinned: %+v", got)
	}
	// Turning 2: out of oil, it dims for a wick and still holds.
	x.turn()
	c, s = x.again("alice")
	if l := x.lanternOf(0, s.WorldID); !l.Lit || !l.Dimming {
		t.Fatalf("turning 2: %+v", l)
	}
	if got := nearChunkAt(x.near(c, cx, cy, 200), cx, cy); got.Source != location.SourceHeld.String() || got.Epoch != pinned {
		t.Fatalf("turning 2: %+v", got)
	}
	h := x.home(c)
	if len(h.Plants) != 1 || !h.Plants[0].Lit {
		t.Fatalf("dimming: the plant %+v", h.Plants)
	}
	// Turning 3: still empty, it goes dark and the backland turns. Nothing is lost.
	x.turn()
	c, s = x.again("alice")
	if l := x.lanternOf(0, s.WorldID); l.Lit || l.Oil != 0 || l.Dimming {
		t.Fatalf("turning 3: %+v", l)
	}
	n = x.near(c, cx, cy, 200)
	if got := nearChunkAt(n, cx, cy); got.Source == location.SourceHeld.String() || got.Epoch != n.Wick.Id {
		t.Fatalf("turning 3: the backland didn't turn: %+v", got)
	}
	var loc string
	if err := x.db.DB.QueryRow("SELECT location FROM homestead_items WHERE id=?", stool).Scan(&loc); err != nil || loc != "storage" {
		t.Fatalf("the stool: %s %v", loc, err)
	}
	h = x.home(c)
	if len(h.Plants) != 0 {
		t.Fatalf("the plant stayed: %+v", h.Plants)
	}
	var archived, seeds int
	if err := x.db.DB.QueryRow("SELECT count(*) FROM homestead_land_archive WHERE homestead_id=? AND kind='homestead_plants'", h.ID).Scan(&archived); err != nil || archived != 1 {
		t.Fatalf("archived: %d %v", archived, err)
	}
	if err := x.db.DB.QueryRow("SELECT COALESCE(SUM(qty),0) FROM item_stacks WHERE location='storage' AND owner=? AND item_def='birch-sapling'", h.ID).Scan(&seeds); err != nil || seeds != 1 {
		t.Fatalf("seed refund: %d %v", seeds, err)
	}
	// Lit again, it holds the land as it is this wick.
	x.lanternOp(c, &s, 0, sx, sy, 200)
	if got := nearChunkAt(x.near(c, cx, cy, 200), cx, cy); got.Source != location.SourceHeld.String() {
		t.Fatalf("relit: %+v", got)
	}
}

// A top-up while dimming takes the warning back.
func TestLotLanternTopUpWhileDimming(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimGate(c, &s, 0)
	x.stack(s.AccountID, "hearth-oil", "", 2)
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	x.turn()
	c, s = x.again("alice")
	x.turn()
	c, s = x.again("alice")
	if l := x.lanternOf(0, s.WorldID); !l.Dimming {
		t.Fatalf("not dimming: %+v", l)
	}
	x.lanternOp(c, &s, 0, sx, sy, 200)
	if l := x.lanternOf(0, s.WorldID); !l.Lit || l.Dimming || l.Oil != 1 {
		t.Fatalf("topped up: %+v", l)
	}
	x.turn()
	c, s = x.again("alice")
	if l := x.lanternOf(0, s.WorldID); !l.Lit || l.Dimming || l.Oil != 0 {
		t.Fatalf("after the top-up's turning: %+v", l)
	}
}

// The server's own chunks always judge lot lanterns (as main.go builds it:
// no chunk source given), so a lapse always reaches Released.
func TestLotLanternHolderRegistered(t *testing.T) {
	a := New(nil, nil, Config{})
	held, ok := a.Config.Epochs.(*store.Chunks)
	if !ok {
		t.Fatalf("epochs %T", a.Config.Epochs)
	}
	if _, ok := held.Holders[lotLanternKind].(lotLanternHolder); !ok {
		t.Fatalf("holders %v", held.Holders)
	}
	// Given chunks keep their own holders and gain the lantern's.
	given := store.NewChunks(nil, nil)
	given.Holders = map[string]store.Holder{"other": lotLanternHolder{}}
	New(nil, nil, Config{Chunks: given, Epochs: given})
	if given.Holders[lotLanternKind] == nil || given.Holders["other"] == nil {
		t.Fatalf("given holders %v", given.Holders)
	}
}
