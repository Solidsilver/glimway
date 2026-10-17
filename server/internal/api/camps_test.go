package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// campCX, campCY: a wick chunk of the Beyond the camps here are set in.
const campCX, campCY = 2, -4

// carry gives an account a home piece in its pack.
func (x *rig) carry(account, def string) string {
	x.t.Helper()
	id, err := store.Random()
	if err == nil {
		_, err = x.db.DB.Exec("INSERT INTO homestead_items(id,item_def,location,account_id) VALUES(?,?,'inventory',?)", id, def, account)
	}
	if err != nil {
		x.t.Fatal(err)
	}
	return id
}

// campOp posts a camp operation standing on world tile (sx, sy).
func (x *rig) campOp(c *http.Cookie, s response, req *contract.CampRequest, sx, sy, status int) (*contract.CampResult, string) {
	x.t.Helper()
	req.Op = opHeader(s.Lease, fmt.Sprintf("camp-%s-%d", req.Action, keySeq()))
	req.Where = tileWhere(sx, sy)
	env, code := x.call("/api/camps", req, c, status)
	return env.GetCamp(), code
}

// camps reads the world's camps (the read that settles a turning).
func (x *rig) camps(c *http.Cookie) []*contract.CampView {
	x.t.Helper()
	v := &contract.CampsRead{}
	x.mixedRead("/api/camps", c, v)
	return v.Camps
}

func (x *rig) recovery(c *http.Cookie) []*contract.RecoveryEntry {
	x.t.Helper()
	v := &contract.RecoveryRead{}
	x.mixedRead("/api/recovery", c, v)
	return v.Entries
}

func (x *rig) mixedRead(path string, c *http.Cookie, into proto.Message) {
	x.t.Helper()
	w := x.rawHTTP("GET", path, nil, c)
	if w.Code != 200 {
		x.t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
	}
	var doc struct{ Result json.RawMessage }
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		x.t.Fatal(err)
	}
	if err := protojson.Unmarshal(doc.Result, into); err != nil {
		x.t.Fatal(err)
	}
}

// collect takes what waits at Pell's, standing in his office (or not).
func (x *rig) collect(c *http.Cookie, s response, key string, atDesk bool, status int) (*contract.RecoveryCollectResult, string) {
	x.t.Helper()
	t := content.HomeRules.GetCommons().GetDeedTable()
	where := &contract.Where{Area: t.GetArea(), X: float64(t.GetX()), Y: float64(t.GetY()) + 8}
	if !atDesk {
		where = tileWhere(campCX*24+12, campCY*24+12)
	}
	env, code := x.call("/api/recovery/collect", &contract.RecoveryCollectRequest{Op: opHeader(s.Lease, key), Where: where}, c, status)
	return env.GetRecoveryCollect(), code
}

// campSpots are a chunk's open tiles this wick (world tiles), away from its
// edges, in reading order: where a lamp, a piece or a path may go.
func (x *rig) campSpots(world string, cx, cy int) [][2]int {
	x.t.Helper()
	tx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	e, err := x.api.epochAt(context.Background(), tx, world, cx, cy, x.now.Load())
	if err != nil {
		x.t.Fatal(err)
	}
	m, err := x.api.Config.Chunks.Chunk(context.Background(), tx, world, e.Id, 0, int32(cx), int32(cy))
	if err != nil {
		x.t.Fatal(err)
	}
	g, err := groundChanges(context.Background(), tx, world, e, cx, cy, x.now.Load())
	if err != nil {
		x.t.Fatal(err)
	}
	b := backland{eff: chunks.NewEffective(m, g)}
	if err = tx.Commit(); err != nil {
		x.t.Fatal(err)
	}
	out := [][2]int{}
	for y := 3; y < 21; y++ {
		for lx := 3; lx < 21; lx++ {
			if b.buildable(lx, y) {
				out = append(out, [2]int{cx*24 + lx, cy*24 + y})
			}
		}
	}
	if len(out) < 6 {
		x.t.Fatalf("camp spots: %d", len(out))
	}
	return out
}

func (x *rig) itemAt(id string) (location string, camp *string) {
	x.t.Helper()
	if err := x.db.DB.QueryRow("SELECT location,camp_id FROM homestead_items WHERE id=?", id).Scan(&location, &camp); err != nil {
		x.t.Fatal(err)
	}
	return
}

// A way-lamp is set with a first flask of oil, holding its chunk as a
// camp; it can't go on a lot's backland, the town, the Tangle or another
// camp; anyone tops it up, but only its setter builds there.
func TestCampSetFillAndAccess(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID) // setting a way-lamp takes the Keeper's hand
	bc, bs := x.member("bob", s.WorldID)
	lamp := x.carry(s.AccountID, "way-lamp")
	spots := x.campSpots(s.WorldID, campCX, campCY)
	at, stand := spots[0], spots[1]
	set := func(cc *http.Cookie, ss response, item string, tile, from [2]int, status int) (*contract.CampResult, string) {
		return x.campOp(cc, ss, &contract.CampRequest{Action: "set", ItemId: item, X: int32(tile[0]), Y: int32(tile[1])}, from[0], from[1], status)
	}
	if _, code := set(c, s, lamp, at, stand, 409); code != "insufficient-materials" {
		t.Fatalf("set without oil: %s", code)
	}
	x.stack(s.AccountID, "hearth-oil", "", 3)
	if _, code := set(c, s, lamp, at, [2]int{at[0] + 8, at[1]}, 409); code != "too-far-away" {
		t.Fatalf("set from afar: %s", code)
	}
	if _, code := set(c, s, x.carry(s.AccountID, "wooden-stool"), at, stand, 409); code != "invalid-item" {
		t.Fatalf("set a stool: %s", code)
	}
	// Not on a backland, the town or the Tangle.
	tangle := wilds.Footprint("tangle")
	_, wx, wy, _ := location.Anchor("hearthwick:well")
	town := [2]int{wilds.FloorDiv(int(wx)/16, 24), wilds.FloorDiv(int(wy)/16, 24)}
	for name, ch := range map[string][2]int{"backland": {-3, 1}, "town": town, "tangle": {int(tangle.GetCx() + tangle.GetWidth()/2), int(tangle.GetCy() + tangle.GetHeight()/2)}} {
		tile := [2]int{ch[0]*24 + 12, ch[1]*24 + 12}
		if _, code := set(c, s, lamp, tile, tile, 409); code != "cannot-hold" {
			t.Fatalf("%s: %s", name, code)
		}
	}
	if location.SourceOf(town[0], town[1]).Kind == location.SourceGenerated {
		t.Fatal("no town chunk")
	}
	v, _ := set(c, s, lamp, at, stand, 200)
	if cv := v.Camp; cv == nil || cv.Id != lamp || cv.Oil != 1 || cv.Dimming || !cv.Builder || int(cv.X) != at[0] || len(cv.Pieces) != 1 || cv.Pieces[0].ItemDef != "way-lamp" {
		t.Fatalf("set: %+v", v.Camp)
	}
	if x.packQty(s.AccountID, "hearth-oil") != 2 {
		t.Fatal("the first flask")
	}
	if loc, camp := x.itemAt(lamp); loc != "camp" || camp == nil || *camp != lamp {
		t.Fatalf("lamp: %s", loc)
	}
	// Another camp can't share the chunk.
	other := x.carry(bs.AccountID, "way-lamp")
	x.stack(bs.AccountID, "hearth-oil", "", 4)
	x.keeper(bs.AccountID)
	if _, code := set(bc, bs, other, spots[3], spots[4], 409); code != "cannot-hold" {
		t.Fatalf("a second camp: %s", code)
	}
	// Anyone tops it up, to three wicks.
	fill := func(cc *http.Cookie, ss response, status int) (*contract.CampResult, string) {
		return x.campOp(cc, ss, &contract.CampRequest{Action: "fill", Camp: lamp}, stand[0], stand[1], status)
	}
	fill(bc, bs, 200)
	if v, _ := fill(c, s, 200); v.Camp.Oil != 3 || v.Camp.Builder != true {
		t.Fatalf("filled: %+v", v.Camp)
	}
	if _, code := fill(bc, bs, 409); code != "lantern-full" {
		t.Fatalf("over-filled: %s", code)
	}
	// Bob may fill, never build.
	cs := x.camps(bc)
	if len(cs) != 1 || cs[0].Builder || cs[0].SetterId != s.AccountID {
		t.Fatalf("bob's read: %+v", cs)
	}
	stool := x.carry(bs.AccountID, "wooden-stool")
	if _, code := x.campOp(bc, bs, &contract.CampRequest{Action: "place", ItemId: stool, X: int32(spots[2][0]), Y: int32(spots[2][1])}, stand[0], stand[1], 409); code != "not-your-land" {
		t.Fatalf("bob placed: %s", code)
	}
	x.give(bs.AccountID, "stone", 2)
	if _, code := x.pathOp(bc, bs, "lay", "bob-lay", spots[2][0], spots[2][1], spots[2][0], spots[2][1], "stone", 409); code != "not-your-land" {
		t.Fatalf("bob laid at the camp: %s", code)
	}
	// Alice builds: a piece, a plant; not on each other, not beyond the chunk.
	mine := x.carry(s.AccountID, "wooden-stool")
	place := func(item string, tile [2]int, status int) string {
		_, code := x.campOp(c, s, &contract.CampRequest{Action: "place", ItemId: item, X: int32(tile[0]), Y: int32(tile[1])}, stand[0], stand[1], status)
		return code
	}
	if code := place(mine, at, 409); code != "placement-overlap" {
		t.Fatalf("on the lamp: %s", code)
	}
	place(mine, spots[2], 200)
	x.stack(s.AccountID, "birch-sapling", "", 1)
	if _, code := x.campOp(c, s, &contract.CampRequest{Action: "plant", ItemDef: "birch-sapling", X: int32(spots[2][0]), Y: int32(spots[2][1])}, stand[0], stand[1], 409); code != "placement-overlap" {
		t.Fatalf("planted under the stool: %s", code)
	}
	v, _ = x.campOp(c, s, &contract.CampRequest{Action: "plant", ItemDef: "birch-sapling", X: int32(spots[3][0]), Y: int32(spots[3][1])}, stand[0], stand[1], 200)
	if len(v.Camp.Pieces) != 2 || len(v.Camp.Plants) != 1 || v.Camp.Plants[0].OwnerId != s.AccountID {
		t.Fatalf("built: %+v", v.Camp)
	}
	// Only a piece's owner picks it up; the lamp stays while others stand.
	if _, code := x.campOp(bc, bs, &contract.CampRequest{Action: "remove", ItemId: mine}, stand[0], stand[1], 409); code != "item-not-owned" {
		t.Fatalf("bob took the stool: %s", code)
	}
	if _, code := x.campOp(c, s, &contract.CampRequest{Action: "remove", ItemId: lamp}, stand[0], stand[1], 409); code != "camp-not-empty" {
		t.Fatalf("took the lamp from under the camp: %s", code)
	}
	x.campOp(c, s, &contract.CampRequest{Action: "remove", ItemId: mine}, stand[0], stand[1], 200)
	if loc, _ := x.itemAt(mine); loc != "inventory" {
		t.Fatalf("stool: %s", loc)
	}
}

// Judged once at each turning, as the lot lantern: a wick burns; out of oil
// the camp dims for a wick, still held; still empty it lapses, its chunk
// turns and everything there waits in a crate at Pell's, each thing for
// whoever it belongs to. Collecting gives it all back once.
func TestCampBurnsDimsAndLapsesIntoPellsCrate(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID) // setting a way-lamp takes the Keeper's hand
	bc, bs := x.member("bob", s.WorldID)
	spots := x.campSpots(s.WorldID, campCX, campCY)
	at, stand := spots[0], spots[1]
	// Bob's path is there before the camp: it comes under the camp's upkeep.
	x.give(bs.AccountID, "stone", 3)
	x.pathOp(bc, bs, "lay", "bob-path", spots[4][0], spots[4][1], spots[4][0], spots[4][1], "stone", 200)
	stoneLeft := x.packQty(bs.AccountID, "stone")
	lamp := x.carry(s.AccountID, "way-lamp")
	x.stack(s.AccountID, "hearth-oil", "", 1)
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(at[0]), Y: int32(at[1])}, stand[0], stand[1], 200)
	pinned := x.near(c, campCX, campCY, 200).Wick.Id
	stool := x.carry(s.AccountID, "wooden-stool")
	x.campOp(c, s, &contract.CampRequest{Action: "place", ItemId: stool, X: int32(spots[2][0]), Y: int32(spots[2][1]), Rotation: 90}, stand[0], stand[1], 200)
	x.stack(s.AccountID, "birch-sapling", "", 1)
	x.campOp(c, s, &contract.CampRequest{Action: "plant", ItemDef: "birch-sapling", X: int32(spots[3][0]), Y: int32(spots[3][1])}, stand[0], stand[1], 200)

	held := func(want bool) {
		t.Helper()
		got := nearChunkAt(x.near(c, campCX, campCY, 200), campCX, campCY)
		if (got.Source == location.SourceHeld.String() && got.Epoch == pinned) != want {
			t.Fatalf("held %v: %+v", want, got)
		}
	}
	// Turning 1: the flask burns; the camp holds.
	x.turn()
	c, s = x.again("alice")
	if cs := x.camps(c); len(cs) != 1 || cs[0].Oil != 0 || cs[0].Dimming {
		t.Fatalf("turning 1: %+v", cs)
	}
	held(true)
	// Turning 2: out of oil, it dims for a wick, still held.
	x.turn()
	c, s = x.again("alice")
	if cs := x.camps(c); len(cs) != 1 || !cs[0].Dimming || len(cs[0].Pieces) != 2 {
		t.Fatalf("turning 2: %+v", cs)
	}
	held(true)
	// Turning 3: still empty, it lapses. Nothing is lost.
	x.turn()
	c, s = x.again("alice")
	if cs := x.camps(c); len(cs) != 0 {
		t.Fatalf("turning 3: %+v", cs)
	}
	held(false)
	for _, id := range []string{lamp, stool} {
		if loc, camp := x.itemAt(id); loc != "crate" || camp != nil {
			t.Fatalf("%s: %s", id, loc)
		}
	}
	var plants int
	if err := x.db.DB.QueryRow("SELECT count(*) FROM camp_plants").Scan(&plants); err != nil || plants != 0 {
		t.Fatalf("plants left: %d %v", plants, err)
	}
	got := map[string]int{}
	for _, e := range x.recovery(c) {
		got[e.Kind+":"+e.ItemDef] += int(e.Qty)
		if e.Cx != campCX || e.Cy != campCY {
			t.Fatalf("entry place: %+v", e)
		}
	}
	if len(got) != 3 || got["piece:way-lamp"] != 1 || got["piece:wooden-stool"] != 1 || got["plant:birch-sapling"] != 1 {
		t.Fatalf("alice's crate: %v", got)
	}
	bc, bs = x.again("bob")
	if es := x.recovery(bc); len(es) != 1 || es[0].Kind != "stack" || es[0].ItemDef != "stone" || es[0].Qty != chunks.LayKind("stone").GetCost() {
		t.Fatalf("bob's crate: %+v", es)
	}
	var state string
	if err := x.db.DB.QueryRow("SELECT state FROM recovery_entries WHERE kind='plant'").Scan(&state); err != nil || state == "{}" {
		t.Fatalf("the planting isn't kept: %s %v", state, err)
	}
	// Collected in Pell's office only; once.
	if _, code := x.collect(c, s, "collect-far", false, 409); code != "too-far-away" {
		t.Fatalf("collected from the Wilds: %s", code)
	}
	r, _ := x.collect(c, s, "collect", true, 200)
	if len(r.Collected) != 3 {
		t.Fatalf("collected: %+v", r.Collected)
	}
	again, _ := x.collect(c, s, "collect", true, 200)
	if len(again.Collected) != 3 {
		t.Fatalf("replayed: %+v", again.Collected)
	}
	if more, _ := x.collect(c, s, "collect-again", true, 200); len(more.Collected) != 0 {
		t.Fatalf("collected twice: %+v", more.Collected)
	}
	for _, id := range []string{lamp, stool} {
		if loc, _ := x.itemAt(id); loc != "inventory" {
			t.Fatalf("%s after collecting: %s", id, loc)
		}
	}
	if x.packQty(s.AccountID, "birch-sapling") != 1 || len(x.recovery(c)) != 0 {
		t.Fatal("the sapling")
	}
	x.collect(bc, bs, "bob-collect", true, 200)
	if got := x.packQty(bs.AccountID, "stone"); got != stoneLeft+int(chunks.LayKind("stone").GetCost()) {
		t.Fatalf("bob's stone: %d, had %d", got, stoneLeft)
	}
	// The lamp can be set again.
	x.stack(s.AccountID, "hearth-oil", "", 1)
	spots = x.campSpots(s.WorldID, campCX, campCY)
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], 200)
}

// A top-up while dimming takes the warning back; a setter can take an empty
// camp down, its unspent oil back in their pack.
func TestCampTopUpWhileDimmingAndTakeDown(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID) // setting a way-lamp takes the Keeper's hand
	spots := x.campSpots(s.WorldID, campCX, campCY)
	at, stand := spots[0], spots[1]
	lamp := x.carry(s.AccountID, "way-lamp")
	x.stack(s.AccountID, "hearth-oil", "", 3)
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(at[0]), Y: int32(at[1])}, stand[0], stand[1], 200)
	x.turn()
	c, s = x.again("alice")
	x.turn()
	c, s = x.again("alice")
	if cs := x.camps(c); !cs[0].Dimming {
		t.Fatalf("not dimming: %+v", cs)
	}
	v, _ := x.campOp(c, s, &contract.CampRequest{Action: "fill", Camp: lamp}, stand[0], stand[1], 200)
	if v.Camp.Dimming || v.Camp.Oil != 1 {
		t.Fatalf("topped up: %+v", v.Camp)
	}
	x.turn()
	c, s = x.again("alice")
	if cs := x.camps(c); len(cs) != 1 || cs[0].Dimming || cs[0].Oil != 0 {
		t.Fatalf("after the top-up's turning: %+v", cs)
	}
	x.campOp(c, s, &contract.CampRequest{Action: "fill", Camp: lamp}, stand[0], stand[1], 200)
	before := x.packQty(s.AccountID, "hearth-oil")
	if v, _ := x.campOp(c, s, &contract.CampRequest{Action: "remove", ItemId: lamp}, stand[0], stand[1], 200); v.Camp != nil {
		t.Fatalf("taken down: %+v", v.Camp)
	}
	if loc, _ := x.itemAt(lamp); loc != "inventory" || x.packQty(s.AccountID, "hearth-oil") != before+1 || len(x.camps(c)) != 0 {
		t.Fatal("the lamp and its oil")
	}
	// Its hold goes at the turning, and nothing is crated for it.
	x.turn()
	c, _ = x.again("alice")
	if got := nearChunkAt(x.near(c, campCX, campCY, 200), campCX, campCY); got.Source == location.SourceHeld.String() || len(x.recovery(c)) != 0 {
		t.Fatalf("after the take-down: %+v", got)
	}
}

// The server's own chunks always judge way-lamps.
func TestWayLampHolderRegistered(t *testing.T) {
	a := New(nil, nil, Config{})
	held, ok := a.Config.Epochs.(*store.Chunks)
	if !ok {
		t.Fatalf("epochs %T", a.Config.Epochs)
	}
	if _, ok := held.Holders[wayLampKind].(wayLampHolder); !ok {
		t.Fatalf("holders %v", held.Holders)
	}
}
