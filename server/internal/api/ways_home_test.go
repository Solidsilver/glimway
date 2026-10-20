package api

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/fights"
	contract "glimway/server/internal/gen/glimway/v1"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/location"
	"glimway/server/internal/wilds"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// waysOp posts a way-home operation standing on world tile (sx, sy).
func (x *rig) waysOp(c *http.Cookie, s response, action string, sx, sy, status int) (*contract.Envelope, string) {
	x.t.Helper()
	req := &contract.WaysHomeRequest{Op: opHeader(s.Lease, fmt.Sprintf("ways-%s-%d", action, keySeq())), Where: tileWhere(sx, sy), Action: action}
	return x.call("/api/ways-home", req, c, status)
}

// pouchBinding reads the caller's binding (nil: none).
func (x *rig) pouchBinding(c *http.Cookie) *contract.WaysHomeBinding {
	x.t.Helper()
	v := &contract.WaysHomeRead{}
	x.mixedRead("/api/ways-home", c, v)
	return v.Binding
}

// fight stamps an account as fighting now, as an enemy's wind-up at them does.
func (x *rig) fight(account string, on bool) {
	h := x.api.presence
	h.mu.Lock()
	defer h.mu.Unlock()
	if on {
		h.markFought(account, h.now())
	} else {
		h.markFought(account, h.now().Add(-fightQuiet))
	}
}

// arrivedTile is where an answer put the player, in world tiles.
func arrivedTile(t *testing.T, env *contract.Envelope) (int, int) {
	t.Helper()
	p := env.GetState().GetPlace()
	if p.GetArea() != outdoorsArea {
		t.Fatalf("arrived in %q", p.GetArea())
	}
	return wilds.TileOfPixel(p.GetX(), p.GetY())
}

// openGround: a world tile is walkable land with nothing on it this wick,
// read straight from the chunk (or its held land), as a landing needs.
func (x *rig) openGround(world string, tx, ty int) bool {
	x.t.Helper()
	ctx := context.Background()
	db, err := x.db.DB.BeginTx(ctx, nil)
	if err != nil {
		x.t.Fatal(err)
	}
	defer db.Rollback()
	cx, cy := wilds.ChunkOf(tx, ty)
	S := chunkSize()
	g, err := x.api.campGround(ctx, db, world, cx, cy, x.now.Load())
	if err != nil {
		x.t.Fatal(err)
	}
	if g == nil {
		e, err := x.api.epochAt(ctx, db, world, cx, cy, x.now.Load())
		if err != nil {
			x.t.Fatal(err)
		}
		m, err := x.api.Config.Chunks.Chunk(ctx, db, world, e.Id, 0, int32(cx), int32(cy))
		if err != nil {
			x.t.Fatal(err)
		}
		gc, err := groundChanges(ctx, db, world, e, cx, cy, x.now.Load())
		if err != nil {
			x.t.Fatal(err)
		}
		g = &backland{eff: chunks.NewEffective(m, gc)}
	}
	return g.buildable(tx-cx*S, ty-cy*S)
}

// The two recipes are bench recipes found on their pages: unknown until the
// page is carried, then made from turncap spawn and amber, lamp ash and
// fiber. Mara's keepers-hand quest gives both pages; nobody sells them.
func TestWaysHomeRecipesNeedTheirPapers(t *testing.T) {
	for _, r := range []struct{ recipe, page, output string }{{"craft-homing-turncap", "recipe-homing-turncap", "homing-turncap"}, {"craft-lamp-ash-pouch", "recipe-lamp-ash-pouch", "lamp-ash-pouch"}} {
		v, ok := content.RecipeFor(r.recipe)
		if !ok || v.GetPage() != r.page || v.GetOutput().GetId() != r.output || v.GetOutput().GetQty() != 1 {
			t.Fatalf("%s: %+v", r.recipe, v)
		}
		for _, seller := range content.ItemsRules.GetSellers() {
			for _, g := range seller.GetGoods() {
				if g.GetItem() == r.page {
					t.Fatalf("%s sells %s", seller.GetId(), r.page)
				}
			}
		}
		q, _ := content.QuestFor("keepers-hand")
		if !slices.ContainsFunc(q.GetSteps(), func(s *content.QuestStep) bool {
			return slices.ContainsFunc(s.GetGive(), func(g *content.QuestItem) bool { return g.GetDef() == r.page })
		}) {
			t.Fatalf("the Keeper's hand doesn't give %s", r.page)
		}
	}
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimFree(c, &s)
	x.seedAssets(x.account("alice"))
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	update(&s, x.exp("POST", "/api/homestead/upgrade", body(s, "tier1", map[string]any{"tier": 1}), c, 200))
	update(&s, x.exp("POST", "/api/homestead/upgrade", body(s, "tier2", map[string]any{"tier": 2}), c, 200))
	me := x.account("alice")
	x.give(me, "turncap-spawn", 1)
	x.give(me, "amber", 2)
	x.give(me, "lamp-ash", 1)
	x.give(me, "fiber", 2)
	amber, fiber := x.packQty(me, "amber"), x.packQty(me, "fiber")
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	if v := x.craftReq("POST", "/api/craft", body(s, "turncap-locked", map[string]any{"recipeId": "craft-homing-turncap", "qty": 1}), c, 409); v.Error.Code != "recipe-unknown" {
		t.Fatalf("crafted without the page: %s", v.Error.Code)
	}
	x.give(me, "recipe-homing-turncap", 1)
	x.give(me, "recipe-lamp-ash-pouch", 1)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	v := x.craftReq("POST", "/api/craft", body(s, "turncap", map[string]any{"recipeId": "craft-homing-turncap", "qty": 1}), c, 200)
	s.Snapshot = v.Snapshot
	if v.Result.Output.GetId() != "homing-turncap" || x.packQty(me, "homing-turncap") != 1 || x.packQty(me, "turncap-spawn") != 0 || x.packQty(me, "amber") != amber-2 {
		t.Fatalf("turncap: %+v", v.Result.Output)
	}
	v = x.craftReq("POST", "/api/craft", body(s, "pouch", map[string]any{"recipeId": "craft-lamp-ash-pouch", "qty": 1}), c, 200)
	if v.Result.Output.GetId() != "lamp-ash-pouch" || x.packQty(me, "lamp-ash-pouch") != 1 || x.packQty(me, "lamp-ash") != 0 || x.packQty(me, "fiber") != fiber-2 {
		t.Fatalf("pouch: %+v", v.Result.Output)
	}
	// The pages teach; they aren't spent.
	if x.packQty(me, "recipe-homing-turncap") != 1 || x.packQty(me, "recipe-lamp-ash-pouch") != 1 {
		t.Fatal("a page was spent")
	}
	x.conserved(me)
}

// The turncap returns you to the anchor its content names (the north
// arch), spending exactly one, once, however often the answer is replayed.
// It refuses in a fight and on the town's safe ground, keeping the turncap.
func TestTurncapReturnsToTheArch(t *testing.T) {
	_, use := wayHome(travelHome)
	space, ax, ay, ok := location.Anchor(use.GetTarget())
	if !ok || use.GetSeconds() != 3 || use.GetTarget() != "hearthwick:arch" {
		t.Fatalf("the turncap's anchor %q doesn't resolve", use.GetTarget())
	}
	x := newRig(t)
	c, s := x.ready("alice")
	sx, sy := local(campCX, campCY, [2]int{12, 12})
	if _, code := x.waysOp(c, s, waysTurncap, sx, sy, 409); code != "invalid-item" {
		t.Fatalf("no turncap: %s", code)
	}
	x.stack(s.AccountID, "homing-turncap", "", 2)
	x.fight(s.AccountID, true)
	if _, code := x.waysOp(c, s, waysTurncap, sx, sy, 409); code != "in-a-fight" {
		t.Fatalf("in a fight: %s", code)
	}
	x.fight(s.AccountID, false)
	tx0, ty0 := wilds.TileOfPixel(ax, ay)
	if _, code := x.waysOp(c, s, waysTurncap, tx0, ty0+2, 409); code != "not-needed" {
		t.Fatalf("in town: %s", code)
	}
	if x.packQty(s.AccountID, "homing-turncap") != 2 {
		t.Fatal("a refusal spent the turncap")
	}
	req := &contract.WaysHomeRequest{Op: opHeader(s.Lease, "turncap-once"), Where: tileWhere(sx, sy), Action: waysTurncap}
	env, _ := x.call("/api/ways-home", req, c, 200)
	p := env.GetState().GetPlace()
	if p.GetArea() != string(space) || p.GetX() != ax || p.GetY() != ay || env.GetWaysHome().GetX() != ax {
		t.Fatalf("arrived at %+v, not the arch (%v, %v)", p, ax, ay)
	}
	if x.packQty(s.AccountID, "homing-turncap") != 1 {
		t.Fatal("not exactly one turncap spent")
	}
	if again, _ := x.call("/api/ways-home", req, c, 200); again.GetWaysHome().GetY() != ay || x.packQty(s.AccountID, "homing-turncap") != 1 {
		t.Fatal("a replay spent another turncap")
	}
	// The server's place stands: a reload starts at the arch.
	if st := x.expect("GET", "/api/state", nil, c, 200); st.State.Position.X != ax || st.State.Position.Y != ay {
		t.Fatalf("reloaded at %+v", st.State.Position)
	}
}

// A pouch binds to a lit communal lamp within reach (with a pouch in the
// pack) and brings you to open ground beside it, spending one. A pouch
// that can't go keeps itself: unbound, in a fight, cross-world, or bound
// to a stone gone dark.
func TestPouchToACommunalLamp(t *testing.T) {
	x := newRig(t)
	x.withStone()
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.stack(s.AccountID, "lamp-wick", "", 1)
	nx, ny := local(2, -1, [2]int{testStoneTile[0] + 1, testStoneTile[1] + 1})
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "relight", Lamp: testStone}, nx, ny, 200)
	if _, code := x.waysOp(c, s, waysBind, nx, ny, 409); code != "invalid-item" {
		t.Fatalf("bind without a pouch: %s", code)
	}
	x.stack(s.AccountID, "lamp-ash-pouch", "", 3)
	far := [2]int{campCX*24 + 12, campCY*24 + 12}
	if _, code := x.waysOp(c, s, waysBind, far[0], far[1], 409); code != "no-lamp" {
		t.Fatalf("bind far from a lamp: %s", code)
	}
	if x.pouchBinding(c) != nil {
		t.Fatal("bound before binding")
	}
	env, _ := x.waysOp(c, s, waysBind, nx, ny, 200)
	ox, oy := local(2, -1, testStoneTile)
	if bv := env.GetWaysHome().GetBinding(); bv == nil || bv.LampId != testStone || bv.State != lampLit || bv.Kind != lampStone || int(bv.X) != ox || int(bv.Y) != oy {
		t.Fatalf("bound: %+v", bv)
	}
	if x.packQty(s.AccountID, "lamp-ash-pouch") != 3 {
		t.Fatal("binding spent a pouch")
	}
	// Bob has a pouch and no binding of his own.
	x.stack(b.AccountID, "lamp-ash-pouch", "", 1)
	if _, code := x.waysOp(bc, b, waysPouch, far[0], far[1], 409); code != "pouch-unbound" {
		t.Fatalf("an unbound pouch: %s", code)
	}
	x.fight(s.AccountID, true)
	if _, code := x.waysOp(c, s, waysPouch, far[0], far[1], 409); code != "in-a-fight" {
		t.Fatalf("in a fight: %s", code)
	}
	x.fight(s.AccountID, false)
	if x.packQty(s.AccountID, "lamp-ash-pouch") != 3 || x.packQty(b.AccountID, "lamp-ash-pouch") != 1 {
		t.Fatal("a refusal spent a pouch")
	}
	env, _ = x.waysOp(c, s, waysPouch, far[0], far[1], 200)
	tx0, ty0 := arrivedTile(t, env)
	if cx, cy := wilds.ChunkOf(tx0, ty0); cx != 2 || cy != -1 || max(intAbs(tx0-ox), intAbs(ty0-oy)) > 2 || tx0 == ox && ty0 == oy {
		t.Fatalf("landed at (%d, %d), not beside the stone (%d, %d)", tx0, ty0, ox, oy)
	}
	if !x.openGround(s.WorldID, tx0, ty0) {
		t.Fatalf("landed on closed ground (%d, %d)", tx0, ty0)
	}
	if x.packQty(s.AccountID, "lamp-ash-pouch") != 2 {
		t.Fatal("not exactly one pouch spent")
	}
	// Bound in another world: it says so, and keeps the pouch.
	_, other := x.ready("carol")
	if _, err := x.db.DB.Exec("UPDATE ways_home_bindings SET world_id=? WHERE account_id=?", other.WorldID, s.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, code := x.waysOp(c, s, waysPouch, far[0], far[1], 409); code != "lamp-elsewhere" {
		t.Fatalf("cross-world: %s", code)
	}
	if bv := x.pouchBinding(c); bv.State != lampElsewhere || bv.Kind != "" {
		t.Fatalf("cross-world binding: %+v", bv)
	}
	if _, err := x.db.DB.Exec("UPDATE ways_home_bindings SET world_id=? WHERE account_id=?", s.WorldID, s.AccountID); err != nil {
		t.Fatal(err)
	}
	// The arrival visited this wick; nobody comes the next, and it goes dark.
	x.turn()
	c, s = x.again("alice")
	x.turn()
	c, s = x.again("alice")
	if _, code := x.waysOp(c, s, waysPouch, far[0], far[1], 409); code != "lamp-unlit" {
		t.Fatalf("a dark stone: %s", code)
	}
	if x.packQty(s.AccountID, "lamp-ash-pouch") != 2 {
		t.Fatal("a dark lamp spent the pouch")
	}
}

// A communal post taken down by its setter is gone; a pouch bound to it
// says so and keeps itself.
func TestPouchToALiftedPostIsGone(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	post := x.carry(s.AccountID, "way-lamp")
	x.stack(s.AccountID, "lamp-ash-pouch", "", 1)
	spots := x.campSpots(s.WorldID, campCX, campCY)
	at, stand := spots[0], spots[1]
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "post", ItemId: post, X: int32(at[0]), Y: int32(at[1])}, stand[0], stand[1], 200)
	env, _ := x.waysOp(c, s, waysBind, stand[0], stand[1], 200)
	if bv := env.GetWaysHome().GetBinding(); bv.LampId != post || bv.Kind != lampPost {
		t.Fatalf("bound: %+v", bv)
	}
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "lift", Lamp: post}, stand[0], stand[1], 200)
	if _, code := x.waysOp(c, s, waysPouch, stand[0], stand[1], 409); code != "lamp-gone" {
		t.Fatalf("a lifted post: %s", code)
	}
	if x.packQty(s.AccountID, "lamp-ash-pouch") != 1 {
		t.Fatal("a gone lamp spent the pouch")
	}
}

// A camp's way-lamp takes a binding; the pouch lands on the camp's held
// ground beside it, off the lamp. Once the camp lapses into Pell's crate,
// the pouch says the lamp is packed and keeps itself.
func TestPouchToACampLampAndPacked(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID) // setting a way-lamp takes the Keeper's hand
	lamp := x.carry(s.AccountID, "way-lamp")
	x.stack(s.AccountID, "hearth-oil", "", 1)
	x.stack(s.AccountID, "lamp-ash-pouch", "", 2)
	spots := x.campSpots(s.WorldID, campCX, campCY)
	at, stand := spots[0], spots[1]
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(at[0]), Y: int32(at[1])}, stand[0], stand[1], 200)
	env, _ := x.waysOp(c, s, waysBind, stand[0], stand[1], 200)
	if bv := env.GetWaysHome().GetBinding(); bv.LampId != lamp || bv.Kind != lampCamp || int(bv.X) != at[0] || int(bv.Y) != at[1] {
		t.Fatalf("bound: %+v", bv)
	}
	sx, sy := local(2, -1, [2]int{12, 12})
	env, _ = x.waysOp(c, s, waysPouch, sx, sy, 200)
	tx0, ty0 := arrivedTile(t, env)
	if max(intAbs(tx0-at[0]), intAbs(ty0-at[1])) > 2 || tx0 == at[0] && ty0 == at[1] || !x.openGround(s.WorldID, tx0, ty0) {
		t.Fatalf("landed at (%d, %d), lamp at %v", tx0, ty0, at)
	}
	if x.packQty(s.AccountID, "lamp-ash-pouch") != 1 {
		t.Fatal("not exactly one pouch spent")
	}
	// Turnings: the flask burns, it dims, then it lapses to Pell's.
	for range 3 {
		x.turn()
		c, s = x.again("alice")
		x.camps(c)
	}
	if loc, _ := x.itemAt(lamp); loc != "crate" {
		t.Fatalf("the lamp is at %s", loc)
	}
	if _, code := x.waysOp(c, s, waysPouch, sx, sy, 409); code != "lamp-packed" {
		t.Fatalf("a packed lamp: %s", code)
	}
	if bv := x.pouchBinding(c); bv.State != lampPacked || x.packQty(s.AccountID, "lamp-ash-pouch") != 1 {
		t.Fatalf("packed: %+v", bv)
	}
}

// Landing tries the nearer ring first, and in front of the lamp first.
func TestLandingOrder(t *testing.T) {
	if len(landingOffsets) != 24 || landingOffsets[0] != [2]int{0, 1} {
		t.Fatalf("landing offsets: %v", landingOffsets[:3])
	}
	for i, o := range landingOffsets[:8] {
		if max(intAbs(o[0]), intAbs(o[1])) != 1 {
			t.Fatalf("offset %d is %v, outside the first ring", i, o)
		}
	}
}

// An enemy winding up at you, as a fight room's output says, puts you in a
// fight: neither way home works until it has been quiet a while.
func TestAnEnemyWindUpRefusesTravel(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.stack(s.AccountID, "homing-turncap", "", 1)
	sx, sy := local(campCX, campCY, [2]int{12, 12})
	room := &presenceFightRoom{handle: 1}
	x.api.fightOutputs([]fights.Emitted{{Tag: room, Output: fights.Output{Message: &wire.FightEvent{Room: 1, Kind: wire.FightEventKind_FIGHT_EVENT_KIND_WINDUP_START, Enemy: proto.Uint32(1), Target: proto.String(s.AccountID)}}}})
	if !x.api.inFight(s.AccountID) {
		t.Fatal("a wind-up at you isn't a fight")
	}
	if _, code := x.waysOp(c, s, waysTurncap, sx, sy, 409); code != "in-a-fight" {
		t.Fatalf("in a fight: %s", code)
	}
	x.fight(s.AccountID, false)
	x.waysOp(c, s, waysTurncap, sx, sy, 200)
	if x.packQty(s.AccountID, "homing-turncap") != 0 {
		t.Fatal("the turncap wasn't spent")
	}
}

// Only a place the server chose is a move (Place.moved_version, which the
// client follows): an operation's own place raises the place watermark but
// is never one, and a way home's landing is one in its answer, its replay
// and every read after.
func TestOnlyAPlaceTheServerChoseIsAMove(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	moved := func() (set, at int64) {
		x.t.Helper()
		if err := x.db.DB.QueryRow("SELECT place_set_version,place_moved_version FROM player_place WHERE account_id=?", s.AccountID).Scan(&set, &at); err != nil {
			t.Fatal(err)
		}
		return
	}
	sx, sy := local(campCX, campCY, [2]int{12, 12})
	mark := &contract.MarkRequest{Op: opHeader(s.Lease, "mark-here"), Mark: "seen:test", Where: tileWhere(sx, sy)}
	env, _ := x.call("/api/story/mark", mark, c, 200)
	if set, at := moved(); set == 0 || at != 0 || env.GetState().GetPlace().GetMovedVersion() != 0 {
		t.Fatalf("an operation's own place: set %d, moved %d", set, at)
	}
	x.stack(s.AccountID, "homing-turncap", "", 1)
	req := &contract.WaysHomeRequest{Op: opHeader(s.Lease, "turncap-moves"), Where: tileWhere(sx, sy), Action: waysTurncap}
	env, _ = x.call("/api/ways-home", req, c, 200)
	p := env.GetState().GetPlace()
	if p.GetMovedVersion() != env.GetState().GetVersion() || p.GetPlaceSetVersion() != p.GetMovedVersion() {
		t.Fatalf("a landing is a move at its version: %+v (version %v)", p, env.GetState().GetVersion())
	}
	if again, _ := x.call("/api/ways-home", req, c, 200); again.GetState().GetPlace().GetMovedVersion() != p.GetMovedVersion() {
		t.Fatal("the replay lost the move")
	}
	var st contract.StateResponse
	if w := x.rawHTTP("GET", "/api/state", nil, c); w.Code != 200 || (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(w.Body.Bytes(), &st) != nil {
		t.Fatalf("state read: %d %s", w.Code, w.Body.String())
	}
	if st.GetState().GetPlace().GetMovedVersion() != p.GetMovedVersion() {
		t.Fatal("a read lost the move")
	}
	// Walking on from the landing is the client's own place again.
	mark.Op = opHeader(s.Lease, "mark-after")
	env, _ = x.call("/api/story/mark", mark, c, 200)
	if got := env.GetState().GetPlace(); got.GetMovedVersion() != p.GetMovedVersion() || got.GetPlaceSetVersion() <= p.GetMovedVersion() {
		t.Fatalf("an operation after the landing: %+v", got)
	}
}

// Only a blow that lands is a fight: a slash into empty air inside a camp's
// room (the whole chunk), its wisp out of reach, doesn't mark you; one
// that hits the wisp does
// (playtest 2026-10-20: E swings when there's nothing to use, and a swing
// anywhere near a camp refused the turncap for eight seconds).
func TestOnlyALandedSwingIsAFight(t *testing.T) {
	var ms atomic.Int64
	ms.Store(100000)
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(ms.Load()) })
	a := &Server{presence: h}
	p := unitFightPeer(t, h)
	addUnitFightRoom(t, a, p, 1, 0, 200)
	swing := func(counter uint32, facing float64) *wire.FightSwingResult {
		h.mu.Lock()
		h.handleFightSwing(p, &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, X: 0, Y: 112, Facing: &wire.FightFacing{X: facing}, SwingCounter: counter, SeenTick: 1000})
		h.mu.Unlock()
		return queuedFightResult(t, p)
	}
	if r := swing(1, 1); r.RefusedReason != 0 || slices.ContainsFunc(r.Hits, landed) {
		t.Fatalf("the empty swing: %v", r)
	}
	if a.inFight(p.identity.ID) {
		t.Fatal("a swing into empty air inside a camp's room is a fight")
	}
	ms.Add(1000)
	addUnitFightRoom(t, a, p, 2, -1, -10)
	if r := swing(2, -1); !slices.ContainsFunc(r.Hits, landed) {
		t.Fatalf("the swing at the wisp: %v", r)
	}
	if !a.inFight(p.identity.ID) {
		t.Fatal("a swing that landed isn't a fight")
	}
}

// An enemy winding up at your Echo (decoy:<account>) is a fight of yours.
func TestAWindUpAtYourEchoIsAFight(t *testing.T) {
	x := newRig(t)
	room := &presenceFightRoom{handle: 1}
	x.api.fightOutputs([]fights.Emitted{{Tag: room, Output: fights.Output{Message: &wire.FightEvent{Room: 1, Kind: wire.FightEventKind_FIGHT_EVENT_KIND_AIM_LOCK, Enemy: proto.Uint32(1), Target: proto.String("decoy:alice")}}}})
	if !x.api.inFight("alice") {
		t.Fatal("an aim lock at your Echo isn't a fight")
	}
}
