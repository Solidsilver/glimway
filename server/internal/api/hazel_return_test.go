package api

import "testing"

// Hazel stops and talks anywhere on her outdoor route, but a keepsake's
// return is measured from her scheduled post (nearResident): at the square
// it goes through; at the bakery end of her route it is refused, and the
// client no longer offers it there (src/game/resident-reach.ts).
func TestHazelReturnMeasuredFromHerPost(t *testing.T) {
	for _, cse := range []struct {
		name   string
		x, y   int
		status int
	}{
		{"square post", 9, 63, 200},
		{"bakery route endpoint", 6, 54, 409},
	} {
		t.Run(cse.name, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.residentPhase("hazel", "square")
			x.stack(x.account("alice"), "tin-whistle", "", 1)
			x.opRefreshing(c, &s, "return", map[string]any{
				"itemDef": "tin-whistle", "target": "hazel",
				"where": map[string]any{"area": "outdoors", "x": cse.x*16 + 8, "y": cse.y*16 + 16},
			}, cse.status)
		})
	}
}
