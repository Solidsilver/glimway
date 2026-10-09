package content

import (
	"os"
	"testing"

	pv "buf.build/go/protovalidate"
	contentv1 "glimway/gen/glimway/content/v1"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestProbeVectors(t *testing.T) {
	val, err := pv.New()
	if err != nil {
		t.Fatal(err)
	}
	run := func(file, vectorName string, mk func() proto.Message, vectors []loaderVector) {
		base, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range vectors {
			msg := mk()
			raw := editVector(t, base, v)
			status := "ok"
			if err := protojson.Unmarshal(raw, msg); err != nil {
				status = "decode: " + err.Error()
			} else if err := val.Validate(msg); err != nil {
				status = "validate: " + err.Error()
			}
			mark := "PASS"
			if (status == "ok") != v.Valid {
				mark = "MISS"
			}
			t.Logf("%s %s/%-32s want_valid=%v %s", mark, vectorName, v.Name, v.Valid, status)
		}
	}
	var furn struct {
		Loader []loaderVector
	}
	readVectors(t, "furnishings", &furn)
	run("furnishings.json", "furnishings", func() proto.Message { return &contentv1.Furnishings{} }, furn.Loader)

	var roomVectors struct {
		Rooms, Residents []loaderVector
	}
	readVectors(t, "rooms", &roomVectors)
	run("rooms.json", "rooms", func() proto.Message { return &contentv1.Rooms{} }, roomVectors.Rooms)
	run("residents.json", "residents", func() proto.Message { return &contentv1.Residents{} }, roomVectors.Residents)
}
