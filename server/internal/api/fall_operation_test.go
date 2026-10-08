package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"testing"
)

func TestFallRecoveryReplayAndMissingGeometry(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.reportState(c, s, 0, 0, map[string]any{"area": "woodland", "x": 250, "y": 250})
	req := body(s, "fall-once", map[string]any{})
	read := func(fields map[string]any) *contract.Envelope {
		t.Helper()
		w := x.rawHTTP("POST", "/api/fall", fields, c)
		var out contract.Envelope
		if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatal(w.Body.String())
		}
		return &out
	}
	out := read(req)
	f := out.GetFall()
	if f == nil || f.Vitals.Hp != 13 || f.Vitals.Mana != 10 || f.Place.Area != "village" || f.Vitals.VitalsSetVersion != out.State.Version || f.Place.PlaceSetVersion != out.State.Version {
		t.Fatal(out)
	}
	s = x.expect("GET", "/api/state", nil, c, 200)
	s.Lease = req["op"].(map[string]any)["lease"].(string)
	s = x.reportState(c, s, 5, 0, testWhere(s.State))
	replay := read(req)
	if replay.State.Vitals.Hp != 5 || replay.GetFall().Vitals.Hp != 13 || replay.State.Version != float64(s.Version) {
		t.Fatal("fall replay healed", replay)
	}
	x.api.Config.Epochs = &chunks.FakeEpochs{CurrentFunc: func(context.Context, *sql.Tx, string, string, int64) (*contract.WildsEpoch, error) {
		return nil, chunks.ErrUnavailable
	}}
	req = body(s, "no-geometry", map[string]any{"where": map[string]any{"area": "wilds:outer-1", "x": 300, "y": 300}})
	out = read(req)
	if out.GetFall().Lantern != "none" || out.GetFall().Reason != "generator-unavailable" || out.State.Place.Area != "village" {
		t.Fatal(out)
	}
	// A zero Habitica HP baseline remains zero even though a fall was requested.
	x.db.DB.Exec("UPDATE sync_baselines SET profile_json=json_set(profile_json,'$.hp',0) WHERE account_id=?", s.AccountID)
	req = body(s, "zero-baseline", map[string]any{"where": map[string]any{"area": "village", "x": 0, "y": 0}})
	if out = read(req); out.State.Vitals.Hp != 0 {
		t.Fatal("zero baseline recovered", out)
	}
}

func TestEveryKeyedRouteRejectsProgressFields(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	before := x.expect("GET", "/api/state", nil, c, 200)
	for _, path := range []string{"/api/spend", "/api/quest/step", "/api/story/mark", "/api/papers/take", "/api/fall", "/api/wilds/echo", "/api/wilds/claim", "/api/wilds/lantern", "/api/items/use", "/api/homestead/buy", "/api/homestead/shelf", "/api/storage", "/api/craft", "/api/hearth/craft", "/api/desk/copy", "/api/homestead/woodpile", "/api/mail", "/api/mail/missing/claim", "/api/mail/missing/recall", "/api/projects/north-bridge/contribute", "/api/repairs/well-rope/mend", "/api/world/move", "/api/world/leave", "/api/library/donate"} {
		req := body(s, "old-body", map[string]any{"baseRev": s.Version, "progress": map[string]any{}})
		raw, _ := json.Marshal(req)
		w := x.rawHTTP("POST", path, json.RawMessage(raw), c)
		if w.Code != 400 {
			t.Fatalf("%s accepted upload: %d %s", path, w.Code, w.Body.String())
		}
	}
	unchanged(t, before.Snapshot, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
}
