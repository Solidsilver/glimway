package api

import (
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"testing"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/wilds"
)

// keeper gives an account the Keeper's hand, as the quest's check-ledger
// step does.
func (x *rig) keeper(account string) {
	x.t.Helper()
	if _, err := x.db.DB.Exec("INSERT INTO story_marks VALUES(?,?,'server',?)", account, keeperHand, x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
}

// questAt puts an account at a quest's step.
func (x *rig) questAt(account, quest, step string) {
	x.t.Helper()
	if _, err := x.db.DB.Exec("INSERT OR REPLACE INTO quest_progress(account_id,quest,step,reached_at,gate_at) VALUES(?,?,?,?,?)", account, quest, step, x.now.Load(), x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
}

// hasMark: the account holds a story mark.
func (x *rig) hasMark(account, mark string) bool {
	x.t.Helper()
	return count(x.t, x.db, "SELECT count(*) FROM story_marks WHERE account_id=? AND mark=?", account, mark) == 1
}

// The square, where Mara keeps the ledger.
var town = [2]float64{72, 968}

// wild is a Wilds tile as a place to stand.
func wild(tx, ty int) [2]float64 { return [2]float64{float64(tx*16 + 8), float64(ty*16 + 8)} }

// questStep asks for a quest step standing at a point outdoors.
func (x *rig) questStep(c *http.Cookie, s response, quest, to string, at [2]float64, status int) string {
	x.t.Helper()
	got := x.exp("POST", "/api/quest/step", body(s, fmt.Sprintf("step-%s-%d", to, keySeq()), map[string]any{"quest": quest, "to": to, "where": map[string]any{"area": outdoorsArea, "x": at[0], "y": at[1]}}), c, status)
	return got.Error.Code
}

// landmarks reads the landmarks a lamp may be named by.
func (x *rig) landmarks(c *http.Cookie, lamp string) []*contract.LampLandmark {
	x.t.Helper()
	v := &contract.LampLandmarksRead{}
	x.mixedRead("/api/lamp-landmarks/"+url.PathEscape(lamp), c, v)
	return v.Landmarks
}

// withCutStone makes the test stone the quest's stone (the fake generator
// lays no road).
func withCutStone(t *testing.T) {
	was := cutStoneFor
	cutStoneFor = func(string, string) string { return testStone }
	t.Cleanup(func() { cutStoneFor = was })
}

// The parts of the form's own naming, by the road fallback.
var roadParts = []string{"first", "past", "whitequiet", "road", "dark", "hold-fast"}

// The whole quest after the Lantern Road: hear Mara, copy the cut at the
// stone, check it against the ledger for the Keeper's hand and its gifts,
// then light and name the stone. Each step waits for the one before, and
// the server's marks are the only way to the flag steps.
func TestKeepersHandQuest(t *testing.T) {
	x := newRig(t)
	x.withStone()
	withCutStone(t)
	c, s := x.ready("alice")
	x.seedOpeningDone(s.AccountID)
	sx, sy := local(2, -1, [2]int{testStoneTile[0] + 1, testStoneTile[1] + 1})
	copyCut := func(lamp string, fx, fy, status int) string {
		_, code := x.lampOp(c, s, &contract.CommunalLampRequest{Action: "copy", Lamp: lamp}, fx, fy, status)
		return code
	}
	if code := x.questStep(c, s, keepersHand, "hear-mara", town, 409); code != "not-next-step" {
		t.Fatalf("before the Lantern Road: %s", code)
	}
	x.questAt(s.AccountID, "lantern-road", "complete")
	if code := copyCut(testStone, sx, sy, 409); code != "not-next-step" {
		t.Fatalf("copied before Mara asked: %s", code)
	}
	x.questStep(c, s, keepersHand, "hear-mara", town, 200)
	if code := x.questStep(c, s, keepersHand, "copy-cut", town, 409); code != "not-next-step" {
		t.Fatalf("copied by saying so: %s", code)
	}
	if code := copyCut("lamp-stone:3:-1", sx, sy, 404); code != "no-lamp" {
		t.Fatalf("another stone: %s", code)
	}
	if code := copyCut(testStone, sx+8, sy, 409); code != "too-far-away" {
		t.Fatalf("from afar: %s", code)
	}
	copyCut(testStone, sx, sy, 200)
	if !x.hasMark(s.AccountID, keeperCut) {
		t.Fatal("no cut")
	}
	x.questStep(c, s, keepersHand, "copy-cut", wild(sx, sy), 200)
	// The ledger is Mara's, in the square.
	if code := x.questStep(c, s, keepersHand, "check-ledger", wild(sx, sy), 409); code != "wrong-area" {
		t.Fatalf("checked the ledger away from it: %s", code)
	}
	if x.hasMark(s.AccountID, keeperHand) {
		t.Fatal("a Keeper before the ledger")
	}
	x.questStep(c, s, keepersHand, "check-ledger", town, 200)
	if !x.hasMark(s.AccountID, keeperHand) || x.packQty(s.AccountID, "lamp-head") != 1 || x.packQty(s.AccountID, "lamp-wick") != 1 {
		t.Fatal("the ledger's gifts")
	}
	if !x.hasMark(s.AccountID, "paper:the-form-of-a-naming") {
		t.Fatal("no Form of a Naming")
	}
	// The ways-home recipe pages, which the bench asks for.
	for _, page := range []string{"recipe-homing-turncap", "recipe-lamp-ash-pouch"} {
		if count(t, x.db, "SELECT (SELECT coalesce(sum(qty),0) FROM item_stacks WHERE location='pack' AND owner=? AND item_def=?)+(SELECT count(*) FROM item_instances WHERE location='pack' AND owner=? AND item_def=?)", s.AccountID, page, s.AccountID, page) != 1 {
			t.Fatal("no page", page)
		}
	}
	if code := x.questStep(c, s, keepersHand, "keep-a-lamp", wild(sx, sy), 409); code != "not-next-step" {
		t.Fatalf("kept a lamp unseen: %s", code)
	}
	// The given wick lights the stone; that alone is the last step.
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "relight", Lamp: testStone}, sx, sy, 200)
	if !x.hasMark(s.AccountID, keeperLamp) || x.packQty(s.AccountID, "lamp-wick") != 0 {
		t.Fatal("relit without the mark")
	}
	x.questStep(c, s, keepersHand, "keep-a-lamp", wild(sx, sy), 200)
	// And named, it gives its ash once.
	v, _ := x.lampOp(c, s, &contract.CommunalLampRequest{Action: "name", Lamp: testStone, Parts: roadParts}, sx, sy, 200)
	if n := v.Lamp.GetNaming(); n == nil || n.Text != "You are the first lamp past the Whitequiet. Behind you the road; ahead the dark. Hold fast." || n.ShortName != "First lamp past the Whitequiet" || n.NamerId != s.AccountID || n.Landmark != "whitequiet" || len(n.Parts) != 6 {
		t.Fatalf("named: %+v", v.Lamp.GetNaming())
	}
	if x.packQty(s.AccountID, "lamp-ash") != 1 || !slices.Equal(v.Given, []string{"lamp-ash"}) {
		t.Fatal("no ash")
	}
}

// Naming is parts on offer only: every part one of content's, the landmark
// one the server found near this lamp, never free text; only a Keeper, from
// beside the lamp; once.
func TestLampNamingValidation(t *testing.T) {
	x := newRig(t)
	x.withStone()
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	sx, sy := local(2, -1, [2]int{testStoneTile[0] + 1, testStoneTile[1] + 1})
	name := func(cc *http.Cookie, ss response, parts []string, fx, fy, status int) string {
		_, code := x.lampOp(cc, ss, &contract.CommunalLampRequest{Action: "name", Lamp: testStone, Parts: parts}, fx, fy, status)
		return code
	}
	x.keeper(s.AccountID)
	if code := name(c, s, roadParts, sx, sy, 404); code != "no-lamp" {
		t.Fatalf("a dark stone named: %s", code)
	}
	x.stack(b.AccountID, "lamp-wick", "", 1)
	x.lampOp(bc, b, &contract.CommunalLampRequest{Action: "relight", Lamp: testStone}, sx, sy, 200)
	if x.hasMark(b.AccountID, keeperLamp) {
		t.Fatal("a mark without the hand")
	}
	if code := name(bc, b, roadParts, sx, sy, 409); code != "needs-keeper" {
		t.Fatalf("named without the hand: %s", code)
	}
	if code := name(c, s, roadParts, sx+8, sy, 409); code != "too-far-away" {
		t.Fatalf("named from afar: %s", code)
	}
	marks := x.landmarks(c, testStone)
	ids := []string{}
	for _, m := range marks {
		ids = append(ids, m.Id)
		if m.Id == testStone || m.Id == "site:"+testStone {
			t.Fatal("a lamp is its own landmark")
		}
	}
	if !slices.Contains(ids, "road") || !slices.Contains(ids, "whitequiet") {
		t.Fatalf("no fallbacks: %v", ids)
	}
	for label, parts := range map[string][]string{
		"too few":            {"first", "past", "whitequiet", "road", "dark"},
		"too many":           append(slices.Clone(roadParts), "stay"),
		"free text":          {"first", "past", "My Lamp", "road", "dark", "hold-fast"},
		"unknown ordinal":    {"zeroth", "past", "whitequiet", "road", "dark", "hold-fast"},
		"unknown relation":   {"first", "under", "whitequiet", "road", "dark", "hold-fast"},
		"unresolved place":   {"first", "past", "place:99:99", "road", "dark", "hold-fast"},
		"unresolved site":    {"first", "past", "site:cairn:9:9", "road", "dark", "hold-fast"},
		"a side as landmark": {"first", "past", "dark", "road", "dark", "hold-fast"},
		"unknown closing":    {"first", "past", "whitequiet", "road", "dark", "Goodbye."},
		"unknown side":       {"first", "past", "whitequiet", "road", "the sea", "hold-fast"},
	} {
		if code := name(c, s, parts, sx, sy, 409); code != "invalid-naming" {
			t.Fatalf("%s: %s", label, code)
		}
	}
	if count(x.t, x.db, "SELECT count(*) FROM lamp_namings") != 0 || x.packQty(s.AccountID, "lamp-ash") != 0 {
		t.Fatal("a refused naming wrote")
	}
	// Any offered landmark works, behind or ahead too.
	last := ids[len(ids)-1]
	name(c, s, []string{"second", "beside", ids[0], last, "home", "stay"}, sx, sy, 200)
	if code := name(c, s, roadParts, sx, sy, 409); code != "lamp-named" {
		t.Fatalf("named twice: %s", code)
	}
	if !x.hasMark(s.AccountID, keeperLamp) || x.packQty(s.AccountID, "lamp-ash") != 1 {
		t.Fatal("naming's mark and ash")
	}
}

// One ash per lamp, ever: not again for tending it, letting it go dark
// and relighting it, or lifting and setting a post again; its naming
// stays with it.
func TestLampAshOnlyOnce(t *testing.T) {
	x := newRig(t)
	x.withStone()
	c, s := x.ready("alice")
	x.keeper(s.AccountID)
	sx, sy := local(2, -1, [2]int{testStoneTile[0] + 1, testStoneTile[1] + 1})
	x.stack(s.AccountID, "lamp-wick", "", 2)
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "relight", Lamp: testStone}, sx, sy, 200)
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "name", Lamp: testStone, Parts: roadParts}, sx, sy, 200)
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "tend", Lamp: testStone}, sx, sy, 200)
	x.turn()
	x.turn()
	c, s = x.again("alice")
	if len(x.lamps(c)) != 0 {
		t.Fatal("the stone stayed lit")
	}
	v, _ := x.lampOp(c, s, &contract.CommunalLampRequest{Action: "relight", Lamp: testStone}, sx, sy, 200)
	if v.Lamp.GetNaming().GetShortName() != "First lamp past the Whitequiet" {
		t.Fatal("relit without its naming")
	}
	if _, code := x.lampOp(c, s, &contract.CommunalLampRequest{Action: "name", Lamp: testStone, Parts: roadParts}, sx, sy, 409); code != "lamp-named" {
		t.Fatalf("renamed: %s", code)
	}

	// A post: named, lifted, set again elsewhere. Same id, same naming, no ash.
	spots := x.campSpots(s.WorldID, 3, -1)
	lamp := x.carry(s.AccountID, "way-lamp")
	post := func(at, stand [2]int) {
		x.lampOp(c, s, &contract.CommunalLampRequest{Action: "post", ItemId: lamp, X: int32(at[0]), Y: int32(at[1])}, stand[0], stand[1], 200)
	}
	post(spots[0], spots[1])
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "name", Lamp: lamp, Parts: []string{"second", "beside", "road", "hearthwick", "wilds", "weave"}}, spots[1][0], spots[1][1], 200)
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "lift", Lamp: lamp}, spots[1][0], spots[1][1], 200)
	post(spots[2], spots[3])
	if _, code := x.lampOp(c, s, &contract.CommunalLampRequest{Action: "name", Lamp: lamp, Parts: roadParts}, spots[3][0], spots[3][1], 409); code != "lamp-named" {
		t.Fatalf("a post set again renamed: %s", code)
	}
	if x.packQty(s.AccountID, "lamp-ash") != 2 {
		t.Fatalf("ash: %d", x.packQty(s.AccountID, "lamp-ash"))
	}
}

// The latecomer: someone else lit the stone first. A Keeper finishes the
// quest by tending it, or by reading its naming; no race, no oil.
func TestKeepersHandLatecomerTendsOrReads(t *testing.T) {
	x := newRig(t)
	x.withStone()
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	cc, cs := x.member("carol", s.WorldID)
	sx, sy := local(2, -1, [2]int{testStoneTile[0] + 1, testStoneTile[1] + 1})
	x.stack(s.AccountID, "lamp-wick", "", 1)
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "relight", Lamp: testStone}, sx, sy, 200)
	for _, who := range []struct {
		c      *http.Cookie
		s      response
		action string
	}{{bc, b, "tend"}, {cc, cs, "read"}} {
		x.seedOpeningDone(who.s.AccountID)
		x.questAt(who.s.AccountID, "lantern-road", "complete")
		x.questAt(who.s.AccountID, keepersHand, "check-ledger")
		x.keeper(who.s.AccountID)
		if _, code := x.lampOp(who.c, who.s, &contract.CommunalLampRequest{Action: who.action, Lamp: testStone}, sx+8, sy, 409); code != "too-far-away" {
			t.Fatalf("%s from afar: %s", who.action, code)
		}
		v, _ := x.lampOp(who.c, who.s, &contract.CommunalLampRequest{Action: who.action, Lamp: testStone}, sx, sy, 200)
		if v.Lamp.GetId() != testStone || !x.hasMark(who.s.AccountID, keeperLamp) {
			t.Fatalf("%s: no mark", who.action)
		}
		x.questStep(who.c, who.s, keepersHand, "keep-a-lamp", wild(sx, sy), 200)
	}
	if x.packQty(b.AccountID, "hearth-oil")+x.packQty(cs.AccountID, "hearth-oil") != 0 || count(x.t, x.db, "SELECT count(*) FROM lamp_namings") != 0 {
		t.Fatal("the latecomers spent or named")
	}
}

// Setting a Built way-lamp takes the Keeper's hand; a camp's lamp is named
// by a Keeper who builds there, and the camp, the map's ledger and the
// near view all carry the naming.
func TestCampKeeperGateAndNaming(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	lamp := x.carry(s.AccountID, "way-lamp")
	x.stack(s.AccountID, "hearth-oil", "", 2)
	spots := x.campSpots(s.WorldID, campCX, campCY)
	at, stand := spots[0], spots[1]
	set := func(status int) string {
		_, code := x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(at[0]), Y: int32(at[1])}, stand[0], stand[1], status)
		return code
	}
	if code := set(409); code != "needs-keeper" || x.packQty(s.AccountID, "hearth-oil") != 2 {
		t.Fatalf("a camp without the hand: %s", code)
	}
	x.keeper(s.AccountID)
	set(200)
	name := func(cc *http.Cookie, ss response, from [2]int, status int) (*contract.CampResult, string) {
		return x.campOp(cc, ss, &contract.CampRequest{Action: "name", Camp: lamp, Parts: []string{"first", "above", "whitequiet", "road", "long-way", "stay"}}, from[0], from[1], status)
	}
	if _, code := name(bc, b, stand, 409); code != "needs-keeper" {
		t.Fatalf("named by bob: %s", code)
	}
	x.keeper(b.AccountID)
	if _, code := name(bc, b, stand, 409); code != "not-your-lamp" {
		t.Fatalf("named by a Keeper who doesn't build there: %s", code)
	}
	if _, code := name(c, s, [2]int{stand[0] + 9, stand[1]}, 409); code != "too-far-away" {
		t.Fatalf("named from afar: %s", code)
	}
	v, _ := name(c, s, stand, 200)
	if n := v.Camp.GetNaming(); n == nil || n.ShortName != "First lamp above the Whitequiet" || n.NamerId != s.AccountID || x.packQty(s.AccountID, "lamp-ash") != 1 {
		t.Fatalf("camp named: %+v", v.Camp.GetNaming())
	}
	if _, code := name(c, s, stand, 409); code != "lamp-named" {
		t.Fatalf("camp renamed: %s", code)
	}
	out := x.mapLand(bc, [2]int{campCX, campCY})
	if len(out.Lamps) != 1 || out.Lamps[0].Name != "First lamp above the Whitequiet" || out.Lamps[0].Naming == "" || out.Lamps[0].Namer == "" {
		t.Fatalf("the ledger: %+v", out.Lamps)
	}
	if cs := x.camps(bc); len(cs) != 1 || cs[0].GetNaming().GetText() == "" {
		t.Fatal("the camps read")
	}
}

// The quest's stone is the Lantern Road's first, out of the Whitequiet: the
// same for a seed every time, north of the Whitequiet, on Common land a
// player can reach.
func TestCutStoneIsTheFirstRoadStone(t *testing.T) {
	wq := wilds.Footprint("whitequiet")
	for _, seed := range []string{"seed-a", "seed-b", "glimway", "w-1234"} {
		id := cutStoneFor("w", seed)
		if id == "" || id != cutStoneFor("w", seed) {
			t.Fatalf("%s: no stable stone", seed)
		}
		stones := wilds.RoadStones(seed)
		i := slices.IndexFunc(stones, func(st wilds.RoadStone) bool { return st.ID == id })
		if i < 0 {
			t.Fatalf("%s: %s is no road stone", seed, id)
		}
		st := stones[i]
		if !visitable("w", st.CX, st.CY) || location.SourceOf(st.CX, st.CY).Kind != location.SourceGenerated || int32(st.CY) >= wq.GetCy() {
			t.Fatalf("%s: stone at %d,%d", seed, st.CX, st.CY)
		}
	}
	if q, ok := content.QuestFor(keepersHand); !ok || q.GetAfter()[0] != "lantern-road" {
		t.Fatal("the quest follows the Lantern Road")
	}
}
