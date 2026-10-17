package api

import (
	"fmt"
	"testing"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
)

// pick collects only the entries named from Pell's crate (asSeed: plants
// taken as their seed), standing in his office.
func (x *rig) pick(p campGoer, key string, entries, asSeed []int32, status int) (*contract.RecoveryCollectResult, string) {
	x.t.Helper()
	t := content.HomeRules.GetCommons().GetDeedTable()
	where := &contract.Where{Area: t.GetArea(), X: float64(t.GetX()), Y: float64(t.GetY()) + 8}
	env, code := x.call("/api/recovery/collect", &contract.RecoveryCollectRequest{Op: opHeader(p.s.Lease, key), Where: where, Entries: entries, AsSeed: asSeed}, p.c, status)
	return env.GetRecoveryCollect(), code
}

// entryOf is the waiting entry of this kind and definition (0 when none).
func entryOf(es []*contract.RecoveryEntry, kind, def string) int32 {
	for _, e := range es {
		if e.Kind == kind && e.ItemDef == def {
			return e.Id
		}
	}
	return 0
}

// carriedPlantsOf are the plants in an account's pack: id → planted_at.
func (x *rig) carriedPlantsOf(account string) map[string]int64 {
	x.t.Helper()
	rows, err := x.db.DB.Query("SELECT id,planted_at FROM carried_plants WHERE account_id=?", account)
	if err != nil {
		x.t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id string
		var at int64
		if err = rows.Scan(&id, &at); err != nil {
			x.t.Fatal(err)
		}
		out[id] = at
	}
	return out
}

// campCrate sets out a stool and plants a sapling at alice's camp, then she
// packs it up: everything waits at Pell's. The plant's id and planting.
func campCrate(t *testing.T) (*claimRig, string, string, int64) {
	x := newClaimRig(t)
	alice := x.alice.s.AccountID
	stool := x.carry(alice, "wooden-stool")
	x.op(x.alice, &contract.CampRequest{Action: "place", ItemId: stool, X: int32(x.spots[2][0]), Y: int32(x.spots[2][1])}, 200)
	x.stack(alice, "birch-sapling", "", 1)
	v, _ := x.op(x.alice, &contract.CampRequest{Action: "plant", ItemDef: "birch-sapling", X: int32(x.spots[3][0]), Y: int32(x.spots[3][1])}, 200)
	if len(v.Camp.Plants) != 1 {
		t.Fatalf("planted: %+v", v.Camp.Plants)
	}
	plant := v.Camp.Plants[0]
	x.op(x.alice, &contract.CampRequest{Action: "pack", Camp: x.lamp}, 200)
	return x, stool, plant.Id, int64(plant.PlantedAt)
}

// At Pell's you take what you pick and leave the rest waiting; a retried
// collect, or the same entry asked for again, never gives twice.
func TestCratePickerTakesWhatsPicked(t *testing.T) {
	x, stool, _, _ := campCrate(t)
	alice := x.alice.s.AccountID
	oil := content.HomeRules.GetWayLamp().GetOil()
	waiting := x.recovery(x.alice.c)
	if len(waiting) != 4 {
		t.Fatalf("the crate: %+v", waiting)
	}
	stoolEntry := entryOf(waiting, "piece", "wooden-stool")
	r, _ := x.pick(x.alice, "pick-stool", []int32{stoolEntry}, nil, 200)
	if len(r.Collected) != 1 || r.Collected[0].Id != stoolEntry || len(r.Kept) != 0 {
		t.Fatalf("picked: %+v", r)
	}
	if loc, _ := x.itemAt(stool); loc != "inventory" {
		t.Fatalf("the stool: %s", loc)
	}
	if loc, _ := x.itemAt(x.lamp); loc != "crate" {
		t.Fatalf("the lamp left the crate: %s", loc)
	}
	if left := x.recovery(x.alice.c); len(left) != 3 || entryOf(left, "piece", "wooden-stool") != 0 {
		t.Fatalf("left waiting: %+v", left)
	}

	// The oil: once, however it is asked for again.
	flasks := x.packQty(alice, oil)
	oilEntry := entryOf(waiting, "stack", oil)
	if r, _ = x.pick(x.alice, "pick-oil", []int32{oilEntry}, nil, 200); len(r.Collected) != 1 {
		t.Fatalf("picked the oil: %+v", r)
	}
	if replay, _ := x.pick(x.alice, "pick-oil", []int32{oilEntry}, nil, 200); len(replay.Collected) != 1 {
		t.Fatalf("replayed: %+v", replay)
	}
	if again, _ := x.pick(x.alice, "pick-oil-again", []int32{oilEntry, stoolEntry}, nil, 200); len(again.Collected) != 0 {
		t.Fatalf("collected twice: %+v", again)
	}
	if got := x.packQty(alice, oil); got != flasks+1 {
		t.Fatalf("oil: %d, had %d", got, flasks)
	}
	// Someone else's entry is never theirs to take.
	bob := campGoer{x.bob.c, x.bob.s}
	if r, _ = x.pick(bob, "bob-picks", []int32{entryOf(waiting, "piece", "way-lamp")}, nil, 200); len(r.Collected) != 0 {
		t.Fatalf("bob took alice's lamp: %+v", r)
	}
	if left := x.recovery(x.alice.c); len(left) != 2 {
		t.Fatalf("left waiting: %+v", left)
	}
	x.conserved(alice)
}

// A pack carries so many plants; past that a plant waits in the crate,
// said so, while everything else comes. Taken as its seed, it always fits.
func TestCratePickerFullPackKeepsThePlant(t *testing.T) {
	x, _, _, _ := campCrate(t)
	alice := x.alice.s.AccountID
	for i := range int(content.GatheringRules.GetCarriedPlants()) {
		if _, err := x.db.DB.Exec("INSERT INTO carried_plants(id,account_id,item_def,planted_at,carried_at) VALUES(?,?,'wild-thyme',0,0)", fmt.Sprintf("full-%d", i), alice); err != nil {
			t.Fatal(err)
		}
	}
	r, _ := x.collect(x.alice.c, x.alice.s, "take-all", true, 200)
	if len(r.Collected) != 3 || len(r.Kept) != 1 || r.Kept[0].Kind != "plant" || r.Kept[0].ItemDef != "birch-sapling" {
		t.Fatalf("collected %+v, kept %+v", r.Collected, r.Kept)
	}
	left := x.recovery(x.alice.c)
	if len(left) != 1 || left[0].Kind != "plant" {
		t.Fatalf("left waiting: %+v", left)
	}
	if n := len(x.carriedPlantsOf(alice)); n != int(content.GatheringRules.GetCarriedPlants()) {
		t.Fatalf("carried plants: %d", n)
	}
	if x.packQty(alice, "birch-sapling") != 0 {
		t.Fatal("the sapling came as a seed unasked")
	}
	r, _ = x.pick(x.alice, "take-seed", []int32{left[0].Id}, []int32{left[0].Id}, 200)
	if len(r.Collected) != 1 || len(r.Kept) != 0 || x.packQty(alice, "birch-sapling") != 1 || len(x.recovery(x.alice.c)) != 0 {
		t.Fatalf("as its seed: %+v", r)
	}
	x.conserved(alice)
}

// A crated plant comes back as itself, its planting kept, and goes into
// the ground again where its owner may plant: at a camp they build at, or
// on their own land. Not at someone else's camp, nor on a neighbour's land.
func TestCratedPlantIsReplantedWithItsGrowth(t *testing.T) {
	x, _, plant, plantedAt := campCrate(t)
	alice, bob := x.alice.s.AccountID, x.bob.s.AccountID
	r, _ := x.collect(x.alice.c, x.alice.s, "take-all", true, 200)
	if len(r.Collected) != 4 || len(r.Kept) != 0 {
		t.Fatalf("collected %+v, kept %+v", r.Collected, r.Kept)
	}
	if got := x.carriedPlantsOf(alice); len(got) != 1 || got[plant] != plantedAt {
		t.Fatalf("carried: %v, want %s at %d", got, plant, plantedAt)
	}
	v := x.items("GET", "/api/items", nil, x.alice.c, 200).Items
	if len(v.Plants) != 1 || v.Plants[0].ID != plant || v.Plants[0].ItemDef != "birch-sapling" || v.Plants[0].PlantedAt != plantedAt {
		t.Fatalf("the pack's plants: %+v", v.Plants)
	}
	if x.packQty(alice, "birch-sapling") != 0 {
		t.Fatal("a seed came too")
	}
	x.conserved(alice)

	// The lamp is set again; bob may not build there, so his own carried
	// plant is refused and stays in his pack.
	x.alice.c, x.alice.s = x.again("alice")
	x.bob.c, x.bob.s = x.again("bob")
	x.op(x.alice, &contract.CampRequest{Action: "set", ItemId: x.lamp, X: int32(x.spots[0][0]), Y: int32(x.spots[0][1])}, 200)
	if _, err := x.db.DB.Exec("INSERT INTO carried_plants(id,account_id,item_def,planted_at,carried_at) VALUES('bobs-plant',?,'wild-thyme',5,5)", bob); err != nil {
		t.Fatal(err)
	}
	if _, code := x.op(x.bob, &contract.CampRequest{Action: "plant", ItemId: "bobs-plant", X: int32(x.spots[4][0]), Y: int32(x.spots[4][1])}, 409); code != "not-your-camp" {
		t.Fatalf("bob planted at alice's camp: %s", code)
	}
	if len(x.carriedPlantsOf(bob)) != 1 {
		t.Fatal("bob's plant left his pack")
	}
	// Nor can anyone plant a carried plant that isn't theirs.
	if _, code := x.op(x.alice, &contract.CampRequest{Action: "plant", ItemId: "bobs-plant", X: int32(x.spots[4][0]), Y: int32(x.spots[4][1])}, 409); code != "item-not-available" {
		t.Fatalf("alice planted bob's plant: %s", code)
	}

	// Alice's goes in at her camp as itself: the same id, the same growth.
	x.now.Add(86400)
	cv, _ := x.op(x.alice, &contract.CampRequest{Action: "plant", ItemId: plant, X: int32(x.spots[3][0]), Y: int32(x.spots[3][1])}, 200)
	if len(cv.Camp.Plants) != 1 || cv.Camp.Plants[0].Id != plant || int64(cv.Camp.Plants[0].PlantedAt) != plantedAt || cv.Camp.Plants[0].ItemDef != "birch-sapling" {
		t.Fatalf("replanted: %+v", cv.Camp.Plants)
	}
	if int64(cv.Camp.Plants[0].PlantedDay) != utcDay(x.now.Load()) {
		t.Fatalf("its day in this ground: %v", cv.Camp.Plants[0].PlantedDay)
	}
	if len(x.carriedPlantsOf(alice)) != 0 {
		t.Fatal("still carried")
	}
	// Planted once: asking again finds nothing to plant.
	if _, code := x.op(x.alice, &contract.CampRequest{Action: "plant", ItemId: plant, X: int32(x.spots[4][0]), Y: int32(x.spots[4][1])}, 409); code != "item-not-available" {
		t.Fatalf("planted twice: %s", code)
	}
	x.conserved(alice)
}

// At home a carried plant goes in as a seed would (the items plant
// operation, its id as the instance), its growth kept; on a neighbour's
// land it's refused and stays carried.
func TestCarriedPlantGoesInAtHome(t *testing.T) {
	x := newRig(t)
	c, s, h := x.homePlayer("alice")
	area := fmt.Sprintf("home:%d", h.Gate)
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
	if _, err := x.db.DB.Exec("INSERT INTO carried_plants(id,account_id,item_def,planted_at,carried_at) VALUES('old-thyme',?,'wild-thyme',1000,2000)", s.AccountID); err != nil {
		t.Fatal(err)
	}
	// A neighbour's land is no place for it.
	bc, b := x.member("bob", s.WorldID)
	if _, err := x.db.DB.Exec("INSERT INTO carried_plants(id,account_id,item_def,planted_at,carried_at) VALUES('bobs-thyme',?,'wild-thyme',1000,2000)", b.AccountID); err != nil {
		t.Fatal(err)
	}
	if code := x.opRefreshing(bc, &b, "plant", map[string]any{"instance": "bobs-thyme", "tile": tile, "progress": standAt(b, area, tile[0], tile[1])}, 409).Error.Code; code != "not-your-land" {
		t.Fatalf("bob planted on alice's land: %s", code)
	}
	if len(x.carriedPlantsOf(b.AccountID)) != 1 {
		t.Fatal("bob's plant left his pack")
	}
	r := x.opRefreshing(c, &s, "plant", map[string]any{"instance": "old-thyme", "tile": tile, "progress": standAt(s, area, tile[0], tile[1])}, 200)
	if p := r.Result.Plant; p == nil || p.ID != "old-thyme" || p.ItemDef != "wild-thyme" || p.PlantedAt != 1000 {
		t.Fatalf("planted: %+v", r.Result.Plant)
	}
	if len(r.Result.Items.Plants) != 0 || len(x.carriedPlantsOf(s.AccountID)) != 0 {
		t.Fatalf("still carried: %+v", r.Result.Items.Plants)
	}
	if ps := x.home(c).Plants; len(ps) != 1 || ps[0].ID != "old-thyme" || ps[0].PlantedAt != 1000 {
		t.Fatalf("the home's plants: %+v", ps)
	}
	x.conserved(s.AccountID)
}
