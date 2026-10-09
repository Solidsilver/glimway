package api

import (
	"fmt"
	"google.golang.org/protobuf/proto"
	"net/http"
	"slices"
	"testing"

	"glimway/content"
	"glimway/server/internal/land"
	"glimway/server/internal/rules"
)

func TestGatheringUnknownDefinitionsRollBack(t *testing.T) {
	for _, source := range []string{"slot", "yield"} {
		t.Run(source, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			axe := x.instance(s.AccountID, "bench-axe", -1, "")
			if source == "slot" {
				if _, err := x.db.DB.Exec("INSERT INTO item_slots(account_id,slot,item_def) VALUES(?,'pocket-1','missing-item')", s.AccountID); err != nil {
					t.Fatal(err)
				}
			} else {
				original := content.GatheringRules.Targets["tree"]
				broken := proto.Clone(original).(*content.GatheringTarget)
				broken.Yields = []*content.GatheringYield{{Item: "missing-item", Min: 1, Max: 1}}
				content.GatheringRules.Targets["tree"] = broken
				t.Cleanup(func() { content.GatheringRules.Targets["tree"] = original })
			}
			x.refresh(c, &s)
			before := s.Snapshot
			condition := count(t, x.db, "SELECT condition FROM item_instances WHERE id=?", axe)
			ledger := count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=?", s.AccountID)
			v := x.opRefreshing(c, &s, "gather", gatherIn(s, "woodland", [2]int{20, 20}, axe, "chop", "tree", "v1"), 500)
			if v.Error.Code != "internal" {
				t.Fatalf("unknown %s definition: %q", source, v.Error.Code)
			}
			x.refresh(c, &s)
			unchanged(t, before, s.Snapshot)
			if count(t, x.db, "SELECT condition FROM item_instances WHERE id=?", axe) != condition || count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=?", s.AccountID) != ledger || count(t, x.db, "SELECT count(*) FROM gathering_caps WHERE account_id=?", s.AccountID) != 0 {
				t.Fatal("failed gathering changed wear, ledger or caps")
			}
		})
	}
}

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

// gatherIn is one gather's fields, standing at a tile of an area (in the
// Wilds, the Tangle unless the fields say otherwise).
func gatherIn(s response, area string, tile [2]int, tool, action, target, visit string) map[string]any {
	f := map[string]any{"tool": tool, "action": action, "target": target, "visitId": visit, "progress": standAt(s, area, tile[0], tile[1])}
	if rules.HomeGate(area) >= 0 {
		f["tile"] = tile
	}
	if area == "wilds" {
		f["region"] = tangleRegion
	}
	return f
}

// inRegion is a wilds gather's fields in another region ("" sends none).
func inRegion(f map[string]any, region string) map[string]any {
	if region == "" {
		delete(f, "region")
	} else {
		f["region"] = region
	}
	return f
}

// packDelta: how each definition's count changed between two reads of the
// pack (stacks, every maker together, and instances).
func packDelta(before, after itemsView) map[string]int {
	count := func(v itemsView) map[string]int {
		n := map[string]int{}
		for _, st := range v.Stacks {
			n[st.ItemDef] += st.Qty
		}
		for _, in := range v.Instances {
			n[in.ItemDef]++
		}
		return n
	}
	a, b := count(before), count(after)
	out := map[string]int{}
	for def, q := range b {
		if q != a[def] {
			out[def] = q - a[def]
		}
	}
	for def, q := range a {
		if _, ok := b[def]; !ok {
			out[def] = -q
		}
	}
	return out
}

// gatheredDelta is a gather's `gathered`, as a pack change.
func gatheredDelta(g []stackView) map[string]int {
	out := map[string]int{}
	for _, st := range g {
		out[st.ItemDef] += st.Qty
	}
	return out
}

// landTiles are a home's tiles of one kind, lit or not, in reading order.
func landTiles(h homeView, kind byte, lit bool) [][2]int {
	lights := connectedLights(placedItems(h), "")
	out := [][2]int{}
	for y := 1; y < int(content.HomeRules.GetLand().GetHeight())-1; y++ {
		for x := 1; x < int(content.HomeRules.GetLand().GetWidth())-1; x++ {
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
		if err := x.db.DB.QueryRow("SELECT world_id FROM players WHERE account_id=?", s.AccountID).Scan(&world); err != nil {
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
	axe := x.instance(s.AccountID, "bench-axe", -1, "")
	here := [2]int{20, 20}

	// Only in the woods: not in the village.
	if x.opRefreshing(c, &s, "gather", gatherIn(s, "village", here, axe, "chop", "tree", "v1"), 409).Error.Code != "cannot-gather-here" {
		t.Fatal("chopped in the village")
	}
	// The tool must suit the target.
	if x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, axe, "break", "tree", "v1"), 409).Error.Code != "wrong-tool" {
		t.Fatal("broke a tree")
	}
	if x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, axe, "break", "boulder", "v1"), 409).Error.Code != "wrong-tool" {
		t.Fatal("broke a boulder with an axe")
	}
	x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, axe, "chop", "nothing", "v1"), 400)

	// A tree in the Tangle: one use off the axe, timber 2–4, and nothing
	// else in the pack changes (no water, no stray yields; in Amberfall
	// the sap rides along, and the delta check keeps the pack honest).
	before := x.items("GET", "/api/items", nil, c, 200).Items
	r := x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, axe, "chop", "tangle-tree", "v1"), 200)
	if got, want := packDelta(before, r.Result.Items), gatheredDelta(r.Result.Gathered); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("the pack changed by %v, the gather said %v", got, want)
	}
	if r.Result.Wear == nil || r.Result.Wear.UsesLeft != 29 {
		t.Fatalf("wear %+v", r.Result.Wear)
	}
	if n := stackQty(r.Result.Items, "timber"); n < 2 || n > 4 || len(r.Result.Gathered) < 1 || r.Result.Gathered[0].ItemDef != "timber" || r.Result.Gathered[0].Qty != n {
		t.Fatalf("timber %d, gathered %+v", n, r.Result.Gathered)
	}
	// The woods by the village give too.
	pick := x.instance(s.AccountID, "bench-pick", -1, "")
	before = x.items("GET", "/api/items", nil, c, 200).Items
	r = x.opRefreshing(c, &s, "gather", gatherIn(s, "woodland", here, pick, "break", "boulder", "w1"), 200)
	if n := stackQty(r.Result.Items, "stone"); n < 2 || n > 4 {
		t.Fatal("stone", n)
	}
	if got, want := packDelta(before, r.Result.Items), gatheredDelta(r.Result.Gathered); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("the pack changed by %v, the gather said %v", got, want)
	}
	// Each kind of place has its own pieces: no hives or lamp-stones in the
	// woods, no ash in the Tangle, no willow at home.
	spade := x.instance(s.AccountID, "bench-spade", -1, "")
	for _, c2 := range []struct{ area, tool, action, target string }{
		{"woodland", spade, "dig", "hollow-tree"},
		{"woodland", pick, "break", "lamp-stone"},
		{"woodland", axe, "chop", "iron-oak"},
		{"wilds", axe, "chop", "ash"},
	} {
		if x.opRefreshing(c, &s, "gather", gatherIn(s, c2.area, here, c2.tool, c2.action, c2.target, "w1"), 409).Error.Code != "cannot-gather-here" {
			t.Fatal("offered", c2)
		}
	}

	// An heirloom blunts at zero and then stops working.
	brack := x.instance(s.AccountID, "brack-felling-axe", 3, "")
	if r = x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, brack, "chop", "tangle-tree", "v1"), 200); r.Result.Wear == nil || r.Result.Wear.State != "blunt" {
		t.Fatalf("brack %+v", r.Result.Wear)
	}
	if x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, brack, "chop", "tangle-tree", "v1"), 409).Error.Code != "tool-blunt" {
		t.Fatal("chopped with a blunt axe")
	}
	// A cheap tool breaks at zero and is gone.
	cheap := x.instance(s.AccountID, "bench-axe", 3, "")
	if r = x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, cheap, "chop", "tangle-tree", "v1"), 200); r.Result.Wear == nil || !r.Result.Wear.Broke {
		t.Fatalf("cheap %+v", r.Result.Wear)
	}
	x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, cheap, "chop", "tangle-tree", "v1"), 404)

	// A refused gather wears nothing.
	if left := findInstance(x.items("GET", "/api/items", nil, c, 200).Items, axe).UsesLeft; left != 29 {
		t.Fatal("refusals wore the axe", left)
	}
	x.conserved(s.AccountID)
}

func TestGatheringInstancedYieldsAndReplay(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	axe := x.instance(s.AccountID, "brack-felling-axe", -1, "")
	here := [2]int{20, 20}
	// Ash now and then gives a green-ash haft: a fitting, so an instance.
	// A haft is a 15% roll seeded by the (random) account, so one day's chops
	// miss it about one run in 130; chop on for up to five days.
	hafts := 0
	for d := 0; d < 5 && hafts == 0; d++ {
		for i := 0; i < int(content.GatheringRules.GetCaps().GetDay().GetChop()) && hafts == 0; i++ {
			r := x.opRefreshing(c, &s, "gather", gatherIn(s, "woodland", here, axe, "chop", "ash", fmt.Sprintf("d%dv%d", d, i/8)), 200)
			for _, id := range r.Result.Created {
				if findInstance(r.Result.Items, id).ItemDef == "green-ash-haft" {
					hafts++
				}
			}
		}
		x.now.Add(24 * 60 * 60)
	}
	if hafts == 0 {
		t.Fatal("no haft from five days of ash")
	}
	x.conserved(s.AccountID)

	// The same key replays the same gather: no second wear, no second yield.
	x.refresh(c, &s)
	b := body(s, "gather-replay", gatherIn(s, "woodland", here, axe, "chop", "tree", "w"))
	first := x.items("POST", "/api/items/gather", b, c, 200)
	again := x.items("POST", "/api/items/gather", b, c, 200)
	if stackQty(first.Result.Items, "timber") != stackQty(again.Result.Items, "timber") || findInstance(again.Result.Items, axe).Condition != findInstance(first.Result.Items, axe).Condition {
		t.Fatal("a replay gathered twice")
	}
	x.conserved(s.AccountID)
}

func TestGatheringCaps(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	axe := x.instance(s.AccountID, "brack-felling-axe", 900, "")
	pick := x.instance(s.AccountID, "bench-pick", -1, "")
	here := [2]int{20, 20}
	chop := func(visit string, status int) itemsResponse {
		return x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, axe, "chop", "tangle-tree", visit), status)
	}
	caps := content.GatheringRules.GetCaps()

	// Eight trees a visit; the ninth is the wood's soft line, and wears nothing.
	for i := 0; i < int(caps.GetVisit().GetChop()); i++ {
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
	x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, pick, "break", "boulder", "first"), 200)
	// Another area is another visit, even with the same visit id.
	x.opRefreshing(c, &s, "gather", gatherIn(s, "woodland", here, axe, "chop", "tree", "first"), 200)
	// Back in the Tangle with a new visit: the trees give again.
	done := int(caps.GetVisit().GetChop()) + 1
	chop("second", 200)
	done++
	// Up to the day's cap, a visit at a time.
	for v := 3; done < int(caps.GetDay().GetChop()); v++ {
		for j := 0; j < int(caps.GetVisit().GetChop()) && done < int(caps.GetDay().GetChop()); j++ {
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
	x.opRefreshing(c, &s, "gather", gatherIn(s, "wilds", here, axe, "chop", "tangle-tree", string(make([]byte, 65))), 400)
	x.conserved(s.AccountID)
}

func TestGatheringHomeLandKeepsWhatLamplightHolds(t *testing.T) {
	x := newRig(t)
	c, s, h := x.homePlayer("alice")
	area := fmt.Sprintf("home:%d", h.Gate)
	axe := x.instance(s.AccountID, "bench-axe", -1, "")
	pick := x.instance(s.AccountID, "bench-pick", -1, "")
	spade := x.instance(s.AccountID, "bench-spade", -1, "")
	litTree := landTiles(h, land.Tree, true)[0]
	darkTree := landTiles(h, land.Tree, false)[0]
	litBoulder := landTiles(h, land.Boulder, true)[0]

	// The land is the server's own: the target must be what stands there,
	// and you must stand by it.
	if x.opRefreshing(c, &s, "gather", gatherIn(s, area, litTree, pick, "break", "boulder", "h1"), 409).Error.Code != "cannot-gather-here" {
		t.Fatal("broke a tree as a boulder")
	}
	// Reach is measured as the client measures it: from just above the
	// hero's feet to the foot of the piece. Straight south, the client
	// prompts at 36 px and lets a swing finish at 46; the server takes both.
	south := func(px int) map[string]any {
		f := gatherIn(s, area, litTree, axe, "chop", "tree", "h1")
		doc := s.State
		doc.Area = area
		doc.Position = rules.Position{X: float64(litTree[0]*16 + 8), Y: float64((litTree[1]+1)*16 + 8 + px)}
		f["progress"] = doc
		return f
	}
	if x.opRefreshing(c, &s, "gather", south(52), 409).Error.Code != "too-far-away" {
		t.Fatal("chopped from afar")
	}

	// Inside lamplight a felled tree stays a stump.
	r := x.opRefreshing(c, &s, "gather", south(46), 200)
	if r.Result.Land == nil || !r.Result.Land.Stump || r.Result.Land.Tile != litTree {
		t.Fatalf("land %+v", r.Result.Land)
	}
	if h = x.home(c); !slices.Contains(h.Stumps, litTree) {
		t.Fatal("stump not kept", h.Stumps)
	}
	if x.opRefreshing(c, &s, "gather", gatherIn(s, area, litTree, axe, "chop", "tree", "h1"), 409).Error.Code != "cannot-gather-here" {
		t.Fatal("felled a stump")
	}
	// Reaching from the edge of the client's prompt works as well.
	if x.opRefreshing(c, &s, "gather", south(36), 409).Error.Code != "cannot-gather-here" {
		t.Fatal("the stump is no tree, from any distance in reach")
	}
	// Digging the stump leaves open ground (and turncap spawn).
	r = x.opRefreshing(c, &s, "gather", gatherIn(s, area, litTree, spade, "dig", "stump", "h1"), 200)
	if r.Result.Land == nil || !r.Result.Land.Cleared || stackQty(r.Result.Items, "turncap-spawn") < 1 {
		t.Fatalf("dig %+v", r.Result.Land)
	}
	if h = x.home(c); slices.Contains(h.Stumps, litTree) || !slices.Contains(h.Cleared, litTree) {
		t.Fatal("dug stump", h.Stumps, h.Cleared)
	}
	// A broken boulder inside lamplight leaves open ground.
	r = x.opRefreshing(c, &s, "gather", gatherIn(s, area, litBoulder, pick, "break", "boulder", "h1"), 200)
	if r.Result.Land == nil || !r.Result.Land.Cleared || stackQty(r.Result.Items, "stone") < 2 {
		t.Fatalf("boulder %+v", r.Result.Land)
	}
	if h = x.home(c); !slices.Contains(h.Cleared, litBoulder) {
		t.Fatal("boulder kept", h.Cleared)
	}

	// The unlit edge regrows like the Tangle: nothing is kept, and the
	// stump drawn there this visit can still be dug.
	r = x.opRefreshing(c, &s, "gather", gatherIn(s, area, darkTree, axe, "chop", "tree", "h1"), 200)
	if r.Result.Land != nil || stackQty(r.Result.Items, "timber") < 4 {
		t.Fatalf("dark land %+v", r.Result.Land)
	}
	if r = x.opRefreshing(c, &s, "gather", gatherIn(s, area, darkTree, spade, "dig", "stump", "h1"), 200); r.Result.Land != nil {
		t.Fatal("dark stump kept")
	}
	if h = x.home(c); slices.Contains(h.Stumps, darkTree) || slices.Contains(h.Cleared, darkTree) {
		t.Fatal("the edge remembered", h.Stumps, h.Cleared)
	}

	// Someone else's land is only for looking at.
	bc, b := x.member("bob", s.WorldID)
	x.claimGate(bc, &b, 1-h.Gate)
	bobAxe := x.instance(x.account("bob"), "bench-axe", -1, "")
	if x.opRefreshing(bc, &b, "gather", gatherIn(b, area, darkTree, bobAxe, "chop", "tree", "b1"), 409).Error.Code != "not-your-land" {
		t.Fatal("chopped a neighbour's tree")
	}
	cc, cs := x.member("carol", s.WorldID)
	carolAxe := x.instance(x.account("carol"), "bench-axe", -1, "")
	if x.opRefreshing(cc, &cs, "gather", gatherIn(cs, area, darkTree, carolAxe, "chop", "tree", "c1"), 409).Error.Code != "not-your-land" {
		t.Fatal("chopped with no deed")
	}
	x.conserved(s.AccountID)
	x.conserved(x.account("bob"))
}

func TestPlantingAtHome(t *testing.T) {
	x := newRig(t)
	c, s, h := x.homePlayer("alice")
	area := fmt.Sprintf("home:%d", h.Gate)
	x.stack(s.AccountID, "birch-sapling", "", 2)
	x.stack(s.AccountID, "wild-thyme", "", 2)
	plant := func(def string, tile [2]int, at [2]int, status int) itemsResponse {
		return x.opRefreshing(c, &s, "plant", map[string]any{"itemDef": def, "tile": tile, "progress": standAt(s, area, at[0], at[1])}, status)
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
	if x.opRefreshing(c, &s, "plant", map[string]any{"itemDef": "birch-sapling", "tile": litTile, "progress": standAt(s, "commons", litTile[0], litTile[1])}, 409).Error.Code != "cannot-plant-here" {
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
	x.stack(x.account("bob"), "wild-thyme", "", 1)
	if x.opRefreshing(bc, &b, "plant", map[string]any{"itemDef": "wild-thyme", "tile": litTile, "progress": standAt(b, area, litTile[0], litTile[1])}, 409).Error.Code != "not-your-land" {
		t.Fatal("planted on a neighbour's land")
	}
	x.conserved(s.AccountID)
	x.conserved(x.account("bob"))
}

func TestPlantingNeverStacksIsCappedAndBlocksPlacement(t *testing.T) {
	x := newRig(t)
	c, s, h := x.homePlayer("alice")
	area := fmt.Sprintf("home:%d", h.Gate)
	x.seedAssets(s.AccountID)
	x.refresh(c, &s)
	x.stack(s.AccountID, "wild-thyme", "", int(content.GatheringRules.GetPlantsPerHome())+5)
	plant := func(tile [2]int, status int) itemsResponse {
		t.Helper()
		return x.opRefreshing(c, &s, "plant", map[string]any{"itemDef": "wild-thyme", "tile": tile, "progress": standAt(s, area, tile[0], tile[1])}, status)
	}
	unique := func(h homeView) {
		t.Helper()
		seen := map[[2]int]bool{}
		for _, p := range h.Plants {
			if seen[[2]int{p.X, p.Y}] {
				t.Fatal("two plants on one tile", h.Plants)
			}
			seen[[2]int{p.X, p.Y}] = true
		}
	}

	// Nothing is set out on top of something growing.
	lit := litSpots(h)[0]
	plant(lit, 200)
	stool := x.homeOpRefreshing(c, &s, "buy", map[string]any{"itemDef": "wooden-stool"}, 200).Result.ItemID
	if x.homeOpRefreshing(c, &s, "place", map[string]any{"itemId": stool, "scene": "outdoor", "x": lit[0], "y": lit[1], "rotation": 0}, 409).Error.Code != "plant-in-the-way" {
		t.Fatal("a stool on a sapling")
	}

	// Silas clearing a kept stump leaves no stump behind in the data.
	axe := x.instance(s.AccountID, "bench-axe", -1, "")
	tree := landTiles(h, land.Tree, true)[0]
	x.opRefreshing(c, &s, "gather", gatherIn(s, area, tree, axe, "chop", "tree", "h1"), 200)
	x.homeOpRefreshing(c, &s, "clear", map[string]any{"x": tree[0], "y": tree[1]}, 200)
	if count(t, x.db, "SELECT count(*) FROM homestead_stumps WHERE x=? AND y=?", tree[0], tree[1]) != 0 {
		t.Fatal("a cleared tile kept its stump row")
	}

	// A plant set where another one started out: they never share a tile.
	h = x.home(c)
	open := plantGround(h)
	var start [2]int
	for _, tl := range landTiles(h, land.Grass, false) {
		if open[tl] && open[[2]int{tl[0] + 1, tl[1]}] && open[[2]int{tl[0] - 1, tl[1]}] && open[[2]int{tl[0], tl[1] + 1}] && open[[2]int{tl[0], tl[1] - 1}] {
			start = tl
			break
		}
	}
	plant(start, 200)
	for day := 0; day < 10; day++ {
		x.now.Add(86400)
		if h = x.home(c); !slices.ContainsFunc(h.Plants, func(p homePlantView) bool { return p.X == start[0] && p.Y == start[1] }) {
			break
		}
	}
	if slices.ContainsFunc(h.Plants, func(p homePlantView) bool { return p.X == start[0] && p.Y == start[1] }) {
		t.Fatal("the thyme never stepped off")
	}
	plant(start, 200)
	for day := 0; day < 15; day++ {
		x.now.Add(86400)
		unique(x.home(c))
	}

	// A home tends so many plants; past that the ground is full.
	// Each read re-walks the older plants against today's ground, so a new
	// plant can move where they stand: read the home again before each one.
	h = x.home(c)
	open = plantGround(h)
	for y := 1; y < int(content.HomeRules.GetLand().GetHeight())-1 && len(h.Plants) < int(content.GatheringRules.GetPlantsPerHome()); y++ {
		for x2 := 1; x2 < int(content.HomeRules.GetLand().GetWidth())-1 && len(h.Plants) < int(content.GatheringRules.GetPlantsPerHome()); x2 += 3 {
			tl := [2]int{x2, y}
			if !open[tl] || slices.ContainsFunc(h.Plants, func(p homePlantView) bool { return p.X == tl[0] && p.Y == tl[1] }) {
				continue
			}
			plant(tl, 200)
			h = x.home(c)
		}
	}
	h = x.home(c)
	if len(h.Plants) != int(content.GatheringRules.GetPlantsPerHome()) {
		t.Fatal("plants", len(h.Plants))
	}
	unique(h)
	for tl := range open {
		if !slices.ContainsFunc(h.Plants, func(p homePlantView) bool { return p.X == tl[0] && p.Y == tl[1] }) {
			if plant(tl, 409).Error.Code != "land-blocked" {
				t.Fatal("planted past the cap")
			}
			break
		}
	}
	x.conserved(s.AccountID)
}

// A plant set where another one started out: the walk never brings the
// first back onto it (plantsOf counts who stands where).
func TestPlantsNeverShareATile(t *testing.T) {
	h := homeView{Gate: 0, LandSeed: 1234, Items: []homeInstance{}}
	open := plantGround(h)
	var r [2]int
	for _, tl := range landTiles(h, land.Grass, false) {
		if open[tl] && open[[2]int{tl[0] + 1, tl[1]}] && open[[2]int{tl[0] - 1, tl[1]}] && open[[2]int{tl[0], tl[1] + 1}] && open[[2]int{tl[0], tl[1] - 1}] {
			r = tl
			break
		}
	}
	const day0 = int64(20000)
	at := func(day int64) int64 { return day*86400 + 3600 }
	// A first plant whose walk leaves its tile on day `off` and comes back on day `back`.
	var q homePlantView
	var off, back int64
	for i := 0; i < 500 && back == 0; i++ {
		q = homePlantView{ID: fmt.Sprintf("q%d", i), ItemDef: "wild-thyme", X: r[0], Y: r[1], PlantedDay: day0}
		off = 0
		for d := day0 + 1; d <= day0+20; d++ {
			p := plantsOf(h, []homePlantView{q}, at(d))[0]
			here := [2]int{p.X, p.Y} == r
			if !here && off == 0 {
				off = d
			}
			if here && off != 0 {
				back = d
				break
			}
		}
	}
	if back == 0 {
		t.Fatal("no walk that comes back")
	}
	// The second goes in on the day the first stepped off, and (alone)
	// would still be standing there the day the first comes back.
	var p homePlantView
	for i := 0; i < 500 && p.ID == ""; i++ {
		c := homePlantView{ID: fmt.Sprintf("p%d", i), ItemDef: "wild-thyme", X: r[0], Y: r[1], PlantedDay: off}
		if got := plantsOf(h, []homePlantView{c}, at(back))[0]; got.X == r[0] && got.Y == r[1] {
			p = c
		}
	}
	if p.ID == "" {
		t.Fatal("no second plant that stays")
	}
	for d := off; d <= back+5; d++ {
		got := plantsOf(h, []homePlantView{q, p}, at(d))
		if got[0].X == got[1].X && got[0].Y == got[1].Y {
			t.Fatalf("day %d: two plants on %d,%d", d-day0, got[0].X, got[0].Y)
		}
	}
}
