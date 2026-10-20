package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"

	"google.golang.org/protobuf/encoding/protojson"
)

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

// putAt saves an account's place at the middle of chunk (cx, cy), as a
// report that walked there would.
func (x *rig) putAt(account string, cx, cy int) {
	x.t.Helper()
	w := atTile(cx*24+12, cy*24+12)
	if _, err := x.db.DB.Exec("UPDATE player_place SET area=?,x=?,y=? WHERE account_id=?", w.Area, w.X, w.Y, account); err != nil {
		x.t.Fatal(err)
	}
}

// refusal asserts a read is refused 409 with code want.
func (x *rig) refusal(path string, c *http.Cookie, want string) {
	x.t.Helper()
	w := x.rawHTTP("GET", path, nil, c)
	var env contract.Refusal
	if w.Code != 409 || protojson.Unmarshal(w.Body.Bytes(), &env) != nil || env.GetError().GetCode() != want {
		x.t.Fatalf("GET %s: %d %s; want 409 %s", path, w.Code, w.Body.String(), want)
	}
}

// Walking any way (0.14): far south, east, west and north of Hearthwick,
// and at the border's corners, the near read answers round whoever stands
// there, and the land is made.
func TestNearReadsFarFromHome(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	b := wilds.BorderChunks()
	for _, at := range [][2]int{{0, 40}, {0, 400}, {300, 0}, {-300, 9}, {5, -300}, {b, b}, {-b, -b}} {
		x.putAt(s.AccountID, at[0], at[1])
		n := x.near(c, at[0], at[1], 200)
		ch := nearChunkAt(n, at[0], at[1])
		if ch == nil || ch.Source != location.SourceGenerated.String() {
			t.Fatalf("%v: %+v", at, ch)
		}
		if r := n.Border.GetRect(); int(r.MinCx) != -b || int(r.MaxCy) != b {
			t.Fatalf("border %+v", r)
		}
		x.chunk(c, ch.Epoch, 0, at[0], at[1], 200)
	}
}

// Reads answer only round the reader: a near read centres within sightLag
// chunks of the saved place, a chunk read within sightChunks. Past the
// border nothing answers.
func TestReadsOnlyWithinSight(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	const cx, cy = 20, 60
	x.putAt(s.AccountID, cx, cy)
	n := x.near(c, cx+sightLag, cy-sightLag, 200)
	x.refusal("/api/wilds/near/"+itoa(cx+sightLag+1)+"/60", c, "beyond-sight")
	x.refusal("/api/wilds/near/20/"+itoa(cy-sightLag-1), c, "beyond-sight")
	x.chunk(c, n.Wick.Id, 0, cx+sightChunks, cy, 200)
	x.refusal("/api/wilds/chunk/"+n.Wick.Id+"/0/"+itoa(cx+sightChunks+1)+"/60", c, "beyond-sight")
	x.refusal("/api/wilds/chunk/"+n.Wick.Id+"/0/20/-60", c, "beyond-sight")
	// Past the border, refused as such.
	b := wilds.BorderChunks()
	x.putAt(s.AccountID, b, 0)
	x.near(c, b, 0, 200)
	x.refusal("/api/wilds/near/"+itoa(b+1)+"/0", c, "beyond-border")
}

// A held chunk reads from anywhere: it is the world's lasting land.
func TestHeldChunkReadsFromAnywhere(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	const cx, cy = 4, -8
	x.putAt(s.AccountID, cx, cy)
	n := x.near(c, cx, cy, 200)
	tx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = x.api.Config.Chunks.(*store.Chunks).Hold(context.Background(), tx, s.WorldID, cx, cy, "test-hold", "0", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	x.putAt(s.AccountID, 200, 200)
	x.chunk(c, n.Wick.Id, 0, cx, cy, 200)
	x.refusal("/api/wilds/chunk/"+n.Wick.Id+"/0/4/-7", c, "beyond-sight")
}

// A saved place past the border (a save from before it, or content that
// narrowed it) comes back on open ground just inside, at a new place
// version (the client follows), never left out there.
func TestPastBorderMovesInside(t *testing.T) {
	x := newRig(t)
	_, s := x.ready("alice")
	b := wilds.BorderChunks()
	x.putAt(s.AccountID, 3, b+3)
	_, _, _, was, _ := x.placeOf(s.AccountID)
	x.again("alice")
	area, cx, cy, setAt, _ := x.placeOf(s.AccountID)
	if area != outdoorsArea || !wilds.InsideBorder(cx, cy) || cy < b-settleSearch || setAt <= was {
		t.Fatalf("landed %s %d,%d (set at %d, was %d)", area, cx, cy, setAt, was)
	}
	var movedAt int64
	if err := x.db.DB.QueryRow("SELECT place_moved_version FROM player_place WHERE account_id=?", s.AccountID).Scan(&movedAt); err != nil || movedAt != setAt {
		t.Fatalf("moved at %d, set at %d (%v)", movedAt, setAt, err)
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
	o, err := x.api.openGroundIn(context.Background(), tx, s.WorldID, cx, cy, nil, x.now.Load())
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
	// The next sign-in leaves her be.
	x.again("alice")
	if _, _, _, at, _ := x.placeOf(s.AccountID); at != setAt {
		t.Fatal("moved again")
	}
}

// A report from past the border is refused (invalid-position); one from far
// inside it, past the old 1e6-pixel bound, is kept.
func TestReportsReachTheBorder(t *testing.T) {
	x := newRig(t)
	c := x.login("alice", "")
	w := x.rawHTTP("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c)
	var p contract.PlayResponse
	if e := protojson.Unmarshal(w.Body.Bytes(), &p); e != nil || w.Code != 200 {
		t.Fatal(w.Code, w.Body.String(), e)
	}
	b := wilds.BorderChunks()
	if float64((b-1)*24*16) <= 1e6 {
		t.Fatal("the test doesn't pass the old bound")
	}
	report := func(seq float64, cx, cy int) (int, string) {
		req := &contract.ReportRequest{Lease: p.Lease, Client: "tab-a", Generation: p.ReportGeneration, Seq: seq, Basis: p.State.Version, Hp: p.State.Vitals.Hp, Mana: p.State.Vitals.Mana, Place: atTile(cx*24+12, cy*24+12)}
		raw, _ := protojson.Marshal(req)
		r := x.rawHTTP("POST", "/api/report", json.RawMessage(raw), c)
		return r.Code, r.Body.String()
	}
	if code, body := report(1, b-1, 7); code != 200 {
		t.Fatalf("report near the border: %d %s", code, body)
	}
	if code, body := report(2, b+1, 7); code != 409 {
		t.Fatalf("report past the border: %d %s", code, body)
	}
}

// The map is a window (0.14): asked for glimpses, it names the chunks
// within map.glimpseChunks of the reader, clipped to the border, and a
// glimpse of each generated one.
func TestMapWindowRoundTheReader(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	ask := func() *contract.WildsMapStatus {
		t.Helper()
		w := x.rawHTTP("POST", "/api/wilds/map", map[string]any{"glimpse": true}, c)
		if w.Code != 200 {
			t.Fatalf("map: %d %s", w.Code, w.Body.String())
		}
		out := &contract.WildsMapStatus{}
		if err := protojson.Unmarshal(w.Body.Bytes(), out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	x.putAt(s.AccountID, 100, 200)
	m := ask()
	if r := m.Window; r == nil || r.MinCx != 68 || r.MaxCx != 132 || r.MinCy != 168 || r.MaxCy != 232 {
		t.Fatalf("window %+v", m.Window)
	}
	if len(m.Glimpse) != 65*65 {
		t.Fatalf("%d glimpses", len(m.Glimpse))
	}
	for _, g := range m.Glimpse {
		if g.Land == "" {
			t.Fatalf("no land at %+v", g.Chunk)
		}
	}
	b := wilds.BorderChunks()
	x.putAt(s.AccountID, b-1, -b)
	if r := ask().Window; r.MaxCx != int32(b) || r.MinCy != int32(-b) || r.MinCx != int32(b-33) {
		t.Fatalf("window at the border %+v", r)
	}
	// Without asking, no window.
	if m := x.mapLand(c); m.Window != nil || len(m.Glimpse) != 0 {
		t.Fatal("a window nobody asked for")
	}
}
