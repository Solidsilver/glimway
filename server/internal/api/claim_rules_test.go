package api

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"glimway/server/internal/chunks"
	"glimway/server/internal/chunks/fakegen"
	contract "glimway/server/internal/gen/glimway/v1"
)

// claimRig is a camp of alice's in a world with her household (carol),
// two neighbours (bob, dave) and someone from another world (zed).
type claimRig struct {
	*rig
	lamp                   string
	spots                  [][2]int
	stand                  [2]int
	alice, bob, carol, dav campGoer
	zed                    campGoer
}

type campGoer struct {
	c *http.Cookie
	s response
}

func newClaimRig(t *testing.T) *claimRig {
	x := &claimRig{rig: newRig(t)}
	x.alice.c, x.alice.s = x.ready("alice")
	x.claimGate(x.alice.c, &x.alice.s, 0)
	x.bob.c, x.bob.s = x.member("bob", x.alice.s.WorldID)
	x.carol.c, x.carol.s = x.member("carol", x.alice.s.WorldID)
	x.dav.c, x.dav.s = x.member("dave", x.alice.s.WorldID)
	x.zed.c, x.zed.s = x.ready("zed")
	if _, err := x.db.DB.Exec("INSERT INTO homestead_members SELECT ?,homestead_id,0 FROM homestead_members WHERE account_id=?", x.carol.s.AccountID, x.alice.s.AccountID); err != nil {
		t.Fatal(err)
	}
	x.spots = nearSpots(t, x.campSpots(x.alice.s.WorldID, campCX, campCY))
	x.stand = x.spots[1]
	x.lamp = x.carry(x.alice.s.AccountID, "way-lamp")
	x.keeper(x.alice.s.AccountID)
	x.stack(x.alice.s.AccountID, "hearth-oil", "", 1)
	x.op(x.alice, &contract.CampRequest{Action: "set", ItemId: x.lamp, X: int32(x.spots[0][0]), Y: int32(x.spots[0][1])}, 200)
	return x
}

// nearSpots are six open tiles all in reach of the second (where everyone
// stands): the lamp's, the stand, then four for pieces, plants and paths.
func nearSpots(t *testing.T, open [][2]int) [][2]int {
	t.Helper()
	for _, s := range open {
		out := [][2]int{s}
		for _, o := range open {
			if dx, dy := o[0]-s[0], o[1]-s[1]; o != s && dx*dx+dy*dy <= 4 {
				out = append(out, o)
			}
		}
		if len(out) >= 6 {
			return [][2]int{out[1], s, out[2], out[3], out[4], out[5]}
		}
	}
	t.Fatal("no six open tiles together")
	return nil
}

// op posts a camp operation from beside the lamp.
func (x *claimRig) op(p campGoer, req *contract.CampRequest, status int) (*contract.CampResult, string) {
	x.t.Helper()
	return x.campOp(p.c, p.s, req, x.stand[0], x.stand[1], status)
}

func (x *claimRig) rule(p campGoer, rule string, members []string, status int) string {
	x.t.Helper()
	_, code := x.op(p, &contract.CampRequest{Action: "rule", Camp: x.lamp, Rule: rule, Members: members}, status)
	return code
}

// may asks the one build check directly.
func (x *claimRig) may(account string) bool {
	x.t.Helper()
	tx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	c, err := campByID(context.Background(), tx, x.alice.s.WorldID, x.lamp)
	if err != nil || c == nil {
		x.t.Fatalf("camp: %v", err)
	}
	ok, err := campBuilder(context.Background(), tx, c, account)
	if err != nil {
		x.t.Fatal(err)
	}
	return ok
}

// Each rule against the keeper, the household, a listed and a blocked
// neighbour, and someone from another world.
func TestCampBuildRules(t *testing.T) {
	x := newClaimRig(t)
	alice, bob, carol, dave, zed := x.alice.s.AccountID, x.bob.s.AccountID, x.carol.s.AccountID, x.dav.s.AccountID, x.zed.s.AccountID
	for _, tc := range []struct {
		rule    string
		members []string
		want    map[string]bool
	}{
		{"household", nil, map[string]bool{alice: true, carol: true, bob: false, dave: false, zed: false}},
		{"household", []string{bob}, map[string]bool{alice: true, carol: true, bob: false, dave: false, zed: false}},
		{"listed", []string{dave}, map[string]bool{alice: true, carol: true, bob: false, dave: true, zed: false}},
		{"except", []string{bob}, map[string]bool{alice: true, carol: true, bob: false, dave: true, zed: false}},
		{"except", []string{carol}, map[string]bool{alice: true, carol: false, bob: true, dave: true, zed: false}},
		{"everyone", []string{bob}, map[string]bool{alice: true, carol: true, bob: true, dave: true, zed: false}},
	} {
		x.rule(x.alice, tc.rule, tc.members, 200)
		for who, want := range tc.want {
			if got := x.may(who); got != want {
				t.Fatalf("%s %v: %s may build %v", tc.rule, tc.members, who, got)
			}
		}
	}
	// The keeper reads the rule and its list; nobody else does.
	x.rule(x.alice, "listed", []string{dave, alice, dave}, 200)
	cs := x.camps(x.alice.c)
	if len(cs) != 1 || cs[0].Rule != "listed" || len(cs[0].Members) != 1 || cs[0].Members[0].AccountId != dave || cs[0].Members[0].Name == "" {
		t.Fatalf("keeper's read: %+v", cs)
	}
	if cs := x.camps(x.dav.c); cs[0].Rule != "" || len(cs[0].Members) != 0 || !cs[0].Builder {
		t.Fatalf("dave's read: %+v", cs[0])
	}
	// Whom the keeper may name: the world's members but the keeper.
	people := &contract.CampsRead{}
	x.mixedRead("/api/camps", x.alice.c, people)
	names := map[string]bool{}
	for _, p := range people.People {
		names[p.AccountId] = true
	}
	if len(names) != 3 || !names[bob] || !names[carol] || !names[dave] {
		t.Fatalf("people: %+v", people.People)
	}
	bobs := &contract.CampsRead{}
	x.mixedRead("/api/camps", x.bob.c, bobs)
	if len(bobs.People) != 0 {
		t.Fatalf("bob's people: %+v", bobs.People)
	}
	// Only the keeper sets it; only world members are named; four rules.
	if code := x.rule(x.carol, "everyone", nil, 409); code != "not-your-lamp" {
		t.Fatalf("carol set the rule: %s", code)
	}
	if code := x.rule(x.bob, "everyone", nil, 409); code != "not-your-lamp" {
		t.Fatalf("bob set the rule: %s", code)
	}
	if code := x.rule(x.alice, "except", []string{zed}, 409); code != "not-in-world" {
		t.Fatalf("named zed: %s", code)
	}
	if code := x.rule(x.alice, "except", []string{"nobody"}, 409); code != "not-in-world" {
		t.Fatalf("named nobody: %s", code)
	}
	if code := x.rule(x.alice, "friends", nil, 400); code != "invalid-request" {
		t.Fatalf("a fifth rule: %s", code)
	}
	if cs := x.camps(x.alice.c); cs[0].Rule != "listed" {
		t.Fatalf("a refused change changed it: %+v", cs[0])
	}
}

// What building covers, refused and then allowed; filling and walking
// never refused.
func TestCampBuildKinds(t *testing.T) {
	x := newClaimRig(t)
	bob := x.bob
	sp := x.spots
	// Bob's path is there before the camp's rule shuts him out.
	x.give(bob.s.AccountID, "stone", 4)
	x.rule(x.alice, "everyone", nil, 200)
	x.pathOp(bob.c, bob.s, "lay", "bob-lay-1", sp[4][0], sp[4][1], sp[4][0], sp[4][1], "stone", 200)
	stool := x.carry(bob.s.AccountID, "wooden-stool")
	x.op(bob, &contract.CampRequest{Action: "place", ItemId: stool, X: int32(sp[2][0]), Y: int32(sp[2][1])}, 200)

	x.rule(x.alice, "except", []string{bob.s.AccountID}, 200)
	refused := func(what, code string) {
		t.Helper()
		if code != "not-your-camp" {
			t.Fatalf("%s: %s", what, code)
		}
	}
	other := x.carry(bob.s.AccountID, "wooden-stool")
	_, code := x.op(bob, &contract.CampRequest{Action: "place", ItemId: other, X: int32(sp[3][0]), Y: int32(sp[3][1])}, 409)
	refused("place", code)
	x.stack(bob.s.AccountID, "birch-sapling", "", 1)
	_, code = x.op(bob, &contract.CampRequest{Action: "plant", ItemDef: "birch-sapling", X: int32(sp[3][0]), Y: int32(sp[3][1])}, 409)
	refused("plant", code)
	// His own things are always his to take back: picking up isn't building.
	x.op(bob, &contract.CampRequest{Action: "remove", ItemId: stool}, 200)
	if loc, _ := x.itemAt(stool); loc != "inventory" {
		t.Fatalf("blocked from his own stool: %s", loc)
	}
	_, code = x.pathOp(bob.c, bob.s, "lay", "bob-lay-2", sp[5][0], sp[5][1], sp[5][0], sp[5][1], "stone", 409)
	refused("lay", code)
	_, code = x.pathOp(bob.c, bob.s, "lift", "bob-lift-1", sp[4][0], sp[4][1], sp[4][0], sp[4][1], "", 409)
	refused("lift", code)
	_, code = x.pathOp(bob.c, bob.s, "clear", "bob-clear", sp[5][0], sp[5][1], sp[5][0], sp[5][1], "", 409)
	refused("clear", code)
	// Still free to walk there and tend the lamp.
	x.near(bob.c, campCX, campCY, 200)
	x.stack(bob.s.AccountID, "hearth-oil", "", 1)
	if v, _ := x.op(bob, &contract.CampRequest{Action: "fill", Camp: x.lamp}, 200); v.Camp.Oil != 2 || v.Camp.Builder {
		t.Fatalf("bob's fill: %+v", v.Camp)
	}

	// Let in again, he builds: places, plants, lays, lifts, picks up.
	x.rule(x.alice, "listed", []string{bob.s.AccountID}, 200)
	x.op(bob, &contract.CampRequest{Action: "place", ItemId: stool, X: int32(sp[2][0]), Y: int32(sp[2][1])}, 200)
	x.op(bob, &contract.CampRequest{Action: "place", ItemId: other, X: int32(sp[3][0]), Y: int32(sp[3][1])}, 200)
	x.op(bob, &contract.CampRequest{Action: "plant", ItemDef: "birch-sapling", X: int32(sp[5][0]), Y: int32(sp[5][1])}, 200)
	x.pathOp(bob.c, bob.s, "lift", "bob-lift-2", sp[4][0], sp[4][1], sp[4][0], sp[4][1], "", 200)
	x.op(bob, &contract.CampRequest{Action: "remove", ItemId: other}, 200)
	if loc, _ := x.itemAt(other); loc != "inventory" {
		t.Fatalf("picked up: %s", loc)
	}
	// Never someone else's piece, not even the lamp.
	mine := x.carry(x.alice.s.AccountID, "wooden-stool")
	x.op(x.alice, &contract.CampRequest{Action: "place", ItemId: mine, X: int32(sp[3][0]), Y: int32(sp[3][1])}, 200)
	for _, id := range []string{mine, x.lamp} {
		if _, code := x.op(bob, &contract.CampRequest{Action: "remove", ItemId: id}, 409); code != "item-not-owned" {
			t.Fatalf("bob took %s: %s", id, code)
		}
	}
	// Household folk can't move the neighbours' things either: only the keeper.
	if _, code := x.op(x.carol, &contract.CampRequest{Action: "remove", ItemId: stool}, 409); code != "item-not-owned" {
		t.Fatalf("carol took bob's stool: %s", code)
	}

	// The keeper moves bob's stool off: to his crate at Pell's, still his.
	if v, _ := x.op(x.alice, &contract.CampRequest{Action: "remove", ItemId: stool}, 200); v.Camp == nil || len(v.Camp.Pieces) != 2 {
		t.Fatalf("after the keeper's removal: %+v", v.Camp)
	}
	if loc, camp := x.itemAt(stool); loc != "crate" || camp != nil {
		t.Fatalf("bob's stool: %s", loc)
	}
	var owner string
	if err := x.db.DB.QueryRow("SELECT account_id FROM homestead_items WHERE id=?", stool).Scan(&owner); err != nil || owner != bob.s.AccountID {
		t.Fatalf("the stool's owner: %s %v", owner, err)
	}
	es := x.recovery(bob.c)
	if len(es) != 1 || es[0].Kind != "piece" || es[0].ItemDef != "wooden-stool" || es[0].Cx != campCX || es[0].MovedBy != "Hero" {
		t.Fatalf("bob's crate: %+v", es)
	}
	if len(x.recovery(x.alice.c)) != 0 {
		t.Fatal("alice was credited bob's stool")
	}
	x.collect(bob.c, bob.s, "bob-collect", true, 200)
	if loc, _ := x.itemAt(stool); loc != "inventory" {
		t.Fatalf("collected: %s", loc)
	}
}

// A lapse sends each campGoer's things to their own crate entries, whoever
// set the lamp; the rule goes with the camp.
func TestCampLapseCreditsEachOwner(t *testing.T) {
	x := newClaimRig(t)
	bob, sp := x.bob, x.spots
	x.rule(x.alice, "everyone", nil, 200)
	stool := x.carry(bob.s.AccountID, "wooden-stool")
	x.op(bob, &contract.CampRequest{Action: "place", ItemId: stool, X: int32(sp[2][0]), Y: int32(sp[2][1])}, 200)
	x.stack(bob.s.AccountID, "birch-sapling", "", 1)
	x.op(bob, &contract.CampRequest{Action: "plant", ItemDef: "birch-sapling", X: int32(sp[3][0]), Y: int32(sp[3][1])}, 200)
	x.give(bob.s.AccountID, "stone", 2)
	x.pathOp(bob.c, bob.s, "lay", "bob-lay", sp[4][0], sp[4][1], sp[4][0], sp[4][1], "stone", 200)
	mine := x.carry(x.alice.s.AccountID, "wooden-stool")
	x.op(x.alice, &contract.CampRequest{Action: "place", ItemId: mine, X: int32(sp[5][0]), Y: int32(sp[5][1])}, 200)
	for range 3 {
		x.turn()
		x.alice.c, x.alice.s = x.again("alice")
		x.camps(x.alice.c)
	}
	if cs := x.camps(x.alice.c); len(cs) != 0 {
		t.Fatalf("not lapsed: %+v", cs)
	}
	got := func(c *http.Cookie) map[string]int {
		out := map[string]int{}
		for _, e := range x.recovery(c) {
			out[e.Kind+":"+e.ItemDef] += int(e.Qty)
		}
		return out
	}
	bob.c, bob.s = x.again("bob")
	if g := got(bob.c); len(g) != 3 || g["piece:wooden-stool"] != 1 || g["plant:birch-sapling"] != 1 || g["stack:stone"] != int(chunks.LayKind("stone").GetCost()) {
		t.Fatalf("bob's crate: %v", g)
	}
	for _, e := range x.recovery(bob.c) {
		if e.MovedBy != "" {
			t.Fatalf("a lapse said it was moved off: %+v", e)
		}
	}
	if g := got(x.alice.c); len(g) != 2 || g["piece:wooden-stool"] != 1 || g["piece:way-lamp"] != 1 {
		t.Fatalf("alice's crate: %v", g)
	}
	var rules int
	if err := x.db.DB.QueryRow("SELECT (SELECT count(*) FROM claim_rules)+(SELECT count(*) FROM claim_rule_members)").Scan(&rules); err != nil || rules != 0 {
		t.Fatalf("the rule outlived its camp: %d %v", rules, err)
	}
}

// Taking the lamp down ends its rule: set again, the camp starts at household.
func TestCampTakeDownDropsRule(t *testing.T) {
	x := newClaimRig(t)
	x.rule(x.alice, "except", []string{x.bob.s.AccountID}, 200)
	x.op(x.alice, &contract.CampRequest{Action: "remove", ItemId: x.lamp}, 200)
	var rules int
	if err := x.db.DB.QueryRow("SELECT (SELECT count(*) FROM claim_rules)+(SELECT count(*) FROM claim_rule_members)").Scan(&rules); err != nil || rules != 0 {
		t.Fatalf("the rule outlived its camp: %d %v", rules, err)
	}
}

// Naming a camp's lamp takes a Keeper who builds there, by the rule.
func TestCampNamingFollowsRule(t *testing.T) {
	x := newClaimRig(t)
	x.keeper(x.bob.s.AccountID)
	name := func(status int) string {
		_, code := x.op(x.bob, &contract.CampRequest{Action: "name", Camp: x.lamp, Parts: []string{"first", "above", "whitequiet", "road", "long-way", "stay"}}, status)
		return code
	}
	if code := name(409); code != "not-your-lamp" {
		t.Fatalf("named by a neighbour: %s", code)
	}
	x.rule(x.alice, "listed", []string{x.bob.s.AccountID}, 200)
	name(200)
}

// One list, kept whatever the rule: switching rules loses no names.
func TestCampRuleKeepsList(t *testing.T) {
	x := newClaimRig(t)
	x.rule(x.alice, "listed", []string{x.bob.s.AccountID}, 200)
	x.rule(x.alice, "everyone", []string{x.bob.s.AccountID}, 200)
	if cs := x.camps(x.alice.c); cs[0].Rule != "everyone" || len(cs[0].Members) != 1 {
		t.Fatalf("after switching: %+v", cs[0])
	}
}

// Felling and breaking in a camp's chunk change its land: only builders.
func TestCampGatherFollowsRule(t *testing.T) {
	x := newClaimRig(t)
	bx, by := local(campCX, campCY, fakegen.Boulder)
	gather := func(p *campGoer, who, action, target string, status int) string {
		t.Helper()
		x.refresh(p.c, &p.s)
		tool := x.instance(p.s.AccountID, map[string]string{"break": "bench-pick", "chop": "bench-axe"}[action], -1, "")
		f := map[string]any{"tool": tool, "action": action, "target": target, "tile": [2]int{bx, by}, "visitId": who, "progress": standAt(p.s, "outdoors", bx, by)}
		v := x.items("POST", "/api/items/gather", body(p.s, fmt.Sprintf("gather-%s-%d", who, keySeq()), f), p.c, status)
		return v.Error.Code
	}
	x.rule(x.alice, "except", []string{x.bob.s.AccountID}, 200)
	for _, a := range [][2]string{{"break", "boulder"}, {"chop", "tree"}} {
		if code := gather(&x.bob, "bob-"+a[0], a[0], a[1], 409); code != "not-your-camp" {
			t.Fatalf("bob %s at the camp: %s", a[0], code)
		}
	}
	gather(&x.dav, "dave", "break", "boulder", 200)
	x.rule(x.alice, "household", nil, 200)
	if code := gather(&x.dav, "dave-2", "break", "boulder", 409); code != "not-your-camp" {
		t.Fatalf("dave broke stone at the camp: %s", code)
	}
}
