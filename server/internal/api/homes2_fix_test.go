package api

import (
	"glimway/content"
	"glimway/server/internal/land"
	"testing"
)

// A test land with every tile's kind and reserved status known, and helpers
// to find open ground by distance from the home's own light.
type testLand struct {
	h homeView
	g ground
}

func newTestLand(seed uint32) testLand {
	h := homeView{ID: "h", LandSeed: seed, Tier: 1, Outdoor: content.HomeRules.Outdoor(), Member: true}
	return testLand{h, groundOf(h)}
}

func (l testLand) open(x, y int) bool {
	if !land.Buildable(l.g.land.Effective(l.g.cleared, x, y)) {
		return false
	}
	for _, r := range content.HomeRules.OutdoorReserved {
		if x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H {
			return false
		}
	}
	return true
}

func d2(ax, ay, bx, by int) int { return (ax-bx)*(ax-bx) + (ay-by)*(ay-by) }

func post(id string, x, y int) homeInstance {
	scene, rot, name := "outdoor", 0, "Lamp "+id
	return homeInstance{ID: id, ItemDef: content.HomeRules.LanternPosts.Item, Scene: &scene, X: &x, Y: &y, Rotation: &rot, Name: &name}
}

func moveTo(x, y int) homeRequest {
	rot := 0
	return homeRequest{Scene: "outdoor", X: &x, Y: &y, Rotation: &rot}
}

// Review finding 2: two posts must not hold each other up away from the
// home's light. Light counts only when it connects back to the home's lamp.
func TestHomes2PostsCannotFloatOnEachOther(t *testing.T) {
	s := content.HomeRules.Land.StartLight
	r := content.HomeRules.LanternPosts.Radius
	W, H := content.HomeRules.Land.Width, content.HomeRules.Land.Height
	for seed := uint32(1); seed < 400; seed++ {
		l := newTestLand(seed)
		// A at the edge of the home's light; B lit only by A; A2 lit only by
		// B (and close enough to B that B would count as lit by it).
		for ax := 1; ax < W-1; ax++ {
			for ay := 1; ay < H-1; ay++ {
				da := d2(ax, ay, s.X, s.Y)
				if da > s.Radius*s.Radius || da <= (s.Radius-1)*(s.Radius-1) || !l.open(ax, ay) {
					continue
				}
				for bx := 1; bx < W-1; bx++ {
					for by := 1; by < H-1; by++ {
						if d2(bx, by, ax, ay) > r*r || d2(bx, by, s.X, s.Y) <= s.Radius*s.Radius || !l.open(bx, by) {
							continue
						}
						for cx := 1; cx < W-1; cx++ {
							for cy := 1; cy < H-1; cy++ {
								if (cx == bx && cy == by) || d2(cx, cy, bx, by) > r*r || d2(cx, cy, s.X, s.Y) <= s.Radius*s.Radius || d2(cx, cy, ax, ay) <= r*r || !l.open(cx, cy) {
									continue
								}
								l.h.Items = []homeInstance{post("a", ax, ay), post("b", bx, by)}
								if err := validatePlacement(l.h, l.h.Items[0], moveTo(cx, cy)); err == nil {
									t.Fatalf("seed %d: post a moved from (%d,%d) to (%d,%d), lit only by post b at (%d,%d) which only a lit", seed, ax, ay, cx, cy, bx, by)
								} else if code := err.Error(); code != "unlit" {
									t.Fatalf("seed %d: want unlit, got %s", seed, code)
								}
								// Moving B away is refused too: A is still connected, B's new spot is not.
								return
							}
						}
					}
				}
			}
		}
	}
	t.Fatal("no land with the floating-pair layout in the first seeds")
}

// A chain that does lead back to the home's light still extends the land.
func TestHomes2ConnectedChainExtendsTheLand(t *testing.T) {
	s := content.HomeRules.Land.StartLight
	r := content.HomeRules.LanternPosts.Radius
	W, H := content.HomeRules.Land.Width, content.HomeRules.Land.Height
	for seed := uint32(1); seed < 400; seed++ {
		l := newTestLand(seed)
		for ax := 1; ax < W-1; ax++ {
			for ay := 1; ay < H-1; ay++ {
				da := d2(ax, ay, s.X, s.Y)
				if da > s.Radius*s.Radius || da <= (s.Radius-1)*(s.Radius-1) || !l.open(ax, ay) {
					continue
				}
				for bx := 1; bx < W-1; bx++ {
					for by := 1; by < H-1; by++ {
						if d2(bx, by, ax, ay) > r*r || d2(bx, by, s.X, s.Y) <= s.Radius*s.Radius || !l.open(bx, by) {
							continue
						}
						l.h.Items = []homeInstance{post("a", ax, ay)}
						if err := validatePlacement(l.h, post("b", bx, by), moveTo(bx, by)); err != nil {
							t.Fatalf("seed %d: a post lit by a connected post was refused: %v", seed, err)
						}
						// And with both set out, A can't go while B stands only in its light.
						l.h.Items = []homeInstance{post("a", ax, ay), post("b", bx, by)}
						if everythingLit(removeItem(l.h.Items, "a")) {
							t.Fatalf("seed %d: removing a should leave b in the dark", seed)
						}
						return
					}
				}
			}
		}
	}
	t.Fatal("no land with a chain layout")
}

func removeItem(items []homeInstance, id string) []homeInstance {
	out := []homeInstance{}
	for _, v := range items {
		if v.ID != id {
			out = append(out, v)
		}
	}
	return out
}

// Review finding 3: a lost deed leaves a ledger trail. Whatever the land
// held goes, and the per-currency sums still balance (the documented restore
// check compares them).
func TestHomes2LostDeedIsInTheLedger(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	a = x.openWorkshop(ac, a)
	h := x.home(ac)
	stools := x.p5("POST", "/api/craft", body(a, "stools", map[string]any{"recipeId": "craft-wooden-stool", "qty": 2}), ac, 200)
	a.Snapshot = stools.Snapshot
	spot := litSpots(h)[0]
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": stools.Result.InstanceIDs[0], "scene": "outdoor", "x": spot[0], "y": spot[1], "rotation": 0}, 200)
	a.Snapshot = x.p5("POST", "/api/storage", body(a, "shared", map[string]any{"direction": "deposit", "asset": map[string]any{"kind": "material", "id": "timber", "qty": 3}}), ac, 200).Snapshot
	a.Snapshot = x.p5("POST", "/api/storage", body(a, "shared-stool", map[string]any{"direction": "deposit", "asset": map[string]any{"kind": "decoration", "id": "wooden-stool", "qty": 1}}), ac, 200).Snapshot
	// A tool with a fitting goes in the chest too (the item model).
	axe := x.instance(x.account("alice"), "bench-axe", -1, x.account("alice"))
	nail := x.instance(x.account("alice"), "loose-road-nail", -1, "")
	x.opRefreshing(ac, &a, "fit", map[string]any{"tool": axe, "instance": nail}, 200)
	a.Snapshot = x.p5("POST", "/api/storage", body(a, "shared-axe", map[string]any{"direction": "deposit", "asset": map[string]any{"kind": "instance", "id": "bench-axe", "qty": 1, "instance": axe}}), ac, 200).Snapshot
	x.homeOpRefreshing(ac, &a, "leave", nil, 200)
	x.now.Add(int64(content.HomeRules.Desolation.DeedLostAfterDays) * 86400)
	// The session idled out over the fortnight: sign in again.
	ac = x.login("alice", "")
	x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, ac, 200)
	x.exp("GET", "/api/commons", nil, ac, 200)
	if count(t, x.db, "SELECT count(*) FROM homesteads WHERE id=?", h.ID) != 0 {
		t.Fatal("the deed should be lost")
	}
	// The shared chest's ledger currencies net to nothing once it is gone.
	for _, cur := range []string{"storage:material:timber", "storage:decoration:wooden-stool", "storage:instance:bench-axe"} {
		if n := count(t, x.db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE currency=?", cur); n != 0 {
			t.Fatalf("%s still sums to %d after the deed was lost", cur, n)
		}
	}
	// Every piece that went is named: its instance, on the last member's ledger.
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id='"+x.account("alice")+"' AND reason='deed-lost' AND currency='decoration:wooden-stool' AND ref LIKE ?", "%"+stools.Result.InstanceIDs[0]+"%") != 1 {
		t.Fatal("the placed stool's loss is not in the ledger")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id='"+x.account("alice")+"' AND reason='deed-lost' AND currency='homestead'") != 1 {
		t.Fatal("no record of the lost deed itself")
	}
	// The chest's tool and the fitting on it are gone, and both are named.
	if count(t, x.db, "SELECT count(*) FROM item_instances WHERE id IN (?,?)", axe, nail) != 0 {
		t.Fatal("the chest's tool outlived the deed")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id='"+x.account("alice")+"' AND reason='deed-lost' AND currency='fitted:loose-road-nail' AND ref LIKE ?", "%"+nail) != 1 {
		t.Fatal("the fitting's loss is not in the ledger")
	}
	x.conserved(x.account("alice"))
}

// Review finding 5: the last one out can take their deed back while the land
// is still under it — same home, everything still there, no charge.
func TestHomes2FormerMemberReclaimsVacantHome(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	x.seedAssets(x.account("alice"))
	h := x.claimGate(ac, &a, 0)
	x.homeOpRefreshing(ac, &a, "buy", map[string]any{"itemDef": content.HomeRules.LanternPosts.Item}, 200)
	if _, err := x.db.DB.Exec("UPDATE homesteads SET tier=1 WHERE id=?", h.ID); err != nil {
		t.Fatal(err)
	}
	x.homeOpRefreshing(ac, &a, "leave", nil, 200)
	// Lane rows say who could take it back.
	if lane := x.exp("GET", "/api/commons", nil, ac, 200); !lane.Gates[0].Reclaim {
		t.Fatal("the former member should be offered the deed back")
	}
	if lane := x.exp("GET", "/api/commons", nil, bc, 200); lane.Gates[0].Reclaim {
		t.Fatal("a stranger can't reclaim")
	}
	if x.homeOpRefreshing(bc, &b, "claim", map[string]any{"gate": 0}, 409).Error.Code != "gate-taken" {
		t.Fatal("a stranger takes a vacant home")
	}
	x.now.Add(int64(content.HomeRules.Desolation.DesolateAfterDays) * 86400)
	x.refresh(ac, &a)
	before := a.State.Embers
	back := x.claimGate(ac, &a, 0)
	if back.ID != h.ID || back.Tier != 1 || back.Desolate || back.VacantSince != nil || back.PostsBought != 1 || !back.Member {
		t.Fatal("reclaimed home", back.ID == h.ID, back.Tier, back.Desolate)
	}
	if a.State.Embers != before {
		t.Fatal("reclaiming costs nothing")
	}
	// A home with someone still on the deed is not reclaimable: ask them.
	x.share(ac, &a, bc, &b)
	x.homeOpRefreshing(ac, &a, "leave", nil, 200)
	if lane := x.exp("GET", "/api/commons", nil, ac, 200); lane.Gates[0].Reclaim {
		t.Fatal("reclaim offered while bob holds the deed")
	}
	if x.homeOpRefreshing(ac, &a, "claim", map[string]any{"gate": 0}, 409).Error.Code != "gate-taken" {
		t.Fatal("rejoined past a member without a joint deed")
	}
}
