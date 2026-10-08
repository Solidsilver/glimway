package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"glimway/server/internal/store"
)

func idem(ctx context.Context, tx *sql.Tx, id, op, key string, req any, now int64) (string, string, error) {
	if key == "" || len(key) > 128 {
		return "", "", fail(400, "key-required")
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM idempotency WHERE created_at<=?", now-7*86400); err != nil {
		return "", "", err
	}
	canonical := store.JSON(req)
	var value any
	if err := json.Unmarshal([]byte(canonical), &value); err != nil {
		return "", "", err
	}
	if fields, ok := value.(map[string]any); ok {
		delete(fields, "lease")
		delete(fields, "op")
	}
	hash := store.Hash(store.JSON(value))
	var prior, response string
	err := tx.QueryRowContext(ctx, "SELECT request_hash,result_json FROM idempotency WHERE account_id=? AND op=? AND key=?", id, op, key).Scan(&prior, &response)
	if err == sql.ErrNoRows {
		return hash, "", nil
	}
	if err != nil {
		return "", "", err
	}
	if hash != prior {
		return "", "", fail(409, "idempotency-mismatch")
	}
	// Interim domain handlers also replay current state, never a stored save.
	current, err := LoadReplay(ctx, tx, id, response)
	return hash, current, err
}

func saveIdem(ctx context.Context, tx *sql.Tx, id, op, key, hash string, v any, now int64) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(store.JSON(v)), &fields); err != nil {
		return err
	}
	for _, key := range snapshotFields {
		delete(fields, key)
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO idempotency(account_id,op,key,request_hash,result_json,created_at,committed_version) VALUES(?,?,?,?,?,?,(SELECT version FROM players WHERE account_id=?))", id, op, key, hash, store.JSON(fields), now, id)
	return err
}

var snapshotFields = []string{"state", "version", "vitalsSource", "importedProfile", "accountId", "displayName", "habiticaPartyId", "worldId", "profileSource", "pending", "verifiedXp", "flagged"}

func LoadReplay(ctx context.Context, tx *sql.Tx, id, result string) (string, error) {
	s, err := store.Load(ctx, tx, id)
	if err != nil {
		return "", err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal([]byte(store.JSON(s)), &fields); err != nil {
		return "", err
	}
	var extra map[string]json.RawMessage
	if err = json.Unmarshal([]byte(result), &extra); err != nil {
		return "", err
	}
	for k, v := range extra {
		fields[k] = v
	}
	return store.JSON(fields), nil
}
