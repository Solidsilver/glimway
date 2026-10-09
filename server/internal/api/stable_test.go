// The stable (docs/design/crafts.md 3.1–3.4): one per homestead, coming
// with stall 1 and growing east a bay at a time; the stalls are shared on a
// joint deed; only the mount's owner saddles or leads it, and a new lease
// finds it back in its stall. A departing member's mounts come out of their
// stalls with them.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"glimway/content"
	"glimway/server/internal/land"
	"glimway/server/internal/store"
	"net/http"
	"testing"
)

// stableTestWorld pins the homestead land: the land is seeded from the world
// id and the gate (land.Seed), so a fixed world id gives the same ground on
// every run — the stable tests always find their spots and never skip.
// (Chosen by scanning: gate 0 has a two-bay spot, a dark bay edge and a bay
// with ground standing on it.)
const stableTestWorld = "lane-b-stable-01"

// pinWorld: the caller lives in the fixed world before claiming its deed.
func (x *rig) pinWorld(s *response) {
	x.t.Helper()
	if _, err := x.db.DB.Exec("INSERT INTO worlds(id,owner_id,seed,created_at) VALUES(?,'lane-b-tests','',?)", stableTestWorld, x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if _, err := x.db.DB.Exec("UPDATE players SET world_id=? WHERE account_id=?", stableTestWorld, s.AccountID); err != nil {
		x.t.Fatal(err)
	}
	s.WorldID = stableTestWorld
}

// storedMountOut is what the account's row says (not what it reads as).
func storedMountOut(t *testing.T, x *rig, account string) string {
	t.Helper()
	var v string
	err := x.db.DB.QueryRow("SELECT COALESCE(mount_out,'') FROM player_companions WHERE account_id=?", account).Scan(&v)
	if err == sql.ErrNoRows {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// exec runs a test's own SQL (the fixtures do what Silas would).
func exec(t *testing.T, x *rig, query string, args ...any) {
	t.Helper()
	if _, err := x.db.DB.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

// clearTiles: Silas's clearing, straight into the land's rows.
func clearTiles(t *testing.T, x *rig, home string, tiles [][2]int) {
	t.Helper()
	for _, tile := range tiles {
		exec(t, x, "INSERT OR IGNORE INTO homestead_cleared VALUES(?,?,?)", home, tile[0], tile[1])
	}
}

// stableSpot finds the top-left tiles where a stable of `stalls` bays stands
// — its grown footprint (4 + 2(n−1) × 3, 3.2) lit, open and buildable — and
// the tiles to clear for it.
func stableSpot(t *testing.T, h homeView, stalls int) (int, int, [][2]int, bool) {
	t.Helper()
	w, ht := 4+2*(stalls-1), 3
	g := groundOf(h)
	lights := connectedLights(placedItems(h), "")
	open := func(here rect) (bool, [][2]int) {
		for _, v := range content.HomeRules.GetOutdoorReserved() {
			if here.overlaps(rect{int(v.GetX()), int(v.GetY()), int(v.GetW()), int(v.GetH())}) {
				return false, nil
			}
		}
		for _, v := range placedItems(h) {
			// Only outdoor pieces stand on this ground (3.2's scene rule):
			// indoor and gate pieces live on their own grids.
			if v.ID != "" && v.Scene != nil && *v.Scene == "outdoor" {
				if o, ok := placedRect(v); ok && here.overlaps(o) {
					return false, nil
				}
			}
		}
		for _, p := range h.Plants {
			if here.overlaps(rect{p.X, p.Y, 1, 1}) {
				return false, nil
			}
		}
		out := [][2]int{}
		for y := here.y; y < here.y+here.h; y++ {
			for x := here.x; x < here.x+here.w; x++ {
				k := g.land.At(x, y)
				switch {
				case !land.Lit(lights, x, y):
					return false, nil
				case land.Buildable(k):
				case land.Clearable(k):
					out = append(out, [2]int{x, y})
				default:
					return false, nil
				}
			}
		}
		return true, out
	}
	for y := 0; y+ht <= g.land.Height; y++ {
		for x := 0; x+w <= g.land.Width; x++ {
			if ok, tiles := open(rect{x, y, w, ht}); ok {
				return x, y, tiles, true
			}
		}
	}
	return 0, 0, nil, false
}

// stableEdge finds the top-left tiles where the stable (4 × 3) stands lit
// and open while its east tiles refuse to grow the bay: `dark` wants the
// bay's ground clear but unlit (`unlit`), `blocked` wants something still
// standing on it (`land-blocked`). The last return is tiles to clear on the
// bay's ground for the dark case.
func stableEdge(t *testing.T, h homeView, dark bool) (int, int, [][2]int, [][2]int, bool) {
	t.Helper()
	g := groundOf(h)
	lights := connectedLights(placedItems(h), "")
	for y := 0; y+3 <= g.land.Height; y++ {
		for x := 0; x+6 <= g.land.Width; x++ {
			here, ext := rect{x, y, 4, 3}, rect{x + 4, y, 2, 3}
			bad := false
			for _, v := range content.HomeRules.GetOutdoorReserved() {
				r := rect{int(v.GetX()), int(v.GetY()), int(v.GetW()), int(v.GetH())}
				bad = bad || here.overlaps(r) || ext.overlaps(r)
			}
			for _, v := range placedItems(h) {
				if v.Scene != nil && *v.Scene == "outdoor" {
					if o, ok := placedRect(v); ok && (here.overlaps(o) || ext.overlaps(o)) {
						bad = true
					}
				}
			}
			for _, p := range h.Plants {
				if here.overlaps(rect{p.X, p.Y, 1, 1}) || ext.overlaps(rect{p.X, p.Y, 1, 1}) {
					bad = true
				}
			}
			if bad {
				continue
			}
			cleared := [][2]int{}
			good := true
			for yy := here.y; yy < here.y+here.h && good; yy++ {
				for xx := here.x; xx < here.x+here.w; xx++ {
					k := g.land.At(xx, yy)
					switch {
					case !land.Lit(lights, xx, yy):
						good = false
					case land.Buildable(k):
					case land.Clearable(k):
						cleared = append(cleared, [2]int{xx, yy})
					default:
						good = false
					}
				}
			}
			if !good {
				continue
			}
			extClear := [][2]int{}
			refuses, builds := false, true
			for yy := ext.y; yy < ext.y+ext.h; yy++ {
				for xx := ext.x; xx < ext.x+ext.w; xx++ {
					k := g.land.At(xx, yy)
					switch {
					case land.Buildable(k):
						refuses = refuses || dark && !land.Lit(lights, xx, yy)
					case land.Clearable(k):
						if dark {
							extClear = append(extClear, [2]int{xx, yy})
							refuses = refuses || !land.Lit(lights, xx, yy)
						} else {
							refuses = true // ground to clear first
						}
					default:
						// Ground that never builds refuses either way, but
						// with land-blocked ahead of unlit.
						if dark {
							builds = false
						} else {
							refuses = true
						}
					}
				}
			}
			if builds && refuses {
				return x, y, cleared, extClear, true
			}
		}
	}
	return 0, 0, nil, nil, false
}

// stableGround is where a `stalls`-bay stable stands (and grows), with the
// tiles cleared for it. The campsite's own light holds little open ground —
// the site and the gate path take its middle — so a test-only lantern post
// may go in first, wherever it makes room (as a player would set one).
func stableGround(t *testing.T, x *rig, c *http.Cookie, h homeView, stalls int) (int, int, homeView) {
	t.Helper()
	if x0, y0, clear, ok := stableSpot(t, h, stalls); ok {
		clearTiles(t, x, h.ID, clear)
		return x0, y0, x.home(c)
	}
	g := groundOf(h)
	lights := connectedLights(placedItems(h), "")
	for ly := 0; ly < g.land.Height; ly++ {
		for lx := 0; lx < g.land.Width; lx++ {
			k := g.land.At(lx, ly)
			if !land.Lit(lights, lx, ly) || (!land.Buildable(k) && !land.Clearable(k)) {
				continue
			}
			reserved := false
			for _, v := range content.HomeRules.GetOutdoorReserved() {
				if (rect{lx, ly, 1, 1}).overlaps(rect{int(v.GetX()), int(v.GetY()), int(v.GetW()), int(v.GetH())}) {
					reserved = true
				}
			}
			if reserved {
				continue
			}
			clearTiles(t, x, h.ID, [][2]int{{lx, ly}})
			exec(t, x, "INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES('test-post','lantern-post','placed',?,'outdoor',?,?,0)", h.ID, lx, ly)
			next := x.home(c)
			if x0, y0, clear, ok := stableSpot(t, next, stalls); ok {
				clearTiles(t, x, next.ID, clear)
				return x0, y0, x.home(c)
			}
			exec(t, x, "DELETE FROM homestead_items WHERE id='test-post'")
		}
	}
	t.Fatal("no ground for the stable, even with a post")
	return 0, 0, homeView{}
}

// boughtStable: the workshop and the stable bought (not yet placed).
func boughtStable(x *rig, c *http.Cookie, s *response) string {
	x.t.Helper()
	*s = x.openWorkshop(c, *s)
	buy := x.homeOpRefreshing(c, s, "buy", map[string]any{"itemDef": "stable"}, 200)
	if buy.Result.ItemID == "" {
		x.t.Fatal("no stable")
	}
	return buy.Result.ItemID
}

// standingStable: the stable bought and placed on cleared, lit ground where
// it could grow to `stalls` bays.
func standingStable(x *rig, c *http.Cookie, s *response, stalls int) (homeView, int, int) {
	x.t.Helper()
	id := boughtStable(x, c, s)
	x0, y0, _ := stableGround(x.t, x, c, x.home(c), stalls)
	x.homeOpRefreshing(c, s, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 200)
	return x.home(c), x0, y0
}

// atBay is where a hero stands to reach a stall's door (3.3).
func atBay(h homeView, x0, y0, stall int) map[string]any {
	return map[string]any{"area": fmt.Sprintf("home:%d", h.Gate), "x": float64((x0+2*stall+1)*16 + 8), "y": float64((y0+3)*16)}
}

func TestStableComesWithStallOneAndOnePerHomestead(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	id := boughtStable(x, ac, &a)

	// It comes with stall 1 (3.1).
	h := x.home(ac)
	carried := false
	for _, it := range h.Items {
		if it.ID == id && it.Stalls != nil && *it.Stalls == 1 {
			carried = true
		}
	}
	if !carried {
		t.Fatal("the stable comes with stall 1", h.Items)
	}

	// One per homestead (3.2): a second buy is refused while one is carried
	// by a member — and again once one stands.
	bc, b := x.member("bob", a.WorldID)
	x.fund(x.account("bob"), 500, 0)
	x.share(ac, &a, bc, &b)
	if r := x.homeOpRefreshing(bc, &b, "buy", map[string]any{"itemDef": "stable"}, 409); r.Error.Code != "stable-full" {
		t.Fatal("a second stable while one is carried", r.Error.Code)
	}
	x0, y0, h := stableGround(t, x, ac, h, 1)
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 200)
	if r := x.homeOpRefreshing(ac, &a, "buy", map[string]any{"itemDef": "stable"}, 409); r.Error.Code != "stable-full" {
		t.Fatal("a second stable while one stands", r.Error.Code)
	}
	// A carried stable goes down only where none stands.
	exec(t, x, "INSERT INTO homestead_items(id,item_def,location,account_id,stalls) VALUES('carried-stable','stable','inventory',?,1)", x.account("bob"))
	if r := x.homeOpRefreshing(bc, &b, "place", map[string]any{"itemId": "carried-stable", "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 409); r.Error.Code != "stable-full" {
		t.Fatal("a second stable placed where one stands", r.Error.Code)
	}
}

func TestStableFacesFrontAndGrowsEast(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	id := boughtStable(x, ac, &a)
	x0, y0, h := stableGround(t, x, ac, x.home(ac), 2)

	// The art faces front (3.2): a rotated stable is refused.
	if r := x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 90}, 400); r.Error.Code != "invalid-placement" {
		t.Fatal("the stable never rotates", r.Error.Code)
	}
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 200)

	// An indoor piece "at" the bay's coordinates stands on its own grid
	// (validatePlacement's scene rule): it never refuses the growth.
	exec(t, x, "INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES('test-bed','wooden-stool','placed',?,'indoor',?,?,0)", h.ID, x0+4, y0)

	// Build a bay: the footprint grows east and the growth bill is paid.
	m0 := x.exp("GET", fmt.Sprintf("/api/homestead/gate/%d", h.Gate), nil, ac, 200).Materials
	grown := x.companionOp("POST", "/api/stable/extend", body(a, "bay2", map[string]any{"homeId": h.ID}), ac, 200)
	stalls := 0
	for _, it := range grown.Result.Home.Items {
		if it.ID != id {
			continue
		}
		if it.Stalls != nil {
			stalls = *it.Stalls
		}
		if r, ok := placedRect(it); !ok || r != (rect{x0, y0, 6, 3}) {
			t.Fatal("the stable grows east", r, ok)
		}
	}
	if stalls != 2 {
		t.Fatal("a bay was built", stalls)
	}
	for m, n := range content.HomeStallCost(content.HomeRules, 1) {
		if int(grown.Result.Materials[m]) != m0[m]-int(n) {
			t.Fatal("the growth bill", m, grown.Result.Materials[m], m0[m])
		}
	}

	// Six stalls is as long as it grows.
	exec(t, x, "UPDATE homestead_items SET stalls=6 WHERE id=?", id)
	if r := x.companionOp("POST", "/api/stable/extend", body(a, "bay7", map[string]any{"homeId": h.ID}), ac, 409); r.Error.Code != "stable-full" {
		t.Fatal("a seventh bay", r.Error.Code)
	}
}

func TestStableExtendRefusesStandingGround(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	id := boughtStable(x, ac, &a)
	h := x.home(ac)
	x0, y0, clear, _, ok := stableEdge(t, h, false)
	if !ok {
		t.Fatal("no ground east of the light refuses a bay")
	}
	clearTiles(t, x, h.ID, clear)
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 200)
	if r := x.companionOp("POST", "/api/stable/extend", body(a, "blocked", map[string]any{"homeId": h.ID}), ac, 409); r.Error.Code != "land-blocked" {
		t.Fatal("a bay over standing ground", r.Error.Code)
	}
}

func TestStableExtendRefusesDarkGround(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	id := boughtStable(x, ac, &a)
	h := x.home(ac)
	x0, y0, clear, extClear, ok := stableEdge(t, h, true)
	if !ok {
		t.Fatal("no dark ground east of the light")
	}
	// The bay's ground is clear but for the light: "Clear and light the
	// ground east of the stable first."
	clearTiles(t, x, h.ID, append(append([][2]int{}, clear...), extClear...))
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 200)
	if r := x.companionOp("POST", "/api/stable/extend", body(a, "dark", map[string]any{"homeId": h.ID}), ac, 409); r.Error.Code != "unlit" {
		t.Fatal("a bay in the dark", r.Error.Code)
	}
}

func TestStableExtendRefusesGrowthAndShortage(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	id := boughtStable(x, ac, &a)
	x0, y0, h := stableGround(t, x, ac, x.home(ac), 2)
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 200)

	// Something growing on the bay's ground.
	exec(t, x, "INSERT INTO homestead_plants(id,homestead_id,item_def,x,y,planted_at,planted_day) VALUES('test-plant',?,'turnip-seed',?,?,?,?)", h.ID, x0+4, y0, x.now.Load(), x.now.Load()/86400)
	if r := x.companionOp("POST", "/api/stable/extend", body(a, "plant", map[string]any{"homeId": h.ID}), ac, 409); r.Error.Code != "placement-overlap" {
		t.Fatal("a bay over a growing plant", r.Error.Code)
	}

	// And no bay without the bill.
	exec(t, x, "DELETE FROM homestead_plants WHERE id='test-plant'")
	exec(t, x, "DELETE FROM item_stacks WHERE owner=? AND location='pack'", x.account("alice"))
	if r := x.companionOp("POST", "/api/stable/extend", body(a, "poor", map[string]any{"homeId": h.ID}), ac, 409); r.Error.Code != "insufficient-materials" {
		t.Fatal("a bay without the bill", r.Error.Code)
	}
}

func TestStallsAreSharedOnAJointDeed(t *testing.T) {
	x := newRig(t)
	alice := profile("alice", 1, 0, 20)
	alice.Mounts = []string{"Wolf-Shade"}
	x.set(alice)
	bob := profile("bob", 1, 0, 20)
	bob.Mounts = []string{"Lion-Golden"}
	x.set(bob)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	id := boughtStable(x, ac, &a)
	bc, b := x.member("bob", a.WorldID)
	x.share(ac, &a, bc, &b)
	x0, y0, h := stableGround(t, x, ac, x.home(ac), 1)
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 200)
	// Three bays, as the growth rule would leave them.
	exec(t, x, "UPDATE homestead_items SET stalls=3 WHERE id=?", id)
	h = x.home(ac)

	// Alice's mount goes in; the view names every stall, its owner and out.
	put := x.companionOp("POST", "/api/stable/stall", body(a, "in", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"}), ac, 200)
	if s := put.Result.Home.Stalls; len(s) != 3 || s[0].Stall != 1 || s[0].Mount != "Wolf-Shade" || s[0].OwnerID != x.account("alice") || s[0].Out || s[1].Mount != "" || s[1].Stall != 2 {
		t.Fatal("the stall view", s)
	}
	// A partner's mount is nobody's to move (3.1)...
	if r := x.companionOp("POST", "/api/stable/stall", body(b, "out", map[string]any{"homeId": h.ID, "stall": 1, "mount": ""}), bc, 409); r.Error.Code != "stall-taken" {
		t.Fatal("moving a partner's mount", r.Error.Code)
	}
	// ...but the shared deed's free bays are his.
	if r := x.companionOp("POST", "/api/stable/stall", body(b, "his", map[string]any{"homeId": h.ID, "stall": 2, "mount": "Lion-Golden"}), bc, 200); r.Result.Home.Stalls[1].Mount != "Lion-Golden" {
		t.Fatal("a partner's stall", r.Result.Home.Stalls)
	}
	// Keys the account doesn't own, and bays the stable doesn't have.
	if r := x.companionOp("POST", "/api/stable/stall", body(a, "stranger", map[string]any{"homeId": h.ID, "stall": 3, "mount": "Lion-Golden"}), ac, 409); r.Error.Code != "companion-not-owned" {
		t.Fatal("an unowned mount", r.Error.Code)
	}
	if r := x.companionOp("POST", "/api/stable/stall", body(a, "beyond", map[string]any{"homeId": h.ID, "stall": 4, "mount": "Wolf-Shade"}), ac, 409); r.Error.Code != "no-stable" {
		t.Fatal("a bay that isn't there", r.Error.Code)
	}
	// The same mount moves between its owner's stalls, never standing twice.
	moved := x.companionOp("POST", "/api/stable/stall", body(a, "move", map[string]any{"homeId": h.ID, "stall": 3, "mount": "Wolf-Shade"}), ac, 200)
	if s := moved.Result.Home.Stalls; s[0].Mount != "" || s[2].Mount != "Wolf-Shade" {
		t.Fatal("the mount moved bays", s)
	}
	// And its owner empties it again (nothing is refunded).
	if s := x.companionOp("POST", "/api/stable/stall", body(a, "empty", map[string]any{"homeId": h.ID, "stall": 3, "mount": ""}), ac, 200).Result.Home.Stalls; s[2].Mount != "" || s[2].OwnerID != "" {
		t.Fatal("the bay stands empty", s)
	}
}

func TestMountOutHomeAndLazyValidity(t *testing.T) {
	x := newRig(t)
	alice := profile("alice", 1, 0, 20)
	alice.Mounts = []string{"Wolf-Shade"}
	x.set(alice)
	bob := profile("bob", 1, 0, 20)
	x.set(bob)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	h, x0, y0 := standingStable(x, ac, &a, 1)
	bc, b := x.member("bob", a.WorldID)
	x.share(ac, &a, bc, &b)
	x.companionOp("POST", "/api/stable/stall", body(a, "in", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"}), ac, 200)

	// Saddle up at the bay (3.3): the walk-up is the server's too.
	tooFar := body(a, "far", map[string]any{"homeId": h.ID, "stall": 1})
	tooFar["where"] = map[string]any{"area": "village", "x": 400.0, "y": 300.0}
	if r := x.companionOp("POST", "/api/stable/out", tooFar, ac, 409); r.Error.Code != "too-far-away" {
		t.Fatal("saddling up from the village", r.Error.Code)
	}
	at := body(a, "up", map[string]any{"homeId": h.ID, "stall": 1})
	at["where"] = atBay(h, x0, y0, 1)
	out := x.companionOp("POST", "/api/stable/out", at, ac, 200)
	if out.Result.Companions.MountOut != "Wolf-Shade" || out.Result.Companions.MountHome != h.ID {
		t.Fatal("out with its owner", out.Result.Companions)
	}
	if c := x.companionsInState(ac); c.MountOut != "Wolf-Shade" {
		t.Fatal("the state knows the mount", c)
	}
	// The avatar carries the mount that is out (3.4), and the stall shows it.
	av, err := x.api.presenceIdentity(context.Background(), store.Hash(ac.Value), true)
	if err != nil {
		t.Fatal(err)
	}
	if av.Avatar.SelectedMount == nil || av.Avatar.SelectedMount.Value != "Wolf-Shade" {
		t.Fatal("presence carries the mount out", av.Avatar.SelectedMount)
	}
	if s := x.home(ac).Stalls; len(s) != 1 || s[0].Mount != "Wolf-Shade" || !s[0].Out {
		t.Fatal("the stall shows the mount out", s)
	}

	// A mount is only its owner's to saddle.
	theirs := body(b, "theirs", map[string]any{"homeId": h.ID, "stall": 1})
	theirs["where"] = atBay(h, x0, y0, 1)
	if r := x.companionOp("POST", "/api/stable/out", theirs, bc, 409); r.Error.Code != "companion-not-owned" {
		t.Fatal("saddling a partner's mount", r.Error.Code)
	}

	// Go home (H): it always answers, and the mount reads home.
	back := x.companionOp("POST", "/api/stable/home", map[string]any{"op": map[string]any{"lease": a.Lease, "key": "home"}}, ac, 200)
	if back.Result.Companions.MountOut != "" || back.Result.Companions.MountHome != "" {
		t.Fatal("sent home", back.Result.Companions)
	}

	// A mount that lapses reads as in its stall; the stored row waits.
	at = body(a, "again", map[string]any{"homeId": h.ID, "stall": 1})
	at["where"] = atBay(h, x0, y0, 1)
	x.companionOp("POST", "/api/stable/out", at, ac, 200)
	lapsed := profile("alice", 1, 0, 20)
	x.companionSync(a, lapsed, a.State, ac)
	if c := x.companionsInState(ac); c.MountOut != "" {
		t.Fatal("a lapsed mount reads home", c)
	}
	if s := x.home(ac).Stalls; s[0].Mount != "" {
		t.Fatal("a lapsed stall reads empty", s)
	}
	returned := profile("alice", 1, 0, 20)
	returned.Mounts = []string{"Wolf-Shade"}
	x.companionSync(a, returned, a.State, ac)
	if c := x.companionsInState(ac); c.MountOut != "Wolf-Shade" {
		t.Fatal("a mount that comes back comes back", c)
	}

	// A new session starts with the mount at home (3.3): the old tab went
	// quiet and a new one took the world up.
	x.now.Add(130)
	x.expect("POST", "/api/play", map[string]any{"clientId": "tab-b"}, ac, 200)
	if c := x.companionsInState(ac); c.MountOut != "" {
		t.Fatal("a new lease finds it home", c)
	}
}

func TestLeavingTakesTheLeaversStalls(t *testing.T) {
	x := newRig(t)
	alice := profile("alice", 1, 0, 20)
	alice.Mounts = []string{"Wolf-Shade"}
	x.set(alice)
	bob := profile("bob", 1, 0, 20)
	bob.Mounts = []string{"Lion-Golden"}
	x.set(bob)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	id := boughtStable(x, ac, &a)
	bc, b := x.member("bob", a.WorldID)
	x.share(ac, &a, bc, &b)
	x0, y0, h := stableGround(t, x, ac, x.home(ac), 1)
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 200)
	exec(t, x, "UPDATE homestead_items SET stalls=2 WHERE id=?", id)
	h = x.home(ac)
	x.companionOp("POST", "/api/stable/stall", body(a, "hers", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"}), ac, 200)
	x.companionOp("POST", "/api/stable/stall", body(b, "his", map[string]any{"homeId": h.ID, "stall": 2, "mount": "Lion-Golden"}), bc, 200)
	at := body(a, "up", map[string]any{"homeId": h.ID, "stall": 1})
	at["where"] = atBay(h, x0, y0, 1)
	x.companionOp("POST", "/api/stable/out", at, ac, 200)

	// Alice goes: her mounts come out of their stalls with her (lane B's
	// rule — nobody can move a partner's mount, so her bays would stand
	// occupied for good), and the mount out with her reads home.
	x.homeOpRefreshing(ac, &a, "leave", nil, 200)
	if n := count(t, x.db, "SELECT count(*) FROM homestead_stalls WHERE homestead_id=? AND owner_id=?", h.ID, x.account("alice")); n != 0 {
		t.Fatal("a leaver's stalls", n)
	}
	if n := count(t, x.db, "SELECT count(*) FROM homestead_stalls WHERE homestead_id=? AND owner_id=?", h.ID, x.account("bob")); n != 1 {
		t.Fatal("the staying member's stalls", n)
	}
	if c := x.companionsInState(ac); c.MountOut != "" {
		t.Fatal("the mount out with her reads home", c)
	}
	if s := x.home(bc).Stalls; s[0].Mount != "" || s[1].Mount != "Lion-Golden" {
		t.Fatal("the view after the departure", s)
	}

	// The stable comes out only when every stall is empty (3.2), and with
	// its stall count.
	if r := x.homeOpRefreshing(bc, &b, "remove", map[string]any{"itemId": id}, 409); r.Error.Code != "stalls-in-use" {
		t.Fatal("removing a stable in use", r.Error.Code)
	}
	x.companionOp("POST", "/api/stable/stall", body(b, "empty", map[string]any{"homeId": h.ID, "stall": 2, "mount": ""}), bc, 200)
	removed := x.homeOpRefreshing(bc, &b, "remove", map[string]any{"itemId": id}, 200)
	for _, it := range removed.Result.Home.Items {
		if it.ID == id {
			if it.Stalls == nil || *it.Stalls != 2 || it.Scene != nil {
				t.Fatal("the stable returns with its stall count", it)
			}
		}
	}
}

// A world move sends the mount that is out home (3.3): each world's stable
// holds its own mounts.
func TestWorldMoveSendsTheMountHome(t *testing.T) {
	x := newRig(t)
	p := profile("alice", 1, 0, 20)
	p.Name = "Alice"
	p.PartyID = strPtr("p1")
	p.Mounts = []string{"Wolf-Shade"}
	x.set(p)
	x.hero("olive", "Olive", "p1")
	x.ready("olive")
	pw := x.partyWorldOf("p1")
	_, c := x.signInAsked("alice", "p1", "")
	x.expect("POST", "/api/world/choose", map[string]any{"choice": "own"}, c, 200)
	r := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
	x.pinWorld(&r)
	h, x0, y0 := standingStable(x, c, &r, 1)
	x.companionOp("POST", "/api/stable/stall", body(r, "in", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"}), c, 200)
	at := body(r, "up", map[string]any{"homeId": h.ID, "stall": 1})
	at["where"] = atBay(h, x0, y0, 1)
	x.companionOp("POST", "/api/stable/out", at, c, 200)
	if got := x.companionsInState(c).MountOut; got != "Wolf-Shade" {
		t.Fatal("out before the move", got)
	}
	x.worldReq("POST", "/api/world/move", moveBody(r, "join", pw, "village"), c, 200)
	if x.worldOf("alice") != pw {
		t.Fatal("the move")
	}
	if got := x.companionsInState(c).MountOut; got != "" {
		t.Fatal("a world move finds the mount home", got)
	}
	// And the stored row says so (relocate's own clear), not just the read.
	if got := storedMountOut(t, x, x.account("alice")); got != "" {
		t.Fatal("the stored row still says out", got)
	}
}

// resultJSON is a keyed answer's result part: a replay answers what it
// answered then, while the state around it moves on.
func resultJSON(t *testing.T, raw []byte) string {
	t.Helper()
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return string(doc["result"])
}

// A mount that is out comes home when its bay goes (3.3): emptying the bay
// clears the row, and stalling the mount again leaves it standing in its
// bay — nothing is out again without a fresh Saddle up.
func TestMountOutDoesNotSurviveAnEmptiedBay(t *testing.T) {
	x := newRig(t)
	alice := profile("alice", 1, 0, 20)
	alice.Mounts = []string{"Wolf-Shade"}
	x.set(alice)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	h, x0, y0 := standingStable(x, ac, &a, 1)
	x.companionOp("POST", "/api/stable/stall", body(a, "in", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"}), ac, 200)
	at := body(a, "up", map[string]any{"homeId": h.ID, "stall": 1})
	at["where"] = atBay(h, x0, y0, 1)
	x.companionOp("POST", "/api/stable/out", at, ac, 200)
	if got := storedMountOut(t, x, x.account("alice")); got != "Wolf-Shade" {
		t.Fatal("out on the mount", got)
	}
	// The bay goes empty: it goes home on the spot.
	x.companionOp("POST", "/api/stable/stall", body(a, "empty", map[string]any{"homeId": h.ID, "stall": 1, "mount": ""}), ac, 200)
	if got := storedMountOut(t, x, x.account("alice")); got != "" {
		t.Fatal("an emptied bay left it out", got)
	}
	if c := x.companionsInState(ac); c.MountOut != "" {
		t.Fatal("it reads home", c)
	}
	// Stalled again, it stands in its bay: no resurrection.
	x.companionOp("POST", "/api/stable/stall", body(a, "again", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"}), ac, 200)
	if c := x.companionsInState(ac); c.MountOut != "" {
		t.Fatal("stalling it again brought it out", c)
	}
}

// And a deed left takes the mount out with its owner (3.3): reclaiming the
// vacant deed and stalling the mount again is not a Saddle up either.
func TestMountOutDoesNotSurviveTheDeed(t *testing.T) {
	x := newRig(t)
	alice := profile("alice", 1, 0, 20)
	alice.Mounts = []string{"Wolf-Shade"}
	x.set(alice)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	h, x0, y0 := standingStable(x, ac, &a, 1)
	x.companionOp("POST", "/api/stable/stall", body(a, "in", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"}), ac, 200)
	at := body(a, "up", map[string]any{"homeId": h.ID, "stall": 1})
	at["where"] = atBay(h, x0, y0, 1)
	x.companionOp("POST", "/api/stable/out", at, ac, 200)
	x.homeOpRefreshing(ac, &a, "leave", nil, 200)
	if got := storedMountOut(t, x, x.account("alice")); got != "" {
		t.Fatal("the deed left it out", got)
	}
	// Back on the deed, the bay is empty (her mounts came with her), and
	// stalling the mount again leaves it standing there.
	x.claimGate(ac, &a, 0)
	x.companionOp("POST", "/api/stable/stall", body(a, "again", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"}), ac, 200)
	if c := x.companionsInState(ac); c.MountOut != "" {
		t.Fatal("stalling it again brought it out", c)
	}
}

// A keyed replay of `stable-extend` is the same envelope, one bay, and the
// bill paid once (opIdem).
func TestStableExtendReplaysOnce(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	id := boughtStable(x, ac, &a)
	x0, y0, h := stableGround(t, x, ac, x.home(ac), 2)
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 200)
	req := body(a, "bay2", map[string]any{"homeId": h.ID})
	first := x.rawHTTP("POST", "/api/stable/extend", req, ac)
	second := x.rawHTTP("POST", "/api/stable/extend", req, ac)
	if first.Code != 200 || second.Code != 200 {
		t.Fatal("the extend", first.Code, second.Code)
	}
	if first.Body.String() != second.Body.String() {
		t.Fatal("a replay is not the same envelope")
	}
	stalls := 0
	for _, it := range x.home(ac).Items {
		if it.ID == id && it.Stalls != nil {
			stalls = *it.Stalls
		}
	}
	if stalls != 2 {
		t.Fatal("a replay built another bay", stalls)
	}
	for m, n := range content.HomeStallCost(content.HomeRules, 1) {
		billed := count(t, x.db, "SELECT COALESCE(-sum(delta),0) FROM ledger WHERE account_id=? AND reason='stable-extend' AND currency=?", x.account("alice"), "material:"+m)
		if billed != int(n) {
			t.Fatal("the bill was not paid exactly once", m, billed)
		}
	}
}

// A keyed replay of `stall` answers what it answered then, even after the
// bay moved on — and it moves nothing.
func TestStallReplayKeepsTheFirstAnswer(t *testing.T) {
	x := newRig(t)
	alice := profile("alice", 1, 0, 20)
	alice.Mounts = []string{"Wolf-Shade"}
	x.set(alice)
	bob := profile("bob", 1, 0, 20)
	bob.Mounts = []string{"Lion-Golden"}
	x.set(bob)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	id := boughtStable(x, ac, &a)
	bc, b := x.member("bob", a.WorldID)
	x.share(ac, &a, bc, &b)
	x0, y0, h := stableGround(t, x, ac, x.home(ac), 1)
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": id, "scene": "outdoor", "x": x0, "y": y0, "rotation": 0}, 200)
	exec(t, x, "UPDATE homestead_items SET stalls=2 WHERE id=?", id)
	h = x.home(ac)
	req := body(a, "in", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"})
	first := x.rawHTTP("POST", "/api/stable/stall", req, ac)
	if first.Code != 200 {
		t.Fatal("the first answer", first.Code)
	}
	// The bay moves on: alice empties it and bob's mount goes in.
	x.companionOp("POST", "/api/stable/stall", body(a, "empty", map[string]any{"homeId": h.ID, "stall": 1, "mount": ""}), ac, 200)
	x.companionOp("POST", "/api/stable/stall", body(b, "his", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Lion-Golden"}), bc, 200)
	// The replayed key answers what it answered then...
	second := x.rawHTTP("POST", "/api/stable/stall", req, ac)
	if second.Code != 200 || resultJSON(t, second.Body.Bytes()) != resultJSON(t, first.Body.Bytes()) {
		t.Fatal("a replay changed its answer")
	}
	// ...and changes nothing: bob's mount still stands in the bay.
	if s := x.home(ac).Stalls; s[0].Mount != "Lion-Golden" {
		t.Fatal("a replay moved the world", s)
	}
}

// An absent `where` on an operation that has one is still an invalid
// position: only `companions` and `mount-home` stay put (6.2, lane D's
// keyedOpStay).
func TestAbsentWhereIsStillInvalid(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	h, _, _ := standingStable(x, ac, &a, 1)
	req := map[string]any{"op": map[string]any{"lease": a.Lease, "key": "no-where"}, "homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"}
	if r := x.companionOp("POST", "/api/stable/stall", req, ac, 409); r.Error.Code != "invalid-position" {
		t.Fatal("a where-less stall was not refused", r.Error.Code)
	}
	// And the two stay-put ops run without one.
	if r := x.companionOp("POST", "/api/stable/home", map[string]any{"op": map[string]any{"lease": a.Lease, "key": "home-no-where"}}, ac, 200); r.Result.Companions.MountOut != "" {
		t.Fatal("mount-home without a where", r.Result.Companions)
	}
}
