package api

import (
	"database/sql"
	"encoding/json"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"net/http"
)

// committedOperationProto reads a stored idempotency row into the wire
// message: the payload (always a JSON object) and result (any JSON) as
// Struct/Value, the Envelope oneof case the result answers as ("result" for
// a domain route), and the stored refusal.
func committedOperationProto(route, key, payloadJSON, hash, resultJSON string, version int64) (*contract.CommittedOperation, error) {
	out := &contract.CommittedOperation{Route: route, Key: key, PayloadHash: hash, Version: float64(version), ResultCase: "result"}
	var stored storedResult
	if err := json.Unmarshal([]byte(resultJSON), &stored); err != nil {
		return nil, err
	}
	if payloadJSON != "" && payloadJSON != "null" {
		payload := &structpb.Struct{}
		if err := (protojson.UnmarshalOptions{}).Unmarshal([]byte(payloadJSON), payload); err != nil {
			return nil, err
		}
		out.Payload = payload
	}
	if stored.Refused != "" {
		out.Refused = wrapperspb.String(stored.Refused)
	}
	if stored.Type != "" {
		out.ResultType = stored.Type
		// Oneof cases resolve by message type name; each case is a distinct
		// message (TestEnvelopeResultCasesHaveDistinctTypes).
		fields := (&contract.Envelope{}).ProtoReflect().Descriptor().Oneofs().ByName("result").Fields()
		for i := 0; i < fields.Len(); i++ {
			f := fields.Get(i)
			if string(f.Message().FullName()) == stored.Type {
				out.ResultCase = f.JSONName()
				break
			}
		}
	}
	var value json.RawMessage
	if err := json.Unmarshal([]byte(resultJSON), &value); err != nil {
		return nil, err
	}
	result := &structpb.Value{}
	if err := (protojson.UnmarshalOptions{}).Unmarshal([]byte(value), result); err != nil {
		return nil, err
	}
	out.Result = result
	return out, nil
}

// operationResult identifies the committed payload and result for this account.
// C2 compares payload with its frozen request before resolving a mismatched key.
func (a *Server) operationResult(w http.ResponseWriter, r *http.Request) error {
	route, key := r.URL.Query().Get("route"), r.URL.Query().Get("key")
	if route == "" || key == "" || len(route) > 256 || len(key) > 128 {
		return fail(400, "invalid-request")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var resultJSON, payload, hash string
	var version int64
	err = tx.QueryRowContext(r.Context(), "SELECT result_json,payload_json,request_hash,committed_version FROM idempotency WHERE account_id=? AND op=? AND key=? AND created_at>?", s.AccountID, route, key, a.Config.Now().Unix()-7*86400).Scan(&resultJSON, &payload, &hash, &version)
	var operation *contract.CommittedOperation
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		if operation, err = committedOperationProto(route, key, payload, hash, resultJSON, version); err != nil {
			return err
		}
	}
	state, err := a.Config.State.PlayerState(r.Context(), tx, s)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	writeMixed(w, 200, state, &contract.OperationsResult{Operation: operation})
	return nil
}

func savePayload(tx *sql.Tx, account, route, key string, request any) error {
	raw, err := requestBytes(request)
	if err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	delete(fields, "op")
	payload, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	_, err = tx.Exec("UPDATE idempotency SET payload_json=? WHERE account_id=? AND op=? AND key=?", string(payload), account, route, key)
	return err
}
