package api

import (
	"fmt"
	"testing"

	"fingersnap/content"
)

// Tests for gathering: caps (visit & day), yields, tool wear,
// regrowth drift rules (homestead stumps stay inside lamplight), and planting.

func TestGatheringWearAndYields(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("gathering-wear-user")
	axe := x.instance(s.HabiticaID, "bench-axe", -1, "")

	// 1. Gather a tree in the Wilds (area: "wilds")
	r := x.op(c, &s, "gather", map[string]any{
		"tool":    axe,
		"action":  "chop",
		"target":  "tree",
		"area":    "wilds",
		"visitId": "visit-1",
	}, 200)

	if r.Result.Wear == nil || r.Result.Wear.UsesLeft != 29 {
		t.Fatalf("expected wear usesLeft 29, got %+v", r.Result.Wear)
	}
	timber := stackQty(r.Result.Items, "timber")
	if timber < 2 || timber > 4 {
		t.Fatalf("expected 2..4 timber, got %d", timber)
	}
	x.conserved(s.HabiticaID)

	// 2. Heirloom blunts at zero and stops working
	brack := x.instance(s.HabiticaID, "brack-felling-axe", 3, "")
	r = x.op(c, &s, "gather", map[string]any{
		"tool":    brack,
		"action":  "chop",
		"target":  "tree",
		"area":    "wilds",
		"visitId": "visit-1",
	}, 200)
	if r.Result.Wear == nil || r.Result.Wear.State != "blunt" {
		t.Fatalf("expected brack axe to be blunt, got %+v", r.Result.Wear)
	}
	// Using blunt tool fails with 409 tool-blunt
	x.op(c, &s, "gather", map[string]any{
		"tool":    brack,
		"action":  "chop",
		"target":  "tree",
		"area":    "wilds",
		"visitId": "visit-1",
	}, 409)

	// 3. Cheap tool breaks at zero
	cheapAxe := x.instance(s.HabiticaID, "bench-axe", 3, "")
	r = x.op(c, &s, "gather", map[string]any{
		"tool":    cheapAxe,
		"action":  "chop",
		"target":  "tree",
		"area":    "wilds",
		"visitId": "visit-1",
	}, 200)
	if r.Result.Wear == nil || !r.Result.Wear.Broke {
		t.Fatalf("expected cheap axe to break, got %+v", r.Result.Wear)
	}
	// Broken tool is gone from pack
	x.op(c, &s, "gather", map[string]any{
		"tool":    cheapAxe,
		"action":  "chop",
		"target":  "tree",
		"area":    "wilds",
		"visitId": "visit-1",
	}, 404)

	x.conserved(s.HabiticaID)
}

func TestGatheringCaps(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("gathering-caps-user")
	axe := x.instance(s.HabiticaID, "brack-felling-axe", 900, "")

	// Chop visit cap is 8
	for i := 1; i <= content.GatheringRules.Caps.Visit.Chop; i++ {
		x.op(c, &s, "gather", map[string]any{
			"tool":    axe,
			"action":  "chop",
			"target":  "tree",
			"area":    "wilds",
			"visitId": "visit-first",
		}, 200)
	}

	// 9th gather in same visit is capped with 409 gathered-enough
	r := x.op(c, &s, "gather", map[string]any{
		"tool":    axe,
		"action":  "chop",
		"target":  "tree",
		"area":    "wilds",
		"visitId": "visit-first",
	}, 409)
	if r.Error.Code != "gathered-enough" {
		t.Fatalf("expected gathered-enough, got %s", r.Error.Code)
	}

	// Changing visitId (new area visit) resets visit cap
	x.op(c, &s, "gather", map[string]any{
		"tool":    axe,
		"action":  "chop",
		"target":  "tree",
		"area":    "wilds",
		"visitId": "visit-second",
	}, 200)

	// Gather until reaching the daily cap (30 trees total)
	done := content.GatheringRules.Caps.Visit.Chop + 1
	for v := 3; done < content.GatheringRules.Caps.Day.Chop; v++ {
		visitID := fmt.Sprintf("visit-%d", v)
		remainingInDay := content.GatheringRules.Caps.Day.Chop - done
		toGather := min(content.GatheringRules.Caps.Visit.Chop, remainingInDay)
		for j := 0; j < toGather; j++ {
			x.op(c, &s, "gather", map[string]any{
				"tool":    axe,
				"action":  "chop",
				"target":  "tree",
				"area":    "wilds",
				"visitId": visitID,
			}, 200)
			done++
		}
	}

	// Daily cap reached: next gather fails even with a new visit
	r = x.op(c, &s, "gather", map[string]any{
		"tool":    axe,
		"action":  "chop",
		"target":  "tree",
		"area":    "wilds",
		"visitId": "visit-tomorrow-early",
	}, 409)
	if r.Error.Code != "gathered-enough" {
		t.Fatalf("expected gathered-enough for daily cap, got %s", r.Error.Code)
	}

	// Advance time by 1 day (86400 seconds): daily cap resets
	x.now.Add(86400)
	x.op(c, &s, "gather", map[string]any{
		"tool":    axe,
		"action":  "chop",
		"target":  "tree",
		"area":    "wilds",
		"visitId": "visit-next-day",
	}, 200)

	x.conserved(s.HabiticaID)
}

func TestGatheringHomesteadDriftAndStumps(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("homestead-drift-user")
	home := x.claimGate(c, &s, 0)
	axe := x.instance(s.HabiticaID, "bench-axe", 100, "")
	pick := x.instance(s.HabiticaID, "bench-pick", 100, "")
	spade := x.instance(s.HabiticaID, "bench-spade", 100, "")

	// StartLight is at (20, 10) with radius 7. Tile (20, 11) is lit!
	litTile := [2]int{20, 11}

	// 1. Chop a tree inside lamplight: becomes a stump and stays!
	r := x.op(c, &s, "gather", map[string]any{
		"tool":    axe,
		"action":  "chop",
		"target":  "tree",
		"area":    "home:0",
		"visitId": "hvisit-1",
		"tile":    litTile,
	}, 200)
	if r.Result.Land == nil || !r.Result.Land.Stump || r.Result.Land.Tile[0] != litTile[0] || r.Result.Land.Tile[1] != litTile[1] {
		t.Fatalf("expected a stump land change at %+v, got %+v", litTile, r.Result.Land)
	}

	// Read homestead: stumps contains litTile
	h := x.home(c)
	foundStump := false
	for _, st := range h.Stumps {
		if st[0] == litTile[0] && st[1] == litTile[1] {
			foundStump = true
			break
		}
	}
	if !foundStump {
		t.Fatalf("expected litTile %+v in Stumps: %+v", litTile, h.Stumps)
	}

	// 2. Dig the stump with a spade: yields turncap-spawn and clears the stump
	r = x.op(c, &s, "gather", map[string]any{
		"tool":    spade,
		"action":  "dig",
		"target":  "stump",
		"area":    "home:0",
		"visitId": "hvisit-1",
		"tile":    litTile,
	}, 200)
	if r.Result.Land == nil || !r.Result.Land.Cleared {
		t.Fatalf("expected a cleared land change, got %+v", r.Result.Land)
	}

	spawn := stackQty(r.Result.Items, "turncap-spawn")
	if spawn < 1 {
		t.Fatalf("expected turncap-spawn, got %d", spawn)
	}

	// Stump is now removed from stumps and added to cleared
	h = x.home(c)
	for _, st := range h.Stumps {
		if st[0] == litTile[0] && st[1] == litTile[1] {
			t.Fatalf("stump should have been removed after digging, found in %+v", h.Stumps)
		}
	}
	clearedFound := false
	for _, cl := range h.Cleared {
		if cl[0] == litTile[0] && cl[1] == litTile[1] {
			clearedFound = true
			break
		}
	}
	if !clearedFound {
		t.Fatalf("expected litTile to be in Cleared after dig: %+v", h.Cleared)
	}

	// 3. Break a boulder inside lamplight: quarry stone + drift-stone, added to cleared
	litBoulderTile := [2]int{20, 12}
	r = x.op(c, &s, "gather", map[string]any{
		"tool":    pick,
		"action":  "break",
		"target":  "boulder",
		"area":    "home:0",
		"visitId": "hvisit-1",
		"tile":    litBoulderTile,
	}, 200)

	stone := stackQty(r.Result.Items, "stone")
	if stone < 2 {
		t.Fatalf("expected stone yield, got %d", stone)
	}

	h = x.home(c)
	boulderCleared := false
	for _, cl := range h.Cleared {
		if cl[0] == litBoulderTile[0] && cl[1] == litBoulderTile[1] {
			boulderCleared = true
			break
		}
	}
	if !boulderCleared {
		t.Fatalf("expected boulder tile to be cleared: %+v", h.Cleared)
	}

	_ = home
	x.conserved(s.HabiticaID)
}

func TestPlantingAtHome(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("planting-home-user")
	x.claimGate(c, &s, 0)

	// Fund seeds
	x.stack(s.HabiticaID, "birch-sapling", "", 2)
	x.stack(s.HabiticaID, "wild-thyme", "", 2)

	// 1. Plant inside lamplight (e.g. tile 20, 13 - outside campsite site, within light radius)
	litTile := [2]int{20, 13}
	r := x.op(c, &s, "plant", map[string]any{
		"itemDef": "birch-sapling",
		"area":    "home:0",
		"tile":    litTile,
	}, 200)

	if r.Result.Plant == nil || !r.Result.Plant.Lit || r.Result.Plant.ItemDef != "birch-sapling" {
		t.Fatalf("expected lit birch-sapling plant, got %+v", r.Result.Plant)
	}
	if stackQty(r.Result.Items, "birch-sapling") != 1 {
		t.Fatalf("expected 1 birch-sapling remaining in pack, got %d", stackQty(r.Result.Items, "birch-sapling"))
	}

	// Read home: plant is present
	h := x.home(c)
	if len(h.Plants) != 1 || h.Plants[0].X != litTile[0] || h.Plants[0].Y != litTile[1] {
		t.Fatalf("expected plant at litTile, got %+v", h.Plants)
	}

	// Advance time by 1 day: plant inside lamplight STAYS at litTile!
	x.now.Add(86400)
	h = x.home(c)
	if len(h.Plants) != 1 || h.Plants[0].X != litTile[0] || h.Plants[0].Y != litTile[1] {
		t.Fatalf("plant in lamplight should not wander: %+v", h.Plants)
	}

	// 2. Plant outside lamplight (e.g. unlit wild edge: tile 2, 2)
	unlitTile := [2]int{2, 2}
	r = x.op(c, &s, "plant", map[string]any{
		"itemDef": "wild-thyme",
		"area":    "home:0",
		"tile":    unlitTile,
	}, 200)
	if r.Result.Plant == nil || r.Result.Plant.Lit {
		t.Fatalf("expected unlit plant, got %+v", r.Result.Plant)
	}

	// Advance time by 1 day: plant outside lamplight WANDERS!
	x.now.Add(86400)
	h = x.home(c)
	var thyme *homePlantView
	for i := range h.Plants {
		if h.Plants[i].ItemDef == "wild-thyme" {
			thyme = &h.Plants[i]
			break
		}
	}
	if thyme == nil {
		t.Fatal("wild-thyme plant missing")
	}
	// The plant wandered: (thyme.X, thyme.Y) != (2, 2)
	if thyme.X == unlitTile[0] && thyme.Y == unlitTile[1] {
		t.Fatalf("expected plant outside lamplight to wander from (2,2), still at (%d,%d)", thyme.X, thyme.Y)
	}

	x.conserved(s.HabiticaID)
}
