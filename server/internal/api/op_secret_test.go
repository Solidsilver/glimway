package api

import (
	contract "glimway/server/internal/gen/glimway/v1"
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/known/structpb"
)

// The idempotency cache stores every keyed request body, minus `op`, for
// seven days and `GET /api/operations/result` hands it back to anyone
// holding the session (review finding 9). A credential in there would be
// plaintext in the database, the WAL and on the wire — and 0.6's top-up
// request sends a Habitica token. requestBytes refuses secret fields by
// construction; this walk holds every request type the keyed pipeline
// routes to that rule.

// keyedRequests is every request type routed through keyedOp (routes.go and
// the handlers behind it). A new keyed route belongs here.
func keyedRequests() []proto.Message {
	return []proto.Message{
		&contract.CompanionsRequest{},
		&contract.HearthCraftRequest{},
		&contract.DeskCopyRequest{},
		&contract.WoodpileRequest{},
		&contract.FishCastRequest{},
		&contract.FishSettleRequest{},
		&contract.FishCancelRequest{},
		&contract.ShelfRequest{},
		&contract.HomesteadRequest{},
		&contract.ItemsRequest{},
		&contract.LibraryDonateRequest{},
		&contract.MailSendRequest{},
		&contract.MailKeyedRequest{},
		&contract.ContributeRequest{},
		&contract.MendRequest{},
		&contract.SpendRequest{},
		&contract.StallRequest{},
		&contract.MountOutRequest{},
		&contract.MountHomeRequest{},
		&contract.StableExtendRequest{},
		&contract.QuestStepRequest{},
		&contract.MarkRequest{},
		&contract.TakePaperRequest{},
		&contract.FallRequest{},
		&contract.WildsClaimRequest{},
		&contract.WildsLanternRequest{},
		&contract.SettleEchoRequest{},
		&contract.StorageMoveRequest{},
		&contract.CraftRequest{},
		&contract.WorldMoveRequest{},
		&contract.WorldLeaveRequest{},
	}
}

func TestKeyedRequestsNeverCarryASecret(t *testing.T) {
	for _, req := range keyedRequests() {
		md := req.ProtoReflect().Descriptor()
		if name, ok := secretProtoField(md, map[protoreflect.FullName]bool{}); ok {
			t.Fatalf("%s routes a secret field to the cache: %s", md.FullName(), name)
		}
		if _, err := requestBytes(req); err != nil {
			t.Fatalf("%s: %v", md.FullName(), err)
		}
	}
}

func TestNoMessageButTheSignInCarriesACredential(t *testing.T) {
	// Every message of the contract, not just today's keyed routes: a new
	// request type is under the rule the day it is added. The sign-in's
	// token is the one credential the contract carries — login is never
	// keyed, and requestBytes must refuse it outright.
	protoregistry.GlobalFiles.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
		if string(fd.Package()) != "glimway.v1" {
			return true
		}
		msgs := fd.Messages()
		for i := 0; i < msgs.Len(); i++ {
			m := msgs.Get(i)
			if name, ok := secretProtoField(m, map[protoreflect.FullName]bool{}); ok && m.FullName() != "glimway.v1.LoginRequest" {
				t.Errorf("%s carries the secret field %s", m.FullName(), name)
			}
		}
		return true
	})
	if _, err := requestBytes(&contract.LoginRequest{}); err == nil {
		t.Fatal("the sign-in token passed the cache's guard")
	}
	// A credential under an invented key goes the same way: Struct and map
	// keys are runtime data, not descriptor fields.
	if _, err := requestBytes(map[string]any{"op": map[string]any{"key": "k"}, "api_key": secret}); err == nil {
		t.Fatal("an api_key passed the cache's guard")
	}
	if _, err := requestBytes(map[string]any{"nested": map[string]any{"accessToken": secret}}); err == nil {
		t.Fatal("a nested accessToken passed the cache's guard")
	}
	// A map key that is a content id is never a credential (review finding
	// 6): `tally-token` is a quest item, and no operation may be refused for
	// carrying it.
	if _, err := requestBytes(&contract.ContributeRequest{Materials: map[string]int32{"tally-token": 1}}); err != nil {
		t.Fatal("a content id read as a secret", err)
	}
	// But a key invented at run time is the request's own — a Struct/Value
	// subtree is scanned whole.
	gear := &contract.HabiticaUserGear{Equipped: map[string]*structpb.Value{"apiToken": structpb.NewStringValue(secret)}}
	if _, err := requestBytes(gear); err == nil {
		t.Fatal("a Struct key named apiToken passed the cache's guard")
	}
}
