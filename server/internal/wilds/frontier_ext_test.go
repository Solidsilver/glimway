package wilds_test

import (
	"testing"

	"glimway/server/internal/frontier"
	"glimway/server/internal/wilds"
)

// The generator keeps its own copy of the 0.8 frontier rule (frontier
// imports wilds, so wilds can't import it) for the river's course and the
// rumour's cells. It must be frontier's rule exactly.
func TestFrontierCopyMatches(t *testing.T) {
	a0, a1, a2, a3 := wilds.FrontierChunks()
	b0, b1, b2, b3 := frontier.Rect("w")
	if a0 != b0 || a1 != b1 || a2 != b2 || a3 != b3 {
		t.Fatalf("wilds %d,%d..%d,%d, frontier %d,%d..%d,%d", a0, a1, a2, a3, b0, b1, b2, b3)
	}
	for cy := b1 - 3; cy <= b3+3; cy++ {
		for cx := b0 - 3; cx <= b2+3; cx++ {
			if wilds.InsideReach(cx, cy) != frontier.Inside("w", cx, cy) {
				t.Fatalf("chunk %d,%d disagrees", cx, cy)
			}
		}
	}
}
