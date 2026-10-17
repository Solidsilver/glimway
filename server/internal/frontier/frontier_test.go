package frontier

import (
	"encoding/json"
	"os"
	"testing"

	"glimway/content"
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

// edge is a chunk on the static frontier's north edge, in column cx.
func edge(t *testing.T, cx int) int {
	t.Helper()
	for cy := -64; cy < 8; cy++ {
		if wilds.InsideReach(cx, cy) {
			return cy
		}
	}
	t.Fatal("no frontier in column", cx)
	return 0
}

// Held keys push one world's frontier out by the slack, no further south
// than the limit; the rect grows to hold it; other worlds keep the static
// frontier; setting none (or Reset) takes it back.
func TestHeldSlack(t *testing.T) {
	t.Cleanup(Reset)
	if Slack() != 3 {
		t.Fatalf("slack %d", Slack())
	}
	ey := edge(t, 2)
	if Inside("w", 2, ey-1) {
		t.Fatal("past the edge before a hold")
	}
	x0, y0, x1, y1 := Rect("w")
	Set("w", [][2]int{{2, ey}, {2, ey}})
	for d := 1; d <= 3; d++ {
		if !Inside("w", 2, ey-d) || !Inside("w", 2+d, ey-d) {
			t.Fatalf("not in the slack %d out", d)
		}
	}
	if Inside("w", 2, ey-4) || Inside("w", 6, ey-3) || Inside("other", 2, ey-1) {
		t.Fatal("past the slack, or in another world")
	}
	if got := Held("w"); len(got) != 1 || got[0] != [2]int{2, ey} {
		t.Fatalf("held %v", got)
	}
	if a, b, c, d := Rect("w"); b != min(y0, ey-3) || a != x0 || c != x1 || d != y1 {
		t.Fatalf("rect %d,%d..%d,%d from %d,%d..%d,%d", a, b, c, d, x0, y0, x1, y1)
	}
	// The south limit holds for held land too.
	south := int(content.WildsRules.GetFrontier().GetSouthLimit())
	Set("w", [][2]int{{40, south}})
	if Inside("w", 40, south+1) || !Inside("w", 40, south) || !Inside("w", 43, south-3) {
		t.Fatal("south of the limit")
	}
	if _, _, _, d := Rect("w"); d > south {
		t.Fatalf("rect past the south limit: %d", d)
	}
	Set("w", nil)
	if Inside("w", 40, south) || Held("w") != nil {
		t.Fatal("kept after none")
	}
	if a, b, c, d := Rect("w"); [4]int{a, b, c, d} != [4]int{x0, y0, x1, y1} {
		t.Fatal("rect kept")
	}
	Set("w", [][2]int{{2, ey}})
	Reset()
	if Inside("w", 2, ey-1) {
		t.Fatal("kept after Reset")
	}
}
