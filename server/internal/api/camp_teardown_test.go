package api

import (
	"testing"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
)

// A camp plant comes up into the digger's pack as its seed: anyone the
// keeper's rule lets build there, or whoever planted it, from beside it,
// with a trowel. Then the lamp can come down (review B7).
func TestCampPlantUproot(t *testing.T) {
	x := newClaimRig(t)
	seed := "turncap-spawn"
	x.stack(x.alice.s.AccountID, seed, "", 1)
	v, _ := x.op(x.alice, &contract.CampRequest{Action: "plant", ItemDef: seed, X: int32(x.spots[2][0]), Y: int32(x.spots[2][1])}, 200)
	plant := v.Camp.Plants[0].Id
	if _, code := x.op(x.alice, &contract.CampRequest{Action: "remove", ItemId: x.lamp}, 409); code != "camp-not-empty" {
		t.Fatalf("lamp down over a plant: %s", code)
	}
	// Bob may not build here by the household rule, so he can't dig it up.
	if _, code := x.op(x.bob, &contract.CampRequest{Action: "uproot", ItemId: plant}, 409); code != "not-your-camp" {
		t.Fatalf("bob dug without the rule: %s", code)
	}
	x.rule(x.alice, "everyone", nil, 200)
	// Leave to build isn't enough: only the trowel digs a plant up.
	if _, code := x.op(x.bob, &contract.CampRequest{Action: "uproot", ItemId: plant}, 409); code != "wrong-tool" {
		t.Fatalf("bob dug without a trowel: %s", code)
	}
	x.instance(x.bob.s.AccountID, "bench-trowel", -1, "")
	x.instance(x.zed.s.AccountID, "bench-trowel", -1, "")
	if _, code := x.campOp(x.bob.c, x.bob.s, &contract.CampRequest{Action: "uproot", ItemId: plant}, x.stand[0]+12, x.stand[1], 409); code != "too-far-away" {
		t.Fatalf("dug from afar: %s", code)
	}
	if _, code := x.op(x.zed, &contract.CampRequest{Action: "uproot", ItemId: plant}, 409); code != "not-placed" {
		t.Fatalf("dug from another world: %s", code)
	}
	v, _ = x.op(x.bob, &contract.CampRequest{Action: "uproot", ItemId: plant}, 200)
	if len(v.Camp.Plants) != 0 || x.packQty(x.bob.s.AccountID, seed) != 1 || x.packQty(x.alice.s.AccountID, seed) != 0 {
		t.Fatalf("the seed: %+v bob=%d", v.Camp.Plants, x.packQty(x.bob.s.AccountID, seed))
	}
	// The dig is one use of bob's trowel, as any tool use.
	if v.Wear == nil || v.Wear.ItemDef != "bench-trowel" || v.Wear.UsesLeft != 29 || v.Wear.Broke {
		t.Fatalf("the trowel's wear: %+v", v.Wear)
	}
	if _, code := x.op(x.bob, &contract.CampRequest{Action: "uproot", ItemId: plant}, 409); code != "not-placed" {
		t.Fatalf("dug twice: %s", code)
	}
	// Whoever planted it takes it back whatever the rule.
	v, _ = x.op(x.bob, &contract.CampRequest{Action: "plant", ItemDef: seed, X: int32(x.spots[2][0]), Y: int32(x.spots[2][1])}, 200)
	x.rule(x.alice, "household", nil, 200)
	x.op(x.bob, &contract.CampRequest{Action: "uproot", ItemId: v.Camp.Plants[0].Id}, 200)
	if x.packQty(x.bob.s.AccountID, seed) != 1 {
		t.Fatal("bob's own seed")
	}
	if v, _ := x.op(x.alice, &contract.CampRequest{Action: "remove", ItemId: x.lamp}, 200); v.Camp != nil {
		t.Fatalf("the lamp stayed: %+v", v.Camp)
	}
}

// The keeper packs the whole camp up at once: every piece to its owner's
// crate entry at Pell's, the lamp, the plants and the unspent oil, as at a
// lapse. The claim ends now; paths laid there come back at the turning.
func TestCampPackUp(t *testing.T) {
	x := newClaimRig(t)
	alice, bob := x.alice.s.AccountID, x.bob.s.AccountID
	x.rule(x.alice, "everyone", nil, 200)
	stool := x.carry(alice, "wooden-stool")
	x.op(x.alice, &contract.CampRequest{Action: "place", ItemId: stool, X: int32(x.spots[2][0]), Y: int32(x.spots[2][1])}, 200)
	bobs := x.carry(bob, "wooden-stool")
	x.op(x.bob, &contract.CampRequest{Action: "place", ItemId: bobs, X: int32(x.spots[3][0]), Y: int32(x.spots[3][1])}, 200)
	x.stack(bob, "birch-sapling", "", 1)
	x.op(x.bob, &contract.CampRequest{Action: "plant", ItemDef: "birch-sapling", X: int32(x.spots[4][0]), Y: int32(x.spots[4][1])}, 200)
	x.give(bob, "stone", 3)
	x.pathOp(x.bob.c, x.bob.s, "lay", "bob-camp-path", x.stand[0], x.stand[1], x.spots[5][0], x.spots[5][1], "stone", 200)
	stoneLeft := x.packQty(bob, "stone")

	if _, code := x.op(x.bob, &contract.CampRequest{Action: "pack", Camp: x.lamp}, 409); code != "not-your-lamp" {
		t.Fatalf("bob packed alice's camp: %s", code)
	}
	if _, code := x.campOp(x.alice.c, x.alice.s, &contract.CampRequest{Action: "pack", Camp: x.lamp}, x.stand[0]+12, x.stand[1], 409); code != "too-far-away" {
		t.Fatalf("packed from afar: %s", code)
	}
	if v, _ := x.op(x.alice, &contract.CampRequest{Action: "pack", Camp: x.lamp}, 200); v.Camp != nil {
		t.Fatalf("still a camp: %+v", v.Camp)
	}
	if len(x.camps(x.alice.c)) != 0 || count(t, x.db, "SELECT count(*) FROM camp_plants") != 0 || count(t, x.db, "SELECT count(*) FROM claim_rules") != 0 {
		t.Fatal("the camp is still there")
	}
	for _, id := range []string{x.lamp, stool, bobs} {
		if loc, camp := x.itemAt(id); loc != "crate" || camp != nil {
			t.Fatalf("%s: %s", id, loc)
		}
	}
	got := map[string]int{}
	for _, e := range x.recovery(x.alice.c) {
		got[e.Kind+":"+e.ItemDef] += int(e.Qty)
		if e.MovedBy != "" {
			t.Fatalf("the keeper's own things name a mover: %+v", e)
		}
	}
	oil := content.HomeRules.GetWayLamp().GetOil()
	if len(got) != 3 || got["piece:way-lamp"] != 1 || got["piece:wooden-stool"] != 1 || got["stack:"+oil] != 1 {
		t.Fatalf("alice's crate: %v", got)
	}
	got = map[string]int{}
	var keeper string
	if err := x.db.DB.QueryRow("SELECT display_name FROM players WHERE account_id=?", alice).Scan(&keeper); err != nil || keeper == "" {
		t.Fatalf("alice's name: %q %v", keeper, err)
	}
	for _, e := range x.recovery(x.bob.c) {
		got[e.Kind+":"+e.ItemDef] += int(e.Qty)
		// Moved off by the keeper, as a single moved-off piece says.
		if e.MovedBy != keeper {
			t.Fatalf("bob's entry doesn't name alice: %+v", e)
		}
	}
	if len(got) != 2 || got["piece:wooden-stool"] != 1 || got["plant:birch-sapling"] != 1 {
		t.Fatalf("bob's crate: %v", got)
	}
	if _, code := x.op(x.alice, &contract.CampRequest{Action: "pack", Camp: x.lamp}, 404); code != "no-camp" {
		t.Fatalf("packed twice: %s", code)
	}
	// At the turning the hold lets go and bob's path stone follows.
	x.turn()
	ac, _ := x.again("alice")
	if got := nearChunkAt(x.near(ac, campCX, campCY, 200), campCX, campCY); got.Source == location.SourceHeld.String() {
		t.Fatalf("still held: %+v", got)
	}
	bc, bs := x.again("bob")
	stone := 0
	for _, e := range x.recovery(bc) {
		if e.Kind == "stack" && e.ItemDef == "stone" {
			stone += int(e.Qty)
		}
	}
	if stone != int(chunks.LayKind("stone").GetCost()) {
		t.Fatalf("bob's path stone: %d", stone)
	}
	x.collect(bc, bs, "bob-collect", true, 200)
	if x.packQty(bob, "stone") != stoneLeft+stone || len(x.carriedPlantsOf(bob)) != 1 {
		t.Fatal("bob's collection")
	}
	if loc, _ := x.itemAt(bobs); loc != "inventory" {
		t.Fatalf("bob's stool: %s", loc)
	}
}
