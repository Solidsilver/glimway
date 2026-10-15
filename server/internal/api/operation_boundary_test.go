package api

import (
	"bytes"
	"encoding/json"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"os"
	"testing"
)

func TestOperationBoundaryFixtures(t *testing.T) {
	raw, err := os.ReadFile("testdata/operation-boundary.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name, Kind, Envelope, ResultCase, StoredType, Hash string
		Request, Payload, Result                           json.RawMessage
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	equalJSON := func(a, b []byte) bool {
		var x, y any
		if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
			return false
		}
		return store.JSON(x) == store.JSON(y)
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			var request, result proto.Message
			switch f.Kind {
			case "mark":
				request, result = &contract.MarkRequest{}, &contract.MarkResult{}
			case "home":
				request, result = &contract.HomesteadRequest{}, &contract.HomesteadResult{}
			default:
				t.Fatal("unknown fixture kind", f.Kind)
			}
			if err := protojson.Unmarshal(f.Request, request); err != nil {
				t.Fatal(err)
			}
			if err := protojson.Unmarshal(f.Result, result); err != nil {
				t.Fatal(err)
			}
			prepared, err := prepareRequest(request)
			if err != nil || prepared.Hash != f.Hash || !equalJSON(prepared.Payload, f.Payload) {
				t.Fatalf("payload/hash changed: %+v, %v", prepared, err)
			}
			// Lease/key changes never affect identity; where remains part of the hash.
			clone := proto.Clone(request)
			switch q := clone.(type) {
			case *contract.MarkRequest:
				q.Op.Lease, q.Op.Key = "new-lease", "new-key"
			case *contract.HomesteadRequest:
				q.Op.Lease, q.Op.Key = "new-lease", "new-key"
			}
			movedHeader, err := prepareRequest(clone)
			if err != nil || movedHeader.Hash != prepared.Hash {
				t.Fatal("header affected hash", err)
			}
			switch q := clone.(type) {
			case *contract.MarkRequest:
				q.Where.X++
			case *contract.HomesteadRequest:
				q.Where.X++
			}
			movedPlace, err := prepareRequest(clone)
			if err != nil || movedPlace.Hash == prepared.Hash {
				t.Fatal("where omitted from hash", err)
			}
			var answer any = result
			if f.Envelope == "mixed" {
				answer, err = mixedOpResult(result)
				if err != nil {
					t.Fatal(err)
				}
			}
			stored, err := encodeStoredResult(answer)
			if err != nil || stored.Type != f.StoredType || !equalJSON(stored.Value, f.Result) {
				t.Fatalf("stored result changed: %+v, %v", stored, err)
			}
			// Replay retains the result envelope while replacing state with current state.
			replay, err := replayResult(&stored)
			if err != nil {
				t.Fatal(err)
			}
			for _, version := range []float64{3, 8} {
				encoded, err := opResultBytes(&contract.PlayerState{Version: version}, replay)
				if err != nil {
					t.Fatal(err)
				}
				fields := map[string]json.RawMessage{}
				if err = json.Unmarshal(encoded, &fields); err != nil {
					t.Fatal(err)
				}
				if !equalJSON(fields[f.ResultCase], f.Result) {
					t.Fatal("replay changed result", string(encoded))
				}
				var state contract.PlayerState
				if err = protojson.Unmarshal(fields["state"], &state); err != nil || state.Version != version {
					t.Fatal("replay changed current version", err)
				}
			}
			storedJSON, err := json.Marshal(stored)
			if err != nil {
				t.Fatal(err)
			}
			committed, err := committedOperationProto("/fixture", "key", string(prepared.Payload), prepared.Hash, string(storedJSON), 3)
			if err != nil || committed.ResultCase != f.ResultCase || committed.ResultType != f.StoredType {
				t.Fatal("lookup changed envelope identity", committed, err)
			}
		})
	}
}

func TestPreparedRequestRetainsPayloadSpellingAndRejectsSecrets(t *testing.T) {
	// Nested object order/numeric spelling belongs to the stored payload; the
	// request hash keeps the previous decoded/re-encoded canonicalization.
	first := json.RawMessage(`{"op":{"lease":"old"},"where":{"y":0.0,"x":1e0,"area":"in:village:library"},"nested":{"z":1.00,"a":0}}`)
	second := json.RawMessage(`{"op":{"lease":"new"},"nested":{"a":0,"z":1},"where":{"area":"in:village:library","x":1,"y":0}}`)
	a, err := prepareRequest(first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := prepareRequest(second)
	if err != nil || a.Hash != b.Hash {
		t.Fatal("canonicalization changed", err)
	}
	if !bytes.Contains(a.Payload, []byte(`"z":1.00`)) || !bytes.Contains(a.Payload, []byte(`"y":0.0`)) {
		t.Fatal("stored payload normalized", string(a.Payload))
	}
	if _, err = prepareRequest(json.RawMessage(`{"nested":{"apiToken":"never-store"}}`)); err == nil {
		t.Fatal("dynamic secret accepted")
	}
}
