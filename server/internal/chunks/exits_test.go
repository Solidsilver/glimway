package chunks

import (
	"encoding/json"
	"os"
	"testing"

	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
)

// TestMalformedExits applies tests/fixtures/malformed-exits.json (shared with
// tests/wilds-chunks.test.ts) to the served fixture chunks: each must fail.
func TestMalformedExits(t *testing.T) {
	load := func(region string) *contract.WildsChunk {
		name := map[string]string{"inner-1": "inner", "outer-1": "outer"}[region]
		b, err := os.ReadFile("../../../tests/fixtures/wilds-" + name + "-1-1.bin")
		if err != nil {
			t.Fatal(err)
		}
		m := &contract.WildsChunk{}
		if err = proto.Unmarshal(b, m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	for _, region := range []string{"inner-1", "outer-1"} {
		if err := Validate(load(region)); err != nil {
			t.Fatalf("served %s chunk refused: %v", region, err)
		}
	}
	b, err := os.ReadFile("../../../tests/fixtures/malformed-exits.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string `json:"name"`
		Chunk string `json:"chunk"`
		Exit  int    `json:"exit"`
		Set   struct {
			TX, TY, TW, TH *uint32
			Dir            string `json:"dir"`
			To             string `json:"to"`
		} `json:"set"`
	}
	if err = json.Unmarshal(b, &cases); err != nil || len(cases) == 0 {
		t.Fatal("fixtures", err)
	}
	dirs := map[string]contract.Dir{"north": contract.Dir_DIR_NORTH, "east": contract.Dir_DIR_EAST, "south": contract.Dir_DIR_SOUTH, "west": contract.Dir_DIR_WEST}
	for _, c := range cases {
		m := load(c.Chunk)
		e := m.Exits[c.Exit]
		for _, f := range []struct {
			v   *uint32
			dst *uint32
		}{{c.Set.TX, &e.Tx}, {c.Set.TY, &e.Ty}, {c.Set.TW, &e.Tw}, {c.Set.TH, &e.Th}} {
			if f.v != nil {
				*f.dst = *f.v
			}
		}
		if c.Set.Dir != "" {
			e.Dir = dirs[c.Set.Dir]
		}
		if c.Set.To != "" {
			e.To = c.Set.To
		}
		if Validate(m) == nil {
			t.Errorf("%s: accepted", c.Name)
		}
	}
}
