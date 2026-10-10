package api

import (
	"context"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"math"
	"slices"
	"testing"
)

func fixtureQuests(t *testing.T, quests ...*content.Quest) {
	t.Helper()
	old := content.QuestRules
	content.QuestRules = append([]*content.Quest{}, old...)
	for _, quest := range quests {
		i := slices.IndexFunc(content.QuestRules, func(q *content.Quest) bool { return q.GetId() == quest.GetId() })
		if i < 0 {
			content.QuestRules = append(content.QuestRules, quest)
		} else {
			content.QuestRules[i] = quest
		}
	}
	t.Cleanup(func() { content.QuestRules = old })
}

// trig builds a one-kind step trigger (the generated trigger's optional
// scalars are pointers; the kind is set through the field named kind).
func trig(kind, target string) *content.QuestTrigger {
	t := &content.QuestTrigger{}
	switch kind {
	case "talk":
		t.Talk = proto.String(target)
	case "use":
		t.Use = proto.String(target)
	case "reach":
		t.Reach = proto.String(target)
	case "defeat":
		t.Defeat = proto.String(target)
	case "carry":
		t.Carry = proto.String(target)
	case "flag":
		t.Flag = proto.String(target)
	case "open":
		t.Open = proto.String(target)
	case "sync":
		t.Sync = proto.String(target)
	}
	return t
}

func plainStep(id string) *content.QuestStep {
	// Optional scalars are pointers on the generated type; open is set.
	open := "journal"
	return &content.QuestStep{Id: id, Do: &content.QuestTrigger{Open: &open}}
}

func TestRoomPositionAndPresence(t *testing.T) {
	for _, area := range []string{"in:village:bakery", "in:village:mill", "in:village:mill:2", "in:village:library", "in:home:0", "in:home:9999"} {
		if !validArea(area) || !validPresenceRoom(area) || !rules.IsSafeArea(area) {
			t.Fatal(area)
		}
		if !finiteWhere(&contract.Where{Area: area, X: 8, Y: 8}) {
			t.Fatal(area)
		}
		for _, p := range []rules.Position{{X: -1, Y: 8}, {X: 8, Y: -1}, {X: 10000, Y: 8}, {X: 8, Y: 10000}, {X: math.NaN(), Y: 8}} {
			if finiteWhere(&contract.Where{Area: area, X: p.X, Y: p.Y}) {
				t.Fatal(area, p)
			}
		}
	}
	for _, area := range []string{"in:village:missing", "in:village:mill:1", "in:home:00", "in:home:10000"} {
		if validArea(area) || validPresenceRoom(area) {
			t.Fatal(area)
		}
	}
	room, _ := content.RoomFor("in:village:bakery")
	if finiteWhere(&contract.Where{Area: room.GetId(), X: float64(len(room.GetMap()[0]) * 16), Y: 8}) || finiteWhere(&contract.Where{Area: room.GetId(), X: 8, Y: float64(len(room.GetMap()) * 16)}) {
		t.Fatal("exclusive bounds")
	}
	// The cottage: its floor grid plus the walls (14 x 14 tiles); you come in at the doorway, low in the room.
	if !finiteWhere(&contract.Where{Area: "in:home:0", X: 104, Y: 184}) || finiteWhere(&contract.Where{Area: "in:home:0", X: 224, Y: 8}) || finiteWhere(&contract.Where{Area: "in:home:0", X: 8, Y: 224}) {
		t.Fatal("cottage bounds")
	}
	x := newRig(t)
	c, s := x.ready("alice")
	before := x.expect("GET", "/api/state", nil, c, 200).Snapshot
	refusal := x.exp("POST", "/api/story/mark", body(s, "bad-room", map[string]any{"mark": "seen:room", "where": map[string]any{"area": "in:village:missing", "x": 8, "y": 8}}), c, 409)
	if refusal.Error.Code != "invalid-position" {
		t.Fatal(refusal)
	}
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	s = x.reportState(c, s, s.State.HP, s.State.Mana, map[string]any{"area": room.GetId(), "x": 80, "y": 80})
	if x.expect("GET", "/api/state", nil, c, 200).State.Area != room.GetId() {
		t.Fatal("room not saved")
	}
}

func TestResidentChecksWithGraceAndReach(t *testing.T) {
	s := store.Snapshot{State: rules.NewState()}
	hazel, _ := content.ResidentByID("hazel")
	for _, row := range []struct {
		now  int64
		spot string
		yes  bool
	}{{0, "kitchen", true}, {1200, "square", false}, {2310, "square", true}, {2400, "kitchen", true}, {2490, "kitchen", true}, {2491, "kitchen", false}, {3000, "square", true}} {
		p := hazel.GetSpots()[row.spot]
		s.State.Area = p.GetArea()
		s.State.Position = rules.Position{X: float64(p.GetTx()*16 + 8), Y: float64(p.GetTy()*16 + 8)}
		if personHere("hazel", p.GetArea(), row.now) != row.yes || nearResident(&s, "hazel", row.now, 4) != row.yes {
			t.Fatal(row)
		}
		s.State.Position.X += 100
		if nearResident(&s, "hazel", row.now, 4) {
			t.Fatal("out of reach")
		}
	}
	if personHere("mara", "in:village:bakery", 0) || !personHere("mara", "village", 0) {
		t.Fatal("fixed talk area")
	}
	finn, _ := content.ResidentAt("finn", 3000)
	s.State.Area = finn.GetArea()
	s.State.Position = rules.Position{X: float64(finn.GetTx()*16 + 8), Y: float64(finn.GetTy()*16 + 8)}
	if finn.GetArea() != "in:village:mill:2" || !nearResident(&s, "finn", 3000, 4) {
		t.Fatal(finn)
	}
}

func TestQuestGatesAtomicReplayAndTimes(t *testing.T) {
	keep := false
	start := plainStep("start")
	middle := plainStep("middle")
	finish := plainStep("finish")
	hours2, hours1, two := 2.0, 1.0, int32(2)
	withHazel := "hazel"
	finish.Gate = &content.QuestGate{With: withHazel, Wait: &content.QuestWait{Hours: &hours2}, Item: &content.QuestGateItem{Def: "flour", Qty: 1, Keep: &keep}, Glims: &two}
	finish.Give = []*content.QuestItem{{Def: "keepers-twists", Qty: 2}}
	finish.Glims = 2
	finish.Items = []string{"tally-token"}
	finish.Marks = []string{"library:lamp"}
	later := plainStep("later")
	later.Gate = &content.QuestGate{Wait: &content.QuestWait{Hours: &hours1}}
	fixtureQuests(t, &content.Quest{Id: "test-bread", Steps: []*content.QuestStep{start, middle, finish, later}}, &content.Quest{Id: "test-other", Steps: []*content.QuestStep{plainStep("start")}})
	x := newRig(t)
	x.now.Store(0)
	c, s := x.ready("alice")
	id := x.account("alice")
	call := func(quest, to, key, area string, status int) expansionResponse {
		return x.exp("POST", "/api/quest/step", body(s, key, map[string]any{"quest": quest, "to": to, "where": map[string]any{"area": area, "x": 80, "y": 80}}), c, status)
	}
	s.Snapshot = call("test-bread", "start", "start", "in:village:bakery", 200).Snapshot
	x.now.Store(3600)
	s.Snapshot = call("test-bread", "middle", "middle", "in:village:bakery", 200).Snapshot
	if s.State.GateAt["test-bread"] != 0 || s.State.ReachedAt["test-bread"] != 3600 {
		t.Fatal(s.State)
	}
	s.Snapshot = call("test-other", "start", "other", "in:village:bakery", 200).Snapshot
	before := x.expect("GET", "/api/state", nil, c, 200).Snapshot
	for i, row := range []struct {
		now        int64
		area, code string
	}{{4000, "village", "not-here"}, {3600, "in:village:bakery", "not-yet"}, {7200, "in:village:bakery", "short"}} {
		x.now.Store(row.now)
		got := call("test-bread", "finish", fmt.Sprint("refuse", i), row.area, 409)
		if got.Error.Code != row.code {
			t.Fatal(got)
		}
		unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	}
	if _, err := x.db.DB.Exec("INSERT INTO item_stacks(location,owner,item_def,qty) VALUES('pack',?,'flour',1)", id); err != nil {
		t.Fatal(err)
	}
	got := call("test-bread", "finish", "short-embers", "in:village:bakery", 409)
	if got.Error.Code != "short" || count(t, x.db, "SELECT qty FROM item_stacks WHERE item_def='flour'") != 1 {
		t.Fatal(got)
	}
	x.fund(id, 2, 0)
	req := body(s, "finish", map[string]any{"quest": "test-bread", "to": "finish", "where": map[string]any{"area": "in:village:bakery", "x": 80, "y": 80}})
	result := x.expect("POST", "/api/quest/step", req, c, 200)
	if result.State.Quests["test-bread"] != "finish" || result.State.Quests["test-other"] != "start" || result.State.GateAt["test-bread"] != 7200 || result.State.Glims != 2 {
		t.Fatal(result)
	}
	var envelope contract.Envelope
	w := x.rawHTTP("POST", "/api/quest/step", req, c)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if err := protojson.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.GetQuestStep().GlimsSpent != 2 || len(envelope.GetQuestStep().Taken) != 1 || len(envelope.GetQuestStep().Given) != 1 {
		t.Fatal(&envelope)
	}
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE item_def='keepers-twists'") != 2 || count(t, x.db, "SELECT count(*) FROM item_stacks WHERE item_def='flour'") != 0 || count(t, x.db, "SELECT count(*) FROM ledger WHERE currency='glims' AND reason='quest'") != 2 {
		t.Fatal("duplicate or missing spending/grants")
	}
	if call("test-bread", "finish", "repeat", "in:village:bakery", 409).Error.Code != "not-next-step" {
		t.Fatal("repeated arrival")
	}
	if call("test-bread", "later", "wait-again", "in:village:bakery", 409).Error.Code != "not-yet" {
		t.Fatal("wait must count from last gate")
	}
	x.now.Store(10800)
	s.Snapshot = call("test-bread", "later", "later", "in:village:bakery", 200).Snapshot
	if s.State.GateAt["test-bread"] != 10800 {
		t.Fatal(s.State.GateAt)
	}
}

func TestQuestTriggerPredicates(t *testing.T) {
	x := newRig(t)
	_, _ = x.ready("alice")
	tx, _ := x.db.DB.Begin()
	defer tx.Rollback()
	snap, err := store.Load(context.Background(), tx, x.account("alice"))
	if err != nil {
		t.Fatal(err)
	}
	snap.State.Area = "in:village:library"
	cases := []struct {
		trigger *content.QuestTrigger
		success bool
	}{{trig("open", "journal"), true}, {trig("reach", "in:village:library"), true}, {trig("reach", "village"), false}, {trig("use", "library-shelf"), true}, {trig("use", "sponge-bowl"), false}, {trig("talk", "mara"), false}, {trig("defeat", "stone-warden"), false}, {trig("carry", "flour"), false}, {trig("carry", "tally-token"), false}, {trig("flag", "library:lamp"), false}, {trig("sync", "glims"), false}}
	for _, row := range cases {
		err = questTrigger(context.Background(), tx, &snap, "test", &content.QuestStep{Do: row.trigger}, 100)
		if (err == nil) != row.success {
			t.Fatal(row, err)
		}
	}
	snap.State.DefeatedEnemies = append(snap.State.DefeatedEnemies, "stone-warden")
	snap.State.Inventory = append(snap.State.Inventory, "tally-token")
	snap.State.Flags = append(snap.State.Flags, "library:lamp")
	for _, trigger := range []*content.QuestTrigger{trig("defeat", "stone-warden"), trig("carry", "tally-token"), trig("flag", "library:lamp")} {
		if err = questTrigger(context.Background(), tx, &snap, "test", &content.QuestStep{Do: trigger}, 100); err != nil {
			t.Fatal(err)
		}
	}
	snap.State.ReachedAt["test"] = 100
	if err = store.Credit(context.Background(), tx, &snap, 1, 1, "sync", "test", nil, 100); err != nil {
		t.Fatal(err)
	}
	trigger := &content.QuestStep{Do: trig("sync", "glims")}
	if questTrigger(context.Background(), tx, &snap, "test", trigger, 100) == nil {
		t.Fatal("same-second sync")
	}
	if err = store.Credit(context.Background(), tx, &snap, 1, 1, "sync", "test", nil, 101); err != nil {
		t.Fatal(err)
	}
	if err = questTrigger(context.Background(), tx, &snap, "test", trigger, 101); err != nil {
		t.Fatal(err)
	}
}

func TestQuestPrerequisitesAndHabitica(t *testing.T) {
	first := plainStep("first")
	last := plainStep("last")
	fixtureQuests(t, &content.Quest{Id: "test-before", Steps: []*content.QuestStep{first, last}})
	s := store.Snapshot{State: rules.NewState(), ProfileSource: "demo"}
	habitica := "habitica"
	q := &content.Quest{After: []string{"test-before:first"}, Needs: habitica}
	if questPrerequisites(s, q) == nil {
		t.Fatal("missing prerequisite")
	}
	s.State.Quests["test-before"] = "first"
	if err := questPrerequisites(s, q); err == nil || err.(*failure).code != "needs-habitica" {
		t.Fatal(err)
	}
	s.ProfileSource = "habitica"
	if err := questPrerequisites(s, q); err != nil {
		t.Fatal(err)
	}
	q.After = []string{"test-before"}
	if questPrerequisites(s, q) == nil {
		t.Fatal("whole quest incomplete")
	}
	s.State.Quests["test-before"] = "last"
	if err := questPrerequisites(s, q); err != nil {
		t.Fatal(err)
	}
}

func TestQuestKeepInstancesAndEarnedGlims(t *testing.T) {
	x := newRig(t)
	_, s := x.ready("alice")
	id := s.AccountID
	tx, _ := x.db.DB.Begin()
	defer tx.Rollback()
	snap, err := store.Load(context.Background(), tx, id)
	if err != nil {
		t.Fatal(err)
	}
	d, _ := content.ItemFor("bench-axe")
	tool, err := newInstance(context.Background(), tx, d, instanceAt{"pack", id}, "", -1, 100)
	if err != nil {
		t.Fatal(err)
	}
	fitting, _ := content.ItemFor("loose-road-nail")
	fitted, err := newInstance(context.Background(), tx, fitting, instanceAt{"fitted", tool}, "", -1, 100)
	if err != nil {
		t.Fatal(err)
	}
	keep := true
	step := plainStep("take")
	two := int32(2)
	step.Gate = &content.QuestGate{Item: &content.QuestGateItem{Def: "bench-axe", Qty: 1, Keep: &keep}, Glims: &two}
	snap.State.Glims = 3
	snap.State.XPGlims = 1
	snap.State.HP = 0
	if err = checkQuestGate(context.Background(), tx, &snap, "test", step, 100); err == nil || err.(*failure).code != "needs-earned" {
		t.Fatal(err)
	}
	snap.State.XPGlims = 2
	if err = checkQuestGate(context.Background(), tx, &snap, "test", step, 100); err != nil {
		t.Fatal(err)
	}
	out := &contract.QuestStepResult{}
	if err = spendQuestGate(context.Background(), tx, &snap, "test", step, 100, out); err != nil {
		t.Fatal(err)
	}
	if snap.State.XPGlims != 0 || snap.State.Glims != 1 || len(out.Taken) != 0 {
		t.Fatal(snap.State, out)
	}
	var n int
	tx.QueryRow("SELECT count(*) FROM item_instances WHERE id=?", tool).Scan(&n)
	if n != 1 {
		t.Fatal("keep lost instance")
	}
	keep = false
	step.Gate.Glims = nil
	if err = spendQuestGate(context.Background(), tx, &snap, "test", step, 101, out); err != nil {
		t.Fatal(err)
	}
	tx.QueryRow("SELECT count(*) FROM item_instances WHERE id=?", tool).Scan(&n)
	if n != 0 {
		t.Fatal("take kept instance")
	}
	var location, owner string
	if err = tx.QueryRow("SELECT location,owner FROM item_instances WHERE id=?", fitted).Scan(&location, &owner); err != nil || location != "pack" || owner != id {
		t.Fatal(location, owner, err)
	}
	if err = questGive(context.Background(), tx, &snap, &content.QuestItem{Def: "bench-axe", Qty: 2}, "test:give", 102); err != nil {
		t.Fatal(err)
	}
	n, err = questItemCount(context.Background(), tx, id, "bench-axe")
	if err != nil || n != 2 {
		t.Fatal(n, err)
	}
}

func TestOpeningTopupOnce(t *testing.T) {
	first := plainStep("see-mara")
	first.Glims = 5
	first.Marks = []string{"lit:road-1", "quest-item:tally-token"}
	fixtureQuests(t, &content.Quest{Id: "signpost", Steps: []*content.QuestStep{first}})
	for _, balance := range []int{0, 1, 3, 9} {
		t.Run(fmt.Sprint(balance), func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.fund(s.AccountID, balance, 0)
			req := body(s, "mara", map[string]any{"quest": "signpost", "to": "see-mara"})
			s.Snapshot = x.expect("POST", "/api/quest/step", req, c, 200).Snapshot
			if s.State.Glims != balance+5+max(0, 3-balance) {
				t.Fatal(s.State.Glims)
			}
			x.expect("POST", "/api/quest/step", req, c, 200)
			reloaded := x.expect("GET", "/api/state", nil, c, 200)
			if reloaded.State.Glims != s.State.Glims || !questHasMark(&reloaded.Snapshot, "lit:road-1") || !questHasMark(&reloaded.Snapshot, "quest-item:tally-token") {
				t.Fatal(reloaded.State)
			}
			if count(t, x.db, "SELECT count(*) FROM outcomes WHERE outcome_id='quest-gift:signpost:topup'") != 1 {
				t.Fatal("topup outcome")
			}
		})
	}
}

func TestIndoorsRestAndGathering(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fund(s.AccountID, 10, 0)
	x.claimGate(c, &s, 0)
	// With the cottage up, the doorstep no longer rests you (the tier-0 bedroll does: TestHomeRestAndSafeBoundaries).
	if _, err := x.db.DB.Exec("UPDATE homesteads SET tier=1 WHERE gate=0"); err != nil {
		t.Fatal(err)
	}
	doc := s.State
	doc.Area = "home:0"
	doc.Position = rules.Position{X: 80, Y: 80}
	doc.HP = 1
	s = x.reportState(c, s, doc.HP, doc.Mana, testWhere(doc))
	if got := x.exp("POST", "/api/spend", spendBody(s, "home-rest", "", "doorstep", doc), c, 409); got.Error.Code != "not-at-own-plot" {
		t.Fatal(got)
	}
	doc.Area = "in:home:0"
	x.expect("POST", "/api/spend", spendBody(s, "home-rest", "", "cottage", doc), c, 200)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	doc = s.State
	doc.Area = "in:village:library"
	doc.Position = rules.Position{X: 80, Y: 80}
	doc.HP = 1
	s = x.reportState(c, s, doc.HP, doc.Mana, testWhere(doc))
	x.expect("POST", "/api/spend", spendBody(s, "rest", "", "library-rest", doc), c, 200)
	for _, area := range []string{"in:village:bakery", "in:village:mill:2", "in:home:0"} {
		doc.Area = area
		got := x.opRefreshing(c, &s, "gather", gatherIn(s, area, [2]int{5, 5}, "", "chop", "tree", "indoors"), 409)
		if got.Error.Code != "cannot-gather-here" {
			t.Fatal(area, got.Error.Code)
		}
	}
}

func TestRoomsHaveSeparatePresence(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	ts := startPresence(t, x, presenceTestConfig())
	alice := wsConnect(t, ts, c, s.Lease)
	bob := wsConnect(t, ts, bc, b.Lease)
	if len(alice.join("in:village:mill").Players) != 0 || len(bob.join("village").Players) != 0 {
		t.Fatal("indoors leaked outdoors")
	}
	alice.none()
	bob.none()
	if len(bob.join("in:village:mill:2").Players) != 0 {
		t.Fatal("floor leaked downstairs")
	}
	bob.none()
	roster := bob.join("in:village:mill")
	if len(roster.Players) != 1 || roster.Players[0].AccountID != s.AccountID {
		t.Fatal("room roster", roster.Raw)
	}
	alice.expect("join")
	bob.none()
	bob.join("in:home:0")
	alice.expect("leave")
	if len(alice.join("in:home:0").Players) != 1 {
		t.Fatal("cottage visitors")
	}
	bob.expect("join")
}

func TestWorldMoveAndLeaveFromVillageRooms(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	_, party := x.ready("olive")
	x.hero("hal", "Hal", "")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	c, s := x.again("hal")
	doc := s.State
	doc.Area = "in:village:library"
	doc.Position = rules.Position{X: 80, Y: 80}
	moved := x.worldReq("POST", "/api/world/move", body(s, "room-move", map[string]any{"worldId": party.WorldID, "progress": doc}), c, 200)
	if moved.WorldID != party.WorldID {
		t.Fatal(moved.raw)
	}
	x.hero("hal", "Hal", "")
	c, s = x.again("hal")
	doc = s.State
	doc.Area = "in:village:mill:2"
	doc.Position = rules.Position{X: 80, Y: 80}
	left := x.worldReq("POST", "/api/world/leave", body(s, "room-leave", map[string]any{"progress": doc}), c, 200)
	if left.WorldID == party.WorldID {
		t.Fatal(left.raw)
	}
}

// Road-focused tests start after the opening, as migrated 0.3 accounts do.
// Seed only completion: the tutorial gifts must not affect their ledger checks.
func (x *rig) seedOpeningDone(account string) {
	x.t.Helper()
	opening, ok := content.QuestFor("signpost")
	if !ok {
		x.t.Fatal("missing opening")
	}
	_, err := x.db.DB.Exec("INSERT INTO quest_progress(account_id,quest,step,reached_at,gate_at) VALUES(?,'signpost',?,?,?)", account, opening.GetSteps()[len(opening.GetSteps())-1].GetId(), x.now.Load(), x.now.Load())
	if err != nil {
		x.t.Fatal(err)
	}
}

func TestAuthoredOpeningUnlocksLanternRoad(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	refused := x.exp("POST", "/api/quest/step", body(s, "before-opening", map[string]any{"quest": "lantern-road", "to": "accepted"}), c, 409)
	if refused.Error.Code != "not-next-step" {
		t.Fatal(refused.Error.Code)
	}
	opening, ok := content.QuestFor("signpost")
	if !ok {
		t.Fatal("missing opening")
	}
	for _, step := range opening.Steps {
		doc := s.State
		if step.At != "" {
			doc.Area = step.GetAt()
		} else if step.GetWhere() != nil && step.GetWhere().GetArea() != "" {
			doc.Area = step.GetWhere().GetArea()
		}
		if step.GetDo().GetDefeat() != "" {
			s.Snapshot = x.expect("POST", "/api/story/mark", body(s, "defeat-"+step.GetId(), map[string]any{"mark": "defeated:" + step.GetDo().GetDefeat(), "where": testWhere(doc)}), c, 200).Snapshot
		}
		if step.GetDo().GetFlag() == "lit:road-1" {
			s.Snapshot = x.expect("POST", "/api/spend", body(s, "first-lamp", map[string]any{"kind": "road-lantern", "target": "road-1", "where": testWhere(doc)}), c, 200).Snapshot
		}
		s.Snapshot = x.expect("POST", "/api/quest/step", body(s, "opening-"+step.GetId(), map[string]any{"quest": opening.GetId(), "to": step.GetId(), "where": testWhere(doc)}), c, 200).Snapshot
		if s.State.Quests[opening.GetId()] != step.GetId() {
			t.Fatal(s.State.Quests)
		}
	}
	doc := s.State
	doc.Area = "village"
	s.Snapshot = x.expect("POST", "/api/quest/step", body(s, "after-opening", map[string]any{"quest": "lantern-road", "to": "accepted", "where": testWhere(doc)}), c, 200).Snapshot
	if s.State.Quests["lantern-road"] != "accepted" {
		t.Fatal(s.State.Quests)
	}
}
