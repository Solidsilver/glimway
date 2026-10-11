package api

import (
	"buf.build/go/protovalidate"
	"bytes"
	"encoding/hex"
	"encoding/json"
	contract "glimway/server/internal/gen/glimway/v2"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"os"
	"testing"
)

func TestFightContractSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../content/vectors/fights-wire.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Name      string
		JSON      json.RawMessage
		Valid     bool
		BinaryHex string
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 20 {
		t.Fatal("insufficient wire vectors")
	}
	validator, err := protovalidate.New()
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range rows {
		t.Run(v.Name, func(t *testing.T) {
			var message contract.PresenceMessage
			if err := protojson.Unmarshal(v.JSON, &message); err != nil {
				t.Fatal(err)
			}
			want, err := hex.DecodeString(v.BinaryHex)
			if err != nil {
				t.Fatal(err)
			}
			got, err := proto.Marshal(&message)
			if err != nil || !bytes.Equal(got, want) {
				t.Fatalf("wire mismatch: %x want %x (%v)", got, want, err)
			}
			decoded, err := decodePresence(want)
			if err != nil || !proto.Equal(decoded, &message) {
				t.Fatal("roundtrip", err)
			}
			if err := validator.Validate(decoded); (err == nil) != v.Valid {
				t.Fatal("validation", v.Valid, err)
			}
			if message.GetFightSwing() != nil && len(got) >= 1024 {
				t.Fatal("swing exceeds ingress limit")
			}
		})
	}
}
