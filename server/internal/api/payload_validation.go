package api

import (
	"fmt"
	"glimway/server/internal/rules"
	"google.golang.org/protobuf/reflect/protoreflect"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

const MaxSafeCounter = 9007199254740991

var payloadID = regexp.MustCompile(`^[A-Za-z0-9:_-]{1,128}$`)
var clientID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func validPayloadID(id string) bool { return payloadID.MatchString(id) }
func validClientID(id string) bool  { return clientID.MatchString(id) }
func safeCounter(n float64) bool    { return n >= 0 && n <= MaxSafeCounter && n == math.Trunc(n) }

// Shared by B/D input decoding. Empty optional ids are checked by domain rules.
// Raw Habitica values and credentials have their own domain validation.
func validatePayload(m protoreflect.Message) error {
	name := string(m.Descriptor().Name())
	if strings.HasPrefix(name, "Habitica") || name == "LoginRequest" {
		return nil
	}
	var err error
	m.Range(func(f protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		if f.Kind() == protoreflect.MessageKind && !f.IsList() && !f.IsMap() {
			err = validatePayload(v.Message())
			return err == nil
		}
		if f.Kind() == protoreflect.StringKind && slices.Contains([]string{"quest", "to", "mark", "paper", "epoch", "site", "member", "kind", "target", "entity_id", "owner_id", "lantern_id", "client", "generation", "key"}, string(f.Name())) && v.String() != "" && !validPayloadID(v.String()) && !(f.Name() == "mark" && validWitnessMark(v.String())) {
			err = fmt.Errorf("invalid payload id")
		}
		if f.Kind() == protoreflect.StringKind && f.Name() == "client" && v.String() != "" && !validClientID(v.String()) {
			err = fmt.Errorf("invalid client id")
		}
		if f.Kind() == protoreflect.DoubleKind {
			n := v.Float()
			if slices.Contains([]string{"seq", "basis", "casts", "cycle"}, string(f.Name())) && !safeCounter(n) {
				err = fmt.Errorf("unsafe counter")
			}
			if slices.Contains([]string{"hp", "mana"}, string(f.Name())) && n < 0 {
				err = fmt.Errorf("negative vitals")
			}
		}
		return err == nil
	})
	return err
}
func validArea(area string) bool {
	if slices.Contains([]string{"village", "woodland", "ruin", "commons"}, area) || rules.HomeGate(area) >= 0 {
		return true
	}
	if !strings.HasPrefix(area, "wilds:") {
		return false
	}
	_, ok := regionDefinition(strings.TrimPrefix(area, "wilds:"))
	return ok
}

// Witness flags compose bounded ids and a human display name, rather than one
// payload id. Their UTF-8 budget matches the client builder and stored story.
func validWitnessMark(mark string) bool {
	if !strings.HasPrefix(mark, "witness:") || len(mark) > 256 || !utf8.ValidString(mark) {
		return false
	}
	parts := strings.SplitN(mark, ":", 4)
	return len(parts) == 4 && validPayloadID(parts[1]) && validClientID(parts[2]) && parts[3] != ""
}
