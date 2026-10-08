package api

import (
	"context"
	"encoding/json"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestEveryClientMarkNamespaceThroughOperation(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	// Examples from the builders in residents, heard, guides, nudges, unmoored,
	// homestead and Session.enter/found/defeated; every table namespace is swept.
	marks := map[string]string{"seen:": "seen:wilds:inner-1", "met:": "met:mara@accepted", "heard:": "heard:mara@home:0", "guide:": "guide:lantern-road:accept", "nudge:": "nudge:pip-gate", "unmoored:": "unmoored:felt", "home:met-silas": "home:met-silas", "home:arrived": "home:arrived", "found:": "found:route-marker", "defeated:": "defeated:wisp-a"}
	for _, ns := range content.StoryRules.Namespaces {
		if ns.Writer != "client" {
			continue
		}
		mark, ok := marks[ns.Prefix]
		if !ok {
			t.Fatal("builder vector missing", ns.Prefix)
		}
		area := "village"
		if ns.Prefix == "home:met-silas" {
			area = "commons"
		}
		if ns.Prefix == "home:arrived" {
			area = "home:42"
		}
		if ns.Prefix == "found:" || ns.Prefix == "defeated:" {
			area = "woodland"
		}
		w := x.rawHTTP("POST", "/api/story/mark", body(s, ns.Prefix, map[string]any{"mark": mark, "where": map[string]any{"area": area, "x": 400, "y": 300}}), c)
		var out contract.Envelope
		if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &out) != nil || !slices.Contains(out.State.Story.Marks, mark) {
			t.Fatal(ns.Prefix, w.Code, w.Body.String())
		}
	}
	for _, mark := range []string{"met:mara@future", "met:@accepted", "heard:mara@", "heard:mara@@intro", "heard:mara@bad.name"} {
		w := x.rawHTTP("POST", "/api/story/mark", body(s, "invalid", map[string]any{"mark": mark}), c)
		if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid-json") {
			t.Fatal(mark, w.Code, w.Body.String())
		}
	}
}

func TestTerminalSpendRefusalReplaysWithCurrentState(t *testing.T) {
	x := newRig(t)
	c, p := x.reportSetup()
	first := x.sendReport(c, p, 1, p.State.Version, 10, 0, 0, "village")
	req := &contract.SpendRequest{Op: &contract.OpHeader{Lease: p.Lease, Key: "short-forever", Report: &contract.ReportBarrier{Client: "tab-a", Generation: p.ReportGeneration, Seq: 1}}, Where: &contract.Where{Area: "village", X: 400, Y: 300}, Kind: "rest"}
	send := func() *contract.Refusal {
		t.Helper()
		raw, _ := protojson.Marshal(req)
		w := x.rawHTTP("POST", "/api/spend", json.RawMessage(raw), c)
		var out contract.Refusal
		if w.Code != 409 || protojson.Unmarshal(w.Body.Bytes(), &out) != nil || out.Error.Code != "short" {
			t.Fatal(w.Code, w.Body.String())
		}
		return &out
	}
	refused := send()
	if !proto.Equal(first.State, refused.State) {
		t.Fatal("refusal changed gameplay")
	}
	x.fund(x.account("alice"), 10, 0)
	req.Op.Report = nil // Replays need no report; header changes do not change identity.
	replay := send()
	if replay.State.Embers.Balance != 10 || replay.State.Version <= refused.State.Version || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='spend'") != 0 {
		t.Fatal("refused key committed", replay)
	}
	w := x.rawHTTP("GET", "/api/operations/result?route=%2Fapi%2Fspend&key=short-forever", nil, c)
	var out struct {
		Result struct {
			Operation struct {
				Refused     string
				Payload     map[string]json.RawMessage
				PayloadHash string
			}
		}
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || out.Result.Operation.Refused != "short" || string(out.Result.Operation.Payload["kind"]) != `"rest"` || len(out.Result.Operation.PayloadHash) != 64 {
		t.Fatal(w.Body.String())
	}
	req.Kind = "chest"
	raw, _ := protojson.Marshal(req)
	w = x.rawHTTP("POST", "/api/spend", json.RawMessage(raw), c)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "idempotency-mismatch") {
		t.Fatal(w.Body.String())
	}
}

func TestQuestWrongAreaRollsBackEveryReward(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.seedOpeningDone(s.AccountID)
	x.quest(c, &s, "accepted", "village")
	x.quest(c, &s, "clue-found", "ruin")
	before := x.expect("GET", "/api/state", nil, c, 200)
	w := x.rawHTTP("POST", "/api/quest/step", body(s, "wrong-area", map[string]any{"quest": "lantern-road", "to": "guardian-defeated", "where": map[string]any{"area": "village", "x": 400, "y": 300}}), c)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "wrong-area") {
		t.Fatal(w.Body.String())
	}
	unchanged(t, before.Snapshot, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='quest'") != 0 || count(t, x.db, "SELECT count(*) FROM story_marks WHERE mark IN ('warden-seal','paper:eleven-days','defeated:stone-warden')") != 0 {
		t.Fatal("wrong-area leaked rewards")
	}
}

func TestReportCooldownWithAmpleManaAndPlayTimeGeneration(t *testing.T) {
	x := newRig(t)
	c, p := x.reportSetup()
	tx, _ := x.db.DB.Begin()
	s, err := store.Load(context.Background(), tx, x.account("alice"))
	if err != nil {
		t.Fatal(err)
	}
	class := "healer"
	s.ImportedProfile.Class = &class
	s.ImportedProfile.MaxMP = 200
	s.State.MaxMana = 200
	s.State.Mana = 100
	s.State.HP = 10
	s.VitalsWritten = true
	if err = store.Persist(context.Background(), tx, &s, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	a := x.sendReport(c, p, 1, float64(s.Version), 50, 200, 1, "village")
	if a.GetReport().Casts != 1 || a.State.Story.PlaySeconds != 0 || a.State.Vitals.Mana < 60 {
		t.Fatal(a)
	}
	b := x.sendReport(c, p, 2, a.State.Version, 50, 200, 1, "village")
	if b.GetReport().Casts != 0 || b.State.Vitals.Mana != a.State.Vitals.Mana {
		t.Fatal("same-time cooldown reused", a, b)
	}
	x.now.Add(100)
	d := x.sendReport(c, p, 3, b.State.Version, 50, 200, 0, "village")
	if d.State.Story.PlaySeconds != 30 {
		t.Fatal("gap cap", d)
	}
	w := x.rawHTTP("POST", "/api/play", map[string]any{"clientId": "tab-b", "takeOver": true}, c)
	var replacement contract.PlayResponse
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &replacement) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	old := &contract.ReportRequest{Lease: replacement.Lease, Client: "tab-a", Generation: p.ReportGeneration, Seq: 4, Basis: d.State.Version, Hp: 1, Place: &contract.Where{Area: "village"}}
	raw, _ := protojson.Marshal(old)
	w = x.rawHTTP("POST", "/api/report", json.RawMessage(raw), c)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "superseded") || strings.Contains(w.Body.String(), `"state"`) {
		t.Fatal("retired generation", w.Body.String())
	}
	x.now.Add(60)
	fresh := &contract.ReportRequest{Lease: replacement.Lease, Client: "tab-b", Generation: replacement.ReportGeneration, Seq: 1, Basis: replacement.State.Version, Hp: replacement.State.Vitals.Hp, Mana: replacement.State.Vitals.Mana, Place: &contract.Where{Area: "village"}}
	raw, _ = protojson.Marshal(fresh)
	w = x.rawHTTP("POST", "/api/report", json.RawMessage(raw), c)
	var out contract.Envelope
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &out) != nil || out.State.Story.PlaySeconds != 30 {
		t.Fatal("first report counted generation gap", w.Code, w.Body.String())
	}
}

func TestSubsecondFallDoesNotCreateCombatBudget(t *testing.T) {
	x := newRig(t)
	c, p := x.reportSetup()
	tx, _ := x.db.DB.Begin()
	s, err := store.Load(context.Background(), tx, x.account("alice"))
	if err != nil {
		t.Fatal(err)
	}
	class := "healer"
	s.ImportedProfile.Class = &class
	s.ImportedProfile.MP = 30
	s.ImportedProfile.MaxMP = 30
	s.State.Mana = 0
	s.State.HP = 1
	s.VitalsWritten = true
	if err = store.Persist(context.Background(), tx, &s, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	clock := time.Unix(x.now.Load()+1, 900_000_000)
	x.api.Config.Now = func() time.Time { return clock }
	req := &contract.FallRequest{Op: &contract.OpHeader{Lease: p.Lease, Key: "fractional-fall"}, Where: &contract.Where{Area: "woodland", X: 400, Y: 300}}
	raw, _ := protojson.Marshal(req)
	w := x.rawHTTP("POST", "/api/fall", json.RawMessage(raw), c)
	var fall contract.Envelope
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &fall) != nil {
		t.Fatal(w.Body.String())
	}
	if fall.State.Vitals.VitalsAt != float64(clock.UnixNano())/1e9 || fall.State.Vitals.CastReadyAt != fall.State.Vitals.VitalsAt {
		t.Fatal("rounded refill", fall)
	}
	clock = time.Unix(clock.Unix()+1, 0)
	// 15 recovered mana + only 0.1s regeneration cannot fund an 18-mana cast.
	out := x.sendReport(c, p, 1, fall.State.Version, 50, 30, 2, "village")
	if out.GetReport().Casts != 0 || out.State.Vitals.Mana >= 17 {
		t.Fatal("refill created mana/time", out)
	}
}

func TestUnmooredOnlyConsumablesNeedNoCombatBarrierOrWatermark(t *testing.T) {
	for _, item := range []string{"comfrey-salve", "willow-bark-tea"} {
		t.Run(item, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.stack(s.AccountID, item, "", 1)
			before := x.rawHTTP("GET", "/api/state", nil, c)
			var prior contract.StateResponse
			protojson.Unmarshal(before.Body.Bytes(), &prior)
			req := body(s, "unmoored-only", map[string]any{"itemDef": item, "unmoored": true})
			raw, _ := json.Marshal(req)
			w := x.rawHTTP("POST", "/api/items/use", json.RawMessage(raw), c)
			var out struct{ State json.RawMessage }
			json.Unmarshal(w.Body.Bytes(), &out)
			var state contract.PlayerState
			if w.Code != 200 || protojson.Unmarshal(out.State, &state) != nil || !proto.Equal(prior.State.Vitals, state.Vitals) {
				t.Fatal(w.Code, w.Body.String())
			}
			if count(t, x.db, "SELECT count(*) FROM item_stacks WHERE owner=? AND item_def=?", s.AccountID, item) != 0 {
				t.Fatal("did not consume")
			}
		})
	}
}

func TestWitnessMarkByteBudgetParity(t *testing.T) {
	raw, err := os.ReadFile("../../../content/vectors/witness.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Beat, Doer, Name, Mark string }
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		if got := witnessMark(v.Beat, v.Doer, v.Name); got != v.Mark {
			t.Fatal(got, v.Mark)
		}
	}

	doer := strings.Repeat("a", 128)
	got := witnessMark("echo:dorrit", doer, strings.Repeat("🦊", 60))
	if len(got) > 256 || !validWitnessMark(got) || !strings.HasPrefix(got, "witness:echo-dorrit:") {
		t.Fatal(len(got), got)
	}
}

func TestMarkCapPreservesLegacyStoryLimitAndEconomyExemption(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	if _, err := x.db.DB.Exec("WITH RECURSIVE n(v) AS (SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<4095) INSERT INTO story_marks SELECT ?, 'seen:'||v,'client',? FROM n", s.AccountID, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	if _, err := x.db.DB.Exec("INSERT INTO outcomes VALUES(?,'lit:road-1','spend',?)", s.AccountID, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	w := x.rawHTTP("POST", "/api/story/mark", body(s, "cap-duplicate", map[string]any{"mark": "seen:0"}), c)
	if w.Code != 200 {
		t.Fatal("existing mark/economy exceeded story cap", w.Body.String())
	}
	w = x.rawHTTP("POST", "/api/story/mark", body(s, "cap-overflow", map[string]any{"mark": "seen:overflow"}), c)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "unknown-mark") || count(t, x.db, "SELECT count(*) FROM story_marks WHERE mark='seen:overflow'") != 0 {
		t.Fatal("cap failed", w.Body.String())
	}
}
