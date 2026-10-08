package api

import (
	"encoding/json"
	"net/http"
	"testing"
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
