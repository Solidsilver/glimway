package api

import (
	"encoding/json"
	"fmt"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// ProtoJSON itself permits numeric strings and original snake_case aliases.
// HTTP has one spelling and finite JSON numbers, enforced before decoding.
func strictRequestJSON(raw json.RawMessage, md protoreflect.MessageDescriptor) error {
	if string(raw) == "null" {
		return nil
	}
	if md.FullName() == "google.protobuf.Value" {
		return nil
	}
	if md.FullName() == "google.protobuf.StringValue" {
		var v string
		return json.Unmarshal(raw, &v)
	}
	if md.FullName() == "google.protobuf.DoubleValue" {
		var v float64
		return json.Unmarshal(raw, &v)
	}
	// Int32/Int64/UInt32/Bool wrappers ride the wire as bare JSON values too
	// (ProtoJSON's wrapper spelling); the numeric ones stay finite numbers.
	switch md.FullName() {
	case "google.protobuf.Int32Value", "google.protobuf.Int64Value", "google.protobuf.UInt32Value":
		var v float64
		if string(raw) == "null" {
			return fmt.Errorf("null number")
		}
		return json.Unmarshal(raw, &v)
	case "google.protobuf.BoolValue":
		var v bool
		return json.Unmarshal(raw, &v)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	for i := 0; i < md.Fields().Len(); i++ {
		f := md.Fields().Get(i)
		if string(f.Name()) != f.JSONName() && fields[string(f.Name())] != nil {
			return fmt.Errorf("proto-name alias")
		}
		v := fields[f.JSONName()]
		if v == nil {
			continue
		}
		check := func(raw json.RawMessage, f protoreflect.FieldDescriptor) error {
			switch f.Kind() {
			case protoreflect.MessageKind:
				return strictRequestJSON(raw, f.Message())
			case protoreflect.DoubleKind, protoreflect.FloatKind, protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind, protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
				var n float64
				if string(raw) == "null" {
					return fmt.Errorf("null number")
				}
				return json.Unmarshal(raw, &n)
			}
			return nil
		}
		if f.IsList() {
			var list []json.RawMessage
			if err := json.Unmarshal(v, &list); err != nil {
				return err
			}
			for _, item := range list {
				if err := check(item, f); err != nil {
					return err
				}
			}
		} else if f.IsMap() {
			var values map[string]json.RawMessage
			if err := json.Unmarshal(v, &values); err != nil {
				return err
			}
			for _, item := range values {
				if err := check(item, f.MapValue()); err != nil {
					return err
				}
			}
		} else if err := check(v, f); err != nil {
			return err
		}
	}
	return nil
}
