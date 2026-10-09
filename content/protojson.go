package content

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"buf.build/go/protovalidate"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// One validator for the process: building it compiles every CEL rule it
// meets, and content decodes far too often (every request, every start-up)
// to pay that each time.
var contentValidator = func() protovalidate.Validator {
	v, err := protovalidate.New()
	if err != nil {
		panic(err)
	}
	return v
}()

// Content files are JSON read into the generated proto messages
// (proto/glimway/content/v1). protojson refuses unknown fields; before it
// runs, refuseContent checks the parsed JSON against the schema's
// descriptors: any explicit null is refused (protojson reads a null as
// "unset", the hand-written loaders treated a null as an error), and so is
// any key that isn't a field's canonical JSON name (a proto name alone
// included, which protojson would otherwise accept). Then protovalidate
// runs the schema's field and message rules; rules that span entries stay
// in each family's loader.
func decodeContentProto(raw []byte, family string, msg proto.Message) error {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("invalid %s: %w", family, err)
	}
	if err := refuseContent("content", doc, msg.ProtoReflect().Descriptor()); err != nil {
		return fmt.Errorf("invalid %s: %w", family, err)
	}
	if err := protojson.Unmarshal(raw, msg); err != nil {
		return fmt.Errorf("invalid %s: decode: %w", family, err)
	}
	return nil
}

// refuseContent walks the parsed content beside the message descriptor,
// refusing any explicit null and any key that isn't a field's JSON name,
// naming the entry by its id ("content.pieces[candle].offers").
func refuseContent(path string, v any, md protoreflect.MessageDescriptor) error {
	if v == nil {
		return fmt.Errorf("null content field %s", path)
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil // scalars and lists are protojson's business
	}
	// Sorted, so with two problems the same one is reported every run.
	keys := make([]string, 0, len(obj))
	for key := range obj {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	fields := md.Fields()
	for _, key := range keys {
		fd := fields.ByJSONName(key)
		if fd == nil {
			if byName := fields.ByName(protoreflect.Name(key)); byName != nil {
				return fmt.Errorf("key %q at %s is the proto name; use the JSON name %q", key, path, byName.JSONName())
			}
			return fmt.Errorf("unknown key %q at %s", key, path)
		}
		child := path + "." + key
		if err := refuseField(child, obj[key], fd); err != nil {
			return err
		}
	}
	return nil
}

func refuseField(path string, v any, fd protoreflect.FieldDescriptor) error {
	if v == nil {
		return fmt.Errorf("null content field %s", path)
	}
	switch {
	case fd.IsList():
		items, ok := v.([]any)
		if !ok {
			return nil
		}
		for i, item := range items {
			// A list of messages names its entries by id ("pieces[candle]").
			name := strconv.Itoa(i)
			if entry, ok := item.(map[string]any); ok {
				if id, ok := entry["id"].(string); ok && id != "" {
					name = id
				}
			}
			if err := refuseSingular(fmt.Sprintf("%s[%s]", path, name), item, fd); err != nil {
				return err
			}
		}
		return nil
	case fd.IsMap():
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		keys := make([]string, 0, len(m))
		for key := range m {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			// Map keys are data, not schema: only the values are walked.
			if err := refuseSingular(fmt.Sprintf("%s[%q]", path, key), m[key], fd.MapValue()); err != nil {
				return err
			}
		}
		return nil
	default:
		return refuseSingular(path, v, fd)
	}
}

func refuseSingular(path string, v any, fd protoreflect.FieldDescriptor) error {
	if v == nil {
		return fmt.Errorf("null content field %s", path)
	}
	if fd.Message() != nil {
		return refuseContent(path, v, fd.Message())
	}
	return nil
}

// entryList names the entries of one repeated field: the field's JSON name
// (as violation paths spell it) and each entry's id, in order.
type entryList struct {
	field string
	ids   []string
}

// entryLists names the entries of the named repeated fields (spelled as the
// violation paths spell them — the fields' JSON names), each entry by its
// id, in order — the loaders' map for rewriting a violation path
// ("projects[2]") to name the entry.
func entryLists(msg proto.Message, fields ...string) []entryList {
	md := msg.ProtoReflect().Descriptor()
	out := make([]entryList, 0, len(fields))
	for _, field := range fields {
		fd := md.Fields().ByJSONName(field)
		if fd == nil {
			fd = md.Fields().ByName(protoreflect.Name(field))
		}
		if fd == nil || !fd.IsList() {
			continue
		}
		list := msg.ProtoReflect().Get(fd).List()
		ids := make([]string, list.Len())
		for i := range list.Len() {
			if e, ok := list.Get(i).Message().Interface().(interface{ GetId() string }); ok {
				ids[i] = e.GetId()
			}
		}
		out = append(out, entryList{field: fd.JSONName(), ids: ids})
	}
	return out
}

// evalRule is a CEL rule that errors mid-evaluation (a timestamp()
// conversion over a malformed string): protovalidate-go names the rule in
// the runtime error's text. Both runtimes render it like a violation, with
// the rule id the shared vectors assert.
var evalRule = regexp.MustCompile(`error evaluating ([^:]+): (.*)$`)

// contentValidate runs protovalidate and reports its violations the way the
// hand-written loaders did: naming the entry and the field
// ("invalid furnishings: candle footprint: ...").
func contentValidate(family string, entries []entryList, msg proto.Message) error {
	err := contentValidator.Validate(msg)
	if err == nil {
		return nil
	}
	if m := evalRule.FindStringSubmatch(err.Error()); m != nil {
		return fmt.Errorf("invalid %s: %s [%s]", family, strings.TrimSpace(m[2]), m[1])
	}
	var bad *protovalidate.ValidationError
	if !errors.As(err, &bad) {
		return err
	}
	md := msg.ProtoReflect().Descriptor()
	issues := make([]string, 0, len(bad.Violations))
	for _, v := range bad.Violations {
		issues = append(issues, nameEntry(entries, violationIssue(md, v)))
	}
	return fmt.Errorf("invalid %s: %s", family, strings.Join(issues, "; "))
}

// violationIssue renders one violation as "path: message [rule.id]", with
// the path's proto names spelled as the JSON names the files use. The rule
// id stays in the text: the shared vectors name the rule they refuse for,
// and both runtimes' errors must carry it.
func violationIssue(md protoreflect.MessageDescriptor, v *protovalidate.Violation) string {
	path := protovalidate.FieldPathString(v.Proto.GetField())
	issue := ""
	if path != "" {
		issue = jsonPath(md, path) + ": "
	}
	return issue + v.Proto.GetMessage() + " [" + v.Proto.GetRuleId() + "]"
}

// jsonPath spells a violation path's field names the way the JSON files do
// (period_minutes -> periodMinutes).
func jsonPath(md protoreflect.MessageDescriptor, path string) string {
	var b strings.Builder
	cur := md
	for rest := path; rest != ""; {
		name := rest
		rest = ""
		if i := strings.IndexByte(name, '.'); i >= 0 {
			name, rest = name[:i], name[i+1:]
		}
		// Trailing brackets stay as they are ("pieces[2]").
		brackets := ""
		if i := strings.IndexByte(name, '['); i >= 0 {
			name, brackets = name[:i], name[i:]
		}
		if name != "" {
			if fd := cur.Fields().ByName(protoreflect.Name(name)); fd != nil {
				name = string(fd.JSONName())
				switch {
				case fd.IsMap() && fd.MapValue().Message() != nil:
					cur = fd.MapValue().Message()
				case fd.Message() != nil:
					cur = fd.Message()
				}
			}
		}
		b.WriteString(name + brackets)
		if rest != "" {
			b.WriteString(".")
		}
	}
	return b.String()
}

var entryPath = regexp.MustCompile(`^(\w+)\[(\d+)\]\.?(.*)$`)

// nameEntry rewrites a violation path ("pieces[2].base.w: ...") to name the
// entry ("candle base.w: ..."); ids[i] names the entry in the message's
// field (pieces, rooms, residents).
func nameEntry(entries []entryList, issue string) string {
	m := entryPath.FindStringSubmatch(issue)
	if m == nil {
		return issue
	}
	for _, e := range entries {
		if e.field != m[1] {
			continue
		}
		i, err := strconv.Atoi(m[2])
		if err != nil || i < 0 || i >= len(e.ids) {
			return issue
		}
		// A message rule's path ends at the entry ("hazel: home is ...").
		if m[3] == "" {
			return e.ids[i]
		}
		if strings.HasPrefix(m[3], ":") {
			return e.ids[i] + m[3]
		}
		return e.ids[i] + " " + m[3]
	}
	return issue
}
