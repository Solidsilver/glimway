package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"math"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestContractGate(t *testing.T) {
	x := newRig(t)
	for _, header := range []string{"", "3", "5", "7", "05", "+5", "5.0", " 5", "bad"} {
		for _, route := range []struct{ method, path string }{{"GET", "/api/state"}, {"POST", "/api/session"}, {"POST", "/api/story/mark"}} {
			r := httptest.NewRequest(route.method, route.path, strings.NewReader(`{"userId":"alice","token":"test"}`))
			r.Header.Set("X-Glimway-Contract", header)
			w := httptest.NewRecorder()
			x.api.ServeHTTP(w, r)
			if w.Code != 409 || !strings.Contains(w.Body.String(), `"code":"reload-needed"`) {
				t.Fatal(header, w.Code, w.Body.String())
			}
		}
	}
	if x.calls.Load() != 0 {
		t.Fatal("gate called Habitica")
	}
	for _, path := range []string{"/api/health", "/api/calendar", "/api/sprites/nonexistent.png"} {
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if strings.Contains(w.Body.String(), "reload-needed") {
			t.Fatal("public route gated", path)
		}
	}
	if content.ContractNumber != 6 {
		t.Fatal("unexpected contract number")
	}
}
func TestKeyedOpCurrentReplayAndAtomicRefusal(t *testing.T) {
	x := newRig(t)
	cookie, s := x.ready("alice")
	calls := 0
	request := &contract.MarkRequest{Op: &contract.OpHeader{Lease: s.Lease, Key: "key"}, Mark: "seen:client-mark", Where: &contract.Where{Area: "village", X: 2, Y: 3}}
	run := func(apply func(context.Context, *sql.Tx, *store.Snapshot, int64) (any, error)) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "https://game.test/api/story/mark", nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		if err := x.api.keyedOp(w, r, request.Op, request.Where, request, apply); err != nil {
			problem(w, err)
		}
		return w
	}
	apply := func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		calls++
		s.State.Flags = append(s.State.Flags, request.Mark)
		return &contract.MarkResult{Mark: request.Mark, Added: true}, nil
	}
	first := run(apply)
	var committed contract.Envelope
	if err := protojson.Unmarshal(first.Body.Bytes(), &committed); err != nil || first.Code != 200 {
		t.Fatal(first.Code, first.Body.String(), err)
	}
	next := x.expect("POST", "/api/play", map[string]any{"clientId": "device", "takeOver": true}, cookie, 200)
	request.Op.Lease = next.Lease
	request.Op.Report = &contract.ReportBarrier{Client: "replacement", Generation: "new", Seq: 9}
	replay := run(apply)
	var replayed contract.Envelope
	if err := protojson.Unmarshal(replay.Body.Bytes(), &replayed); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || replayed.State.Version != float64(next.Version) || replayed.GetMark().Mark != committed.GetMark().Mark {
		t.Fatal("replay must combine original result and current state")
	}
	var stored string
	if err := x.db.DB.QueryRow("SELECT result_json FROM idempotency WHERE key='key'").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, `"state"`) || strings.Contains(stored, `"version"`) {
		t.Fatal("stored snapshot", stored)
	}
	request.Where.X = 4
	if w := run(apply); w.Code != 409 || !strings.Contains(w.Body.String(), "idempotency-mismatch") {
		t.Fatal(w.Code, w.Body.String())
	}
	request.Where.X = 2
	request.Op.Key = "barrier-blocked"
	request.Where.X = 90
	blocked := run(apply)
	var blockedState contract.Refusal
	if err := protojson.Unmarshal(blocked.Body.Bytes(), &blockedState); err != nil {
		t.Fatal(err)
	}
	if blocked.Code != 409 || blockedState.Error.Code != "report-required" || blockedState.State.Place.X != 2 || calls != 1 {
		t.Fatal("barrier must precede placement and callback", blocked.Body.String())
	}
	request.Where.X = 2
	request.Op.Report = nil
	request.Op.Key = "refusal"
	before := next.Version
	refused := run(func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		s.State.HP = 1
		if _, err := tx.ExecContext(ctx, "UPDATE balances SET embers=999 WHERE account_id=?", s.AccountID); err != nil {
			return nil, err
		}
		return nil, fail(409, "not-next-step")
	})
	var refusal contract.Refusal
	if err := protojson.Unmarshal(refused.Body.Bytes(), &refusal); err != nil {
		t.Fatal(err)
	}
	if refused.Code != 409 || refusal.Error.Code != "not-next-step" || refusal.State.Version != float64(before) || refusal.State.Embers.Balance == 999 {
		t.Fatal("refusal leaked partial writes", refused.Body.String())
	}
	request.Op.Key = "mixed"
	mixed := run(func(context.Context, *sql.Tx, *store.Snapshot, int64) (any, error) {
		return map[string]any{"items": []string{}, "home": nil, "materials": map[string]int{}}, nil
	})
	var fields map[string]json.RawMessage
	if json.Unmarshal(mixed.Body.Bytes(), &fields) != nil || len(fields) != 2 {
		t.Fatal("mixed wire", mixed.Body.String())
	}
	request.Op.Key = "nonfinite"
	bad := run(func(context.Context, *sql.Tx, *store.Snapshot, int64) (any, error) {
		return &contract.ReportResult{Seq: math.NaN()}, nil
	})
	if bad.Code != 500 {
		t.Fatal("nonfinite output committed")
	}
	request.Op.Lease = "old"
	if w := run(apply); w.Code != 409 || strings.Contains(w.Body.String(), `"state"`) {
		t.Fatal("lease refusal must be code-only")
	}
}
func TestPlayGenerationsAndReportBarrier(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	var first contract.PlayResponse
	w := x.rawHTTP("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c)
	if err := protojson.Unmarshal(w.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	var second contract.PlayResponse
	w = x.rawHTTP("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c)
	if err := protojson.Unmarshal(w.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if first.Lease != s.Lease || first.ReportGeneration != second.ReportGeneration || second.State.Version != first.State.Version+1 {
		t.Fatal("same-tab reload did not resume generation")
	}
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	barrier := &contract.ReportBarrier{Client: second.ReportClient, Generation: second.ReportGeneration, Seq: 2}
	if requireReportBarrier(context.Background(), tx, x.account("alice"), barrier) == nil {
		t.Fatal("unacknowledged report accepted")
	}
	if _, err = tx.Exec("UPDATE player_vitals SET report_seq=2,report_basis=vitals_set_version WHERE account_id='" + x.account("alice") + "'"); err != nil {
		t.Fatal(err)
	}
	if err = requireReportBarrier(context.Background(), tx, x.account("alice"), barrier); err != nil {
		t.Fatal(err)
	}
	barrier.Generation = "retired-generation"
	if requireReportBarrier(context.Background(), tx, x.account("alice"), barrier) == nil {
		t.Fatal("retired generation accepted")
	}
}

func TestOperationStubsAndNumericWire(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	for _, raw := range []string{`{"lease":"x","seq":"1"}`, `{"lease":"x","basis":"NaN"}`, `{"lease":"x","report_generation":"alias"}`, `{"lease":"x","progress":{}}`} {
		r := httptest.NewRequest("POST", "/api/report", strings.NewReader(raw))
		w := httptest.NewRecorder()
		if decodeOp(w, r, &contract.ReportRequest{}) == nil {
			t.Fatal("invalid request accepted", raw)
		}
	}
	if _, err := x.db.DB.Exec("UPDATE player_vitals SET cast_ready_at=? WHERE account_id='"+x.account("alice")+"'", x.now.Load()+60); err != nil {
		t.Fatal(err)
	}
	w := x.rawHTTP("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c)
	var play contract.PlayResponse
	if err := protojson.Unmarshal(w.Body.Bytes(), &play); err != nil {
		t.Fatal(err)
	}
	if play.State.Vitals.CastReadyAt != float64(x.now.Load()+60) {
		t.Fatal("reconnect reset persistent cast debt")
	}
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	snap, err := store.Load(context.Background(), tx, x.account("alice"))
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Persist(context.Background(), tx, &snap, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	wire, err := store.PlayerState(context.Background(), tx, snap)
	if err != nil || wire.Vitals.CastReadyAt != play.State.Vitals.CastReadyAt || wire.Vitals.VitalsSetVersion != play.State.Vitals.VitalsSetVersion {
		t.Fatal("server refill reset budget or omitted watermark", err)
	}
}

func TestRetiredTrustRoutesB5(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("retirement-hero")
	for _, route := range []struct{ method, path string }{{"PUT", "/api/progress"}, {"POST", "/api/sync"}, {"POST", "/api/spend"}, {"POST", "/api/wilds/claim"}, {"POST", "/api/wilds/lantern"}, {"POST", "/api/wilds/defeat"}, {"POST", "/api/origin"}} {
		w := x.rawHTTP(route.method, route.path, map[string]any{"lease": s.Lease, "baseRev": s.Version, "progress": s.State, "doc": s.State}, c)
		if w.Code != 404 && w.Code != 405 {
			t.Errorf("old trust route %s %s remains: %d", route.method, route.path, w.Code)
		}
	}
}

func TestIndependentPlaceAndVitalsWatermarks(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("watermark-subject")
	account := x.account("watermark-subject")
	if _, err := x.db.DB.Exec(`UPDATE player_vitals SET report_seq=2,report_basis=vitals_set_version,cast_ready_at=? WHERE account_id=?`, x.now.Load()+60, account); err != nil {
		t.Fatal(err)
	}
	var before contract.StateResponse
	w := x.rawHTTP("GET", "/api/state", nil, c)
	if err := protojson.Unmarshal(w.Body.Bytes(), &before); err != nil {
		t.Fatal(err)
	}
	barrier := &contract.ReportBarrier{Client: before.State.Vitals.ReportClient, Generation: before.State.Vitals.ReportGeneration, Seq: 2}
	request := &contract.MarkRequest{Op: &contract.OpHeader{Lease: s.Lease, Key: "unrelated-crafting", Report: barrier}, Where: &contract.Where{Area: "commons", X: 5, Y: 6}, Mark: "seen:fixture"}
	run := func(refill bool) *contract.Envelope {
		r := httptest.NewRequest("POST", "/api/story/mark", nil)
		r.AddCookie(c)
		out := httptest.NewRecorder()
		if err := x.api.keyedOp(out, r, request.Op, request.Where, request, func(_ context.Context, _ *sql.Tx, s *store.Snapshot, _ int64) (any, error) {
			s.VitalsWritten = refill
			return &contract.MarkResult{Mark: request.Mark, Added: true}, nil
		}); err != nil {
			t.Fatal(err)
		}
		var envelope contract.Envelope
		if err := protojson.Unmarshal(out.Body.Bytes(), &envelope); err != nil {
			t.Fatal(out.Code, out.Body.String(), err)
		}
		return &envelope
	}
	unrelated := run(false)
	if unrelated.State.Place.PlaceSetVersion != unrelated.State.Version || unrelated.State.Vitals.VitalsSetVersion != before.State.Vitals.VitalsSetVersion || unrelated.State.Vitals.VitalsAt != before.State.Vitals.VitalsAt || unrelated.State.Vitals.CastReadyAt != before.State.Vitals.CastReadyAt {
		t.Fatal("unrelated operation altered combat budget")
	}
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = requireReportBarrier(context.Background(), tx, account, barrier); err != nil {
		tx.Rollback()
		t.Fatal("place write invalidated combat report", err)
	}
	tx.Rollback()
	request.Op.Key = "explicit-refill"
	refilled := run(true)
	if refilled.State.Vitals.VitalsSetVersion != refilled.State.Version || refilled.State.Vitals.CastReadyAt != before.State.Vitals.CastReadyAt {
		t.Fatal("refill watermark/debt")
	}
	tx, err = x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if requireReportBarrier(context.Background(), tx, account, barrier) == nil {
		t.Fatal("server vitals write accepted stale combat report")
	}
}

func TestSharedBoundsAndStatefulPlacementRefusals(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("bounded-subject")
	for _, area := range []string{"invented", "wilds:unknown"} {
		w := x.rawHTTP("POST", "/api/story/mark", map[string]any{"op": map[string]any{"lease": s.Lease, "key": "unknown-area"}, "where": map[string]any{"area": area}, "mark": "seen:fixture"}, c)
		if w.Code != 409 || !strings.Contains(w.Body.String(), "invalid-position") || !strings.Contains(w.Body.String(), `"state"`) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := x.rawHTTP("POST", "/api/story/mark", map[string]any{"where": map[string]any{"area": "village"}}, c)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid-json") {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, raw := range []string{`{"seq":9007199254740992}`, `{"basis":0.5}`, `{"casts":-1}`, `{"hp":-1}`, `{"mana":-1}`, `{"client":"bad/client"}`, `{"client":"bad:client"}`} {
		r := httptest.NewRequest("POST", "/api/report", strings.NewReader(raw))
		if decodeOp(httptest.NewRecorder(), r, &contract.ReportRequest{}) == nil {
			t.Fatal("unsafe report accepted", raw)
		}
	}
	witness := "witness:warden:" + strings.Repeat("a", 64) + ":" + strings.Repeat("灯", 50)
	for _, mark := range []string{witness, witness + strings.Repeat("灯", 50)} {
		raw, _ := json.Marshal(map[string]any{"mark": mark})
		err := decodeOp(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/story/mark", strings.NewReader(string(raw))), &contract.MarkRequest{})
		if (err == nil) != (len(mark) <= 256) {
			t.Fatal("witness UTF-8 bound", len(mark), err)
		}
	}
	for _, client := range []string{"bad:id", "bad/client", strings.Repeat("x", 129)} {
		w := x.rawHTTP("POST", "/api/play", map[string]any{"clientId": client}, c)
		if w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	err = requireReportBarrier(context.Background(), tx, "no-vitals", &contract.ReportBarrier{Client: "client", Generation: "generation", Seq: 1})
	var refusal *failure
	if !errors.As(err, &refusal) || refusal.code != "report-required" {
		t.Fatal("missing row must be retryable", err)
	}
}
