package api

import (
	"encoding/json"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"net/http"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// Protobuf enum identifiers cannot contain hyphens. This reversible adapter
// preserves the public string vocabulary; the enum is its only catalog.
func errorCodeWire(code contract.ErrorCode) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimPrefix(code.String(), "ERROR_CODE_")), "_", "-")
}
func errorCodeProto(code string) contract.ErrorCode {
	name := "ERROR_CODE_" + strings.ReplaceAll(strings.ToUpper(code), "-", "_")
	if n, ok := contract.ErrorCode_value[name]; ok && n != 0 {
		return contract.ErrorCode(n)
	}
	return contract.ErrorCode_ERROR_CODE_INTERNAL
}

// HTTP uses protojson only for migrated domains. EmitUnpopulated keeps all
// zero values, [] lists, {} maps and null message fields in their existing shape.
func writeProto(w http.ResponseWriter, status int, message proto.Message) {
	b, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(message)
	if err != nil {
		problem(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(append(b, '\n'))
}
func calendarResponse(day content.CalendarDay) *contract.CalendarResponse {
	out := &contract.CalendarResponse{Wick: day.Wick, WickNumber: float64(day.WickNumber), Year: float64(day.Year), Day: int32(day.Day), Mark: day.Mark, StartsAt: float64(day.StartsAt), NextTurning: float64(day.NextTurning), WickDays: int32(day.WickDays)}
	if day.Festival != nil {
		out.Festival = wrapperspb.String(*day.Festival)
	}
	if day.Notice != nil {
		out.Notice = wrapperspb.String(*day.Notice)
	}
	return out
}

const presenceProtocol = "glimway.presence.v1"

// The envelope's oneof is the sole event catalog. Both JSON and binary use
// the same generated payloads; legacy JSON flattens the selected event.
func presenceEnvelope(v proto.Message) *contract.PresenceMessage {
	out := &contract.PresenceMessage{}
	fields := out.ProtoReflect().Descriptor().Fields()
	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		if field.Message().FullName() == v.ProtoReflect().Descriptor().FullName() {
			out.ProtoReflect().Set(field, protoreflect.ValueOfMessage(v.ProtoReflect()))
			return out
		}
	}
	panic("unsupported presence payload")
}
func presenceJSON(v *contract.PresenceMessage, defaults bool) ([]byte, error) {
	m := v.ProtoReflect()
	field := m.WhichOneof(m.Descriptor().Oneofs().Get(0))
	if field == nil {
		return nil, fmt.Errorf("missing presence event")
	}
	payload := m.Get(field).Message().Interface()
	b, err := (protojson.MarshalOptions{EmitUnpopulated: defaults}).Marshal(payload)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(b, &fields); err != nil {
		return nil, err
	}
	fields["type"], _ = json.Marshal(string(field.Name()))
	return json.Marshal(fields)
}
func encodePresence(v proto.Message, binary bool) ([]byte, error) {
	envelope := presenceEnvelope(v)
	if binary {
		return proto.Marshal(envelope)
	}
	return presenceJSON(envelope, true)
}

// Reject unknown binary fields recursively, just as the legacy JSON reader
// rejects unknown keys. Unknown outgoing events can still be ignored by clients.
func knownPresence(m protoreflect.Message) bool {
	if len(m.GetUnknown()) != 0 {
		return false
	}
	known := true
	m.Range(func(f protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		switch {
		case f.IsMap() && f.MapValue().Kind() == protoreflect.MessageKind:
			v.Map().Range(func(_ protoreflect.MapKey, value protoreflect.Value) bool {
				known = knownPresence(value.Message())
				return known
			})
		case f.IsList() && f.Kind() == protoreflect.MessageKind:
			list := v.List()
			for i := 0; i < list.Len() && known; i++ {
				known = knownPresence(list.Get(i).Message())
			}
		case !f.IsMap() && !f.IsList() && f.Kind() == protoreflect.MessageKind:
			known = knownPresence(v.Message())
		}
		return known
	})
	return known
}
func decodePresence(b []byte, binary bool, out any) error {
	if !binary {
		return strictPresenceJSON(b, out)
	}
	var message contract.PresenceMessage
	if err := proto.Unmarshal(b, &message); err != nil {
		return err
	}
	if !knownPresence(message.ProtoReflect()) {
		return fmt.Errorf("unknown presence field")
	}
	// Leave absent fields absent so required-coordinate and irrelevant-field
	// checks are identical for both protocols.
	flat, err := presenceJSON(&message, false)
	if err != nil {
		return err
	}
	return strictPresenceJSON(flat, out)
}

// Internal spatial state stays convenient for proximity calculations. The
// transmitted position is generated, with explicit zero coordinates and stop.
func presencePositionProto(pos *presencePosition) *contract.PresencePosition {
	if pos == nil {
		return nil
	}
	return &contract.PresencePosition{X: proto.Float64(pos.X), Y: proto.Float64(pos.Y), Facing: &contract.PresenceFacing{X: proto.Float64(pos.Facing.X), Y: proto.Float64(pos.Facing.Y)}, Moving: proto.Bool(pos.Moving)}
}
