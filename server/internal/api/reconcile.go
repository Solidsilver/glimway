package api

import (
	"database/sql"
	"encoding/json"
	contract "glimway/server/internal/gen/glimway/v1"
	"net/http"
)

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
	var raw, payload, hash string
	var version int64
	err = tx.QueryRowContext(r.Context(), "SELECT result_json,payload_json,request_hash,committed_version FROM idempotency WHERE account_id=? AND op=? AND key=? AND created_at>?", s.AccountID, route, key, a.Config.Now().Unix()-7*86400).Scan(&raw, &payload, &hash, &version)
	var operation any
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		var result storedResult
		if err = json.Unmarshal([]byte(raw), &result); err != nil {
			return err
		}
		resultCase := "result"
		if result.Type != "" {
			fields := (&contract.Envelope{}).ProtoReflect().Descriptor().Oneofs().ByName("result").Fields()
			for i := 0; i < fields.Len(); i++ {
				f := fields.Get(i)
				if string(f.Message().FullName()) == result.Type {
					resultCase = f.JSONName()
					break
				}
			}
		}
		operation = struct {
			Route       string          `json:"route"`
			Key         string          `json:"key"`
			Payload     json.RawMessage `json:"payload"`
			PayloadHash string          `json:"payloadHash"`
			Version     int64           `json:"version"`
			Refused     string          `json:"refused,omitempty"`
			Result      json.RawMessage `json:"result"`
			ResultCase  string          `json:"resultCase"`
			ResultType  string          `json:"resultType"`
		}{route, key, json.RawMessage(payload), hash, version, result.Refused, result.Value, resultCase, result.Type}
	}
	state, err := a.Config.State.PlayerState(r.Context(), tx, s)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	writeMixed(w, 200, state, map[string]any{"operation": operation})
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
