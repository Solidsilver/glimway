package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/habitica"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"glimway/server/internal/store/storetest"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestRouteMetadataLabelsAndSanitizedUnexpectedErrors(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	for _, action := range []string{"clear", "lay", "lift", "discover", "claim", "lantern", "echo"} {
		path := "/api/wilds/" + action
		x.logs.Reset()
		response := x.rawHTTP("POST", path, map[string]any{}, c)
		if response.Code != 400 {
			t.Fatalf("%s status %d", path, response.Code)
		}
		if !strings.Contains(x.logs.String(), "route="+path+" ") {
			t.Fatalf("missing action label: %s", x.logs.String())
		}
	}
	x.logs.Reset()
	x.rawHTTP("GET", "/api/operations/result", nil, c)
	if !strings.Contains(x.logs.String(), "route=/api/operations/result ") {
		t.Fatal(x.logs.String())
	}
	for _, path := range []string{"/api/progress", "/api/sync"} {
		if routeFor("POST", path) != nil {
			t.Fatal("retired route metadata", path)
		}
	}
	x.api.Config.State = storetest.FakeState{PlayerStateFunc: func(context.Context, *sql.Tx, store.Snapshot, time.Time) (*contract.PlayerState, error) {
		return nil, errors.New("untrusted body and token: " + secret)
	}}
	x.logs.Reset()
	response := x.rawHTTP("GET", "/api/state?token="+secret, nil, c)
	if response.Code != 500 || !strings.Contains(response.Body.String(), `"internal"`) {
		t.Fatal(response.Code, response.Body.String())
	}
	logs := x.logs.String()
	if !strings.Contains(logs, "unexpected route=/api/state error_type=*errors.errorString") {
		t.Fatal("unexpected error lost", logs)
	}
	if strings.Contains(logs, secret) || strings.Contains(logs, c.Value) || strings.Contains(logs, "untrusted body") || strings.Contains(response.Body.String(), secret) {
		t.Fatal("diagnostic leaked untrusted data")
	}
}

func TestProjectionUsesOneTimestampAtTurning(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	turning := content.CalendarAt(content.CalendarRules, x.now.Load()).NextTurning
	x.now.Store(turning - 1)
	before := x.near(c, 2, -4, 200)
	reads := 0
	x.api.Config.Now = func() time.Time { now := time.Unix(turning-1+int64(reads), 0); reads++; return now }
	response := x.rawHTTP("GET", "/api/state", nil, c)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	state := &contract.StateResponse{}
	if err := protojson.Unmarshal(response.Body.Bytes(), state); err != nil {
		t.Fatal(err)
	}
	if state.State.Rumour == nil || state.State.Rumour.Epoch != before.Wick.Id {
		t.Fatalf("projection crossed turning: %v", state.State.Rumour)
	}
	if reads != 1 || response.Header().Get("X-Glimway-Now") != strconv.FormatInt(turning-1, 10) {
		t.Fatalf("clock reads=%d header=%s", reads, response.Header().Get("X-Glimway-Now"))
	}
}

// A sign-in's clock is the login transaction's, sampled after the Habitica
// proof: the limiters and the precheck never seed it (review P3-1).
func TestSignInClockSampledAfterUpstreamWait(t *testing.T) {
	x := newRig(t)
	start := x.now.Load()
	if err := x.db.Allow(context.Background(), "alice", true, start); err != nil {
		t.Fatal(err)
	}
	x.api.Config.Now = func() time.Time {
		if x.calls.Load() == 0 {
			return time.Unix(start, 0)
		}
		return time.Unix(start+60, 0)
	}
	response := x.rawHTTP("POST", "/api/session", map[string]any{"userId": "alice", "token": secret}, nil)
	if response.Code != 200 || x.calls.Load() == 0 {
		t.Fatal(response.Code, x.calls.Load(), response.Body.String())
	}
	created := count(t, x.db, "SELECT max(created_at) FROM (SELECT created_at FROM sessions UNION ALL SELECT created_at FROM pending_sessions)")
	if created != int(start+60) || response.Header().Get("X-Glimway-Now") != strconv.FormatInt(start+60, 10) {
		t.Fatalf("session created_at=%d header=%s, want %d after the upstream wait", created, response.Header().Get("X-Glimway-Now"), start+60)
	}
}

// A refusal's stored committed version is the one its answer carries, after
// maintenance moved it (review P3-2).
func TestRefusedOperationStoresTheVersionItAnswers(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.staleCast(s.AccountID, s.WorldID, "water:village:gone-pond", "north", float64(x.now.Load()))
	response := x.rawHTTP("POST", "/api/homestead/buy", body(s, "buy-desk", map[string]any{"itemDef": "writing-desk"}), c)
	refusal := &contract.Refusal{}
	if err := protojson.Unmarshal(response.Body.Bytes(), refusal); err != nil || response.Code != 409 || refusal.Error.GetCode() != "not-a-member" {
		t.Fatal(response.Code, response.Body.String(), err)
	}
	if refusal.State.Version <= float64(s.State.Version) {
		t.Fatalf("maintenance did not move the version: %v -> %v", s.State.Version, refusal.State.Version)
	}
	stored := count(t, x.db, "SELECT committed_version FROM idempotency WHERE account_id=? AND key='buy-desk'", s.AccountID)
	if float64(stored) != refusal.State.Version {
		t.Fatalf("stored version %d, answered %v", stored, refusal.State.Version)
	}
}

// unreachableHabitica fails the sign-in's proof below the HTTP layer, with
// an error whose text carries the token.
type unreachableHabitica struct{ habitica.Upstream }

func (unreachableHabitica) VerifyLimited(context.Context, string, string, func() bool) (rules.Profile, []string, error) {
	return rules.Profile{}, nil, fmt.Errorf("dial habitica with %s: %w", secret, context.DeadlineExceeded)
}

// An upstream failure logs its type-only diagnostic before it becomes a 502,
// never the error text or the token (review P3-7).
func TestUpstreamFailureLogsTypeOnlyDiagnostic(t *testing.T) {
	x := newRig(t)
	if err := x.db.Allow(context.Background(), "alice", true, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	x.api.Habitica = unreachableHabitica{x.api.Habitica}
	x.logs.Reset()
	response := x.rawHTTP("POST", "/api/session", map[string]any{"userId": "alice", "token": secret}, nil)
	if response.Code != 502 || !strings.Contains(response.Body.String(), "habitica-unavailable") {
		t.Fatal(response.Code, response.Body.String())
	}
	logs := x.logs.String()
	if !strings.Contains(logs, "upstream route=/api/session error_type=*fmt.wrapError diagnostic=deadline-exceeded") {
		t.Fatal("upstream failure left no diagnostic:", logs)
	}
	if strings.Contains(logs, secret) || strings.Contains(logs, "dial habitica") {
		t.Fatal("diagnostic leaked the error text:", logs)
	}
}

func TestMaintenanceSettlesAndLapsesBeforePureProjection(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	now := x.now.Load()
	cast := x.staleCast(s.AccountID, s.WorldID, "water:village:gone-pond", "north", float64(now))
	if _, err := x.db.DB.Exec("INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES('abandoned',?,'abandoned',20,'checking',?)", s.AccountID, now-91); err != nil {
		t.Fatal(err)
	}
	response := x.rawHTTP("GET", "/api/state", nil, c)
	state := &contract.StateResponse{}
	if err := protojson.Unmarshal(response.Body.Bytes(), state); err != nil {
		t.Fatal(err)
	}
	version := count(t, x.db, "SELECT version FROM players WHERE account_id=?", s.AccountID)
	if state.State.Version != float64(version) || state.State.Version <= float64(s.State.Version) || state.State.Fishing.Cast != nil || state.State.Purse.Working != nil {
		t.Fatalf("version/content disagree: %v", state.State)
	}
	if got := x.topUpRow("abandoned"); got.State != "unconfirmed" {
		t.Fatal(got)
	}
	if count(t, x.db, "SELECT count(*) FROM fishing_casts WHERE id=? AND state='lapsed'", cast) != 1 {
		t.Fatal("cast not lapsed")
	}
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	snap, err := store.Load(context.Background(), tx, s.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	var before, after int
	tx.QueryRow("SELECT total_changes()").Scan(&before)
	projected, err := x.api.Config.State.PlayerState(context.Background(), tx, snap, time.Unix(now, 0))
	if err != nil {
		t.Fatal(err)
	}
	tx.QueryRow("SELECT total_changes()").Scan(&after)
	if before != after || projected.Version != float64(version) {
		t.Fatal(fmt.Sprintf("projection wrote: %d -> %d", before, after))
	}
}

func TestProjectionDoesNotRecoverOrLapseWithoutMaintenance(t *testing.T) {
	x := newRig(t)
	_, s := x.ready("alice")
	now := x.now.Load()
	x.staleCast(s.AccountID, s.WorldID, "water:village:gone-pond", "north", float64(now))
	if _, err := x.db.DB.Exec("INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES('abandoned-pure',?,'abandoned-pure',20,'checking',?)", s.AccountID, now-91); err != nil {
		t.Fatal(err)
	}
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	snap, err := store.Load(context.Background(), tx, s.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	var before, after int
	if err = tx.QueryRow("SELECT total_changes()").Scan(&before); err != nil {
		t.Fatal(err)
	}
	state, err := x.api.Config.State.PlayerState(context.Background(), tx, snap, time.Unix(now, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.QueryRow("SELECT total_changes()").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after || state.Purse.Working == nil || state.Fishing.Cast == nil || state.Version != float64(snap.Version) {
		t.Fatalf("projection ran maintenance: changes %d -> %d, purse=%v fishing=%v", before, after, state.Purse, state.Fishing)
	}
}

func TestPathOperationAndProjectionUseCapturedTurningTime(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	turning := content.CalendarAt(content.CalendarRules, x.now.Load()).NextTurning
	x.now.Store(turning - 1)
	before := x.near(c, 2, -4, 200)
	x.give(s.AccountID, "stone", 2)
	reads := 0
	x.api.Config.Now = func() time.Time {
		now := time.Unix(turning-1+int64(reads), 0)
		reads++
		x.now.Store(now.Unix())
		return now
	}
	tx, ty := local(2, -4, [2]int{3, 14})
	response, _ := x.pathOp(c, s, "lay", "at-turning", tx, ty+1, tx, ty, "stone", 200, before.Wick.Id)
	if reads != 1 || response.GetWildsLay().Ground.Epoch != before.Wick.Id || response.State.Rumour.Epoch != before.Wick.Id {
		t.Fatalf("operation/projection crossed turning: reads=%d response=%v", reads, response)
	}
}
