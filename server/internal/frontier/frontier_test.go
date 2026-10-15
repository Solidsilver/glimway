package frontier

import (
	"encoding/json"
	"os"
	"testing"

	"glimway/server/internal/wilds"
)

func TestFrontierVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../content/vectors/wilds-coords.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Chunks []struct {
			Chunk  [2]int
			Inside bool
		}
		Frontier struct {
			Rect   [4]int
			Chunks int
			New    int
		}
	}
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Chunks {
		if Inside("w", c.Chunk[0], c.Chunk[1]) != c.Inside {
			t.Errorf("chunk %v: inside %v", c.Chunk, !c.Inside)
		}
	}
	x0, y0, x1, y1 := Rect("w")
	if [4]int{x0, y0, x1, y1} != v.Frontier.Rect {
		t.Fatalf("rect %d,%d..%d,%d; want %v", x0, y0, x1, y1, v.Frontier.Rect)
	}
	// Count the reach union; the bounding rectangle includes closed corners.
	inside, fresh := 0, 0
	for cy := y0 - 5; cy <= y1+5; cy++ {
		for cx := x0 - 5; cx <= x1+5; cx++ {
			in := Inside("w", cx, cy)
			if in {
				inside++
				if wilds.FootprintAt(cx, cy) == nil && wilds.FixedFootprintAt(cx, cy) == nil {
					fresh++
				}
			}
		}
	}
	if inside != v.Frontier.Chunks || fresh != v.Frontier.New {
		t.Fatalf("%d chunks inside, %d new; want %d, %d", inside, fresh, v.Frontier.Chunks, v.Frontier.New)
	}
}
