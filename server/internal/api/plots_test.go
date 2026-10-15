package api

import (
	"fmt"
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/land"
	"testing"
)

// The same operations used by Arrange and gathering, with world pixels and
// local persisted home coordinates, on every one-chunk lot.
func TestOutdoorLotServices(t *testing.T) {
	for gate := 0; gate < 8; gate++ {
		t.Run(fmt.Sprint(gate), func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("plot-owner")
			x.pinWorld(&s)
			h := x.claimGate(c, &s, gate)
			ox, oy := chunks.LotOrigin(gate)
			x.fund(s.AccountID, 200, 0)
			s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
			doc := s.State
			doc.Area = "outdoors"
			doc.Position.X = float64((ox+11)*16 + 8)
			doc.Position.Y = float64((oy+8)*16 + 8)
			doc.HP = 1
			s = x.reportState(c, s, doc.HP, doc.Mana, testWhere(doc))
			x.expect("POST", "/api/spend", spendBody(s, "home-rest", "", fmt.Sprintf("plot-rest-%d", gate), doc), c, 200)
			s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
			// Local reserved site/public margins remain unavailable for furniture.

			cfg := content.HomeRules.GetLand()
			if cfg.GetWidth() != 24 || cfg.GetHeight() != 24 {
				t.Fatal("wrong grid")
			}
			tree := landTiles(h, land.Tree, true)
			if len(tree) == 0 {
				tree = landTiles(h, land.Stump, true)
			}
			local := litSpots(h)[0]
			if len(tree) > 0 {
				local = tree[0]
				x.homeOpRefreshing(c, &s, "clear", map[string]any{"x": local[0], "y": local[1]}, 200)
				if !groundOf(x.home(c)).cleared[local] {
					t.Fatal("clear stored world coordinates")
				}
			}
			kept := x.home(c)
			item := x.homeOpRefreshing(c, &s, "buy", map[string]any{"itemDef": "wooden-stool"}, 200).Result.ItemID
			if x.homeOpRefreshing(c, &s, "place", map[string]any{"itemId": item, "scene": "outdoor", "x": 8, "y": 3, "rotation": 0}, 409).Error.Code != "placement-overlap" {
				t.Fatal("built on the cottage site")
			}
			x.homeOpRefreshing(c, &s, "place", map[string]any{"itemId": item, "scene": "outdoor", "x": local[0], "y": local[1], "rotation": 0}, 200)
			// Work another nearby obstacle, passing world tiles to gathering.
			for _, target := range landTiles(kept, land.Tree, true) {
				if target == local {
					continue
				}
				axe := x.instance(s.AccountID, "bench-axe", -1, "")
				worldTile := [2]int{ox + target[0], oy + target[1]}
				fields := gatherIn(s, "outdoors", worldTile, axe, "chop", "tree", fmt.Sprintf("lot-%d", gate))
				fields["tile"] = worldTile
				fields["progress"] = standAt(s, "outdoors", worldTile[0], worldTile[1])
				delete(fields, "region")
				x.opRefreshing(c, &s, "gather", fields, 200)
				after := x.home(c)
				found := false
				for _, st := range after.Stumps {
					if st == target {
						found = true
					}
				}
				if !found {
					t.Fatal("stump was not stored in local coordinates")
				}
				break
			}
			// A neighbouring lot can never receive this deed's home-rest or gathering.
			nox, noy := chunks.LotOrigin((gate + 1) % 8)
			bad := s.State
			bad.Area = "outdoors"
			bad.Position.X = float64((nox+11)*16 + 8)
			bad.Position.Y = float64((noy+8)*16 + 8)
			bad.HP = 1
			if x.exp("POST", "/api/spend", spendBody(s, "home-rest", "", fmt.Sprintf("wrong-lot-%d", gate), bad), c, 409).Error.Code != "not-at-own-plot" {
				t.Fatal("rested on a neighbour's lot")
			}
			// Public reads carry the full placed overlay, not another player's pack.
			lane := x.exp("GET", "/api/commons", nil, c, 200)
			if len(lane.Homes) != 1 || lane.Homes[0].Gate != gate {
				t.Fatal("missing full plot overlay")
			}
			if lane.GateCount != 8 {
				t.Fatal("lot capacity")
			}
		})
	}
}

func TestPlotChangesReachOutdoorAndMatchingIndoorClients(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("owner")
	x.claimGate(c, &s, 0)
	outdoor := x.peerAt("watcher", s.WorldID, "outdoors:-2:1")
	indoor := x.peerAt("inside", s.WorldID, "in:home:0")
	otherRoom := x.peerAt("other-room", s.WorldID, "in:home:1")
	otherWorld := x.peerAt("other-world", "another-world", "outdoors:-3:1")
	far := x.peerAt("far", s.WorldID, "outdoors:0:-2")
	x.fund(s.AccountID, 200, 0)
	x.refresh(c, &s)
	x.homeOpRefreshing(c, &s, "buy", map[string]any{"itemDef": "wooden-stool"}, 200)
	for _, p := range []*presencePeer{outdoor, indoor} {
		select {
		case bytes := <-p.queue:
			message, err := decodePresence(bytes)
			if err != nil || message.GetHomeChanged() == nil || message.GetHomeChanged().Gate != 0 {
				t.Fatal("missing plot invalidation", message, err)
			}
		default:
			t.Fatal("client heard no plot change")
		}
	}
	for _, p := range []*presencePeer{otherRoom, otherWorld, far} {
		if len(p.queue) != 0 {
			t.Fatal("unrelated client heard plot change")
		}
	}
}

func TestPlotServicesRequirePrivateGround(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("owner")
	x.pinWorld(&s)
	h := x.claimGate(c, &s, 0)
	x.fund(s.AccountID, 500, 100)
	x.refresh(c, &s)
	item := x.homeOpRefreshing(c, &s, "buy", map[string]any{"itemDef": "wooden-stool"}, 200).Result.ItemID
	spots := litSpots(h)
	if len(spots) == 0 {
		t.Fatal("fixture has no lit placement")
	}
	spot := spots[0]
	for n, p := range [][2]int{{0, 0}, {-48, 35}, {-23, 35}, {-25, 33}, {59, 32}} {
		// town/Tangle, spine, south public lane, solid gate-row fence, wrong lot.
		x.refresh(c, &s)
		where := map[string]any{"area": "outdoors", "x": p[0]*16 + 8, "y": p[1]*16 + 8}
		req := body(s, fmt.Sprintf("remote-place-%d", n), map[string]any{"where": where, "itemId": item, "scene": "outdoor", "x": spot[0], "y": spot[1], "rotation": 0})
		if r := x.exp("POST", "/api/homestead/place", req, c, 409); r.Error.Code != "not-at-own-plot" {
			t.Fatal(r.Error)
		}
		x.refresh(c, &s)
		req = body(s, fmt.Sprintf("remote-clear-%d", n), map[string]any{"where": where, "x": spot[0], "y": spot[1]})
		if r := x.exp("POST", "/api/homestead/clear", req, c, 409); r.Error.Code != "not-at-own-plot" {
			t.Fatal(r.Error)
		}
		x.refresh(c, &s)
		req = spendBody(s, "home-rest", "", fmt.Sprintf("remote-rest-%d", n), s.State)
		req["where"] = where
		if r := x.exp("POST", "/api/spend", req, c, 409); r.Error.Code != "not-at-own-plot" {
			t.Fatal(r.Error)
		}
	}
	x.homeOpRefreshing(c, &s, "place", map[string]any{"itemId": item, "scene": "outdoor", "x": spot[0], "y": spot[1], "rotation": 0}, 200)
	// A raw removal cannot edit the home from a different scene either.
	x.refresh(c, &s)
	x.exp("POST", "/api/homestead/remove", body(s, "remote-remove", map[string]any{"where": map[string]any{"area": "woodland", "x": 80, "y": 80}, "itemId": item}), c, 409)
}

func TestPublicCommonsDoesNotRequireEveryMembersProfile(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("owner")
	x.claimGate(c, &s, 0)
	visitor, _ := x.member("visitor", s.WorldID)
	exec(t, x, "UPDATE sync_baselines SET profile_json=NULL WHERE account_id=?", s.AccountID)
	lane := x.exp("GET", "/api/commons", nil, visitor, 200)
	if len(lane.Homes) != 1 || len(lane.Homes[0].Members) != 1 || len(lane.Homes[0].YardPets) != 0 {
		t.Fatal("public lane should retain home but omit absent companions")
	}
}
