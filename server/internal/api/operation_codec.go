package api

import (
	"encoding/json"
	"errors"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"net/http"
)

// The public oneof and mixed envelopes remain different encodings. Domain
// callbacks can retain their message without erasing a mixed result to JSON.
type envelopeStyle uint8

const (
	oneofEnvelope envelopeStyle = iota
	mixedEnvelope
)

type operationAnswer struct {
	style envelopeStyle
	value any
}

func operationAnswerOf(result any) operationAnswer {
	if answer, ok := result.(operationAnswer); ok {
		return answer
	}
	if _, ok := result.(proto.Message); ok {
		return operationAnswer{oneofEnvelope, result}
	}
	return operationAnswer{mixedEnvelope, result}
}
func mixedOpResult(message proto.Message) (operationAnswer, error) {
	// Keep callback-time finite validation, while retaining the typed message.
	if err := finiteProto(message.ProtoReflect()); err != nil {
		return operationAnswer{}, err
	}
	return operationAnswer{mixedEnvelope, message}, nil
}

var envelopeResultFields = func() map[protoreflect.FullName]protoreflect.FieldDescriptor {
	fields := (&contract.Envelope{}).ProtoReflect().Descriptor().Oneofs().ByName("result").Fields()
	out := make(map[protoreflect.FullName]protoreflect.FieldDescriptor, fields.Len())
	for i := 0; i < fields.Len(); i++ {
		f := fields.Get(i)
		// Retain the first matching case, as the previous descriptor scan did.
		if out[f.Message().FullName()] == nil {
			out[f.Message().FullName()] = f
		}
	}
	return out
}()

// encodeStoredResult preserves mixed results' empty Type, including typed
// messages deliberately served under result rather than the Envelope oneof.
func encodeStoredResult(result any) (storedResult, error) {
	answer := operationAnswerOf(result)
	stored := storedResult{}
	if message, ok := answer.value.(proto.Message); ok {
		if answer.style == oneofEnvelope {
			stored.Type = string(message.ProtoReflect().Descriptor().FullName())
		}
		raw, err := protoResult(message)
		if err != nil {
			return stored, err
		}
		stored.Value = raw
	} else {
		raw, err := json.Marshal(answer.value)
		if err != nil {
			return stored, err
		}
		stored.Value = raw
	}
	return stored, nil
}

// protoResult marshals a typed domain result for the mixed envelope, with
// the same finite-number validation a typed envelope answer carries.
func protoResult(message proto.Message) (json.RawMessage, error) {
	if err := finiteProto(message.ProtoReflect()); err != nil {
		return nil, err
	}
	raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(message)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// All typed operation results must appear exactly once in Envelope.result.
func typedEnvelope(state *contract.PlayerState, result proto.Message) (*contract.Envelope, error) {
	e := &contract.Envelope{State: state}
	f := envelopeResultFields[result.ProtoReflect().Descriptor().FullName()]
	if f != nil {
		e.ProtoReflect().Set(f, protoreflect.ValueOfMessage(result.ProtoReflect()))
		return e, nil
	}

	return nil, errors.New("operation result missing from envelope")
}

func opResultBytes(state *contract.PlayerState, result any) ([]byte, error) {
	answer := operationAnswerOf(result)
	if answer.style == oneofEnvelope {
		message := answer.value.(proto.Message)
		envelope, err := typedEnvelope(state, message)
		if err != nil {
			return nil, err
		}
		if err = finiteProto(envelope.ProtoReflect()); err != nil {
			return nil, err
		}
		return (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(envelope)
	}
	return mixedBytes(state, answer.value)
}
func writeOpResult(w http.ResponseWriter, state *contract.PlayerState, result any) error {
	raw, err := opResultBytes(state, result)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, err = w.Write(append(raw, '\n'))
	return err
}

// mixedBytes is the domain-read envelope: the same current PlayerState the
// keyed answers carry, beside the read's own result — a typed proto message
// (protojson) or an existing domain's JSON result.
func mixedBytes(state *contract.PlayerState, result any) ([]byte, error) {
	if state == nil {
		return nil, errors.New("missing player state")
	}
	if err := finiteProto(state.ProtoReflect()); err != nil {
		return nil, err
	}
	raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(state)
	if err != nil {
		return nil, err
	}
	if message, ok := result.(proto.Message); ok {
		if err := finiteProto(message.ProtoReflect()); err != nil {
			return nil, err
		}
		encoded, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(message)
		if err != nil {
			return nil, err
		}
		result = json.RawMessage(encoded)
	}
	return json.Marshal(struct {
		State  json.RawMessage `json:"state"`
		Result any             `json:"result"`
	}{raw, result})
}
func writeMixed(w http.ResponseWriter, status int, state *contract.PlayerState, result any) {
	raw, err := mixedBytes(state, result)
	if err != nil {
		problem(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(append(raw, '\n'))
}
func writeRefusal(w http.ResponseWriter, status int, code string, state *contract.PlayerState) {
	writeProto(w, status, &contract.Refusal{Error: &contract.ErrorDetail{Code: errorCodeWire(errorCodeProto(code))}, State: state})
}
