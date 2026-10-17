package api

// Regressions for the 0.12 server review (Codex reviews A and B, 2026-10-17):
// the weekly turning judged once per boundary, claims told apart by place,
// and nothing a player placed or paid for lost (roadmap rules 3 and 4).

import (
	"testing"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// A4: three turnings pass with nobody in the world. Each is judged in
// order: the one wick of oil burns at the first, the lamp dims at the
// second, and the camp lapses into a crate at the third.
func TestMissedTurningsJudgedInOrder(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID)
	spots := x.campSpots(s.WorldID, campCX, campCY)
	lamp := x.carry(s.AccountID, "way-lamp")
	x.stack(s.AccountID, "hearth-oil", "", 1)
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], 200)
	x.turn()
	x.turn()
	c, _ = x.again("alice")
	if cs := x.camps(c); len(cs) != 1 || cs[0].Oil != 0 || !cs[0].Dimming {
		t.Fatalf("two missed turnings: want one dimming camp, got %v", cs)
	}
	x.turn()
	c, _ = x.again("alice")
	if cs := x.camps(c); len(cs) != 0 {
		t.Fatalf("after three missed turnings want a lapsed camp, got oil=%d dimming=%v", cs[0].Oil, cs[0].Dimming)
	}
	if x.crated(s.AccountID, "way-lamp") != 1 {
		t.Fatal("the lapsed camp's lamp is not in a crate")
	}
	// Each boundary is judged once: reading again judges nothing more.
	var cursor int64
	if err := x.db.DB.QueryRow("SELECT judged_through FROM wick_turnings WHERE world_id=?", s.WorldID).Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	if want := content.CalendarAt(content.CalendarRules, x.now.Load()).StartsAt; cursor != want {
		t.Fatalf("turning cursor %d, want %d", cursor, want)
	}
}

// A2, B2: a lamp taken down and set again elsewhere in the same wick is a
// new camp. The old place's released hold packs only what it held (its
// path), never the new camp, and their crates don't collide.
func TestRelocatedCampKeepsItsNewPlace(t *testing.T) {
	for _, paths := range []bool{false, true} {
		t.Run(map[bool]string{false: "pieces", true: "paths"}[paths], func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.keeper(s.AccountID)
			old, next := x.campSpots(s.WorldID, 2, -4), x.campSpots(s.WorldID, 3, -4)
			lamp := x.carry(s.AccountID, "way-lamp")
			x.stack(s.AccountID, "hearth-oil", "", 2)
			x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(old[0][0]), Y: int32(old[0][1])}, old[1][0], old[1][1], 200)
			if paths {
				x.give(s.AccountID, "stone", 2)
				x.pathOp(c, s, "lay", "old-path", old[4][0], old[4][1], old[4][0], old[4][1], "stone", 200)
			}
			x.campOp(c, s, &contract.CampRequest{Action: "remove", ItemId: lamp}, old[1][0], old[1][1], 200)
			x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(next[0][0]), Y: int32(next[0][1])}, next[1][0], next[1][1], 200)
			if paths {
				x.pathOp(c, s, "lay", "new-path", next[4][0], next[4][1], next[4][0], next[4][1], "stone", 200)
			}
			x.turn()
			if w := x.rawHTTP("GET", "/api/camps", nil, c); w.Code != 200 {
				t.Fatalf("turning request status=%d body=%s logs=%s", w.Code, w.Body.String(), x.logs.String())
			}
			cs := x.camps(c)
			if len(cs) != 1 || cs[0].Cx != 3 || cs[0].Cy != -4 {
				t.Fatalf("the relocated camp was packed: camps=%v lamp crate=%d", cs, x.crated(s.AccountID, "way-lamp"))
			}
			if x.crated(s.AccountID, "way-lamp") != 0 {
				t.Fatal("the standing lamp is in a crate")
			}
			if loc, camp := x.itemAt(lamp); loc != "camp" || camp == nil || *camp != lamp {
				t.Fatalf("lamp at %s", loc)
			}
			if paths {
				if got := x.crated(s.AccountID, "stone"); got < 1 {
					t.Fatalf("the old place's path stone was not refunded: %d", got)
				}
				var held int
				if err := x.db.DB.QueryRow("SELECT count(*) FROM holds WHERE world_id=? AND cx=3 AND cy=-4", s.WorldID).Scan(&held); err != nil || held != 1 {
					t.Fatalf("the new camp's hold: %d %v", held, err)
				}
			}
		})
	}
}

// A5: a lot lantern dimming with no oil is due to lapse at the next
// turning. A flask poured after that turning, before anything else read
// the world, can't pay the old wick's bill: the turning is judged first.
func TestLateLotTopUpDoesNotRescueLapsedHold(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimGate(c, &s, 0)
	x.stack(s.AccountID, "hearth-oil", "", 3)
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	x.turn()
	c, s = x.again("alice")
	x.turn()
	c, s = x.again("alice")
	if !x.lanternOf(0, s.WorldID).Dimming {
		t.Fatal("setup must be dimming")
	}
	x.now.Store(content.CalendarAt(content.CalendarRules, x.now.Load()).NextTurning - 60)
	c, s = x.again("alice")
	x.turn()
	req := &contract.HomesteadRequest{Op: opHeader(s.Lease, "late-fuel"), Where: tileWhere(sx, sy), Gate: wrapperspb.Int32(0)}
	raw, _ := protojson.Marshal(req)
	if w := x.rawHTTP("POST", "/api/homestead/lantern", raw, c); w.Code != 200 {
		t.Fatalf("lot fill: %d %s", w.Code, w.Body.String())
	}
	// The flask relit the lantern on the new wick's land: a fresh hold.
	var since int64
	if err := x.db.DB.QueryRow("SELECT since FROM holds WHERE world_id=? AND holder_kind='lot-lantern' AND holder_id='0'", s.WorldID).Scan(&since); err != nil {
		t.Fatal(err)
	}
	if boundary := content.CalendarAt(content.CalendarRules, x.now.Load()).StartsAt; since < boundary {
		t.Fatalf("post-boundary fuel rescued a hold due to lapse (since=%d, boundary=%d)", since, boundary)
	}
}

// A6: a communal post in a chunk an oil-funded camp keeps stays under
// that camp, whatever the unserved new wick would put on its tile.
func TestCommunalPostUnderHoldStays(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID)
	spots := x.campSpots(s.WorldID, 2, -4)
	post := x.carry(s.AccountID, "way-lamp")
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "post", ItemId: post, X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], 200)
	lamp := x.carry(s.AccountID, "way-lamp")
	x.stack(s.AccountID, "hearth-oil", "", 3)
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[2][0]), Y: int32(spots[2][1])}, spots[1][0], spots[1][1], 200)
	var pinned string
	if err := x.db.DB.QueryRow("SELECT epoch_id FROM holds WHERE holder_id=?", lamp).Scan(&pinned); err != nil {
		t.Fatal(err)
	}
	lx, ly := uint32(spots[0][0]-2*24), uint32(spots[0][1]+4*24)
	x.gen.Edit = func(e *contract.WildsEpoch, m *contract.WorldChunk) {
		if e.Id != pinned && m.Cx == 2 && m.Cy == -4 {
			m.Entities = append(m.Entities, &contract.WildsEntity{Id: "poi:2:-4:9", Kind: "poi", Tx: lx, Ty: ly, Poi: content.WildsRules.PoiIds[0]})
		}
	}
	x.turn()
	c, _ = x.again("alice")
	if ls := x.lamps(c); len(ls) != 1 {
		t.Fatalf("post on unchanged held terrain was crated: lamps=%d crated=%d", len(ls), x.crated(s.AccountID, "way-lamp"))
	}
}

// A3: a lost deed packs everything on the land into a crate at Pell's for
// the last member out: the backland's pieces and the lantern's unspent
// oil too. It waits there after the home has gone.
func TestLostDeedCratesTheLot(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	h := x.claimGate(c, &s, 0)
	x.stack(s.AccountID, "hearth-oil", "", 3)
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	spots := x.backlandSpots(s.WorldID, 0)
	stool := x.carry(s.AccountID, "wooden-stool")
	ox, oy := chunks.LotOrigin(0)
	x.homeOpRefreshing(c, &s, "place", map[string]any{"itemId": stool, "scene": "outdoor", "x": spots[0][0], "y": spots[0][1], "rotation": 0, "progress": standAt(s, "outdoors", ox+spots[1][0], oy+spots[1][1])}, 200)
	if _, err := x.db.DB.Exec("INSERT INTO item_stacks(location,owner,item_def,maker_id,qty) VALUES('storage',?,'stone','',4)", h.ID); err != nil {
		t.Fatal(err)
	}
	axe := x.instance(s.AccountID, "bench-axe", -1, "")
	if _, err := x.db.DB.Exec("UPDATE item_instances SET location='storage',owner=? WHERE id=?", h.ID, axe); err != nil {
		t.Fatal(err)
	}
	x.homeOpRefreshing(c, &s, "leave", nil, 200)
	x.now.Add(int64(content.HomeRules.GetDesolation().GetDeedLostAfterDays()) * 86400)
	c, _ = x.again("alice")
	x.exp("GET", "/api/commons", nil, c, 200)
	if n := count(t, x.db, "SELECT count(*) FROM homesteads WHERE id=?", h.ID); n != 0 {
		t.Fatal("the deed was not lost")
	}
	if loc, _ := x.itemAt(stool); loc != "crate" {
		t.Fatalf("backland stool at %s", loc)
	}
	if x.crated(s.AccountID, "wooden-stool") != 1 || x.crated(s.AccountID, "stone") != 4 {
		t.Fatalf("crate: stool=%d stone=%d", x.crated(s.AccountID, "wooden-stool"), x.crated(s.AccountID, "stone"))
	}
	if x.crated(s.AccountID, "hearth-oil") == 0 {
		t.Fatal("no unspent lantern oil reached the crate")
	}
	if x.crated(s.AccountID, "bench-axe") != 1 {
		t.Fatal("the chest's axe is not in the crate")
	}
	// Pell says why, and hands it all over once.
	c, s = x.again("alice")
	for _, e := range x.recovery(c) {
		if e.Reason != reasonDeedLost {
			t.Fatalf("entry %s reason %q", e.ItemDef, e.Reason)
		}
	}
	x.collect(c, s, "collect-deed", true, 200)
	if loc, _ := x.itemAt(stool); loc != "inventory" {
		t.Fatalf("collected stool at %s", loc)
	}
	var where, owner string
	if err := x.db.DB.QueryRow("SELECT location,owner FROM item_instances WHERE id=?", axe).Scan(&where, &owner); err != nil || where != "pack" || owner != s.AccountID {
		t.Fatalf("collected axe at %s of %s (%v)", where, owner, err)
	}
	if x.packQty(s.AccountID, "stone") != 4 || x.crated(s.AccountID, "stone") != 0 {
		t.Fatalf("collected stone: %d", x.packQty(s.AccountID, "stone"))
	}
}

// B3: taking a camp down leaves its hold released until the turning.
// The map and near reads of that chunk still answer.
func TestMapAfterCampTakenDown(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID)
	lamp := x.carry(s.AccountID, "way-lamp")
	x.stack(s.AccountID, "hearth-oil", "", 1)
	spots := x.campSpots(s.WorldID, campCX, campCY)
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], 200)
	x.campOp(c, s, &contract.CampRequest{Action: "remove", ItemId: lamp}, spots[1][0], spots[1][1], 200)
	m := x.mapLand(c, [2]int{campCX, campCY})
	if len(m.Chunks) != 1 || m.Chunks[0].Tier != "built" || m.Chunks[0].NextTurning != "released" {
		t.Fatalf("released camp land: %v", m.Chunks)
	}
	for _, l := range m.Lamps {
		if l.Kind == wayLampKind {
			t.Fatal("a lamp taken down still shows", l)
		}
	}
	if w := x.rawHTTP("GET", "/api/wilds/near/2/-4", nil, c); w.Code != 200 {
		t.Fatalf("near after taking down: %d %s", w.Code, w.Body.String())
	}
}

// B8: a camp can't be set on a communal post, and nothing is spent.
func TestCampRefusedOnCommunalPost(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID)
	post := x.carry(s.AccountID, "way-lamp")
	lamp := x.carry(s.AccountID, "way-lamp")
	stool := x.carry(s.AccountID, "wooden-stool")
	x.stack(s.AccountID, "hearth-oil", "", 1)
	spots := x.campSpots(s.WorldID, campCX, campCY)
	at, stand := spots[0], spots[1]
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "post", ItemId: post, X: int32(at[0]), Y: int32(at[1])}, stand[0], stand[1], 200)
	if _, code := x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(at[0]), Y: int32(at[1])}, stand[0], stand[1], 409); code != "placement-overlap" {
		t.Fatalf("camp on a post: %s", code)
	}
	if x.packQty(s.AccountID, "hearth-oil") != 1 {
		t.Fatal("the refused camp spent oil")
	}
	// Set beside it, the camp's pieces can't go on the post either.
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[2][0]), Y: int32(spots[2][1])}, stand[0], stand[1], 200)
	if _, code := x.campOp(c, s, &contract.CampRequest{Action: "place", ItemId: stool, X: int32(at[0]), Y: int32(at[1])}, stand[0], stand[1], 409); code != "placement-overlap" {
		t.Fatalf("piece on a post: %s", code)
	}
}

// A keeper's pack-up is no lapse: every entry says the camp was packed up
// (Pell doesn't tell them the woods turned), and what wasn't theirs still
// names them as the keeper who moved it.
func TestCampPackUpReason(t *testing.T) {
	x := newClaimRig(t)
	bob := x.bob.s.AccountID
	x.rule(x.alice, "everyone", nil, 200)
	bobs := x.carry(bob, "wooden-stool")
	x.op(x.bob, &contract.CampRequest{Action: "place", ItemId: bobs, X: int32(x.spots[3][0]), Y: int32(x.spots[3][1])}, 200)
	x.op(x.alice, &contract.CampRequest{Action: "pack", Camp: x.lamp}, 200)
	if n := count(t, x.db, "SELECT count(*) FROM recovery_entries WHERE reason<>'packed-up'"); n != 0 {
		t.Fatalf("%d pack-up entries without the reason", n)
	}
	if n := count(t, x.db, "SELECT count(*) FROM recovery_entries WHERE account_id=? AND json_extract(state,'$.movedBy')=?", bob, x.alice.s.AccountID); n != 1 {
		t.Fatalf("bob's stool doesn't name the keeper: %d", n)
	}
}

// Everyone at a camp reads whose each plant and piece is by name, not only
// its keeper: a builder sees the keeper's lamp and another builder's plant.
func TestCampReadNamesPlantersForEveryone(t *testing.T) {
	x := newClaimRig(t)
	x.rule(x.alice, "everyone", nil, 200)
	x.stack(x.bob.s.AccountID, "birch-sapling", "", 1)
	x.op(x.bob, &contract.CampRequest{Action: "plant", ItemDef: "birch-sapling", X: int32(x.spots[4][0]), Y: int32(x.spots[4][1])}, 200)
	var bob, alice string
	if err := x.db.DB.QueryRow("SELECT display_name FROM players WHERE account_id=?", x.bob.s.AccountID).Scan(&bob); err != nil {
		t.Fatal(err)
	}
	if err := x.db.DB.QueryRow("SELECT display_name FROM players WHERE account_id=?", x.alice.s.AccountID).Scan(&alice); err != nil {
		t.Fatal(err)
	}
	cs := x.camps(x.carol.c)
	if len(cs) != 1 || len(cs[0].Plants) != 1 || len(cs[0].Pieces) != 1 {
		t.Fatalf("carol's camp read: %v", cs)
	}
	if got := cs[0].Plants[0].OwnerName; got != capDonor(bob) || got == "" {
		t.Fatalf("plant planter for a non-keeper: %q, want %q", got, capDonor(bob))
	}
	if got := cs[0].Pieces[0].OwnerName; got != capDonor(alice) || got == "" {
		t.Fatalf("lamp owner for a non-keeper: %q", got)
	}
	if len(cs[0].Members) != 0 || cs[0].Rule != "" {
		t.Fatal("a non-keeper reads the camp's rule")
	}
}
