package wilds

import (
	"bytes"
	"os"
	"testing"

	"google.golang.org/protobuf/proto"
)

// TestClientFixtures keeps the client's chunk fixtures (tests/fixtures/*.bin)
// the server's real output: one entry chunk of each region, as served. The
// TypeScript tests decode and draw them. Regenerate with -update.
func TestClientFixtures(t *testing.T) {
	for _, f := range []struct {
		path  string
		epoch Epoch
		id    string
	}{
		{"../../../tests/fixtures/wilds-inner-1-1.bin", innerEpoch("fixture"), "fixture-inner"},
		{"../../../tests/fixtures/wilds-outer-1-1.bin", Epoch{"fixture", OuterRegion, GeneratorV2, "t:1790812800:1792022400"}, "fixture-outer"},
	} {
		c, err := GenerateChunk(f.epoch, 1, 1)
		if err != nil {
			t.Fatal(err)
		}
		b, err := proto.MarshalOptions{Deterministic: true}.Marshal(ToProto(c, f.id))
		if err != nil {
			t.Fatal(err)
		}
		if *updateGoldens {
			if err = os.WriteFile(f.path, b, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		got, err := os.ReadFile(f.path)
		if err != nil || !bytes.Equal(got, b) {
			t.Fatalf("%s is stale: go test ./internal/wilds -run TestClientFixtures -update", f.path)
		}
	}
}
