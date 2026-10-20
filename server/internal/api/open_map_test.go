package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"sync"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks/fakegen"
	"glimway/server/internal/fights"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"glimway/server/internal/wildsgen"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// The open map's operations (open-map.md 2.4, 2.10, section 3), against the
// test generator (chunks/fakegen): every chunk has a thicket, a fallen
// trunk, a boulder and a fern at fixed tiles, water, a ford and paving, and
// each place cell's middle chunk a landmark at (10, 10).

// tileWhere is the world-pixel `where` standing on a world tile.
func tileWhere(tx, ty int) *contract.Where { return atTile(tx, ty) }

// local is a chunk-local tile in world tiles.
func local(cx, cy int, t [2]int) (int, int) { return cx*24 + t[0], cy*24 + t[1] }

// pathOp posts a clear, lay or lift standing on (sx, sy) at the tile (tx, ty).
func (x *rig) pathOp(c *http.Cookie, s response, op string, key string, sx, sy, tx, ty int, kind string, status int, epochs ...string) (*contract.Envelope, string) {
	x.t.Helper()
	where := tileWhere(sx, sy)
	h := opHeader(s.Lease, key)
	epoch := "outside"
	if len(epochs) > 0 {
		epoch = epochs[0]
	} else if wildsWhereInside(tileWhere(tx, ty)) {
		dbtx, err := x.db.DB.BeginTx(context.Background(), nil)
		if err != nil {
			x.t.Fatal(err)
		}
		defer dbtx.Rollback()
		e, err := x.api.epochAt(context.Background(), dbtx, s.WorldID, wilds.FloorDiv(tx, 24), wilds.FloorDiv(ty, 24), x.now.Load())
		if err != nil {
			x.t.Fatal(err)
		}
		epoch = e.Id
		if err = dbtx.Commit(); err != nil {
			x.t.Fatal(err)
		}
	}
	var req proto.Message
	switch op {
	case "clear":
		req = &contract.WildsClearRequest{Op: h, Where: where, Epoch: epoch, X: int32(tx), Y: int32(ty)}
	case "lay":
		req = &contract.WildsLayRequest{Op: h, Where: where, Epoch: epoch, X: int32(tx), Y: int32(ty), Kind: kind}
	case "lift":
		req = &contract.WildsLiftRequest{Op: h, Where: where, Epoch: epoch, X: int32(tx), Y: int32(ty)}
	}
	return x.call("/api/wilds/"+op, req, c, status)
}

func opHeader(lease, key string) *contract.OpHeader { return op(lease, key) }

func groundAt(g *contract.ChunkGroundChanges, lx, ly int) *contract.GroundChange {
	for _, c := range g.GetChanges().GetChanges() {
		if int(c.Tx) == lx && int(c.Ty) == ly {
			return c
		}
	}
	return nil
}

// Clearing (decision 7): a thicket with a spade, a fallen trunk with an
// axe; free, yields nothing, refused on anything else and outside reach or
// the frontier.
func TestWildsClear(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	cx, cy := 2, -4 // a wick chunk of the Beyond
	thx, thy := local(cx, cy, fakegen.Thicket)
	lgx, lgy := local(cx, cy, fakegen.Log)
	stand := func(tx, ty int) (int, int) { return tx, ty + 1 }
	sx, sy := stand(thx, thy)
	refuse := func(key string, tx, ty int, want string) {
		t.Helper()
		_, code := x.pathOp(c, s, "clear", key, tx, ty+1, tx, ty, "", 409)
		if code != want {
			t.Fatalf("%s: %s, want %s", key, code, want)
		}
	}
	refuse("no-spade", thx, thy, "wrong-tool")
	x.instance(s.AccountID, "bench-spade", -1, "")
	refuse("trunk-needs-axe", lgx, lgy, "wrong-tool")
	bx, by := local(cx, cy, fakegen.Boulder)
	refuse("boulder", bx, by, "not-clearable")
	fx, fy := local(cx, cy, fakegen.Fern)
	refuse("fern", fx, fy, "not-clearable")
	refuse("open-ground", thx, thy+1, "not-clearable")
	if _, code := x.pathOp(c, s, "clear", "far", sx+5, sy, thx, thy, "", 409); code != "too-far-away" {
		t.Fatal(code)
	}
	ledger := count(t, x.db, "SELECT count(*) FROM ledger")
	// A successful clear must invalidate the loaded campless/room ground only
	// after its keyed transaction commits.
	epochTx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	epoch, err := x.api.epochAt(context.Background(), epochTx, s.WorldID, cx, cy, x.now.Load())
	if err != nil {
		epochTx.Rollback()
		t.Fatal(err)
	}
	epochTx.Rollback()
	location := fightLocation{world: s.WorldID, realm: content.WildsRules.GetRealm(), cx: int32(cx), cy: int32(cy)}
	key := fights.Key{World: s.WorldID, Realm: location.realm, Epoch: epoch.Id, CX: int32(cx), CY: int32(cy)}
	x.api.presence.mu.Lock()
	x.api.presence.setFightLocationLocked(location, fightLocationEpoch{key: key})
	x.api.presence.mu.Unlock()
	env, _ := x.pathOp(c, s, "clear", "thicket", sx, sy, thx, thy, "", 200)
	x.api.presence.mu.Lock()
	_, cachedAfterClear := x.api.presence.fightLocations[location]
	x.api.presence.mu.Unlock()
	if cachedAfterClear {
		t.Fatal("successful clear kept old fight ground cached")
	}
	got := env.GetWildsClear()
	if ch := groundAt(got.Ground, fakegen.Thicket[0], fakegen.Thicket[1]); ch == nil || ch.Change != "cleared" || ch.By != s.AccountID || got.Ground.Chunk.Cx != int32(cx) || got.Ground.Chunk.Cy != int32(cy) || got.Ground.Epoch == "" {
		t.Fatal("cleared", got)
	}
	if count(t, x.db, "SELECT count(*) FROM ledger") != ledger {
		t.Fatal("clearing yielded something")
	}
	replay, _ := x.pathOp(c, s, "clear", "thicket", sx, sy, thx, thy, "", 200)
	if !proto.Equal(replay.GetWildsClear(), got) {
		t.Fatal("replay")
	}
	refuse("again", thx, thy, "already-cleared")
	x.instance(s.AccountID, "bench-axe", -1, "")
	x.pathOp(c, s, "clear", "trunk", sx, sy, lgx, lgy, "", 200)
	// The near read carries the chunk's changes, under the wick epoch.
	n := x.near(c, cx, cy, 200)
	if len(n.Ground) != 1 || n.Ground[0].Epoch != n.Wick.Id || len(n.Ground[0].Changes.Changes) != 2 {
		t.Fatal("near ground", n.Ground)
	}
	// Past the border: the where itself is refused.
	past := (wilds.BorderChunks()+1)*24 + 1
	if _, code := x.pathOp(c, s, "clear", "beyond", past, -10, past, -11, "", 409); code != "beyond-border" {
		t.Fatal(code)
	}
	// Water, fords and paving can't be cleared, nor an entity's tile.
	wx, wy := local(cx, cy, fakegen.Water)
	if _, code := x.pathOp(c, s, "clear", "water", wx, wy-1, wx, wy, "", 409); code != "not-clearable" {
		t.Fatal(code)
	}
	ex, ey := local(cx, cy, fakegen.Camp)
	if _, code := x.pathOp(c, s, "clear", "camp", ex, ey+1, ex, ey, "", 409); code != "not-clearable" {
		t.Fatal(code)
	}
}

// Laying and lifting (decisions 5, 7, 12): stone for 1 stone, plank for 1
// timber, on walkable land only; lifting refunds only your own tile, and a
// tile that needed clearing stays cleared.
func TestWildsLayAndLift(t *testing.T) {
	x := newRig(t)
	x.hero("alice", "Alice", "")
	c, s := x.ready("alice")
	x.hero("bob", "Bob", "")
	bc, b := x.member("bob", s.WorldID)
	cx, cy := -3, -2
	ox, oy := local(cx, cy, [2]int{3, 14}) // open woods
	if _, code := x.pathOp(c, s, "lay", "broke", ox, oy+1, ox, oy, "stone", 409); code != "insufficient-materials" {
		t.Fatal(code)
	}
	x.give(s.AccountID, "stone", 3)
	x.give(s.AccountID, "timber", 1)
	if _, code := x.pathOp(c, s, "lay", "bad-kind", ox, oy+1, ox, oy, "gravel", 400); code != "invalid-request" {
		t.Fatal(code)
	}
	for _, tc := range []struct {
		name string
		t    [2]int
	}{{"water", fakegen.Water}, {"ford", fakegen.Ford}, {"paving", fakegen.Road}, {"thicket", fakegen.Thicket}, {"boulder", fakegen.Boulder}, {"chest", fakegen.Chest}} {
		tx, ty := local(cx, cy, tc.t)
		if _, code := x.pathOp(c, s, "lay", "on-"+tc.name, tx, ty-1, tx, ty, "stone", 409); code != "cannot-lay-here" {
			t.Fatal(tc.name, code)
		}
	}
	env, _ := x.pathOp(c, s, "lay", "stone", ox, oy+1, ox, oy, "stone", 200)
	lay := env.GetWildsLay()
	if ch := groundAt(lay.Ground, 3, 14); ch == nil || ch.Change != "stone" || lay.Materials["stone"] != 2 || x.packQty(s.AccountID, "stone") != 2 || len(lay.WaysMade) != 0 {
		t.Fatal("laid", lay)
	}
	if _, code := x.pathOp(c, s, "lay", "twice", ox, oy+1, ox, oy, "plank", 409); code != "already-laid" {
		t.Fatal(code)
	}
	// A plank on a cleared thicket.
	x.instance(s.AccountID, "bench-spade", -1, "")
	thx, thy := local(cx, cy, fakegen.Thicket)
	x.pathOp(c, s, "clear", "clear", thx, thy+1, thx, thy, "", 200)
	env, _ = x.pathOp(c, s, "lay", "plank", thx, thy+1, thx, thy, "plank", 200)
	if ch := groundAt(env.GetWildsLay().Ground, fakegen.Thicket[0], fakegen.Thicket[1]); ch.Change != "plank" || x.packQty(s.AccountID, "timber") != 0 {
		t.Fatal("plank on the cleared thicket", ch)
	}
	// Lifting: never another's, never an unlaid tile.
	if _, code := x.pathOp(bc, b, "lift", "not-mine", ox, oy+1, ox, oy, "", 409); code != "not-your-path" {
		t.Fatal(code)
	}
	if _, code := x.pathOp(c, s, "lift", "bare", ox+1, oy+1, ox+1, oy, "", 409); code != "not-your-path" {
		t.Fatal(code)
	}
	env, _ = x.pathOp(c, s, "lift", "lift-plank", thx, thy+1, thx, thy, "", 200)
	lift := env.GetWildsLift()
	if ch := groundAt(lift.Ground, fakegen.Thicket[0], fakegen.Thicket[1]); ch == nil || ch.Change != "cleared" || x.packQty(s.AccountID, "timber") != 1 || len(lift.WaysBroken) != 0 {
		t.Fatal("lifted plank", lift)
	}
	env, _ = x.pathOp(c, s, "lift", "lift-stone", ox, oy+1, ox, oy, "", 200)
	if groundAt(env.GetWildsLift().Ground, 3, 14) != nil || x.packQty(s.AccountID, "stone") != 3 {
		t.Fatal("lifted stone")
	}
	// Nothing duplicated: what went down came back, once.
	replay, _ := x.pathOp(c, s, "lift", "lift-stone", ox, oy+1, ox, oy, "", 200)
	if !proto.Equal(replay.GetWildsLift(), env.GetWildsLift()) || x.packQty(s.AccountID, "stone") != 3 {
		t.Fatal("lift replay refunded twice")
	}
}

// Changes are stored under their chunk's epoch: the Tangle's last for good;
// the Beyond's are Common (common_ways.go), carried onto the next wick while
// someone stood in their chunk (laying there counts), and turned, their
// stone crated at Pell's for its layer, at the first turning nobody came.
func TestWildsChangesTurnWithTheirLand(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.give(s.AccountID, "stone", 2)
	tx, ty := local(0, -1, [2]int{3, 14})
	wx, wy := local(2, -1, [2]int{3, 14})
	x.pathOp(c, s, "lay", "tangle", tx, ty+1, tx, ty, "stone", 200)
	x.pathOp(c, s, "lay", "beyond", wx, wy+1, wx, wy, "stone", 200)
	before := x.near(c, 1, -1, 200)
	if len(before.Ground) != 2 {
		t.Fatal("ground before", before.Ground)
	}
	day := content.CalendarAt(content.CalendarRules, x.now.Load())
	x.now.Store(day.NextTurning + 60)
	c, _ = x.again("alice")
	after := x.near(c, 1, -1, 200)
	beyond := slices.IndexFunc(after.Ground, func(g *contract.ChunkGroundChanges) bool { return g.Chunk.Cx == 2 })
	if after.Wick.Id == before.Wick.Id || len(after.Ground) != 2 || beyond < 0 || after.Ground[beyond].Epoch != after.Wick.Id || groundAt(after.Ground[beyond], 3, 14).GetChange() != "stone" {
		t.Fatal("ground after the turning", after.Ground)
	}
	if x.packQty(s.AccountID, "stone") != 0 {
		t.Fatal("a carried path refunded")
	}
	x.now.Store(content.CalendarAt(content.CalendarRules, x.now.Load()).NextTurning + 60)
	c, _ = x.again("alice")
	last := x.near(c, 1, -1, 200)
	if len(last.Ground) != 1 || last.Ground[0].Epoch != last.Still.Id || last.Ground[0].Chunk.Cx != 0 || x.crated(s.AccountID, "stone") != 1 {
		t.Fatal("ground after an unvisited turning", last.Ground, x.crated(s.AccountID, "stone"))
	}
}

// Named ways (decision 23): a run of laid tiles joining two places becomes
// "<name>'s way" with a fixed path and two signs. The name goes to whoever
// laid most of the run, a tie to the joining tile's layer. A lift of a path
// tile reroutes the way, or breaks it when the places no longer join. Two
// footprints never make a way.
func TestWildsNamedWays(t *testing.T) {
	x := newRig(t)
	x.hero("alice", "Alice", "")
	c, s := x.ready("alice")
	x.hero("bob", "Bob", "")
	bc, b := x.member("bob", s.WorldID)
	x.give(s.AccountID, "stone", 200)
	x.give(b.AccountID, "stone", 200)
	// Place (1,-1)'s landmark is at world tile (82,-86); place (1,0)'s at
	// (82,-14); both find radii are 3. Column 82 between them is open.
	ax, ay := 82, -86
	by := -14
	lay := func(cookie *http.Cookie, r response, y int) *contract.WildsLayResult {
		t.Helper()
		env, _ := x.pathOp(cookie, r, "lay", fmt.Sprintf("lay%d", y), ax, y, ax, y, "stone", 200)
		return env.GetWildsLay()
	}
	// The run: column 82 from -83 (touching A) to -17 (touching B), and a
	// side tile. Bob lays -83..-51 and the side tile (34), Alice -50..-18
	// and then the joining tile -17 (34): a tie, so the way is Alice's.
	for y := ay + 3; y <= -51; y++ {
		if got := lay(bc, b, y); len(got.WaysMade) != 0 {
			t.Fatal("a way too soon", y)
		}
	}
	x.pathOp(bc, b, "lay", "side-70", ax+1, -70, ax+1, -70, "stone", 200)
	for y := -50; y <= by-4; y++ {
		if got := lay(c, s, y); len(got.WaysMade) != 0 {
			t.Fatal("a way too soon", y)
		}
	}
	made := lay(c, s, by-3).WaysMade
	if len(made) != 1 {
		t.Fatal("no way", made)
	}
	way := made[0]
	if way.Id != "way:place:1:-1:place:1:0" || way.A != "place:1:-1" || way.B != "place:1:0" || way.Name != "Alice's way" || way.By != s.AccountID || way.Tiles != 68 || way.Epoch == "" {
		t.Fatalf("way %+v", way)
	}
	// The path is the column (67 tiles); the signs stand beside its ends:
	// north of -83, and east of -17 (north of it is laid).
	if len(way.Path) != 67 || way.Path[0].Y != int32(ay+3) || way.Path[66].Y != int32(by-3) || way.SignA.X != int32(ax) || way.SignA.Y != int32(ay+2) || way.SignB.X != int32(ax+1) || way.SignB.Y != int32(by-3) {
		t.Fatalf("path %v..%v signs %v %v", way.Path[0], way.Path[len(way.Path)-1], way.SignA, way.SignB)
	}
	placeA := wayPlace{id: way.A, x: ax, y: ay, radius: 3}
	placeB := wayPlace{id: way.B, x: ax, y: by, radius: 3}
	anyTile := func(int, int) bool { return true }
	checkWay(t, way, placeA, placeB, anyTile, anyTile, 67)
	// Laying on doesn't make it again or move its path.
	if _, code := x.pathOp(bc, b, "lay", "twice", ax, ay+3, ax, ay+3, "stone", 409); code != "already-laid" {
		t.Fatal(code)
	}
	if got := x.pathOpLay(bc, b, ax+1, ay+20); len(got) != 0 {
		t.Fatal("a second way for a pair", got)
	}
	// The way shows in a near read whose window holds a path tile.
	if n := x.near(c, 3, -2, 200); len(n.Ways) != 1 || !proto.Equal(n.Ways[0], way) {
		t.Fatal("near ways", n.Ways)
	}
	if n := x.near(c, -3, -7, 200); len(n.Ways) != 0 {
		t.Fatal("a way outside the window")
	}
	// A detour around (82,-60), then lifting it: rerouted, same name.
	for _, d := range [][2]int{{83, -61}, {83, -60}, {83, -59}} {
		x.pathOp(bc, b, "lay", fmt.Sprintf("detour%d", d[1]), d[0], d[1], d[0], d[1], "stone", 200)
	}
	env, _ := x.pathOp(bc, b, "lift", "lift-60", ax, -60, ax, -60, "", 200)
	lift := env.GetWildsLift()
	if len(lift.WaysBroken) != 0 || len(lift.WaysRerouted) != 1 || lift.WaysRerouted[0].Name != "Alice's way" || !slices.ContainsFunc(lift.WaysRerouted[0].Path, func(t *contract.WorldTile) bool { return t.X == 83 && t.Y == -60 }) {
		t.Fatal("reroute", lift)
	}
	checkWay(t, lift.WaysRerouted[0], placeA, placeB, anyTile, anyTile, 69)
	// Lifting a tile off the path changes nothing.
	if env, _ = x.pathOp(bc, b, "lift", "lift-side", ax+1, ay+20, ax+1, ay+20, "", 200); len(env.GetWildsLift().WaysBroken)+len(env.GetWildsLift().WaysRerouted) != 0 {
		t.Fatal("an off-path lift touched the way")
	}
	// Breaking it: lift the detour's middle.
	env, _ = x.pathOp(bc, b, "lift", "lift-detour", 83, -60, 83, -60, "", 200)
	if got := env.GetWildsLift(); !slices.Equal(got.WaysBroken, []string{way.Id}) || len(got.WaysRerouted) != 0 {
		t.Fatal("break", got)
	}
	if n := x.near(c, 3, -2, 200); len(n.Ways) != 0 {
		t.Fatal("a broken way stood")
	}
	// Mending the gap makes the way anew, named for the run's majority (Bob).
	if got := x.pathOpLay(bc, b, ax, -60); len(got) != 1 || got[0].Name != "Bob's way" || got[0].By != b.AccountID {
		t.Fatal("remade", got)
	}
	// The Tangle and the Whitequiet meet at the crossing: no way.
	if got := lay2(t, x, c, s, 11, -48); len(got) != 0 {
		t.Fatal(got)
	}
	if got := lay2(t, x, c, s, 11, -49); len(got) != 0 {
		t.Fatal("a way between the footprints", got)
	}
	// Laying visited the column's chunks: the way carries through the
	// turning with its tiles, name and namer, while its places (dealt
	// with the wick) still join; then goes with them at a turning nobody
	// came to.
	stand := content.CalendarAt(content.CalendarRules, x.now.Load()).NextTurning + 60
	x.now.Store(stand)
	c, _ = x.again("alice")
	n := x.near(c, 3, -2, 200)
	if len(n.Ways) != 1 {
		t.Fatal("carried ways", n.Ways)
	}
	if w := n.Ways[0]; w.Id != "way:place:1:-1:place:1:0" || w.Name != "Bob's way" || w.By != b.AccountID || w.Epoch != n.Wick.Id {
		t.Fatal("carried way", w)
	}
	if len(n.Ground) == 0 {
		t.Fatal("ground didn't carry")
	}
	x.now.Store(content.CalendarAt(content.CalendarRules, stand).NextTurning + 60)
	c, _ = x.again("alice")
	if n := x.near(c, 3, -2, 200); len(n.Ways) != 0 || len(n.Ground) != 0 {
		t.Fatal("ways or ground outlived an unvisited turning", n.Ways)
	}
}

func lay2(t *testing.T, x *rig, c *http.Cookie, s response, tx, ty int) []*contract.WildsWay {
	t.Helper()
	env, _ := x.pathOp(c, s, "lay", fmt.Sprintf("lay2:%d:%d", tx, ty), tx, ty, tx, ty, "stone", 200)
	return env.GetWildsLay().WaysMade
}

// First to find a place (decision 20): within the find radius only; the
// first insert this wick wins and alone rolls the discovery table, even
// under two racing requests; later finders get the name.
func TestWildsDiscover(t *testing.T) {
	x := newRig(t)
	x.hero("alice", "Alice", "")
	c, s := x.ready("alice")
	x.hero("bob", "Bob", "")
	bc, b := x.member("bob", s.WorldID)
	wick := x.near(c, 3, -1, 200).Wick
	discover := func(cookie *http.Cookie, r response, key, place string, tx, ty, status int) (*contract.WildsDiscoverResult, string) {
		t.Helper()
		env, code := x.call("/api/wilds/discover", &contract.WildsDiscoverRequest{Op: op(r.Lease, key), Where: tileWhere(tx, ty), Place: place, Epoch: wick.Id}, cookie, status)
		return env.GetWildsDiscover(), code
	}
	// Place (1,0): landmark at (82,-14), find radius 3 (Chebyshev).
	if _, code := discover(c, s, "far", "place:1:0", 82, -10, 409); code != "too-far-away" {
		t.Fatal(code)
	}
	if _, code := discover(c, s, "footprint", "place:0:0", 82, -12, 404); code != "entity-not-found" {
		t.Fatal(code)
	}
	if _, code := discover(c, s, "bad-id", "place:1:00", 82, -12, 404); code != "entity-not-found" {
		t.Fatal(code)
	}
	// Two racing first finds: one wins.
	other, err := store.Open(filepath.Join(x.dir, "game.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	api2 := New(other, x.api.Habitica, x.api.Config)
	var wg sync.WaitGroup
	results := make(chan *contract.WildsDiscoverResult, 2)
	for i, pair := range []struct {
		c *http.Cookie
		s response
	}{{c, s}, {bc, b}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			raw, _ := protojson.Marshal(&contract.WildsDiscoverRequest{Op: op(pair.s.Lease, "race"), Where: tileWhere(85, -11), Place: "place:1:0", Epoch: wick.Id})
			r := httptest.NewRequest("POST", "/api/wilds/discover", bytes.NewReader(raw))
			r.Header.Set("X-Glimway-Contract", testContract())
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(pair.c)
			w := httptest.NewRecorder()
			if i == 0 {
				x.api.ServeHTTP(w, r)
			} else {
				api2.ServeHTTP(w, r)
			}
			env := &contract.Envelope{}
			if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), env) != nil {
				t.Error(w.Code, w.Body.String())
				return
			}
			results <- env.GetWildsDiscover()
		}()
	}
	wg.Wait()
	close(results)
	firsts := 0
	var finder string
	for r := range results {
		if r.First {
			firsts++
			finder = r.Discovery.DiscovererId
		} else if len(r.Loot.Materials) != 0 || r.Loot.Trinket != nil {
			t.Fatal("a later finder rolled loot")
		}
		if r.Discovery.EntityId != "place:1:0" || r.Discovery.PoiId == "" || r.Discovery.DisplayName == "" {
			t.Fatal("discovery", r.Discovery)
		}
	}
	if firsts != 1 || count(t, x.db, "SELECT count(*) FROM discoveries WHERE entity_id='place:1:0'") != 1 || count(t, x.db, "SELECT count(*) FROM ledger WHERE currency='glims' AND reason='wilds-discover'") != 1 {
		t.Fatal("first insert wins", firsts)
	}
	// The first finder's loot is the discovery table's roll; the near read
	// names the finder.
	if !slices.Contains([]string{s.AccountID, b.AccountID}, finder) {
		t.Fatal("finder", finder)
	}
	n := x.near(c, 3, -1, 200)
	if !slices.ContainsFunc(n.Discoveries, func(d *contract.WildsDiscovery) bool { return d.EntityId == "place:1:0" && d.DiscovererId == finder }) {
		t.Fatal("near discoveries", n.Discoveries)
	}
}

// rumourState reads the rumour from a state answer.
func (x *rig) rumourState(c *http.Cookie) *contract.WildsRumour {
	x.t.Helper()
	w := x.rawHTTP("GET", "/api/state", nil, c)
	var doc struct {
		State struct {
			Rumour json.RawMessage `json:"rumour"`
		} `json:"state"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &doc) != nil {
		x.t.Fatal(w.Code, w.Body.String())
	}
	if string(doc.State.Rumour) == "null" || len(doc.State.Rumour) == 0 {
		return nil
	}
	r := &contract.WildsRumour{}
	if err := protojson.Unmarshal(doc.State.Rumour, r); err != nil {
		x.t.Fatal(err)
	}
	return r
}

// A rumour each wick (decision 19): in every player state, opened once by
// each player as a personal claim rolling the rumour table, the first
// opener its discoverer; the turning brings the next.
func TestWildsRumour(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	r := x.rumourState(c)
	if r == nil || r.Site == "" || r.Place == "" || r.Compass == "" || r.Ring < 1 || r.Opened {
		t.Fatal("rumour", r)
	}
	wick := x.near(c, 0, -4, 200).Wick
	pick, ok, _ := x.gen.Rumour(wick)
	if !ok || r.Epoch != wick.Id || r.Site != pick.Site || r.Place != pick.Place || r.Landmark != pick.Landmark || r.PastRiver != pick.PastRiver {
		t.Fatal("rumour parts", r, pick)
	}
	var cx, cy int
	fmt.Sscanf(r.Site, "rumour:%d:%d", &cx, &cy)
	tx, ty := local(cx, cy, fakegen.Find)
	find := &contract.WildsEntity{Id: r.Site, Kind: "rumour"}
	if _, code := x.claim(c, s, "far", wick.Id, find, 0, tileWhere(tx+5, ty), 409); code != "too-far-away" {
		t.Fatal(code)
	}
	if _, code := x.claim(c, s, "cycle", wick.Id, find, 1, tileWhere(tx, ty+1), 409); code != "old-cycle" {
		t.Fatal(code)
	}
	if _, code := x.claim(c, s, "elsewhere", wick.Id, &contract.WildsEntity{Id: fmt.Sprintf("rumour:%d:%d", cx+1, cy)}, 0, tileWhere(tx, ty+1), 404); code != "entity-not-found" {
		t.Fatal(code)
	}
	got, _ := x.claim(c, s, "open", wick.Id, find, 0, tileWhere(tx, ty+1), 200)
	want, _ := wilds.RollTableLoot(generationOf(wick), "rumour", r.Site, 0)
	if !proto.Equal(got.Loot, lootProto(want)) || got.Entity.Id != r.Site {
		t.Fatal("rumour loot", got)
	}
	if _, code := x.claim(c, s, "again", wick.Id, find, 0, tileWhere(tx, ty+1), 409); code != "already-claimed" {
		t.Fatal(code)
	}
	x.claim(bc, b, "open", wick.Id, find, 0, tileWhere(tx, ty+1), 200)
	if !x.rumourState(c).Opened || !x.rumourState(bc).Opened {
		t.Fatal("opened")
	}
	if count(t, x.db, "SELECT count(*) FROM discoveries WHERE entity_id=? AND discoverer_id=?", r.Site, s.AccountID) != 1 {
		t.Fatal("the first opener isn't its discoverer")
	}
	n := x.near(c, cx, cy, 200)
	if !slices.ContainsFunc(n.PersonalClaims, func(p *contract.WildsPersonalClaim) bool { return p.EntityId == r.Site }) {
		t.Fatal("near claims", n.PersonalClaims)
	}
	// The turning: a new wick, its own rumour, not opened.
	x.now.Store(content.CalendarAt(content.CalendarRules, x.now.Load()).NextTurning + 60)
	c, _ = x.again("alice")
	next := x.rumourState(c)
	if next == nil || next.Epoch == r.Epoch || next.Opened {
		t.Fatal("rumour across the turning", next)
	}
	// No generator: no rumour.
	x.api.Config.WildsGenerator = nil
	if x.rumourState(c) != nil {
		t.Fatal("a rumour without a generator")
	}
}

// The near read's budget (open-map.md section 4): one query a table, at
// most 20 ms p95 on a warm world with a full frontier.
func TestNearReadBudget(t *testing.T) {
	if os.Getenv("GLIMWAY_PERF") != "1" {
		t.Skip("set GLIMWAY_PERF=1")
	}
	x := newRig(t)
	x.api.Config.Epochs.(*store.Chunks).Generator = wildsgen.V3{}
	x.api.Config.WildsGenerator = wildsgen.V3{}
	c, s := x.ready("alice")
	var ep *contract.WildsNearResult
	for cy := -8; cy <= 0; cy += 2 {
		for cx := -4; cx <= 4; cx += 2 {
			ep = x.near(c, cx, cy, 200)
		}
	}
	// Forty changes in each of the 81 chunks, more than a busy wick lays.
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for cy := -8; cy <= 0; cy++ {
		for cx := -4; cx <= 4; cx++ {
			e := ep.Wick
			if wilds.EpochKindAt(cx, cy) == "still" {
				e = ep.Still
			}
			g := &contract.GroundChanges{}
			for i := 0; i < 40; i++ {
				g.Changes = append(g.Changes, &contract.GroundChange{Tx: uint32(i % 24), Ty: uint32(i / 24), Change: "stone", By: s.AccountID, At: float64(x.now.Load())})
			}
			if err = putGround(context.Background(), tx, s.WorldID, e, cx, cy, g, s.AccountID, x.now.Load()); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var took []time.Duration
	for i := 0; i < 100; i++ {
		start := time.Now()
		x.near(c, (i%9)-4, -(i % 9), 200)
		took = append(took, time.Since(start))
	}
	sort.Slice(took, func(i, j int) bool { return took[i] < took[j] })
	if p95 := took[94]; p95 > 20*time.Millisecond {
		t.Fatalf("near read p95 %v", p95)
	}
	t.Logf("near read p95 %v (median %v)", took[94], took[49])
}

// Ground changes' size budget (section 4): a chunk's changes, as stored and
// sent, stay under 4 KiB for the few dozen a path makes in practice.
func TestGroundChangesSizeBudget(t *testing.T) {
	g := &contract.GroundChanges{}
	by := fmt.Sprintf("%064x", 1)
	for i := 0; i < 40; i++ {
		g.Changes = append(g.Changes, &contract.GroundChange{Tx: uint32(i % 24), Ty: uint32(i / 24), Change: "stone", By: by, At: 1795000000})
	}
	wire, _ := proto.Marshal(&contract.ChunkGroundChanges{Chunk: chunkKeyProto(-4, -8), Epoch: by, Changes: g})
	if len(wire) > 4096 {
		t.Fatalf("40 changes are %d bytes on the wire", len(wire))
	}
	t.Logf("40 changes: %d bytes on the wire (%d a change)", len(wire), len(wire)/40)
}

func (x *rig) pathOpLay(c *http.Cookie, s response, tx, ty int) []*contract.WildsWay {
	x.t.Helper()
	env, _ := x.pathOp(c, s, "lay", fmt.Sprintf("lay:%d:%d", tx, ty), tx, ty, tx, ty, "stone", 200)
	return env.GetWildsLay().WaysMade
}

// Review 1, finding 1: a refused lay that made a chunk rolls the chunk back
// with it; the next read makes and stores it for good, here and on a second
// server with its own chunk cache.
func TestRefusedOperationDoesNotLeaveAPhantomChunk(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	wick := x.near(c, 0, -4, 200).Wick
	tx, ty := local(3, -4, [2]int{3, 14})
	if _, code := x.pathOp(c, s, "lay", "broke", tx, ty+1, tx, ty, "stone", 409); code != "insufficient-materials" {
		t.Fatal(code)
	}
	stored := func(cx, cy int) int {
		return count(t, x.db, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=? AND cx=? AND cy=?", wick.Id, cx, cy)
	}
	if stored(3, -4) != 0 {
		t.Fatal("the refused lay stored its chunk")
	}
	x.chunk(c, wick.Id, 0, 3, -4, 200)
	if stored(3, -4) != 1 {
		t.Fatal("the read after the refusal served a chunk it didn't store")
	}
	other, err := store.Open(filepath.Join(x.dir, "game.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	cfg := x.api.Config
	own := store.NewChunks(cfg.Now, x.gen)
	cfg.Chunks, cfg.Epochs = own, own
	api2 := New(other, x.api.Habitica, cfg)
	api2.Config.Lanterns, api2.Config.HomeLand = wildsService{api2}, wildsService{api2}
	read := func(srv *Server, path string) int {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("X-Glimway-Contract", testContract())
		r.AddCookie(c)
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		return w.Code
	}
	// The second server refuses a lay that makes (4,-8), then the first reads
	// it, from near it (reads answer within sight).
	x.putAt(s.AccountID, 4, -6)
	tx2, ty2 := local(4, -8, [2]int{3, 14})
	raw, _ := protojson.Marshal(&contract.WildsLayRequest{Op: op(s.Lease, "broke-2"), Where: tileWhere(tx2, ty2+1), X: int32(tx2), Y: int32(ty2), Kind: "stone", Epoch: wick.Id})
	r := httptest.NewRequest("POST", "/api/wilds/lay", bytes.NewReader(raw))
	r.Header.Set("X-Glimway-Contract", testContract())
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(c)
	w := httptest.NewRecorder()
	api2.ServeHTTP(w, r)
	if w.Code != 409 || stored(4, -8) != 0 {
		t.Fatal("second server's refused lay", w.Code, stored(4, -8))
	}
	if read(x.api, fmt.Sprintf("/api/wilds/chunk/%s/0/4/-8", wick.Id)) != 200 || stored(4, -8) != 1 {
		t.Fatal("first server's read")
	}
	if read(api2, fmt.Sprintf("/api/wilds/chunk/%s/0/4/-8", wick.Id)) != 200 || read(api2, fmt.Sprintf("/api/wilds/chunk/%s/0/3/-4", wick.Id)) != 200 || stored(4, -8) != 1 || stored(3, -4) != 1 {
		t.Fatal("the servers disagree")
	}
}

// A node yields its chunk's tier's nodeYieldBonus more of each material
// (tiers in content/wilds.json; the generator leaves it to the claim).
func TestNodeYieldBonusByTier(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	for _, ch := range [][2]int{{0, -1}, {3, -4}} {
		n := x.near(c, ch[0], ch[1], 200)
		e := n.Still
		if wilds.EpochKindAt(ch[0], ch[1]) == "wick" {
			e = n.Wick
		}
		m := x.chunk(c, e.Id, 0, ch[0], ch[1], 200)
		var node *contract.WildsEntity
		for _, en := range m.Entities {
			if en.Kind == "node" {
				node = en
			}
		}
		got, _ := x.claim(c, s, fmt.Sprintf("node%d", ch[0]), e.Id, node, 0, at(node, 0), 200)
		base, _ := wilds.RollEntityLoot(generationOf(e), wilds.EntityFromProto(node), 0)
		bonus := int(content.WildsRules.Tiers[m.Tier-1].GetNodeYieldBonus())
		if len(got.Loot.Materials) != len(base.Materials) {
			t.Fatal("node loot", got.Loot, base)
		}
		for i, mat := range got.Loot.Materials {
			if int(mat.Qty) != base.Materials[i].Qty+bonus {
				t.Fatalf("tier %d node: %v, base %v, bonus %d", m.Tier, got.Loot, base, bonus)
			}
		}
		if m.Tier == 3 && bonus != 1 || m.Tier == 1 && bonus != 0 {
			t.Fatal("tiers", m.Tier, bonus)
		}
	}
}

func TestPathOperationsCapturedEpoch(t *testing.T) {
	parent := t
	x := newRig(t)
	c, s := x.ready("alice")
	x.give(s.AccountID, "stone", 4)
	x.instance(s.AccountID, "bench-spade", -1, "")
	before := x.near(c, 2, -4, 200)
	old := before.Wick.Id
	tx, ty := local(2, -4, [2]int{3, 14})
	original, _ := x.pathOp(c, s, "lay", "committed-before-turn", tx, ty+1, tx, ty, "stone", 200, old)
	balance := count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner=? AND item_def='stone'", s.AccountID)
	x.now.Store(content.CalendarAt(content.CalendarRules, x.now.Load()).NextTurning + 1)
	thx, thy := local(2, -4, fakegen.Thicket)
	for _, op := range []string{"clear", "lay", "lift"} {
		t.Run(op, func(t *testing.T) {
			x.t = t
			defer func() { x.t = parent }()
			px, py := tx, ty
			if op == "clear" {
				px, py = thx, thy
			}
			_, code := x.pathOp(c, s, op, "late-"+op, px, py+1, px, py, "stone", 409, old)
			if code != "epoch-ended" {
				t.Fatalf("late %s: %s", op, code)
			}
			if got := count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner=? AND item_def='stone'", s.AccountID); got != balance {
				t.Fatalf("%s spent on refusal: %d != %d", op, got, balance)
			}
		})
	}
	replay, _ := x.pathOp(c, s, "lay", "committed-before-turn", tx, ty+1, tx, ty, "stone", 200, old)
	if !proto.Equal(original.GetWildsLay(), replay.GetWildsLay()) {
		t.Fatal("old committed operation did not replay its original result")
	}
	if got := count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner=? AND item_def='stone'", s.AccountID); got != balance {
		t.Fatal("replay spent twice")
	}
	// The lay visited its chunk: the stone carried into the new wick, where
	// it lifts and lays again under the new epoch.
	current := x.near(c, 2, -4, 200)
	x.pathOp(c, s, "lift", "carried-lift", tx, ty+1, tx, ty, "", 200, current.Wick.Id)
	x.pathOp(c, s, "lay", "new-epoch", tx, ty+1, tx, ty, "stone", 200, current.Wick.Id)
	for _, epoch := range []string{current.Still.Id, ""} {
		_, code := x.pathOp(c, s, "lay", "mismatch-"+epoch, tx+1, ty+1, tx+1, ty, "stone", 409, epoch)
		if code != "epoch-ended" {
			t.Fatalf("mismatched epoch: %s", code)
		}
	}

	x.pathOp(c, s, "lift", "current-lift", tx, ty+1, tx, ty, "", 200, current.Wick.Id)
}
