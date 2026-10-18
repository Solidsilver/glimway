package api

import (
	"net/http"
	"testing"

	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

func (x *rig) lampNotices(c *http.Cookie) []*contract.LampNotice {
	x.t.Helper()
	w := x.rawHTTP("GET", "/api/lamp-notices", nil, c)
	if w.Code != 200 {
		x.t.Fatalf("lamp notices: %d %s", w.Code, w.Body.String())
	}
	v := &contract.LampNoticesRead{}
	if err := protojson.Unmarshal(w.Body.Bytes(), v); err != nil {
		x.t.Fatal(err)
	}
	return v.Notices
}

func noticeKinds(ns []*contract.LampNotice) []string {
	out := []string{}
	for _, n := range ns {
		out = append(out, n.Kind)
	}
	return out
}

// A light you keep is told once per dimming, from its last wick through its
// guttering one: not on every read, not to
// someone who doesn't keep it, not while you stand by it (you can see it),
// and again only when it dims afresh at a later turning.
func TestLampNoticeOncePerDimming(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID)
	x.claimGate(c, &s, 0)
	x.stack(s.AccountID, "hearth-oil", "", 3)
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	bc, _ := x.member("bob", s.WorldID)
	lamp := x.carry(s.AccountID, "way-lamp")
	spots := x.campSpots(s.WorldID, campCX, campCY)
	stand := spots[1]
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[0][0]), Y: int32(spots[0][1])}, stand[0], stand[1], 200)
	if got := x.lampNotices(c); len(got) != 0 {
		t.Fatal("lit lights told", got)
	}
	// The turning burns the last flask: both start their last wick, which is dimming.
	x.turn()
	c, s = x.again("alice")
	s = x.standAt(c, s, stand[0], stand[1])
	// Standing at the camp: only the lantern behind the lot is told.
	got := x.lampNotices(c)
	if len(got) != 1 || got[0].Kind != lotLanternKind || got[0].Id != "0" {
		t.Fatal(noticeKinds(got), got)
	}
	if bx, by := chunks.BacklandChunk(0); got[0].Cx != int32(bx) || got[0].Cy != int32(by) {
		t.Fatal(got[0])
	}
	if again := x.lampNotices(c); len(again) != 0 {
		t.Fatal("told twice", again)
	}
	// Walking away doesn't bring the camp's back: it was seen there.
	ax, ay := local(2, -1, [2]int{13, 14})
	s = x.standAt(c, s, ax, ay)
	if again := x.lampNotices(c); len(again) != 0 {
		t.Fatal("told after leaving", again)
	}
	// Bob keeps neither.
	bc, _ = x.again("bob")
	if other := x.lampNotices(bc); len(other) != 0 {
		t.Fatal("told a non-keeper", other)
	}
	// The next turning sets both guttering: the same dimming, not told again.
	x.turn()
	c, s = x.again("alice")
	s = x.standAt(c, s, ax, ay)
	if again := x.lampNotices(c); len(again) != 0 {
		t.Fatal("guttering told again", again)
	}
	if cs := x.camps(c); len(cs) != 1 || !cs[0].Dimming {
		t.Fatal("not guttering", cs)
	}
	// Filling it ends this dimming; the next one is told afresh.
	s = x.standAt(c, s, stand[0], stand[1])
	x.campOp(c, s, &contract.CampRequest{Action: "fill", Camp: lamp}, stand[0], stand[1], 200)
	x.turn()
	c, s = x.again("alice")
	x.standAt(c, s, ax, ay)
	// The lot lantern went dark at that turning: no longer told of.
	got = x.lampNotices(c)
	if len(got) != 1 || got[0].Kind != wayLampKind || got[0].Id != lamp || got[0].Cx != campCX || got[0].Cy != campCY {
		t.Fatal(noticeKinds(got), got)
	}
	if again := x.lampNotices(c); len(again) != 0 {
		t.Fatal("told twice", again)
	}
}

// A household member is told of the lot lantern they share.
func TestLampNoticeHousehold(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.claimGate(c, &s, 0)
	x.stack(s.AccountID, "hearth-oil", "", 1)
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	bc, bs := x.member("bob", s.WorldID)
	if _, err := x.db.DB.Exec("INSERT INTO homestead_members SELECT ?,homestead_id,0 FROM homestead_members WHERE account_id=?", bs.AccountID, s.AccountID); err != nil {
		t.Fatal(err)
	}
	x.turn()
	x.camps(c)
	x.turn()
	bc, _ = x.again("bob")
	if got := x.lampNotices(bc); len(got) != 1 || got[0].Kind != lotLanternKind {
		t.Fatal(got)
	}
	// Alice is still by the stake she lit it from: she sees it there.
	c, _ = x.again("alice")
	if got := x.lampNotices(c); len(got) != 0 {
		t.Fatal("told at the stake", got)
	}
}

// The near read's land status says whose a Built claim is, to each reader.
func TestLandStatusKeeper(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID)
	x.claimGate(c, &s, 0)
	x.stack(s.AccountID, "hearth-oil", "", 2)
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	bc, _ := x.member("bob", s.WorldID)
	lamp := x.carry(s.AccountID, "way-lamp")
	spots := x.campSpots(s.WorldID, campCX, campCY)
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], 200)
	setter := x.camps(c)[0].SetterName
	bx, by := chunks.BacklandChunk(0)
	mine := x.mapLand(c, [2]int{campCX, campCY}, [2]int{bx, by})
	theirs := x.mapLand(bc, [2]int{campCX, campCY}, [2]int{bx, by})
	if camp := mine.Chunks[0]; !camp.Yours || camp.Keeper != setter || setter == "" {
		t.Fatal(camp)
	}
	if camp := theirs.Chunks[0]; camp.Yours || camp.Keeper != setter {
		t.Fatal(camp)
	}
	if lot := mine.Chunks[1]; !lot.Yours || lot.Keeper != "" {
		t.Fatal(lot)
	}
	if lot := theirs.Chunks[1]; lot.Yours || lot.Keeper != "" {
		t.Fatal(lot)
	}
}
