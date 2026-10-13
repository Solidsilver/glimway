package api

import (
	"bytes"
	"encoding/json"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExactHTTPSendsUnmodifiedBytes(t *testing.T) {
	for _, raw := range [][]byte{[]byte(" { \"op\":null, \"hp\": 1.00 } \n"), []byte(`{"broken":`), nil} {
		calls := 0
		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			got, err := io.ReadAll(r.Body)
			if err != nil || !bytes.Equal(got, raw) {
				t.Fatalf("request changed: %q, %v", got, err)
			}
			if r.Header.Get("X-Glimway-Contract") != testContract() {
				t.Fatal("missing contract")
			}
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"bad-request"}}`))
		})
		w := sendExactHTTP(handler, "POST", "/api/spend", raw, nil)
		if calls != 1 || w.Code != 400 {
			t.Fatalf("calls=%d status=%d", calls, w.Code)
		}
	}
}

func TestRawHTTPDoesNotRepairScenarioOrInsertReport(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("exact-http")
	fields := body(s, "raw-rest", map[string]any{"kind": "rest", "target": ""})
	fields["progress"] = s.State
	before, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	reports := count(t, x.db, "SELECT report_seq FROM player_vitals WHERE account_id=?", s.AccountID)
	w := x.rawHTTP("POST", "/api/spend", fields, c)
	after, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("rawHTTP mutated caller body")
	}
	if got := count(t, x.db, "SELECT report_seq FROM player_vitals WHERE account_id=?", s.AccountID); got != reports {
		t.Fatalf("rawHTTP inserted report: %d -> %d", reports, got)
	}
	if w.Code == 200 {
		t.Fatal("unmodified request unexpectedly accepted")
	}
}

func TestExactResponseDecodingKeepsBothEnvelopes(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("exact-envelopes")
	stateResponse := x.rawHTTP("GET", "/api/state", nil, c)
	if stateResponse.Code != 200 {
		t.Fatal(stateResponse.Body.String())
	}
	state := decodeHTTP[map[string]json.RawMessage](t, stateResponse)["state"]
	for _, resultField := range []string{"spend", "result"} {
		raw, err := json.Marshal(map[string]json.RawMessage{
			"state":     state,
			resultField: json.RawMessage(`{"outcome":"rested"}`),
		})
		if err != nil {
			t.Fatal(err)
		}

		w := httptest.NewRecorder()
		_, _ = w.Write(raw)
		fields := decodeHTTP[map[string]json.RawMessage](t, w)
		if len(fields) != 2 {
			t.Fatalf("wire fields enriched: %s", w.Body.String())
		}
		if fields["spend"] != nil {
			var env contract.Envelope
			if err := protojson.Unmarshal(w.Body.Bytes(), &env); err != nil {
				t.Fatal(err)
			}
			if env.GetSpend().GetOutcome() != "rested" {
				t.Fatal("typed result lost")
			}
			if fields["result"] != nil {
				t.Fatal("oneof repaired to mixed result")
			}
		} else {
			var result contract.SpendResult
			if err := protojson.Unmarshal(fields["result"], &result); err != nil {
				t.Fatal(err)
			}
			if result.GetOutcome() != "rested" {
				t.Fatal("mixed result lost")
			}
		}
	}
}
