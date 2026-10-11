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
	if len(rows) < 50 {
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

// A cast's fight part is the caster's own (review P3-2): the relay strips it.
func TestRelayedAbilityStripsTheFightPart(t *testing.T) {
	p := &presencePeer{identity: presenceIdentity{ID: "alice"}}
	cast := &contract.PresenceAbility{Ability: "cleave", X: 10, Y: 20, Fight: &contract.FightCast{
		SeenTick: 7, SeenOffsetMs: 40, SwingCounter: 3, Facing: &contract.FightFacing{X: 1},
		Predicted: []*contract.FightTarget{{Room: 1, Enemy: 2}},
	}}
	raw, err := relayedAbility(p, cast)
	if err != nil {
		t.Fatal(err)
	}
	message, err := decodePresence(raw)
	if err != nil {
		t.Fatal(err)
	}
	out := message.GetAbility()
	if out.Fight != nil || out.GetAccountId() != "alice" || out.GetAbility() != "cleave" || out.GetX() != 10 {
		t.Fatal("relayed cast", out)
	}
	if cast.Fight == nil {
		t.Fatal("relay changed the caster's message")
	}
}
