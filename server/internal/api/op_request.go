package api

import (
	"encoding/json"
	"glimway/server/internal/store"
)

// Payload retains the original nested JSON representation for reconciliation;
// Hash uses the existing decoded/re-encoded canonical form. Both exclude op,
// include where, and share one secret-checked serialization of the request.
type preparedRequest struct {
	Hash    string
	Payload json.RawMessage
}

func prepareRequest(request any) (preparedRequest, error) {
	raw, err := requestBytes(request)
	if err != nil {
		return preparedRequest{}, err
	}
	var payload map[string]json.RawMessage
	if err = json.Unmarshal(raw, &payload); err != nil {
		return preparedRequest{}, err
	}
	delete(payload, "op")
	// Canonicalize keys throughout the payload; header is deliberately outside
	// the hash. where and every other field remain part of the identity.
	var value any
	canonical, err := json.Marshal(payload)
	if err != nil {
		return preparedRequest{}, err
	}
	if err = json.Unmarshal(canonical, &value); err != nil {
		return preparedRequest{}, err
	}
	return preparedRequest{Hash: store.Hash(store.JSON(value)), Payload: canonical}, nil
}
