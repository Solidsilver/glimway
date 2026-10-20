package wilds

import (
	"encoding/json"
	"reflect"
	"testing"

	"glimway/content"
)

func TestToolContentReload(t *testing.T) {
	original, err := content.FS.ReadFile("wilds.json")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := ConfigureForTools(original); err != nil {
			t.Fatal(err)
		}
	})
	e := WickEpoch("lab-reload", "t:1795000000:1796209600")
	before, err := GenerateV3(e, -4, -9, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Prime the lazy seam cache before changing the vocabulary.
	_ = seams()
	var doc map[string]any
	if err := json.Unmarshal(original, &doc); err != nil {
		t.Fatal(err)
	}
	// Reordering vocabularies is legal. A stale cached index now points to a
	// different ID, catching incomplete resets that weight-only tuning misses.
	for _, key := range []string{"grounds", "decor", "lands"} {
		a := doc[key].([]any)
		for i, j := 0, len(a)-1; i < j; i, j = i+1, j-1 {
			a[i], a[j] = a[j], a[i]
		}
	}
	changed, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := ConfigureForTools(changed); err != nil {
		t.Fatal(err)
	}
	after, err := GenerateV3(e, -4, -9, nil)
	if err != nil {
		t.Fatal(err)
	}
	for i, g := range before.Ground {
		// Resolve the baseline IDs with the original document, not current globals.
		var base struct {
			Grounds []struct {
				ID string `json:"id"`
			}
		}
		if err := json.Unmarshal(original, &base); err != nil {
			t.Fatal(err)
		}
		if base.Grounds[int(g)].ID != content.WildsRules.Grounds[int(after.Ground[i])].GetId() {
			t.Fatalf("stale ground lookup at tile %d", i)
		}
	}
	if err := ConfigureForTools(original); err != nil {
		t.Fatal(err)
	}
	restored, err := GenerateV3(e, -4, -9, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, restored) {
		t.Fatal("restoring original content changed generated chunk")
	}
	if err := ConfigureForTools([]byte(`{"bad":true}`)); err == nil {
		t.Fatal("accepted invalid content")
	}
	if int(content.WildsRules.GetChunkSize()) != before.Size {
		t.Fatal("invalid reload changed active content")
	}
}

func TestToolMacroQueries(t *testing.T) {
	e := WickEpoch("lab-macro", "t:1795000000:1796209600")
	coords := [][2]int{{0, 0}, {-4, -9}, {5, -12}, {20, -20}}
	got := Glimpses(e, coords)
	for i, p := range coords {
		if land := LandAt(e, p[0]*chunkSize()+chunkSize()/2, p[1]*chunkSize()+chunkSize()/2); land != got[i].Land {
			t.Fatalf("land sample mismatch at %v", p)
		}
	}
	// Every tile paved by the macro road must lie inside a marked chunk.
	road := newRoad(e.WorldSeed)
	var positions [][2]int
	for _, p := range road.line.pts {
		tx, ty := p.tile()
		positions = append(positions, [2]int{FloorDiv(tx, chunkSize()), FloorDiv(ty, chunkSize())})
	}
	for i, hit := range RoadCrossings(e, positions) {
		if !hit {
			t.Fatalf("road misses its own point %v", positions[i])
		}
	}
	if c := GroundColour("future-ground"); c.A != 255 || c != GroundColour("future-ground") {
		t.Fatal("unknown grounds need stable opaque colours")
	}
}
