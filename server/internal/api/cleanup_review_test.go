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
