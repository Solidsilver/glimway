package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

type storedResult struct {
	Type  string          `json:"type,omitempty"`
	Value json.RawMessage `json:"value"`
}

func requestBytes(request any) ([]byte, error) {
	if message, ok := request.(proto.Message); ok {
		return (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(message)
	}
	return json.Marshal(request)
}
func opIdem(ctx context.Context, tx *sql.Tx, id, route, key string, request any, now int64) (string, *storedResult, error) {
	if key == "" || len(key) > 128 {
		return "", nil, fail(400, "key-required")
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM idempotency WHERE created_at<=?", now-7*86400); err != nil {
		return "", nil, err
	}
	raw, err := requestBytes(request)
	if err != nil {
		return "", nil, err
	}
	var payload map[string]json.RawMessage
	if err = json.Unmarshal(raw, &payload); err != nil {
		return "", nil, err
	}
	delete(payload, "op")
	// Canonicalize keys throughout the payload; header is deliberately outside
	// the hash. where and every other field remain part of the identity.
	var value any
	canonical, err := json.Marshal(payload)
	if err != nil {
		return "", nil, err
	}
	if err = json.Unmarshal(canonical, &value); err != nil {
		return "", nil, err
	}
	hash := store.Hash(store.JSON(value))
	var prior, body string
	err = tx.QueryRowContext(ctx, "SELECT request_hash,result_json FROM idempotency WHERE account_id=? AND op=? AND key=?", id, route, key).Scan(&prior, &body)
	if err == sql.ErrNoRows {
		return hash, nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	if hash != prior {
		return "", nil, fail(409, "idempotency-mismatch")
	}
	var result storedResult
	if err = json.Unmarshal([]byte(body), &result); err != nil {
		return "", nil, err
	}
	return hash, &result, nil
}
func saveOpIdem(ctx context.Context, tx *sql.Tx, id, route, key, hash string, result any, version, now int64) error {
	stored := storedResult{}
	if message, ok := result.(proto.Message); ok {
		stored.Type = string(message.ProtoReflect().Descriptor().FullName())
		if err := finiteProto(message.ProtoReflect()); err != nil {
			return err
		}
		raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(message)
		if err != nil {
			return err
		}
		stored.Value = raw
	} else {
		raw, err := json.Marshal(result)
		if err != nil {
			return err
		}
		stored.Value = raw
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO idempotency(account_id,op,key,request_hash,result_json,created_at,committed_version) VALUES(?,?,?,?,?,?,?)", id, route, key, hash, store.JSON(stored), now, version)
	return err
}
func replayResult(stored *storedResult, _ any) (any, error) {
	if stored.Type == "" {
		if !json.Valid(stored.Value) {
			return nil, errors.New("invalid stored result")
		}
		return stored.Value, nil
	}
	mt, err := protoregistry.GlobalTypes.FindMessageByName(protoreflect.FullName(stored.Type))
	if err != nil {
		return nil, err
	}
	message := mt.New().Interface()
	if err = protojson.Unmarshal(stored.Value, message); err != nil {
		return nil, err
	}
	// Refuse results no longer represented by the contract before committing.
	if _, err = typedEnvelope(&contract.PlayerState{}, message); err != nil {
		return nil, err
	}
	return message, nil
}
