package api

import (
	"context"
	"encoding/json"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"net/http"
	"slices"
	"testing"
)

func (x *rig) reportSetup() (*http.Cookie, *contract.PlayResponse) {
	x.t.Helper()
	c, _ := x.ready("alice")
	w := x.rawHTTP("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c)
	var p contract.PlayResponse
	if e := protojson.Unmarshal(w.Body.Bytes(), &p); e != nil {
		x.t.Fatal(e)
	}
	return c, &p
}
func (x *rig) sendReport(c *http.Cookie, p *contract.PlayResponse, seq, basis, hp, mana, casts float64, area string) *contract.Envelope {
	x.t.Helper()
	req := &contract.ReportRequest{Lease: p.Lease, Client: "tab-a", Generation: p.ReportGeneration, Seq: seq, Basis: basis, Hp: hp, Mana: mana, Casts: casts, Place: &contract.Where{Area: area, X: 400, Y: 300}}
	raw, _ := protojson.Marshal(req)
	w := x.rawHTTP("POST", "/api/report", json.RawMessage(raw), c)
	var out contract.Envelope
	if e := protojson.Unmarshal(w.Body.Bytes(), &out); e != nil || w.Code != 200 {
		x.t.Fatal(w.Code, w.Body.String(), e)
	}
	return &out
}
func TestReportPersistentManaCooldownAndReplay(t *testing.T) {
	x := newRig(t)
	c, p := x.reportSetup()
	class := "healer"
	tx, e := x.db.DB.Begin()
	if e != nil {
		t.Fatal(e)
	}
	s, e := store.Load(context.Background(), tx, x.account("alice"))
	if e != nil {
		t.Fatal(e)
	}
	s.ImportedProfile.Class = &class
	s.State.Mana = 18
	s.State.HP = 10
	s.VitalsWritten = true
	if e = store.Persist(context.Background(), tx, &s, x.now.Load()); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	first := x.sendReport(c, p, 1, float64(s.Version), 50, 18, 1, "village")
	if first.GetReport().Casts != 1 || first.State.Vitals.Mana != 0 || first.State.Vitals.Hp != 16 {
		t.Fatal(first)
	}
	second := x.sendReport(c, p, 2, first.State.Version, 50, 18, 1, "village")
	if second.GetReport().Casts != 0 || second.State.Vitals.Mana != 0 || second.State.Vitals.Hp != 16 {
		t.Fatal(second)
	}
	replay := x.sendReport(c, p, 2, first.State.Version, 50, 18, 1, "village")
	if replay.State.Version != second.State.Version || replay.GetReport().Casts != 0 {
		t.Fatal(replay)
	}
	x.now.Add(1)
	third := x.sendReport(c, p, 3, second.State.Version, 50, 50, 100, "village")
	if third.GetReport().Casts != 0 || third.State.Vitals.Mana != 16 {
		t.Fatal(third)
	}
}
func TestReportWatermarksAndBarrier(t *testing.T) {
	x := newRig(t)
	c, p := x.reportSetup()
	first := x.sendReport(c, p, 1, p.State.Version, 10, 0, 0, "woodland")
	raw := map[string]any{"op": map[string]any{"lease": p.Lease, "key": "m"}, "mark": "seen:test", "where": map[string]any{"area": "village", "x": 2, "y": 3}}
	w := x.rawHTTP("POST", "/api/story/mark", raw, c)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	placed := x.sendReport(c, p, 2, first.State.Version, 5, 0, 0, "ruin")
	if !placed.GetReport().Accepted || !placed.GetReport().PlaceIgnored || placed.State.Place.Area != "village" || placed.State.Vitals.Hp != 5 {
		t.Fatal(placed)
	}
	tx, _ := x.db.DB.Begin()
	s, e := store.Load(context.Background(), tx, x.account("alice"))
	if e != nil {
		t.Fatal(e)
	}
	s.VitalsWritten = true
	s.State.HP = 20
	if e = store.Persist(context.Background(), tx, &s, x.now.Load()); e != nil {
		t.Fatal(e)
	}
	tx.Commit()
	stale := x.sendReport(c, p, 3, placed.State.Version, 1, 0, 1, "ruin")
	if !stale.GetReport().StaleBasis || stale.GetReport().Accepted || stale.State.Vitals.Hp != 20 || stale.State.Version != float64(s.Version+1) {
		t.Fatal(stale)
	}
	tx, _ = x.db.DB.Begin()
	if e = requireReportBarrier(context.Background(), tx, s.AccountID, &contract.ReportBarrier{Client: "tab-a", Generation: p.ReportGeneration, Seq: 3}); e == nil {
		t.Fatal("stale basis satisfied barrier")
	}
	tx.Rollback()
	accepted := x.sendReport(c, p, 4, stale.State.Version, 20, 0, 0, "village")
	tx, _ = x.db.DB.Begin()
	if e = requireReportBarrier(context.Background(), tx, s.AccountID, &contract.ReportBarrier{Client: "tab-a", Generation: p.ReportGeneration, Seq: 4}); e != nil {
		t.Fatal(e)
	}
	tx.Rollback()
	if accepted.State.Vitals.VitalsSetVersion != float64(s.Version) {
		t.Fatal("report advanced server vitals watermark")
	}
}
func TestReportPartitionBudget(t *testing.T) {
	class := "healer"
	p := profile("hero", 1, 0, 50)
	p.Class = &class
	s := store.Snapshot{State: rules.NewState(), ImportedProfile: &p}
	s.State.HP = 10
	s.State.MaxMana = 200
	s.State.Mana = 100
	hp, mp, n, ready := boundReport(s, 50, 200, 1, 100, 100, 100)
	s.State.HP, s.State.Mana = hp, mp
	_, split, n2, _ := boundReport(s, 50, 200, 1, 100, ready, 101)
	original := s
	original.State.HP = 10
	original.State.Mana = 100
	_, coalesced, n3, _ := boundReport(original, 50, 200, 2, 100, 100, 101)
	if n+n2 != n3 || split != coalesced {
		t.Fatal("partition creates budget", n, n2, n3, split, coalesced)
	}
	// Refill preserves a future cooldown debt.
	_, _, allowed, _ := boundReport(original, 50, 200, 10, 101, 104, 102)
	if allowed != 0 {
		t.Fatal("refill erased debt")
	}
}
func TestQuestOperationsMarksAndPaperRules(t *testing.T) {
	x := newRig(t)
	c, p := x.reportSetup()
	request := func(path, key string, fields map[string]any, area string, status int) *contract.Envelope {
		t.Helper()
		fields["op"] = map[string]any{"lease": p.Lease, "key": key}
		fields["where"] = map[string]any{"area": area, "x": 25*16 + 8, "y": 14*16 + 8}
		w := x.rawHTTP("POST", path, fields, c)
		if w.Code != status {
			t.Fatal(w.Code, w.Body.String())
		}
		var out contract.Envelope
		if status == 200 {
			if e := protojson.Unmarshal(w.Body.Bytes(), &out); e != nil {
				t.Fatal(e)
			}
		}
		return &out
	}
	request("/api/quest/step", "skip", map[string]any{"quest": "lantern-road", "to": "complete"}, "village", 409)
	for _, step := range content.QuestRules[0].Steps {
		out := request("/api/quest/step", step.ID, map[string]any{"quest": "lantern-road", "to": step.ID}, step.At, 200)
		if out.GetQuestStep().Step != step.ID {
			t.Fatal(out)
		}
	}
	if count(t, x.db, "SELECT SUM(delta) FROM ledger WHERE reason='quest'") != 5 {
		t.Fatal("quest gift sum")
	}
	request("/api/story/mark", "forged", map[string]any{"mark": "paper:eleven-days"}, "village", 409)
	request("/api/story/mark", "unknown", map[string]any{"mark": "found:unknown"}, "ruin", 409)
	request("/api/story/mark", "area", map[string]any{"mark": "defeated:wisp-a"}, "village", 409)
	request("/api/papers/take", "unbuilt", map[string]any{"paper": "joss-penhallow-letter-map-case"}, "village", 409)
	out := request("/api/papers/take", "placed", map[string]any{"paper": "pip-copybook-warden-corrections"}, "village", 200)
	if !out.GetTakePaper().Added {
		t.Fatal(out)
	}
}

func TestStorySetProjectionStableBeforeAndAfterReload(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	for _, m := range []string{"seen:z", "seen:a", "found:old-route-marker", "defeated:stone-warden"} {
		w := x.rawHTTP("POST", "/api/story/mark", body(s, m, map[string]any{"mark": m, "where": map[string]any{"area": "ruin", "x": 300, "y": 300}}), c)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var out contract.Envelope
		if e := protojson.Unmarshal(w.Body.Bytes(), &out); e != nil {
			t.Fatal(e)
		}
		read := x.rawHTTP("GET", "/api/state", nil, c)
		var state contract.StateResponse
		if e := protojson.Unmarshal(read.Body.Bytes(), &state); e != nil {
			t.Fatal(e)
		}
		if !proto.Equal(out.State, state.State) {
			t.Fatal("same version changed after reload", out.State, state.State)
		}
		if !slices.Contains(out.State.Story.Marks, m) {
			t.Fatal("mark missing from wire source", m)
		}
	}
}
