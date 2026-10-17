package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"

	"google.golang.org/protobuf/encoding/protojson"
)

// reachColumn is a column whose static frontier's north edge (ey) is
// generated wick land, as are the eight chunks north of it: where camps
// push out.
func reachColumn(t *testing.T) (ex, ey int) {
	t.Helper()
	wild := func(cx, cy int) bool {
		return location.SourceOf(cx, cy).Kind == location.SourceGenerated && wilds.EpochKindAt(cx, cy) == store.EpochWick && wilds.FootprintAt(cx, cy) == nil
	}
	for ex = 2; ex < 12; ex++ {
		for ey = -64; ey < 8 && !wilds.InsideReach(ex, ey); ey++ {
		}
		ok := true
		for d := 0; d <= 8; d++ {
			ok = ok && wild(ex, ey-d)
		}
		if ok {
			return ex, ey
		}
	}
	t.Fatal("no column to push out")
	return
}

// placeOf is an account's saved place, the chunk it stands in, and the
// version it was set at.
func (x *rig) placeOf(account string) (area string, cx, cy int, setAt, version int64) {
	x.t.Helper()
	var px, py float64
	if err := x.db.DB.QueryRow("SELECT p.area,p.x,p.y,p.place_set_version,s.version FROM player_place p JOIN players s ON s.account_id=p.account_id WHERE p.account_id=?", account).Scan(&area, &px, &py, &setAt, &version); err != nil {
		x.t.Fatal(err)
	}
	cx, cy = wilds.ChunkOf(wilds.TileOfPixel(px, py))
	return
}

// Setting a camp on the frontier's edge pushes the frontier out three
// chunks (lamps.md 2.2): the near read names it and reads the land there,
// the map tells its tier, its chunks are made, and a camp set in that slack
// pushes it on. One past the slack stays beyond the frontier.
func TestCampPushesFrontierOut(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID)
	world := s.WorldID
	ex, ey := reachColumn(t)
	x.near(c, ex, ey-1, 409)
	if frontier.Inside(world, ex, ey-1) {
		t.Fatal("past the edge before a camp")
	}
	x.stack(s.AccountID, "hearth-oil", "", 4)
	set := func(cy int, status int) string {
		t.Helper()
		lamp := x.carry(s.AccountID, "way-lamp")
		spots := x.campSpots(world, ex, cy)
		_, code := x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], status)
		return code
	}
	set(ey, 200)
	for d := 1; d <= 3; d++ {
		if !frontier.Inside(world, ex, ey-d) {
			t.Fatalf("%d out isn't in reach", d)
		}
	}
	if frontier.Inside(world, ex, ey-4) {
		t.Fatal("past the slack")
	}
	// The near read names the held key and the wider rect, and reads the slack's land.
	n := x.near(c, ex, ey-2, 200)
	if h := n.Frontier.Held; len(h) != 1 || int(h[0].Cx) != ex || int(h[0].Cy) != ey {
		t.Fatalf("held keys: %+v", h)
	}
	if int(n.Frontier.Rect.MinCy) > ey-3 {
		t.Fatalf("rect: %+v", n.Frontier.Rect)
	}
	if ch := nearChunkAt(n, ex, ey-3); ch == nil || ch.Source != location.SourceGenerated.String() {
		t.Fatalf("the slack's edge chunk: %+v", ch)
	}
	if nearChunkAt(n, ex, ey-4) != nil {
		t.Fatal("listed a chunk past the slack")
	}
	glimpsed := false
	for _, g := range n.Glimpse {
		glimpsed = glimpsed || int(g.Chunk.Cx) == ex && int(g.Chunk.Cy) == ey-4
		if frontier.Inside(world, int(g.Chunk.Cx), int(g.Chunk.Cy)) {
			t.Fatalf("a glimpse in reach: %+v", g.Chunk)
		}
	}
	if !glimpsed {
		t.Fatal("no glimpse past the slack")
	}
	// The map agrees: a tier for the slack, nothing past it.
	m := x.mapLand(c, [2]int{ex, ey - 3}, [2]int{ex, ey - 4})
	if len(m.Chunks) != 1 || int(m.Chunks[0].Chunk.Cy) != ey-3 || m.Chunks[0].Tier != "wild" {
		t.Fatalf("map: %+v", m.Chunks)
	}
	// Chunk loading agrees.
	chunk := func(cy int) error {
		tx, err := x.db.DB.BeginTx(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		_, err = x.api.Config.Chunks.Chunk(context.Background(), tx, world, n.Wick.Id, 0, int32(ex), int32(cy))
		return err
	}
	if err := chunk(ey - 3); err != nil {
		t.Fatal("the slack's chunk:", err)
	}
	if err := chunk(ey - 4); err == nil {
		t.Fatal("made a chunk past the slack")
	}
	// Standing past the slack is beyond the frontier; in it, a camp pushes on.
	far := (ey-4)*24 + 12
	if _, code := x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: x.carry(s.AccountID, "way-lamp"), X: int32(ex*24 + 12), Y: int32(far)}, ex*24+12, far, 409); code != "beyond-frontier" {
		t.Fatalf("set past the slack: %s", code)
	}
	set(ey-3, 200)
	if !frontier.Inside(world, ex, ey-6) || frontier.Inside(world, ex, ey-7) {
		t.Fatal("the second camp's slack")
	}
	x.near(c, ex, ey-6, 200)
	x.near(c, ex, ey-7, 409)
}

// When a camp lapses at the turning, its slack goes. While it dims its reach
// stays. Whoever stood out there comes back on open ground in reach, at a
// new place version (the client follows), with nothing in their pack
// changed, never left past the frontier.
func TestLapsedReachMovesPlayerSafely(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID)
	world := s.WorldID
	ex, ey := reachColumn(t)
	x.stack(s.AccountID, "hearth-oil", "", 1)
	lamp := x.carry(s.AccountID, "way-lamp")
	spots := x.campSpots(world, ex, ey)
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], 200)
	// Alice walks out into the slack and stops there.
	out := x.campSpots(world, ex, ey-2)[0]
	stand := atTile(out[0], out[1])
	if _, err := x.db.DB.Exec("UPDATE player_place SET area=?,x=?,y=? WHERE account_id=?", stand.Area, stand.X, stand.Y, s.AccountID); err != nil {
		t.Fatal(err)
	}
	x.stack(s.AccountID, "hearth-oil", "", 2)
	x.carry(s.AccountID, "wooden-stool")
	// Everything she carries: stacks by kind, and pieces.
	pack := func() string {
		var stacks string
		var pieces int
		if err := x.db.DB.QueryRow("SELECT coalesce(group_concat(d||':'||q),'') FROM (SELECT item_def d,SUM(qty) q FROM item_stacks WHERE location='pack' AND owner=? GROUP BY item_def ORDER BY item_def)", s.AccountID).Scan(&stacks); err != nil {
			t.Fatal(err)
		}
		if err := x.db.DB.QueryRow("SELECT count(*) FROM homestead_items WHERE account_id=? AND location='inventory'", s.AccountID).Scan(&pieces); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprint(stacks, " ", pieces)
	}
	before := pack()
	// Turning 1 burns the flask; turning 2 dims it: still held, still in reach.
	for i := 1; i <= 2; i++ {
		x.turn()
		c, _ = x.again("alice")
		if area, cx, cy, _, _ := x.placeOf(s.AccountID); area != outdoorsArea || cx != ex || cy != ey-2 {
			t.Fatalf("turning %d moved her: %s %d,%d", i, area, cx, cy)
		}
	}
	// Turning 3: it lapses, and the slack with it. Her place is set past
	// every version a report from out there could name.
	_, _, _, _, was := x.placeOf(s.AccountID)
	x.turn()
	c, _ = x.again("alice")
	if frontier.Inside(world, ex, ey-2) {
		t.Fatal("the slack outlived the camp")
	}
	area, cx, cy, setAt, _ := x.placeOf(s.AccountID)
	if area != outdoorsArea || !frontier.Inside(world, cx, cy) || location.SourceOf(cx, cy).Kind != location.SourceGenerated || setAt <= was {
		t.Fatalf("landed %s %d,%d (set at %d, was %d)", area, cx, cy, setAt, was)
	}
	if cx != ex || cy != ey {
		t.Fatalf("not the nearest chunk in reach: %d,%d", cx, cy)
	}
	// On open ground, as the server reads it.
	var px, py float64
	if err := x.db.DB.QueryRow("SELECT x,y FROM player_place WHERE account_id=?", s.AccountID).Scan(&px, &py); err != nil {
		t.Fatal(err)
	}
	tx0, ty0 := wilds.TileOfPixel(px, py)
	tx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	o, err := x.api.openGroundIn(context.Background(), tx, world, cx, cy, nil, x.now.Load())
	if err == nil {
		var ok bool
		ok, err = o.open(context.Background(), tx, tx0-cx*24, ty0-cy*24)
		if err == nil && !ok {
			err = errors.New("not open ground")
		}
	}
	tx.Rollback()
	if err != nil {
		t.Fatal(err)
	}
	if pack() != before {
		t.Fatal("the pack changed")
	}
	// The next sign-in leaves her be.
	x.again("alice")
	if _, _, _, at, _ := x.placeOf(s.AccountID); at != setAt {
		t.Fatal("moved again")
	}
	x.near(c, ex, ey-2, 409)
}

// With no open ground in reach near enough, a stranded player goes where the
// turncap would take them, never left in the drift.
func TestStrandedFarFallsBackToTurncapAnchor(t *testing.T) {
	x := newRig(t)
	_, s := x.ready("alice")
	ex, ey := reachColumn(t)
	far := atTile(ex*24+12, (ey-40)*24+12)
	if _, err := x.db.DB.Exec("UPDATE player_place SET area=?,x=?,y=? WHERE account_id=?", far.Area, far.X, far.Y, s.AccountID); err != nil {
		t.Fatal(err)
	}
	x.again("alice")
	_, use := wayHome(travelHome)
	space, ax, ay, _ := location.Anchor(use.GetTarget())
	var area string
	var px, py float64
	if err := x.db.DB.QueryRow("SELECT area,x,y FROM player_place WHERE account_id=?", s.AccountID).Scan(&area, &px, &py); err != nil {
		t.Fatal(err)
	}
	if area != string(space) || px != ax || py != ay {
		t.Fatalf("landed %s %v,%v; want %s %v,%v", area, px, py, space, ax, ay)
	}
}

// Online when someone else's read makes the turning: her next report from
// the lapsed slack is refused (invalid-position, which the client follows),
// and that refusal already carries her new place in reach.
func TestLapsedReachRefusesReportAndMoves(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID)
	world := s.WorldID
	bc, _ := x.member("bob", world)
	ex, ey := reachColumn(t)
	x.stack(s.AccountID, "hearth-oil", "", 1)
	lamp := x.carry(s.AccountID, "way-lamp")
	spots := x.campSpots(world, ex, ey)
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], 200)
	// The flask burns, then the lamp dims.
	x.turn()
	bc, _ = x.again("bob")
	x.camps(bc)
	x.turn()
	bc, _ = x.again("bob")
	x.camps(bc)
	out := x.campSpots(world, ex, ey-2)[0]
	stand := atTile(out[0], out[1])
	if _, err := x.db.DB.Exec("UPDATE player_place SET area=?,x=?,y=? WHERE account_id=?", stand.Area, stand.X, stand.Y, s.AccountID); err != nil {
		t.Fatal(err)
	}
	c = x.login("alice", "")
	w := x.rawHTTP("POST", "/api/play", map[string]any{"clientId": "tab-a", "takeOver": true}, c)
	var p contract.PlayResponse
	if e := protojson.Unmarshal(w.Body.Bytes(), &p); e != nil || w.Code != 200 {
		t.Fatal(w.Code, w.Body.String(), e)
	}
	// Bob's read makes the turning: the camp lapses.
	x.turn()
	bc, _ = x.again("bob")
	x.camps(bc)
	if frontier.Inside(world, ex, ey-2) {
		t.Fatal("the slack outlived the camp")
	}
	c = x.login("alice", "") // a week on: her session cookie, not a new play
	req := &contract.ReportRequest{Lease: p.Lease, Client: "tab-a", Generation: p.ReportGeneration, Seq: 1, Basis: p.State.Version, Hp: p.State.Vitals.Hp, Mana: p.State.Vitals.Mana, Place: stand}
	raw, _ := protojson.Marshal(req)
	w = x.rawHTTP("POST", "/api/report", json.RawMessage(raw), c)
	var env contract.Refusal
	if w.Code != 409 || protojson.Unmarshal(w.Body.Bytes(), &env) != nil || env.GetError().GetCode() != "invalid-position" {
		t.Fatalf("report from the lapsed slack: %d %s", w.Code, w.Body.String())
	}
	if area, cx, cy, _, _ := x.placeOf(s.AccountID); area != outdoorsArea || !frontier.Inside(world, cx, cy) {
		t.Fatalf("still out there: %s %d,%d", area, cx, cy)
	}
	if env.State == nil || env.State.Version <= p.State.Version {
		t.Fatal("the refusal's state isn't the moved one")
	}
}
