package api

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"testing"
)

type wireFixture struct {
	Name      string          `json:"name"`
	Case      string          `json:"case"`
	JSON      json.RawMessage `json:"json"`
	BinaryHex string          `json:"binaryHex,omitempty"`
}

func populated(m protoreflect.Message, depth int) {
	if depth > 8 {
		return
	}
	fields := m.Descriptor().Fields()
	for i := 0; i < fields.Len(); i++ {
		f := fields.Get(i)
		if f.ContainingOneof() != nil && m.WhichOneof(f.ContainingOneof()) != nil {
			continue
		}
		value := func() protoreflect.Value {
			switch f.Kind() {
			case protoreflect.MessageKind:
				return protoreflect.ValueOfMessage(m.NewField(f).Message())
			case protoreflect.StringKind:
				return protoreflect.ValueOfString("fixture")
			case protoreflect.BoolKind:
				return protoreflect.ValueOfBool(true)
			case protoreflect.BytesKind:
				return protoreflect.ValueOfBytes([]byte{1, 2})
			case protoreflect.DoubleKind:
				return protoreflect.ValueOfFloat64(1)
			case protoreflect.FloatKind:
				return protoreflect.ValueOfFloat32(1)
			case protoreflect.EnumKind:
				n := f.Enum().Values().Get(0).Number()
				if f.Enum().Values().Len() > 1 {
					n = f.Enum().Values().Get(1).Number()
				}
				return protoreflect.ValueOfEnum(n)
			case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
				return protoreflect.ValueOfInt32(1)
			case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
				return protoreflect.ValueOfUint32(1)
			default:
				panic("unexpected fixture scalar")
			}
		}
		if f.IsMap() {
			v := m.Mutable(f).Map().NewValue()
			switch f.MapValue().Kind() {
			case protoreflect.StringKind:
				v = protoreflect.ValueOfString("fixture")
			case protoreflect.DoubleKind:
				v = protoreflect.ValueOfFloat64(1)
			case protoreflect.BoolKind:
				v = protoreflect.ValueOfBool(true)
			case protoreflect.Int32Kind:
				v = protoreflect.ValueOfInt32(1)
			case protoreflect.MessageKind:
				populated(v.Message(), depth+1)
			default:
				panic("unexpected map")
			}
			m.Mutable(f).Map().Set(protoreflect.ValueOfString("fixture").MapKey(), v)
		} else if f.IsList() {
			l := m.Mutable(f).List()
			v := l.NewElement()
			if f.Kind() == protoreflect.MessageKind {
				populated(v.Message(), depth+1)
			} else {
				v = value()
			}
			l.Append(v)
		} else if f.Kind() == protoreflect.MessageKind {
			if f.Message().FullName() == "google.protobuf.Value" {
				m.Mutable(f).Message().Set(f.Message().Fields().ByName("string_value"), protoreflect.ValueOfString("fixture"))
			} else {
				populated(m.Mutable(f).Message(), depth+1)
			}
		} else {
			m.Set(f, value())
		}
	}
}
func TestServerFirstWireFixtures(t *testing.T) {
	var fixtures []wireFixture
	files := []protoreflect.FileDescriptor{contract.File_glimway_v1_op_proto, contract.File_glimway_v1_operations_proto, contract.File_glimway_v1_profile_proto, contract.File_glimway_v1_state_proto, contract.File_glimway_v1_wilds_proto, contract.File_glimway_v1_village_proto, contract.File_glimway_v1_world_proto}
	for _, file := range files {
		messages := file.Messages()
		for i := 0; i < messages.Len(); i++ {
			md := messages.Get(i)
			mt, err := protoregistry.GlobalTypes.FindMessageByName(md.FullName())
			if err != nil {
				t.Fatal(err)
			}
			for _, kind := range []string{"empty", "populated"} {
				m := mt.New()
				if kind == "populated" {
					populated(m, 0)
				}
				raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(m.Interface())
				if err != nil {
					t.Fatal(err)
				}
				fixtures = append(fixtures, wireFixture{string(md.FullName()), kind, raw, ""})
			}
		}
	}
	// Exercise production's state projection and mixed writer, not a handcrafted JSON body.
	x := newRig(t)
	x.now.Store(1791400000)
	c, _ := x.ready("fixture-hero")
	w := x.rawHTTP("GET", "/api/state", nil, c)
	var state contract.StateResponse
	if err := protojson.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	state.State.Account.AccountId = "fixture-account"
	state.State.Account.WorldId = "fixture-world"
	state.State.Vitals.VitalsAt = 1
	state.State.Vitals.CastReadyAt = 1
	state.State.Vitals.ReportGeneration = "generation"
	state.State.Vitals.ReportClient = "client"
	raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(state.State)
	if err != nil {
		t.Fatal(err)
	}
	fixtures = append(fixtures, wireFixture{"glimway.v1.PlayerState", "valid", raw, ""})
	questState := proto.Clone(state.State).(*contract.PlayerState)
	questState.Story.Quests = map[string]string{"set-to-rise": "let-it-rise"}
	questState.Story.ReachedAt = map[string]float64{"set-to-rise": 1791400000}
	questState.Story.GateAt = map[string]float64{"set-to-rise": 1791400000}
	questRaw, err := opResultBytes(questState, &contract.QuestStepResult{
		Quest: "set-to-rise", Step: "let-it-rise", Embers: 2, EmbersSpent: 1,
		Taken: []*contract.ItemQty{{Def: "flour", Qty: 1}}, Given: []*contract.ItemQty{{Def: "keepers-twists", Qty: 2}},
	})
	if err != nil {
		t.Fatal(err)
	}
	fixtures = append(fixtures, wireFixture{"glimway.v1.Envelope", "quest-gates", questRaw, ""})
	mixed, err := mixedBytes(state.State, map[string]any{"home": nil, "materials": map[string]int{}, "itemId": ""})
	if err != nil {
		t.Fatal(err)
	}
	fixtures = append(fixtures, wireFixture{"mixed", "empty", mixed, ""})
	for _, result := range []proto.Message{&contract.ReportResult{Seq: 1, Accepted: true, Client: "client", Generation: "generation", Basis: state.State.Version}, &contract.QuestStepResult{Quest: "lantern-road", Step: "accepted"}} {
		raw, err := opResultBytes(state.State, result)
		if err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, wireFixture{"glimway.v1.Envelope", "valid", raw, ""})
	}
	// Capture real domain read extras, with embedded snapshots excluded.
	for _, route := range []string{"/api/items", "/api/storage", "/api/mail", "/api/projects", "/api/commons"} {
		w := x.rawHTTP(http.MethodGet, route, nil, c)
		if w.Code != 200 {
			t.Fatal(route, w.Code, w.Body.String())
		}
		var read struct {
			Result map[string]json.RawMessage `json:"result"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &read); err != nil {
			t.Fatal(err)
		}
		raw, err := mixedBytes(state.State, read.Result)
		if err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, wireFixture{"mixed", route, raw, ""})
	}
	chunk := &contract.WildsChunk{EpochId: "epoch", Region: "inner-1", Realm: "hearthwick", Look: "tangle", Cx: 1, Cy: 0, GeneratorVersion: 2, Size: 24, Palette: []string{"grass"}, Ground: make([]byte, 288), Solid: make([]byte, 72), Spawn: &contract.Tile{Tx: 1, Ty: 1}, Decor: &contract.DecorList{Kinds: []string{"tree"}, Kind: []uint32{0}, Tx: []uint32{2}, Ty: []uint32{3}, Ox: []int32{1}, Oy: []int32{-2}, Variant: []uint32{0}, Flags: []byte{0}}, Entities: []*contract.WildsEntity{{Id: "node:1:0:0", Kind: "node", Tx: 3, Ty: 4, Material: "timber"}}, Sites: []*contract.StorySite{{Id: "echo", Kind: contract.SiteKind_SITE_KIND_ECHO, Tx: 3, Ty: 5}}, Exits: []*contract.Exit{{Tx: 12, Ty: 0, Tw: 1, Th: 1, Dir: contract.Dir_DIR_NORTH, To: "chunk:outer-1:1:1", Entry: &contract.Tile{Tx: 12, Ty: 23}}}}
	chunkJSON, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(chunk)
	if err != nil {
		t.Fatal(err)
	}
	binary, err := proto.Marshal(chunk)
	if err != nil {
		t.Fatal(err)
	}
	fixtures = append(fixtures, wireFixture{"glimway.v1.WildsChunk", "valid", chunkJSON, hex.EncodeToString(binary)})

	add := func(kind string, message proto.Message) {
		raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, wireFixture{string(message.ProtoReflect().Descriptor().FullName()), kind, raw, ""})
	}
	add("valid-refusal", &contract.Refusal{Error: &contract.ErrorDetail{Code: "not-next-step"}, State: state.State})
	add("world-choice", &contract.SessionResponse{Answer: &contract.SessionResponse_WorldChoice{WorldChoice: &contract.WorldChoice{HabiticaId: "held-subject", DisplayName: "New hero", PartyWorld: &contract.WorldRef{Id: "party-world", OwnerName: "Party", Members: 2, Party: true}, PartyAdmitted: true}}})
	add("valid-play", &contract.PlayResponse{State: state.State, Lease: "lease", ReportGeneration: "generation", ReportClient: "client"})
	add("valid-state", &contract.StateResponse{State: state.State, LeaseActive: true})
	owned := map[string]*structpb.Value{"released": structpb.NewNullValue(), "zero": structpb.NewNumberValue(0), "negative": structpb.NewNumberValue(-1), "owned": structpb.NewBoolValue(true)}
	add("nullable-ownership", &contract.HabiticaUser{Id: "fixture-hero", Items: &contract.HabiticaUserItems{Pets: owned, Mounts: owned}})
	for _, reason := range []string{"not-wilds", "invalid-place", "epoch-missing", "daily-cap", ""} {
		result := &contract.FallResult{Vitals: state.State.Vitals, Place: state.State.Place, Lantern: "none", Reason: reason}
		if reason == "" {
			result.Lantern = "placed"
			result.LanternId = "fallen-lamp"
			result.Epoch = "epoch"
		}
		envelope, err := typedEnvelope(state.State, result)
		if err != nil {
			t.Fatal(err)
		}
		add("fall-"+reason, envelope)
	}
	entity := &contract.WildsEntityState{Id: "node:1:0:0", Epoch: "epoch", Cycle: 2, State: "harvested", AvailableAt: 1791400020, By: wrapperspb.String("fixture-account"), At: wrapperspb.Double(1791400000)}
	lamp := &contract.WildsLantern{Id: "fallen-lamp", OwnerId: "peer-account", DisplayName: "Peer", X: 400, Y: 300, At: 1791400000, LitBy: wrapperspb.String("fixture-account"), LitAt: wrapperspb.Double(1791400010)}
	add("valid-region", &contract.WildsRegionResult{Epoch: &contract.WildsEpoch{Id: "epoch", WorldSeed: "world-seed", RegionId: "outer-1", GeneratorVersion: 2, Season: "autumn", StartsAt: 1791300000, EndsAt: wrapperspb.Double(1791500000)}, Entities: []*contract.WildsEntityState{entity}, Echoes: []*contract.EchoAssignment{{Site: "echo-tam", Member: "tam", Settled: true}}, Lanterns: []*contract.WildsLantern{lamp}, Materials: map[string]float64{"timber": 3}})
	loot := &contract.WildsLoot{Materials: []*contract.WildsMaterial{{Id: "timber", Qty: 2}}, Trinket: wrapperspb.String("beeswax-candle")}
	for kind, result := range map[string]proto.Message{
		"claim-loot":   &contract.WildsClaimResult{Epoch: "epoch", Entity: entity, Loot: loot, Materials: map[string]float64{"timber": 3}, Papers: []string{"failed-grid-of-sector-4"}},
		"lantern-loot": &contract.WildsLanternResult{Epoch: "epoch", Rewarded: true, Loot: loot, Materials: map[string]float64{"timber": 3}, Lanterns: []*contract.WildsLantern{lamp}},
	} {
		envelope, err := typedEnvelope(state.State, result)
		if err != nil {
			t.Fatal(err)
		}
		add(kind, envelope)
	}
	// A keyed domain write uses production's transaction and mixed result writer.
	play := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
	request := &contract.MarkRequest{Op: &contract.OpHeader{Lease: play.Lease, Key: "fixture-domain"}, Where: &contract.Where{Area: "village", X: 2, Y: 3}, Mark: "seen:fixture"}
	req := httptest.NewRequest("POST", "/api/items/gather", nil)
	req.AddCookie(c)
	mutation := httptest.NewRecorder()
	if err = x.api.keyedOp(mutation, req, request.Op, request.Where, request, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if _, err := tx.ExecContext(ctx, "INSERT INTO item_stacks(location,owner,item_def,qty,maker_id) VALUES('pack',?,'timber',2,'')", s.AccountID); err != nil {
			return nil, err
		}
		items, err := readItems(ctx, tx, s, now)
		return itemResult{Items: items, Gathered: []stackView{{ItemDef: "timber", Qty: 2}}}, err
	}); err != nil {
		t.Fatal(err)
	}
	var domain struct {
		State  json.RawMessage
		Result json.RawMessage
	}
	if err = json.Unmarshal(mutation.Body.Bytes(), &domain); err != nil {
		t.Fatal(err)
	}
	if mutation.Code != 200 {
		t.Fatal(mutation.Body.String())
	}
	writer := httptest.NewRecorder()
	writeMixed(writer, 200, state.State, domain.Result)
	fixtures = append(fixtures, wireFixture{"mixed", "keyed-items", json.RawMessage(writer.Body.Bytes()), ""})
	path := "testdata/server-first.json"
	sort.SliceStable(fixtures, func(i, j int) bool {
		if fixtures[i].Name == fixtures[j].Name {
			return fixtures[i].Case < fixtures[j].Case
		}
		return fixtures[i].Name < fixtures[j].Name
	})
	raw, err = json.MarshalIndent(fixtures, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	if os.Getenv("UPDATE_PROTO_FIXTURES") == "1" {
		if err = os.WriteFile(path, raw, 0644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	if json.Unmarshal(raw, &a) != nil || json.Unmarshal(want, &b) != nil || !reflect.DeepEqual(a, b) {
		t.Fatal("wire fixture changed; regenerate and review contract")
	}
}
