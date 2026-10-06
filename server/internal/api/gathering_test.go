package api

import (
	"fmt"
	"net/http"
	"slices"
	"testing"

	"fingersnap/content"
	"fingersnap/server/internal/land"
	"fingersnap/server/internal/rules"
)

// Gathering (docs/items/crafting-and-repair.md, "Gathering"): tool wear,
// yields, the caps per area visit and per day, the drift on home land
// (a stump stays inside lamplight, the unlit edge regrows), and planting.

// standAt is the progress of a player standing on (or beside) a tile.
func standAt(s response, area string, tx, ty int) rules.State {
	doc := s.State
	doc.Area = area
	doc.Position = rules.Position{X: float64(tx*16 + 8), Y: float64(ty*16 + 12)}
	return doc
}

// gatherIn is one gather's fields, standing at a tile of an area.
func gatherIn(s response, area string, tile [2]int, tool, action, target, visit string) map[string]any {
	f := map[string]any{"tool": tool, "action": action, "target": target, "visitId": visit, "progress": standAt(s, area, tile[0], tile[1])}
	if rules.HomeGate(area) >= 0 {
		f["tile"] = tile
	}
	return f
}

// landTiles are a home's tiles of one kind, lit or not, in reading order.
func landTiles(h homeView, kind byte, lit bool) [][2]int {
	lights := connectedLights(placedItems(h), "")
	out := [][2]int{}
	for y := 1; y < content.HomeRules.Land.Height-1; y++ {
		for x := 1; x < content.HomeRules.Land.Width-1; x++ {
			if landKind(h, x, y) == kind && land.Lit(lights, x, y) == lit {
				out = append(out, [2]int{x, y})
			}
		}
	}
	return out
}

// homePlayer is a new player (in a world of their own) with a home whose
// land has lit and unlit trees and a lit boulder. Land is seeded by the
// world and the gate, and a new world's lane offers the first gates only,
// so this tries a few worlds.
func (x *rig) homePlayer(name string) (*http.Cookie, response, homeView) {
	x.t.Helper()
	for i := 0; i < 40; i++ {
		id := fmt.Sprintf("%s-%d", name, i)
		c, s := x.ready(id)
		var world string
		if err := x.db.DB.QueryRow("SELECT world_id FROM players WHERE habitica_id=?", id).Scan(&world); err != nil {
			x.t.Fatal(err)
		}
		for gate := 0; gate < 2; gate++ {
			h := homeView{Gate: gate, LandSeed: land.Seed(world, gate, content.HomeRules.Land)}
			if len(landTiles(h, land.Tree, true)) > 0 && len(landTiles(h, land.Tree, false)) > 0 && len(landTiles(h, land.Boulder, true)) > 0 {
				return c, s, x.claimGate(c, &s, gate)
			}
		}
	}
	x.t.Fatal("no world with lit trees, unlit trees and a lit boulder")
	return nil, response{}, homeView{}
}

func TestGatheringWearAndYields(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	axe := x.instance(s.HabiticaID, "bench-axe", -1, "")
	here := [2]int{20, 20}

	// Only in the woods: not in the village.
	if x.op(c, &s, "gather", gatherIn(s, "village", here, axe, "chop", "tree", "v1"), 409).Error.Code != "cannot-gather-here" {
		t.Fatal("chopped in the village")
	}
	// The tool must suit the target.
	if x.op(c, &s, "gather", gatherIn(s, "wilds", here, axe, "break", "tree", "v1"), 409).Error.Code != "wrong-tool" {
		t.Fatal("broke a tree")
	}
	if x.op(c, &s, "gather", gatherIn(s, "wilds", here, axe, "break", "boulder", "v1"), 409).Error.Code != "wrong-tool" {
		t.Fatal("broke a boulder with an axe")
	}
	x.op(c, &s, "gather", gatherIn(s, "wilds", here, axe, "chop", "nothing", "v1"), 400)

	// A tree in the Tangle: one use off the axe, timber 2–4.
	r := x.op(c, &s, "gather", gatherIn(s, "wilds", here, axe, "chop", "tree", "v1"), 200)
	if r.Result.Wear == nil || r.Result.Wear.UsesLeft != 29 {
		t.Fatalf("wear %+v", r.Result.Wear)
	}
	if n := stackQty(r.Result.Items, "timber"); n < 2 || n > 4 || len(r.Result.Gathered) != 1 || r.Result.Gathered[0].Qty != n {
		t.Fatalf("timber %d, gathered %+v", n, r.Result.Gathered)
	}
	// The woods by the village give too.
	pick := x.instance(s.HabiticaID, "bench-pick", -1, "")
	r = x.op(c, &s, "gather", gatherIn(s, "woodland", here, pick, "break", "boulder", "w1"), 200)
	if n := stackQty(r.Result.Items, "stone"); n < 2 || n > 4 {
		t.Fatal("stone", n)
	}

	// An heirloom blunts at zero and then stops working.
	brack := x.instance(s.HabiticaID, "brack-felling-axe", 3, "")
	if r = x.op(c, &s, "gather", gatherIn(s, "wilds", here, brack, "chop", "tree", "v1"), 200); r.Result.Wear == nil || r.Result.Wear.State != "blunt" {
		t.Fatalf("brack %+v", r.Result.Wear)
	}
	if x.op(c, &s, "gather", gatherIn(s, "wilds", here, brack, "chop", "tree", "v1"), 409).Error.Code != "tool-blunt" {
		t.Fatal("chopped with a blunt axe")
	}
	// A cheap tool breaks at zero and is gone.
	cheap := x.instance(s.HabiticaID, "bench-axe", 3, "")
	if r = x.op(c, &s, "gather", gatherIn(s, "wilds", here, cheap, "chop", "tree", "v1"), 200); r.Result.Wear == nil || !r.Result.Wear.Broke {
		t.Fatalf("cheap %+v", r.Result.Wear)
	}
	x.op(c, &s, "gather", gatherIn(s, "wilds", here, cheap, "chop", "tree", "v1"), 404)

	// A refused gather wears nothing.
	if left := findInstance(x.items("GET", "/api/items", nil, c, 200).Items, axe).UsesLeft; left != 29 {
		t.Fatal("refusals wore the axe", left)
	}
	x.conserved(s.HabiticaID)
}

func TestGatheringInstancedYieldsAndReplay(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	axe := x.instance(s.HabiticaID, "brack-felling-axe", -1, "")
	here := [2]int{20, 20}
	// Ash now and then gives a green-ash haft: a fitting, so an instance.
	hafts := 0
	for i := 0; i < content.GatheringRules.Caps.Day.Chop && hafts == 0; i++ {
		r := x.op(c, &s, "gather", gatherIn(s, "wilds", here, axe, "chop", "ash", fmt.Sprintf("v%d", i/8)), 200)
		for _, id := range r.Result.Created {
			if findInstance(r.Result.Items, id).ItemDef == "green-ash-haft" {
				hafts++
			}
		}
	}
	if hafts == 0 {
		t.Fatal("no haft from a day of ash")
	}
	x.conserved(s.HabiticaID)

	// The same key replays the same gather: no second wear, no second yield.
	x.refresh(c, &s)
	b := body(s, "gather-replay", gatherIn(s, "woodland", here, axe, "chop", "tree", "w"))
	first := x.items("POST", "/api/items/gather", b, c, 200)
	again := x.items("POST", "/api/items/gather", b, c, 200)
	if stackQty(first.Result.Items, "timber") != stackQty(again.Result.Items, "timber") || findInstance(again.Result.Items, axe).Condition != findInstance(first.Result.Items, axe).Condition {
		t.Fatal("a replay gathered twice")
	}
	x.conserved(s.HabiticaID)
}

func TestGatheringCaps(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	axe := x.instance(s.HabiticaID, "brack-felling-axe", 900, "")
	pick := x.instance(s.HabiticaID, "bench-pick", -1, "")
	here := [2]int{20, 20}
	chop := func(visit string, status int) itemsResponse {
		return x.op(c, &s, "gather", gatherIn(s, "wilds", here, axe, "chop", "tree", visit), status)
	}
	caps := content.GatheringRules.Caps

	// Eight trees a visit; the ninth is the wood's soft line, and wears nothing.
	for i := 0; i < caps.Visit.Chop; i++ {
		chop("first", 200)
	}
	before := findInstance(x.items("GET", "/api/items", nil, c, 200).Items, axe).Condition
	if chop("first", 409).Error.Code != "gathered-enough" {
		t.Fatal("ninth tree")
	}
	if findInstance(x.items("GET", "/api/items", nil, c, 200).Items, axe).Condition != before {
		t.Fatal("the capped swing wore the axe")
	}
	// Each kind of work counts on its own: the boulders still give.
	x.op(c, &s, "gather", gatherIn(s, "wilds", here, pick, "break", "boulder", "first"), 200)
	// Another area is another visit, even with the same visit id.
	x.op(c, &s, "gather", gatherIn(s, "woodland", here, axe, "chop", "tree", "first"), 200)
	// Back in the Tangle with a new visit: the trees give again.
	done := caps.Visit.Chop + 1
	chop("second", 200)
	done++
	// Up to the day's cap, a visit at a time.
	for v := 3; done < caps.Day.Chop; v++ {
		for j := 0; j < caps.Visit.Chop && done < caps.Day.Chop; j++ {
			chop(fmt.Sprintf("visit-%d", v), 200)
			done++
		}
	}
	if chop("fresh", 409).Error.Code != "gathered-enough" {
		t.Fatal("past the day's cap")
	}
	// A new day (UTC), and the woods give again.
	x.now.Add(86400)
	chop("tomorrow", 200)
	x.op(c, &s, "gather", gatherIn(s, "wilds", here, axe, "chop", "tree", string(make([]byte, 65))), 400)
	x.conserved(s.HabiticaID)
}

func TestGatheringHomeLandKeepsWhatLamplightHolds(t *testing.T) {
	x := newRig(t)
	c, s, h := x.homePlayer("alice")
	area := fmt.Sprintf("home:%d", h.Gate)
	axe := x.instance(s.HabiticaID, "bench-axe", -1, "")
	pick := x.instance(s.HabiticaID, "bench-pick", -1, "")
	spade := x.instance(s.HabiticaID, "bench-spade", -1, "")
	litTree := landTiles(h, land.Tree, true)[0]
	darkTree := landTiles(h, land.Tree, false)[0]
	litBoulder := landTiles(h, land.Boulder, true)[0]

	// The land is the server's own: the target must be what stands there,
	// and you must stand by it.
	if x.op(c, &s, "gather", gatherIn(s, area, litTree, pick, "break", "boulder", "h1"), 409).Error.Code != "cannot-gather-here" {
		t.Fatal("broke a tree as a boulder")
	}
	far := gatherIn(s, area, litTree, axe, "chop", "tree", "h1")
	far["progress"] = standAt(s, area, litTree[0]+6, litTree[1])
	if x.op(c, &s, "gather", far, 409).Error.Code != "too-far-away" {
		t.Fatal("chopped from afar")
	}

	// Inside lamplight a felled tree stays a stump.
	r := x.op(c, &s, "gather", gatherIn(s, area, litTree, axe, "chop", "tree", "h1"), 200)
	if r.Result.Land == nil || !r.Result.Land.Stump || r.Result.Land.Tile != litTree {
		t.Fatalf("land %+v", r.Result.Land)
	}
	if h = x.home(c); !slices.Contains(h.Stumps, litTree) {
		t.Fatal("stump not kept", h.Stumps)
	}
	if x.op(c, &s, "gather", gatherIn(s, area, litTree, axe, "chop", "tree", "h1"), 409).Error.Code != "cannot-gather-here" {
		t.Fatal("felled a stump")
	}
	// Digging the stump leaves open ground (and turncap spawn).
	r = x.op(c, &s, "gather", gatherIn(s, area, litTree, spade, "dig", "stump", "h1"), 200)
	if r.Result.Land == nil || !r.Result.Land.Cleared || stackQty(r.Result.Items, "turncap-spawn") < 1 {
		t.Fatalf("dig %+v", r.Result.Land)
	}
	if h = x.home(c); slices.Contains(h.Stumps, litTree) || !slices.Contains(h.Cleared, litTree) {
		t.Fatal("dug stump", h.Stumps, h.Cleared)
	}
	// A broken boulder inside lamplight leaves open ground.
	r = x.op(c, &s, "gather", gatherIn(s, area, litBoulder, pick, "break", "boulder", "h1"), 200)
	if r.Result.Land == nil || !r.Result.Land.Cleared || stackQty(r.Result.Items, "stone") < 2 {
		t.Fatalf("boulder %+v", r.Result.Land)
	}
	if h = x.home(c); !slices.Contains(h.Cleared, litBoulder) {
		t.Fatal("boulder kept", h.Cleared)
	}

	// The unlit edge regrows like the Tangle: nothing is kept, and the
	// stump drawn there this visit can still be dug.
	r = x.op(c, &s, "gather", gatherIn(s, area, darkTree, axe, "chop", "tree", "h1"), 200)
	if r.Result.Land != nil || stackQty(r.Result.Items, "timber") < 4 {
		t.Fatalf("dark land %+v", r.Result.Land)
	}
	if r = x.op(c, &s, "gather", gatherIn(s, area, darkTree, spade, "dig", "stump", "h1"), 200); r.Result.Land != nil {
		t.Fatal("dark stump kept")
	}
	if h = x.home(c); slices.Contains(h.Stumps, darkTree) || slices.Contains(h.Cleared, darkTree) {
		t.Fatal("the edge remembered", h.Stumps, h.Cleared)
	}

	// Someone else's land is only for looking at.
	bc, b := x.member("bob", s.WorldID)
	x.claimGate(bc, &b, 1-h.Gate)
	bobAxe := x.instance("bob", "bench-axe", -1, "")
	if x.op(bc, &b, "gather", gatherIn(b, area, darkTree, bobAxe, "chop", "tree", "b1"), 409).Error.Code != "not-your-land" {
		t.Fatal("chopped a neighbour's tree")
	}
	cc, cs := x.member("carol", s.WorldID)
	carolAxe := x.instance("carol", "bench-axe", -1, "")
	if x.op(cc, &cs, "gather", gatherIn(cs, area, darkTree, carolAxe, "chop", "tree", "c1"), 409).Error.Code != "not-your-land" {
		t.Fatal("chopped with no deed")
	}
	x.conserved(s.HabiticaID)
	x.conserved("bob")
}

func TestPlantingAtHome(t *testing.T) {
	x := newRig(t)
	c, s, h := x.homePlayer("alice")
	area := fmt.Sprintf("home:%d", h.Gate)
	x.stack(s.HabiticaID, "birch-sapling", "", 2)
	x.stack(s.HabiticaID, "wild-thyme", "", 2)
	plant := func(def string, tile [2]int, at [2]int, status int) itemsResponse {
		return x.op(c, &s, "plant", map[string]any{"itemDef": def, "tile": tile, "progress": standAt(s, area, at[0], at[1])}, status)
	}

	litTile := litSpots(h)[0]
	var darkTile [2]int
	for _, t := range landTiles(h, land.Grass, false) {
		// Room to wander: open grass all round.
		if landKind(h, t[0]+1, t[1]) == land.Grass && landKind(h, t[0]-1, t[1]) == land.Grass && landKind(h, t[0], t[1]+1) == land.Grass && landKind(h, t[0], t[1]-1) == land.Grass {
			darkTile = t
			break
		}
	}
	if darkTile == [2]int{} {
		t.Fatal("no open dark ground")
	}

	// Only seeds, only open ground, only beside you, only at home.
	if plant("timber", litTile, litTile, 400).Error.Code != "not-a-seed" {
		t.Fatal("planted timber")
	}
	if plant("birch-sapling", landTiles(h, land.Tree, true)[0], landTiles(h, land.Tree, true)[0], 409).Error.Code != "land-blocked" {
		t.Fatal("planted in a tree")
	}
	if plant("birch-sapling", litTile, [2]int{litTile[0] + 5, litTile[1]}, 409).Error.Code != "too-far-away" {
		t.Fatal("planted from afar")
	}
	if x.op(c, &s, "plant", map[string]any{"itemDef": "birch-sapling", "tile": litTile, "progress": standAt(s, "commons", litTile[0], litTile[1])}, 409).Error.Code != "cannot-plant-here" {
		t.Fatal("planted in the Commons")
	}

	// Inside lamplight a plant stays where it was put.
	r := plant("birch-sapling", litTile, litTile, 200)
	if r.Result.Plant == nil || !r.Result.Plant.Lit || r.Result.Plant.ItemDef != "birch-sapling" || stackQty(r.Result.Items, "birch-sapling") != 1 {
		t.Fatalf("plant %+v", r.Result.Plant)
	}
	if plant("birch-sapling", litTile, litTile, 409).Error.Code != "land-blocked" {
		t.Fatal("two plants on one tile")
	}
	// Outside it wanders a little each day, never far.
	if r = plant("wild-thyme", darkTile, darkTile, 200); r.Result.Plant == nil || r.Result.Plant.Lit {
		t.Fatalf("dark plant %+v", r.Result.Plant)
	}
	moved := false
	for day := 0; day < 10; day++ {
		x.now.Add(86400)
		h = x.home(c)
		if len(h.Plants) != 2 {
			t.Fatal("plants", h.Plants)
		}
		for _, p := range h.Plants {
			switch p.ItemDef {
			case "birch-sapling":
				if [2]int{p.X, p.Y} != litTile {
					t.Fatal("a lit plant wandered", p)
				}
			case "wild-thyme":
				if abs(p.X-darkTile[0]) > plantWanderReach || abs(p.Y-darkTile[1]) > plantWanderReach || landKind(h, p.X, p.Y) != land.Grass {
					t.Fatal("wandered too far, or into something", p)
				}
				moved = moved || [2]int{p.X, p.Y} != darkTile
			}
		}
		// Reading the land twice the same day finds it the same: reads never write.
		if again := x.home(c); !slices.Equal(again.Plants, h.Plants) {
			t.Fatal("the land shifted between reads", again.Plants, h.Plants)
		}
	}
	if !moved {
		t.Fatal("ten days and the thyme never wandered")
	}

	// A visitor sees the plants too, and can't plant.
	bc, b := x.member("bob", s.WorldID)
	x.claimGate(bc, &b, 1-h.Gate)
	if v := x.exp("GET", fmt.Sprintf("/api/homestead/gate/%d", h.Gate), nil, bc, 200); len(v.Home.Plants) != 2 {
		t.Fatal("visitor sees", v.Home.Plants)
	}
	x.stack("bob", "wild-thyme", "", 1)
	if x.op(bc, &b, "plant", map[string]any{"itemDef": "wild-thyme", "tile": litTile, "progress": standAt(b, area, litTile[0], litTile[1])}, 409).Error.Code != "not-your-land" {
		t.Fatal("planted on a neighbour's land")
	}
	x.conserved(s.HabiticaID)
	x.conserved("bob")
}
