package api

import (
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	presencecontract "glimway/server/internal/gen/glimway/v2"
	"log"
	"math"
	"net/http"
	"strings"
	"testing"

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
	log.Printf("api error code missing from protobuf enum: %q", code)
	if testing.Testing() {
		panic("api error code missing from protobuf enum: " + code)
	}
	return contract.ErrorCode_ERROR_CODE_INTERNAL
}

// HTTP uses protojson only for migrated domains. EmitUnpopulated keeps all
// zero values, [] lists, {} maps and null message fields in their existing shape.
func writeProto(w http.ResponseWriter, status int, message proto.Message) {
	if err := finiteProto(message.ProtoReflect()); err != nil {
		problem(w, err)
		return
	}
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

const presenceProtocol = "glimway.presence.v2"

// The envelope's oneof is the only event catalog. A payload is immutable
// after construction, and its encoded bytes can be shared by recipient queues.
func encodePresence(v proto.Message) ([]byte, error) {
	envelope := &presencecontract.PresenceMessage{}
	fields := envelope.ProtoReflect().Descriptor().Fields()
	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		if field.Message().FullName() == v.ProtoReflect().Descriptor().FullName() {
			envelope.ProtoReflect().Set(field, protoreflect.ValueOfMessage(v.ProtoReflect()))
			return proto.Marshal(envelope)
		}
	}
	return nil, fmt.Errorf("unsupported presence payload")
}

// Reject unknown binary fields recursively. Unknown outgoing events can still
// be ignored by clients.
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
func decodePresence(b []byte) (*presencecontract.PresenceMessage, error) {
	var message presencecontract.PresenceMessage
	if err := proto.Unmarshal(b, &message); err != nil {
		return nil, err
	}
	if message.Event == nil || !knownPresence(message.ProtoReflect()) {
		return nil, fmt.Errorf("invalid presence event")
	}
	return &message, nil
}

// ProtoJSON allows NaN/Inf as strings. HTTP numeric fields must stay finite
// numbers, including doubles inside nested messages, lists and maps.
func finiteProto(message protoreflect.Message) error {
	var err error
	message.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		check := func(kind protoreflect.Kind, value protoreflect.Value) error {
			switch kind {
			case protoreflect.DoubleKind, protoreflect.FloatKind:
				if math.IsNaN(value.Float()) || math.IsInf(value.Float(), 0) {
					return fmt.Errorf("non-finite number")
				}
			case protoreflect.MessageKind, protoreflect.GroupKind:
				return finiteProto(value.Message())
			}
			return nil
		}
		switch {
		case field.IsMap():
			value.Map().Range(func(_ protoreflect.MapKey, v protoreflect.Value) bool {
				err = check(field.MapValue().Kind(), v)
				return err == nil
			})
		case field.IsList():
			list := value.List()
			for i := 0; i < list.Len() && err == nil; i++ {
				err = check(field.Kind(), list.Get(i))
			}
		default:
			err = check(field.Kind(), value)
		}
		if err != nil {
			err = fmt.Errorf("%s: %w", field.FullName(), err)
		}
		return err == nil
	})
	return err
}

// Internal spatial state stays convenient for proximity calculations. The
// transmitted position is generated, with explicit zero coordinates and stop.
func presencePositionProto(pos *presencePosition) *presencecontract.PresencePosition {
	if pos == nil {
		return nil
	}
	return &presencecontract.PresencePosition{X: proto.Float64(pos.X), Y: proto.Float64(pos.Y), Facing: &presencecontract.PresenceFacing{X: proto.Float64(pos.Facing.X), Y: proto.Float64(pos.Facing.Y)}, Moving: proto.Bool(pos.Moving)}
}
