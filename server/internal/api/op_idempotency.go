package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"strings"
)

type storedResult struct {
	Refused string          `json:"refused,omitempty"`
	Status  int             `json:"status,omitempty"`
	Type    string          `json:"type,omitempty"`
	Value   json.RawMessage `json:"value"`
}

// secretNames are the credential-shaped field names a keyed request may
// never carry (review finding 9). `opIdem` hashes and `savePayload` stores
// the whole request body for seven days, and `GET /api/operations/result`
// hands it back to anyone holding the session: a token written there would
// be a plaintext credential in the database and on the wire. 0.6's top-up
// request sends a Habitica token, so the cache refuses the field outright.
var secretNames = []string{"token", "apikey", "secret", "password", "credential"}

// secretField reports whether a field name is credential-shaped. The name
// is matched case-insensitively with separators removed, so "api_key",
// "apiKey" and "accessToken" all read as secrets.
func secretField(name string) bool {
	n := strings.ToLower(name)
	for _, sep := range []string{"_", "-", "."} {
		n = strings.ReplaceAll(n, sep, "")
	}
	for _, s := range secretNames {
		if strings.Contains(n, s) {
			return true
		}
	}
	return false
}

// secretProtoField walks a message's fields, and every message type they
// reach, for a credential-shaped name. This is what holds for messages that
// carry none today: the day a request gains a token field, the cache refuses
// it before anything is stored.
func secretProtoField(md protoreflect.MessageDescriptor, seen map[protoreflect.FullName]bool) (string, bool) {
	if seen[md.FullName()] {
		return "", false
	}
	seen[md.FullName()] = true
	fields := md.Fields()
	for i := 0; i < fields.Len(); i++ {
		f := fields.Get(i)
		if secretField(string(f.Name())) || secretField(f.JSONName()) {
			return string(f.Name()), true
		}
		if f.Kind() == protoreflect.MessageKind || f.Kind() == protoreflect.GroupKind {
			if name, ok := secretProtoField(f.Message(), seen); ok {
				return name, true
			}
		}
	}
	return "", false
}

// secretJSONKey walks marshalled request bytes for a credential-shaped key
// at any depth. Protobuf field names are covered by the walk above; this
// also covers keys a message invents at run time (Struct and map keys).
func secretJSONKey(raw []byte) (string, bool) {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return "", false
	}
	return secretJSONKeyNode(v)
}

// secretJSONKeyNode is secretJSONKey over an already-unmarshalled tree.
func secretJSONKeyNode(node any) (string, bool) {
	var walk func(any) (string, bool)
	walk = func(node any) (string, bool) {
		switch t := node.(type) {
		case map[string]any:
			for k, sub := range t {
				if secretField(k) {
					return k, true
				}
				if name, ok := walk(sub); ok {
					return name, true
				}
			}
		case []any:
			for _, sub := range t {
				if name, ok := walk(sub); ok {
					return name, true
				}
			}
		}
		return "", false
	}
	return walk(node)
}

// dynamicContainer is a Struct, a Value, or a map whose values are Values:
// the only places a request invents names at run time (review finding 6).
// Every other name in the marshalled bytes is a field name (secretProtoField
// covers those) or a map key that is a content id.
func dynamicContainer(fd protoreflect.FieldDescriptor) bool {
	dynamic := func(md protoreflect.MessageDescriptor) bool {
		switch md.FullName() {
		case "google.protobuf.Struct", "google.protobuf.Value", "google.protobuf.ListValue":
			return true
		}
		return false
	}
	if fd.IsMap() {
		v := fd.MapValue()
		return v.Kind() == protoreflect.MessageKind && dynamic(v.Message())
	}
	return (fd.Kind() == protoreflect.MessageKind || fd.Kind() == protoreflect.GroupKind) && dynamic(fd.Message())
}

// secretJSONKeyIn walks one message's marshalled bytes against its
// descriptor (review finding 6): only the dynamic containers — Struct and
// Value fields, and maps of Values — are scanned as wholes, because they are
// the only keys invented at run time. A map key elsewhere is a content id
// (`tally-token` is a quest item), never a field name, and refusing one would
// answer every player with an error.
func secretJSONKeyIn(raw []byte, md protoreflect.MessageDescriptor) (string, bool) {
	var root any
	if json.Unmarshal(raw, &root) != nil {
		return "", false
	}
	var walkMsg func(any, protoreflect.MessageDescriptor) (string, bool)
	walkField := func(node any, fd protoreflect.FieldDescriptor) (string, bool) {
		if list, ok := node.([]any); ok {
			for _, sub := range list {
				if name, ok := walkMsg(sub, fd.Message()); ok {
					return name, true
				}
			}
			return "", false
		}
		if fd.IsMap() {
			obj, ok := node.(map[string]any)
			if !ok {
				return "", false
			}
			for _, sub := range obj {
				if name, ok := walkMsg(sub, fd.MapValue().Message()); ok {
					return name, true
				}
			}
			return "", false
		}
		return walkMsg(node, fd.Message())
	}
	walkMsg = func(node any, md protoreflect.MessageDescriptor) (string, bool) {
		obj, ok := node.(map[string]any)
		if !ok {
			return "", false
		}
		fields := md.Fields()
		for key, sub := range obj {
			fd := fields.ByJSONName(key)
			if fd == nil {
				fd = fields.ByName(protoreflect.Name(key))
			}
			if fd == nil {
				continue
			}
			if dynamicContainer(fd) {
				if name, ok := secretJSONKeyNode(sub); ok {
					return name, true
				}
				continue
			}
			if fd.Kind() == protoreflect.MessageKind || fd.Kind() == protoreflect.GroupKind {
				if name, ok := walkField(sub, fd); ok {
					return name, true
				}
			}
		}
		return "", false
	}
	return walkMsg(root, md)
}

// requestBytes is the only way a keyed request becomes payload bytes: the
// cache's request hash and its stored body. It refuses any request carrying
// a secret field (review finding 9), so no credential can ever be stored in
// `idempotency.payload_json`, served by `/api/operations/result`, or left in
// the WAL.
func requestBytes(request any) ([]byte, error) {
	if message, ok := request.(proto.Message); ok {
		md := message.ProtoReflect().Descriptor()
		if name, ok := secretProtoField(md, map[protoreflect.FullName]bool{}); ok {
			return nil, fmt.Errorf("request %s may not carry the secret field %s", md.FullName(), name)
		}
		raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(message)
		if err != nil {
			return nil, err
		}
		if name, ok := secretJSONKeyIn(raw, md); ok {
			return nil, fmt.Errorf("request %s may not carry the secret key %s", md.FullName(), name)
		}
		return raw, nil
	}
	raw, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if name, ok := secretJSONKey(raw); ok {
		return nil, fmt.Errorf("request may not carry the secret key %s", name)
	}
	return raw, nil
}
func opIdem(ctx context.Context, tx *sql.Tx, id, route, key string, request any, now int64) (string, *storedResult, error) {
	if key == "" || len(key) > 128 {
		return "", nil, fail(400, "key-required")
	}
	// Wilds stump proofs use successful chop payloads for the same visit.
	// Keep that seven-day visit window in mind when changing this retry retention.
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
func replayResult(stored *storedResult) (any, error) {
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

// Terminal gameplay failures must never become successes when their predicates change.
func terminalRefusal(f *failure) bool {
	if f.status != 409 && f.status != 422 && f.status != 403 && f.status != 404 {
		return false
	}
	switch f.code {
	case "not-found", "report-required", "idempotency-mismatch", "invalid-position", "invalid-revision", "superseded", "reload-needed", "playing-elsewhere", "access-denied", "world-access-denied", "player-flagged":
		return false
	}
	return true
}
func saveRefusedOp(ctx context.Context, tx *sql.Tx, id, route, key, hash string, f *failure, version, now int64) error {
	result := storedResult{Refused: errorCodeWire(errorCodeProto(f.code)), Status: f.status, Value: json.RawMessage("null")}
	_, err := tx.ExecContext(ctx, "INSERT INTO idempotency(account_id,op,key,request_hash,result_json,created_at,committed_version) VALUES(?,?,?,?,?,?,?)", id, route, key, hash, store.JSON(result), now, version)
	return err
}
