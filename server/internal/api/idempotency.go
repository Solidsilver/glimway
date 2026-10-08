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
	}
	hash := store.Hash(store.JSON(value))
	var prior, response string
	err := tx.QueryRowContext(ctx, "SELECT request_hash,response_json FROM idempotency WHERE habitica_id=? AND op=? AND key=?", id, op, key).Scan(&prior, &response)
	if err == sql.ErrNoRows {
		return hash, "", nil
	}
	if err != nil {
		return "", "", err
	}
	if hash != prior {
		return "", "", fail(409, "idempotency-mismatch")
	}
	return hash, response, nil
}

func saveIdem(ctx context.Context, tx *sql.Tx, id, op, key, hash string, v any, now int64) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO idempotency VALUES(?,?,?,?,?,?)", id, op, key, hash, store.JSON(v), now)
	return err
}
