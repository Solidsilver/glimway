package api

import (
	"fmt"
	"net/http"
	"testing"

	contract "glimway/server/internal/gen/glimway/v1"
)

// The test stone: a Lantern Road lamp stone the fake generator puts in
// chunk (2, -1) in every wick, at a chunk-local tile by the west seam.
const testStone = "lamp-stone:2:-1"

var testStoneTile = [2]int{1, 8}

func (x *rig) withStone() {
	x.gen.Edit = func(e *contract.WildsEpoch, m *contract.WorldChunk) {
		if m.Cx == 2 && m.Cy == -1 {
			m.Sites = append(m.Sites, &contract.StorySite{Id: testStone, Kind: contract.SiteKind_SITE_KIND_LAMP_STONE, Tx: uint32(testStoneTile[0]), Ty: uint32(testStoneTile[1])})
		}
	}
}

// lampOp posts a communal-lamp operation standing on world tile (sx, sy).
func (x *rig) lampOp(c *http.Cookie, s response, req *contract.CommunalLampRequest, sx, sy, status int) (*contract.CommunalLampResult, string) {
	x.t.Helper()
	req.Op = opHeader(s.Lease, fmt.Sprintf("lamp-%s-%d", req.Action, keySeq()))
	req.Where = tileWhere(sx, sy)
	env, code := x.call("/api/communal-lamps", req, c, status)
	return env.GetCommunalLamp(), code
}

// lamps reads the world's lit communal lamps (the read that settles a turning).
func (x *rig) lamps(c *http.Cookie) []*contract.CommunalLampView {
	x.t.Helper()
	v := &contract.CommunalLampsRead{}
	x.mixedRead("/api/communal-lamps", c, v)
	return v.Lamps
}

// Anyone relights a dark stone with a lamp wick and no oil; it can't be lit
// twice; one visit in the wick keeps it lit through the turning, and a wick
// nobody came goes dark again. Its naming outlives the dark.
func TestCommunalStoneRelightKeepAndDark(t *testing.T) {
	x := newRig(t)
	x.withStone()
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	sx, sy := local(2, -1, [2]int{testStoneTile[0] + 1, testStoneTile[1] + 1})
	relight := func(cc *http.Cookie, ss response, lamp string, fx, fy, status int) (*contract.CommunalLampResult, string) {
		return x.lampOp(cc, ss, &contract.CommunalLampRequest{Action: "relight", Lamp: lamp}, fx, fy, status)
	}
	if _, code := relight(c, s, testStone, sx, sy, 409); code != "insufficient-materials" {
		t.Fatalf("relight without a wick: %s", code)
	}
	x.stack(s.AccountID, "lamp-wick", "", 2)
	if _, code := relight(c, s, testStone, sx+8, sy, 409); code != "too-far-away" {
		t.Fatalf("relight from afar: %s", code)
	}
	if _, code := relight(c, s, "lamp-stone:3:-1", sx, sy, 404); code != "no-lamp" {
		t.Fatalf("relight where no stone stands: %s", code)
	}
	v, _ := relight(c, s, testStone, sx, sy, 200)
	ox, oy := local(2, -1, testStoneTile)
	if l := v.Lamp; l == nil || l.Id != testStone || l.Kind != "stone" || int(l.X) != ox || int(l.Y) != oy || l.SetterId != s.AccountID || !l.Visited || l.Naming != nil {
		t.Fatalf("relit: %+v", v.Lamp)
	}
	if x.packQty(s.AccountID, "lamp-wick") != 1 || x.packQty(s.AccountID, "hearth-oil") != 0 {
		t.Fatal("a relight burns one wick, no oil")
	}
	x.stack(b.AccountID, "lamp-wick", "", 1)
	if _, code := relight(bc, b, testStone, sx, sy, 409); code != "lamp-lit" {
		t.Fatalf("relit twice: %s", code)
	}
	// The Keeper's-hand lane will name it; its home is ready.
	if _, err := x.db.DB.Exec("INSERT INTO lamp_namings(world_id,lamp_id,parts,landmark,text,short_name,namer,named_at) VALUES(?,?,?,?,?,?,?,?)", s.WorldID, testStone, `["first","past","whitequiet","hold-fast"]`, "whitequiet", "You are the first lamp past the Whitequiet. Hold fast.", "First past the Whitequiet", b.AccountID, x.now.Load()); err != nil {
		t.Fatal(err)
	}

	// Relighting stood there: it stays lit through the turning.
	x.turn()
	c, s = x.again("alice")
	ls := x.lamps(c)
	if len(ls) != 1 || ls[0].Id != testStone || ls[0].Visited || ls[0].Naming == nil || ls[0].Naming.NamerId != b.AccountID || ls[0].Naming.NamerName == "" || len(ls[0].Naming.Parts) != 4 {
		t.Fatalf("after a visited wick: %+v", ls)
	}
	// Nobody comes this wick: dark at the turning, its naming kept.
	x.turn()
	c, s = x.again("alice")
	if ls := x.lamps(c); len(ls) != 0 {
		t.Fatalf("an unvisited stone stayed lit: %+v", ls)
	}
	if n := count(t, x.db, "SELECT count(*) FROM lamp_namings WHERE lamp_id=?", testStone); n != 1 {
		t.Fatal("the naming went with the light")
	}
	// Anyone may light it again; the wick burnt isn't owed back.
	v, _ = relight(c, s, testStone, sx, sy, 200)
	if v.Lamp.Naming == nil || x.packQty(s.AccountID, "lamp-wick") != 0 || x.crated(s.AccountID, "lamp-wick") != 0 {
		t.Fatalf("relit again: %+v", v.Lamp)
	}
}

// Relighting and tending a lamp across a seam visit the lamp's chunk, not
// only the one the player stands in.
func TestCommunalLampCreditsItsChunkAcrossSeam(t *testing.T) {
	x := newRig(t)
	x.withStone()
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.stack(s.AccountID, "lamp-wick", "", 1)
	// The stone is at local x=1 of chunk 2; stand two tiles west, in chunk 1.
	sx, sy := local(1, -1, [2]int{23, testStoneTile[1]})
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "relight", Lamp: testStone}, sx, sy, 200)
	if x.visits(s.WorldID, 2, -1) != 1 {
		t.Fatal("the relight didn't visit the stone's chunk")
	}
	// Next wick, Bob tends it from across the seam: the stone's chunk is visited.
	x.turn()
	bc, b = x.again("bob")
	if x.visits(b.WorldID, 2, -1) != 0 {
		t.Fatal("a visit before tending")
	}
	if _, code := x.lampOp(bc, b, &contract.CommunalLampRequest{Action: "tend", Lamp: "lamp-stone:9:9"}, sx, sy, 404); code != "no-lamp" {
		t.Fatalf("tend nothing: %s", code)
	}
	x.lampOp(bc, b, &contract.CommunalLampRequest{Action: "tend", Lamp: testStone}, sx, sy, 200)
	if x.visits(b.WorldID, 2, -1) != 1 {
		t.Fatal("tending didn't visit the stone's chunk")
	}
	x.turn()
	c, _ = x.again("alice")
	if ls := x.lamps(c); len(ls) != 1 {
		t.Fatal("a tended stone went dark")
	}
}

// A communal post is a way-lamp set with no oil, on Common ground only;
// nobody but its setter lifts it. Unvisited through a turning, it waits at
// Pell's for its setter, the same piece, collected once; lifted first, it
// never reaches a crate.
func TestCommunalPostCrateAndLift(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	spots := x.campSpots(s.WorldID, 3, -1)
	at, stand := spots[0], spots[1]
	post := func(cc *http.Cookie, ss response, item string, tile, from [2]int, status int) (*contract.CommunalLampResult, string) {
		return x.lampOp(cc, ss, &contract.CommunalLampRequest{Action: "post", ItemId: item, X: int32(tile[0]), Y: int32(tile[1])}, from[0], from[1], status)
	}
	lamp := x.carry(s.AccountID, "way-lamp")
	if _, code := post(c, s, x.carry(s.AccountID, "wooden-stool"), at, stand, 409); code != "invalid-item" {
		t.Fatalf("post a stool: %s", code)
	}
	back := [2]int{-3*24 + 12, 1*24 + 12}
	if _, code := post(c, s, lamp, back, back, 409); code != "not-common" {
		t.Fatalf("post on a lot's backland: %s", code)
	}
	x.holdChunk(s.WorldID, 4, -1)
	held := [2]int{4*24 + 12, -1*24 + 12}
	if _, code := post(c, s, lamp, held, held, 409); code != "not-common" {
		t.Fatalf("post on held land: %s", code)
	}
	v, _ := post(c, s, lamp, at, stand, 200)
	if l := v.Lamp; l == nil || l.Id != lamp || l.Kind != "post" || int(l.X) != at[0] || int(l.Y) != at[1] || !l.Visited {
		t.Fatalf("posted: %+v", v.Lamp)
	}
	if loc, _ := x.itemAt(lamp); loc != "lamp" || x.packQty(s.AccountID, "hearth-oil") != 0 {
		t.Fatalf("the post's piece: %s", loc)
	}
	if _, code := post(bc, b, x.carry(b.AccountID, "way-lamp"), at, stand, 409); code != "placement-overlap" && code != "land-blocked" {
		t.Fatalf("a second post on the tile: %s", code)
	}
	x.give(b.AccountID, "stone", 1)
	if _, code := x.pathOp(bc, b, "lay", "under-post", stand[0], stand[1], at[0], at[1], "stone", 409); code != "cannot-lay-here" {
		t.Fatalf("a path laid under the post: %s", code)
	}
	lift := func(cc *http.Cookie, ss response, status int) string {
		_, code := x.lampOp(cc, ss, &contract.CommunalLampRequest{Action: "lift", Lamp: lamp}, stand[0], stand[1], status)
		return code
	}
	if code := lift(bc, b, 409); code != "not-your-lamp" {
		t.Fatalf("Bob lifts Alice's post: %s", code)
	}

	// Setting it stood there: it carries one turning.
	x.turn()
	c, s = x.again("alice")
	if ls := x.lamps(c); len(ls) != 1 || ls[0].Id != lamp {
		t.Fatalf("after a visited wick: %+v", ls)
	}
	// Nobody comes: the post goes to Pell's for Alice, the same piece.
	x.turn()
	c, s = x.again("alice")
	if ls := x.lamps(c); len(ls) != 0 {
		t.Fatalf("an unvisited post stayed: %+v", ls)
	}
	if loc, _ := x.itemAt(lamp); loc != "crate" {
		t.Fatalf("the post's piece: %s", loc)
	}
	if n := count(t, x.db, "SELECT count(*) FROM recovery_entries e JOIN recovery_crates c ON c.id=e.crate_id WHERE c.source=? AND e.kind='piece' AND e.instance_id=? AND e.account_id=?", "communal:"+lamp, lamp, s.AccountID); n != 1 {
		t.Fatalf("%d crate entries, want 1", n)
	}
	// Crated, it can't be lifted too; collected, it comes back once.
	if code := lift(c, s, 404); code != "no-lamp" {
		t.Fatalf("lift a crated post: %s", code)
	}
	x.collect(c, s, "collect", true, 200)
	x.collect(c, s, "collect-again", true, 200)
	if loc, _ := x.itemAt(lamp); loc != "inventory" {
		t.Fatalf("collected: %s", loc)
	}

	// Set again and lifted: back in the pack, and the turning crates nothing.
	spots = x.campSpots(s.WorldID, 3, -1)
	post(c, s, lamp, spots[0], spots[1], 200)
	stand = spots[1]
	if code := lift(c, s, 200); code != "" {
		t.Fatalf("lift: %s", code)
	}
	if loc, _ := x.itemAt(lamp); loc != "inventory" {
		t.Fatalf("lifted: %s", loc)
	}
	x.turn()
	c, _ = x.again("alice")
	x.lamps(c)
	x.turn()
	c, _ = x.again("alice")
	x.lamps(c)
	if n := count(t, x.db, "SELECT count(*) FROM recovery_entries WHERE instance_id=?", lamp); n != 1 {
		t.Fatalf("%d crate entries for the post, want the first one only", n)
	}
	if loc, _ := x.itemAt(lamp); loc != "inventory" {
		t.Fatalf("after lifting and turning: %s", loc)
	}
}

// The map marks a lit communal lamp in an explored chunk as a common-lamp
// under the neutral label (no name until a Keeper names it), the chunk
// Common by its lamp alone, visited or not this wick. An unexplored chunk's
// lamp stays off the map; a dark stone is never marked.
func TestCommunalLampOnTheMap(t *testing.T) {
	x := newRig(t)
	x.withStone()
	c, s := x.ready("alice")
	x.stack(s.AccountID, "lamp-wick", "", 1)
	sx, sy := local(2, -1, [2]int{testStoneTile[0] + 1, testStoneTile[1] + 1})
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "relight", Lamp: testStone}, sx, sy, 200)
	find := func(m *contract.WildsMapStatus) *contract.MapLamp {
		for _, l := range m.Lamps {
			if l.Kind == "common-lamp" {
				return l
			}
		}
		return nil
	}
	if find(x.mapLand(c, [2]int{3, -1})) != nil {
		t.Fatal("an unexplored chunk's lamp is on the map")
	}
	m := x.mapLand(c, [2]int{2, -1})
	ox, oy := local(2, -1, testStoneTile)
	l := find(m)
	if l == nil || l.Id != testStone || int(l.X) != ox || int(l.Y) != oy || l.Name != "" || l.Land.GetTier() != "common" || !l.Land.Visited || l.Land.NextTurning != "lamps-carry" {
		t.Fatalf("mark: %+v", l)
	}
	// Next wick, nobody has come yet: it needs a visit.
	x.turn()
	c, _ = x.again("alice")
	l = find(x.mapLand(c, [2]int{2, -1}))
	if l == nil || l.Land.Visited || l.Land.NextTurning != "lamps-turn" {
		t.Fatalf("unvisited mark: %+v", l)
	}
	if _, err := x.db.DB.Exec("INSERT INTO lamp_namings(world_id,lamp_id,text,short_name,namer,named_at) VALUES(?,?,?,?,?,?)", s.WorldID, testStone, "Hold fast.", "First past the Whitequiet", s.AccountID, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	if l = find(x.mapLand(c, [2]int{2, -1})); l == nil || l.Name != "First past the Whitequiet" || l.Naming != "Hold fast." || l.Namer == "" {
		t.Fatalf("named mark: %+v", l)
	}
	// Dark after the unvisited wick: off the map.
	x.turn()
	c, _ = x.again("alice")
	x.lamps(c)
	if find(x.mapLand(c, [2]int{2, -1})) != nil {
		t.Fatal("a dark stone is on the map")
	}
}
