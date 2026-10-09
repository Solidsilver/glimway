package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

type operationLookup struct {
	State struct {
		Version float64 `json:"version"`
	} `json:"state"`
	Result struct {
		Operation *struct {
			Route, Key, PayloadHash, ResultType, ResultCase string
			Version                                         float64
			Payload                                         map[string]json.RawMessage
			Result                                          json.RawMessage
		} `json:"operation"`
	} `json:"result"`
}

func TestCommittedOperationLookupIdentifiesMismatchedPayload(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	original := body(s, "collision", map[string]any{"mark": "seen:original"})
	landed := x.rawHTTP("POST", "/api/story/mark", original, c)
	if landed.Code != 200 {
		t.Fatal(landed.Body.String())
	}
	different := body(s, "collision", map[string]any{"mark": "seen:different"})
	refusal := x.rawHTTP("POST", "/api/story/mark", different, c)
	if refusal.Code != 409 {
		t.Fatal(refusal.Body.String())
	}
	var fields map[string]json.RawMessage
	json.Unmarshal(refusal.Body.Bytes(), &fields)
	if fields["state"] == nil {
		t.Fatal("mismatch omitted current state")
	}
	// Move the account forward: lookup and replay must use today's state, while
	// retaining the committed operation's identity, version and own result.
	x.expect("POST", "/api/story/mark", body(s, "later", map[string]any{"mark": "seen:later"}), c, 200)
	lookup := func(c *http.Cookie) operationLookup {
		w := x.rawHTTP("GET", "/api/operations/result?route=%2Fapi%2Fstory%2Fmark&key=collision", nil, c)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var out operationLookup
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	out := lookup(c)
	op := out.Result.Operation
	if op == nil || string(op.Payload["mark"]) != `"seen:original"` || op.Payload["op"] != nil || op.Route != "/api/story/mark" || op.Key != "collision" || len(op.PayloadHash) != 64 || op.ResultCase != "mark" || op.ResultType != "glimway.v1.MarkResult" || out.State.Version <= op.Version {
		t.Fatalf("lookup: %+v", out)
	}
	if string(op.Result) == "null" {
		t.Fatal("lost stored result")
	}
	bc, _ := x.ready("bob")
	if lookup(bc).Result.Operation != nil {
		t.Fatal("another account read the operation")
	}
	x.db.DB.Exec("UPDATE idempotency SET created_at=? WHERE key='collision'", x.now.Load()-7*86400)
	if lookup(c).Result.Operation != nil {
		t.Fatal("lookup exposed expired key")
	}
}

// lookupOperation reads the reconciliation answer for one route and key.
func lookupOperation(t *testing.T, x *rig, c *http.Cookie, route, key string) struct {
	Route, Key, PayloadHash, ResultType, ResultCase string
	Version                                         float64
	Payload                                         map[string]json.RawMessage
	Result                                          json.RawMessage
	Refused                                         *string
} {
	t.Helper()
	w := x.rawHTTP("GET", "/api/operations/result?route="+url.QueryEscape(route)+"&key="+url.QueryEscape(key), nil, c)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var out struct {
		Result struct {
			Operation *struct {
				Route, Key, PayloadHash, ResultType, ResultCase string
				Version                                         float64
				Payload                                         map[string]json.RawMessage
				Result                                          json.RawMessage
				Refused                                         *string
			} `json:"operation"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Result.Operation == nil {
		t.Fatalf("no committed operation for %s %s", route, key)
	}
	op := out.Result.Operation
	if op.Route != route || op.Key != key {
		t.Fatalf("lookup: %+v", out)
	}
	return struct {
		Route, Key, PayloadHash, ResultType, ResultCase string
		Version                                         float64
		Payload                                         map[string]json.RawMessage
		Result                                          json.RawMessage
		Refused                                         *string
	}{op.Route, op.Key, op.PayloadHash, op.ResultType, op.ResultCase, op.Version, op.Payload, op.Result, op.Refused}
}

// The reconciliation read answers the operation's actual result: the stored
// value's own fields, never the storage wrapper it was saved in.
func TestCommittedOperationCarriesTheActualResult(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	// A mark: {"added":…,"mark":…}, oneof case `mark`.
	if w := x.rawHTTP("POST", "/api/story/mark", body(s, "settled", map[string]any{"mark": "seen:original"}), c); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	op := lookupOperation(t, x, c, "/api/story/mark", "settled")
	if op.ResultType != "glimway.v1.MarkResult" || op.ResultCase != "mark" {
		t.Fatalf("mark answer: %s", op.Result)
	}
	var mark struct {
		Added bool
		Mark  string
	}
	if err := json.Unmarshal(op.Result, &mark); err != nil {
		t.Fatal(err, string(op.Result))
	}
	if !mark.Added || mark.Mark != "seen:original" || strings.Contains(string(op.Result), "\"type\"") || strings.Contains(string(op.Result), "\"value\"") {
		t.Fatalf("mark result: %s", op.Result)
	}

	// A fall: the recovered answer carries the committed lantern status.
	s = x.reportState(c, s, 0, 0, map[string]any{"area": "woodland", "x": 250, "y": 250})
	w := x.rawHTTP("POST", "/api/fall", body(s, "fallen", map[string]any{}), c)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var env contract.Envelope
	if err := protojson.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	fallen := env.GetFall()
	if fallen == nil {
		t.Fatalf("no fall result: %s", w.Body.String())
	}
	op = lookupOperation(t, x, c, "/api/fall", "fallen")
	if op.ResultType != "glimway.v1.FallResult" || op.ResultCase != "fall" {
		t.Fatalf("fall answer: %s", op.Result)
	}
	var fall struct {
		Lantern string
		Reason  string
		Place   struct{ Area string }
	}
	if err := json.Unmarshal(op.Result, &fall); err != nil {
		t.Fatal(err, string(op.Result))
	}
	if fall.Lantern != fallen.GetLantern() || fall.Reason != fallen.GetReason() || fall.Place.Area != fallen.GetPlace().GetArea() || fall.Lantern == "" {
		t.Fatalf("fall result: %s (answered %v)", op.Result, fallen)
	}

	// A domain result (the mixed envelope's `result`, no type): its own fields.
	w = x.rawHTTP("POST", "/api/items/pocket", body(s, "pocketed", map[string]any{"slot": 1}), c)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	op = lookupOperation(t, x, c, "/api/items/pocket", "pocketed")
	if op.ResultType != "" || op.ResultCase != "result" {
		t.Fatalf("domain answer: %s", op.Result)
	}
	var domain struct {
		Items struct {
			Stacks []any
		}
	}
	if err := json.Unmarshal(op.Result, &domain); err != nil {
		t.Fatal(err, string(op.Result))
	}
	if domain.Items.Stacks == nil {
		t.Fatalf("domain result: %s", op.Result)
	}

	// A terminal refusal: the refusal in its own field, no result.
	poor := body(s, "poor", map[string]any{"recipeId": "craft-plank", "qty": 1})
	if w = x.rawHTTP("POST", "/api/craft", poor, c); w.Code != 409 {
		t.Fatal(w.Body.String())
	}
	op = lookupOperation(t, x, c, "/api/craft", "poor")
	if op.Refused == nil || *op.Refused != "not-a-member" || string(op.Result) != "null" {
		t.Fatalf("refusal: %s %s", op.Result, func() string {
			if op.Refused == nil {
				return "<none>"
			}
			return *op.Refused
		}())
	}
}

func TestReportRequiredSameKeyCanRetry(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fund(s.AccountID, 10, 5)
	req := body(s, "barrier-retry", map[string]any{"kind": "rest"})
	raw, _ := json.Marshal(req) // raw bypasses the domain fixture's automatic report flush
	w := x.rawHTTP("POST", "/api/spend", json.RawMessage(raw), c)
	if w.Code != 409 || !json.Valid(w.Body.Bytes()) {
		t.Fatal(w.Body.String())
	}
	var f struct {
		Error struct{ Code string }
		State json.RawMessage
	}
	json.Unmarshal(w.Body.Bytes(), &f)
	if f.Error.Code != "report-required" || len(f.State) == 0 || count(t, x.db, "SELECT count(*) FROM idempotency WHERE key='barrier-retry'") != 0 {
		t.Fatal("retryable barrier consumed the key", w.Body.String())
	}
	x.flushFixtureReport(c, req["op"].(map[string]any))
	w = x.rawHTTP("POST", "/api/spend", req, c)
	if w.Code != 200 || count(t, x.db, "SELECT count(*) FROM idempotency WHERE key='barrier-retry'") != 1 {
		t.Fatal(w.Body.String())
	}
	// No new barrier is required to recover an already committed result.
	req["op"].(map[string]any)["report"] = nil
	raw, _ = json.Marshal(req)
	w = x.rawHTTP("POST", "/api/spend", json.RawMessage(raw), c)
	if w.Code != 200 || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='spend'") != 1 {
		t.Fatal(w.Body.String())
	}
}
