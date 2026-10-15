package api

import (
	"encoding/json"
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/location"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"os"
	"strings"
	"testing"
)

func TestTownRuleVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../content/vectors/town-rules.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Spawn, Recovery struct {
			Area string
			X, Y float64
		}
		Gates []struct {
			Name, With, Area string
			Now              int64
			X, Y             float64
			Here             bool
		}
		FixedGather []struct {
			Name, Target string
			X, Y         float64
			Tile         []int
			Allowed      bool
		}
		Cases []struct {
			Name, Area, Rest, Target string
			X, Y                     float64
			Gather, GatherArea, Fish bool
		}
	}
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Gates {
		place := location.At(location.Space(c.Area), c.X, c.Y)
		if got := personHere(c.With, place.ID, c.Now); got != c.Here {
			t.Fatalf("%s: person here %v", c.Name, got)
		}
	}

	spawn := rules.NewTownState()
	if spawn.Area != v.Spawn.Area || spawn.Position != (rules.Position{X: v.Spawn.X, Y: v.Spawn.Y}) {
		t.Fatal("spawn", spawn.Area, spawn.Position)
	}
	area, p := rules.TownAnchor("well")
	if area != v.Recovery.Area || p != (rules.Position{X: v.Recovery.X, Y: v.Recovery.Y}) {
		t.Fatal("recovery", area, p)
	}
	for _, c := range v.FixedGather {
		s := store.Snapshot{State: rules.NewTownState()}
		s.State.Position = rules.Position{X: c.X, Y: c.Y}
		got := false
		if len(c.Tile) == 2 {
			x, y := c.Tile[0], c.Tile[1]
			cx, cy := wilds.FloorDiv(x, 24), wilds.FloorDiv(y, 24)
			got = fixedGatherAt(&s, chunks.Fixed(chunks.FixedEpoch("hearthwick", 1), int32(cx), int32(cy)), c.Target, x, y)
		}
		if got != c.Allowed {
			t.Fatalf("%s: fixed gather %v", c.Name, got)
		}
	}
	water, _ := content.WaterFor("water:village:mill-pond")
	bank, _ := content.BankFor(water, "north")
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			place := location.At(location.Space(c.Area), c.X, c.Y)
			if string(place.Rest) != c.Rest {
				t.Fatal("rest", place.Rest)
			}
			offered := place.ID
			if c.Area == "outdoors" && place.Source.Kind == location.SourceGenerated {
				offered = "wilds"
			}
			kind := offered
			if strings.HasPrefix(kind, "lot:") || strings.HasPrefix(kind, "home:") {
				kind = "home"
			}
			state := store.Snapshot{State: rules.NewTownState()}
			state.State.Area = c.Area
			state.State.Position = rules.Position{X: c.X, Y: c.Y}
			private := !strings.HasPrefix(place.ID, "lot:") || onPrivateLot(&state, homeGateAt(&state))
			canGather := private && validArea(c.Area) && !strings.HasPrefix(c.Area, "in:") && len(content.GatheringRules.GetAreas()[kind].GetTargets()) > 0
			if canGather != c.GatherArea {
				t.Fatal("gatherArea", canGather)
			}
			if got := private && validArea(c.Area) && content.GatheringOffered(offered, c.Target); got != c.Gather {
				t.Fatal("gather", got)
			}
			s := store.Snapshot{State: rules.NewTownState()}
			s.State.Area = c.Area
			s.State.Position = rules.Position{X: c.X, Y: c.Y}
			if got := nearBank(&s, water, bank); got != c.Fish {
				t.Fatal("fish", got)
			}
		})
	}
}

func TestTownRestBoundariesThroughAPI(t *testing.T) {
	for _, c := range []struct {
		name, area string
		x, y       float64
		allowed    bool
	}{
		{"square", "outdoors", 72, 968, true}, {"apron", "outdoors", 40, 392, true},
		{"library", "in:village:library", 80, 80, true}, {"Tangle", "outdoors", 40, 376, false},
		{"south", "outdoors", 152, 1544, false}, {"west", "outdoors", -1544, 1112, false},
		{"lot", "outdoors", -952, 712, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			x := newRig(t)
			cookie, s := x.ready("alice")
			x.fundGlims(s.AccountID, 10)
			doc := s.State
			doc.Area = c.area
			doc.Position = rules.Position{X: c.x, Y: c.y}
			s = x.reportState(cookie, s, 1, 0, testWhere(doc))
			doc = s.State
			status := 409
			if c.allowed {
				status = 200
			}
			got := x.exp("POST", "/api/spend", spendBody(s, "rest", "", "town-rest", doc), cookie, status)
			if !c.allowed && got.Error.Code != "not-at-safe-boundary" {
				t.Fatal(got.Error.Code)
			}
			paid := count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='spend'")
			if c.allowed && paid != 1 || !c.allowed && paid != 0 {
				t.Fatal("spend", paid)
			}
		})
	}
}

// Exercise the authored quest graph through real operations, rather than
// replacement quest rows. Town talks use outdoor world pixels; kitchen,
// library and mill steps retain their room identities.
func TestTownAuthoredQuestCampaign(t *testing.T) {
	x := newRig(t)
	cookie, s := x.ready("alice")
	if s.State.Area != "outdoors" || s.State.Position != rules.NewTownState().Position {
		t.Fatal("new arrival", s.State.Area, s.State.Position)
	}
	x.fundGlims(s.AccountID, 20)
	for _, item := range []string{"flour", "tallow", "mill-roach"} {
		x.stack(s.AccountID, item, "", 3)
	}
	for _, id := range []string{"signpost", "lantern-road", "your-own-day", "set-to-rise", "stuck-hoist", "seat-by-the-lamp", "a-line-in-the-race"} {
		t.Run(id, func(t *testing.T) {
			parent := x.t
			x.t = t
			defer func() { x.t = parent }()
			q, ok := content.QuestFor(id)
			if !ok {
				t.Fatal(id)
			}
			for _, step := range q.Steps {
				if wait := step.GetGate().GetWait(); wait != nil {
					for !content.QuestWaitReady(wait, s.State.GateAt[id], x.now.Load()) {
						x.now.Add(60)
					}
				}
				doc := s.State
				if area := step.GetAt(); area != "" {
					doc.Area = area
					if strings.HasPrefix(area, "in:") {
						doc.Position = rules.Position{X: 80, Y: 80}
					}
				}
				if step.GetAt() == "hearthwick" {
					doc.Area, doc.Position = rules.TownAnchor("spawn")
				}
				if where := step.GetWhere(); where != nil && where.GetArea() != "" && step.GetAt() == "" {
					doc.Area = where.GetArea()
				}
				person := step.GetDo().GetTalk()
				if person != "" {
					if resident, ok := content.ResidentByID(person); ok {
						preferred := ""
						switch person {
						case "hazel":
							preferred = "kitchen"
						case "finn":
							preferred = "door"
						}
						if preferred != "" {
							x.residentPhase(person, preferred)
						}
						spot := resident.GetSpots()[content.CycleAt(resident, float64(x.now.Load())).Spot]
						doc = atContentTile(doc, spot.GetArea(), int(spot.GetTx()), int(spot.GetTy()), 8)
					}
				}
				if enemy := step.GetDo().GetDefeat(); enemy != "" {
					s.Snapshot = x.expect("POST", "/api/story/mark", body(s, id+":"+step.GetId()+":defeat", map[string]any{"mark": "defeated:" + enemy, "where": testWhere(doc)}), cookie, 200).Snapshot
				}
				if step.GetDo().GetFlag() == "lit:road-1" {
					s.Snapshot = x.expect("POST", "/api/spend", body(s, "campaign-lamp", map[string]any{"kind": "road-lantern", "target": "road-1", "where": testWhere(doc)}), cookie, 200).Snapshot
				}
				if step.GetDo().GetSync() != "" {
					x.now.Add(60)
					doc.Area, doc.Position = rules.TownAnchor("spawn")
					x.companionSync(s, profile("alice", 2, 5, 20), doc, cookie)
					s.Snapshot = x.expect("GET", "/api/state", nil, cookie, 200).Snapshot
				}
				req := body(s, id+":"+step.GetId(), map[string]any{"quest": id, "to": step.GetId(), "where": testWhere(doc)})
				s.Snapshot = x.expect("POST", "/api/quest/step", req, cookie, 200).Snapshot
				if s.State.Quests[id] != step.GetId() {
					t.Fatal("step", s.State.Quests)
				}
			}
		})
	}
}
