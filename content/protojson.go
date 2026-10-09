package content

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"buf.build/go/protovalidate"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Content files are JSON read into the generated proto messages
// (proto/glimway/content/v1). protojson refuses unknown fields; explicit
// nulls need refusing here, because protojson reads a null as "unset" and
// the hand-written loaders treated a null as an error. Then protovalidate
// runs the schema's field and message rules; rules that span entries stay in
// each family's loader.
func decodeContentProto(raw []byte, msg proto.Message) error {
	if err := refuseNulls(raw); err != nil {
		return err
	}
	return protojson.Unmarshal(raw, msg)
}

// refuseNulls walks the parsed content and refuses any explicit null, naming
// the entry by its id when the object has one ("pieces[candle].offers").
func refuseNulls(raw []byte) error {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	return refuseNullsIn("content", doc)
}

func refuseNullsIn(path string, v any) error {
	switch v := v.(type) {
	case nil:
		return fmt.Errorf("null content field %s", path)
	case []any:
		for i, item := range v {
			if err := refuseNullsIn(fmt.Sprintf("%s[%d]", path, i), item); err != nil {
				return err
			}
		}
	case map[string]any:
		for key, item := range v {
			child := path + "." + key
			if entry, ok := item.(map[string]any); ok {
				if id, ok := entry["id"].(string); ok && id != "" {
					child = fmt.Sprintf("%s[%s]", path, id)
				}
			}
			if err := refuseNullsIn(child, item); err != nil {
				return err
			}
		}
	}
	return nil
}

// contentValidate runs protovalidate and reports its violations the way the
// hand-written loaders did: naming the entry and the field
// ("invalid furnishings: candle footprint: ..."). ids[i] names the entry in
// the message's field (pieces, rooms, residents).
func contentValidate(family, field string, ids []string, msg proto.Message) error {
	validator, err := protovalidate.New()
	if err != nil {
		return err
	}
	err = validator.Validate(msg)
	var bad *protovalidate.ValidationError
	if err == nil {
		return nil
	} else if !errors.As(err, &bad) {
		return err
	}
	issues := make([]string, 0, len(bad.Violations))
	for _, v := range bad.Violations {
		issues = append(issues, nameEntry(field, ids, v.String()))
	}
	return fmt.Errorf("invalid %s: %s", family, strings.Join(issues, "; "))
}

var entryPath = regexp.MustCompile(`^(\w+)\[(\d+)\]\.?(.*)$`)

// nameEntry rewrites a violation path ("pieces[2].base.w: ...") to name the
// entry ("candle base.w: ...").
func nameEntry(field string, ids []string, issue string) string {
	m := entryPath.FindStringSubmatch(issue)
	if m == nil || m[1] != field {
		return issue
	}
	i, err := strconv.Atoi(m[2])
	if err != nil || i < 0 || i >= len(ids) {
		return issue
	}
	if m[3] == "" {
		return ids[i]
	}
	return ids[i] + " " + m[3]
}
