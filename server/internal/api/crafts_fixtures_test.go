package api

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

// The Crafts lanes' sample messages (content/vectors/crafts-fixtures.json):
// the shapes lanes B-G send, store and draw, in ProtoJSON spelling. Every
// fixture must decode and re-emit exactly as the wire spells it — the file
// is shared with the TypeScript test (tests/crafts-fixtures.test.ts), and
// frozen: fix a fixture that drifts, never a decoder that refuses it.
func TestCraftsFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../../content/vectors/crafts-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Messages []struct {
			Name string          `json:"name"`
			Type string          `json:"type"`
			JSON json.RawMessage `json:"json"`
		} `json:"messages"`
	}
	if err = json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Messages) == 0 {
		t.Fatal("no crafts fixtures")
	}
	for _, f := range doc.Messages {
		t.Run(f.Name, func(t *testing.T) {
			mt, err := protoregistry.GlobalTypes.FindMessageByName(protoreflect.FullName(f.Type))
			if err != nil {
				t.Fatalf("%s: %v", f.Type, err)
			}
			m := mt.New()
			if err = (protojson.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(f.JSON, m.Interface()); err != nil {
				t.Fatalf("decode: %v", err)
			}
			again, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(m.Interface())
			if err != nil {
				t.Fatal(err)
			}
			var got, want any
			if json.Unmarshal(again, &got) != nil || json.Unmarshal(f.JSON, &want) != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("fixture drift:\n got %s\nwant %s", again, f.JSON)
			}
		})
	}
}
