package api

import (
	"context"
	"testing"

	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
)

func TestOutdoorsPresenceV4Grammar(t *testing.T) {
	if presenceProtocol != "glimway.presence.v4" {
		t.Fatal(presenceProtocol)
	}
	for _, room := range []string{"outdoors:0:0", "outdoors:-1:-1", "outdoors:-1:1", "outdoors:1:2", "home:0", "in:commons:yard"} {
		if !validPresenceRoom(room) {
			t.Error("refused", room)
		}
	}
	for _, room := range []string{"wilds", "wilds:0:0", "outdoors", "outdoors:00:0", "outdoors:-0:0", "outdoors:+1:0", "outdoors:2:4", "outdoors:5:0", "outdoors:0:0:0", "commons"} {
		if validPresenceRoom(room) {
			t.Error("accepted", room)
		}
	}
	// The Commons is outdoors (S5): no saved area or room of its own.
	if validArea("wilds") || !validArea("outdoors") || validArea("commons") || !validArea("in:commons:yard") {
		t.Fatal("saved-space grammar")
	}
}

func TestLocationRulesAtSeam(t *testing.T) {
	for _, row := range []struct {
		area      string
		x, y      float64
		safe, gen bool
		id        string
	}{
		{"outdoors", 40, 424, true, false, "hearthwick"},
		{"outdoors", 40, 392, true, false, "hearthwick"},
		{"outdoors", 40, 376, false, true, "tangle"},
		{"outdoors", 40, -1200, false, true, "whitequiet"},
		{"village", 400, 300, true, false, "village"},
		{"home:0", 40, 40, true, false, "home:0"},
		{"in:commons:yard", 40, 40, true, false, "in:commons:yard"},
		{"wilds", 40, 376, false, false, "wilds"},
	} {
		t.Run(row.area+row.id, func(t *testing.T) {
			s := store.Snapshot{State: rules.NewState()}
			s.State.Area = row.area
			s.State.Position = rules.Position{X: row.x, Y: row.y}
			// Shared eligibility for profile reports, world moves, sync and lamplight.
			p := location.At(location.Space(row.area), row.x, row.y)
			if p.Safe != row.safe || p.Sync != row.safe || rules.IsSafeArea(row.area, s.State.Position) != row.safe || placeID(s) != row.id {
				t.Fatal(p, placeID(s))
			}
			result := rules.Sync(rules.Save{State: s.State, VitalsSource: "demo"}, rules.Profile{HP: 20, MaxHP: 50, MP: 10, MaxMP: 30}, true)
			if (result.Status != "rejected") != row.safe {
				t.Fatal(result.Status)
			}
			// Reward/near/fallen lantern gates all reject fixed ground.
			if generatedPlace(row.area, row.x, row.y) != row.gen {
				t.Fatal("generated eligibility", p)
			}
			tx, ty := wildsTileOf(row.x, row.y)
			if (nearWithin(s, tx, ty, 3) == nil) != row.gen {
				t.Fatal("near eligibility", p)
			}
			if !row.gen {
				f, err := (wildsService{}).PlaceFallen(context.Background(), nil, &s, nil, &contract.Where{Area: row.area, X: row.x, Y: row.y}, 1)
				if err != nil || f.Reason != "not-wilds" {
					t.Fatal(f, err)
				}
			}
		})
	}
}

// Content names Commons positions in layout tiles; reach resolves them onto
// the outdoors grid, and the old local frame reaches nothing.
func TestContentReachResolvesCommonsTilesOntoTheGrid(t *testing.T) {
	s := store.Snapshot{State: rules.NewState()}
	s.State.Area = "commons"
	s.State.Position = rules.Position{X: 53*16 + 8, Y: 18*16 + 8}
	if nearTile(&s, "hearthwick", 34, 35, 0) {
		t.Fatal("local reach")
	}
	space, tx, ty := location.ContentSpace("hearthwick"), 34, 35
	s.State.Area = string(space)
	s.State.Position = rules.Position{X: float64(tx*16 + 8), Y: float64(ty*16 + 8)}
	if !nearTile(&s, "hearthwick", 34, 35, 0) || placeID(s) != "hearthwick" {
		t.Fatal("world reach")
	}
	s.State.Position.X += 17
	if nearTile(&s, "hearthwick", 34, 35, 1) {
		t.Fatal("reach widened")
	}
	if beatRoom("echo:nan", "outdoors", "outdoors:0:1", &presencePosition{X: 40, Y: 392}) || !beatRoom("echo:nan", "outdoors", "outdoors:0:-1", &presencePosition{X: 40, Y: -8}) {
		t.Fatal("echo must stand on generated ground")
	}
}
