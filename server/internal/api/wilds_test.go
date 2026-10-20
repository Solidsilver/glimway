package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/chunks/fakegen"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/land"
	"glimway/server/internal/location"
	"glimway/server/internal/ports"
	"glimway/server/internal/ports/portstest"
	"glimway/server/internal/store"
	"glimway/server/internal/story"
	"glimway/server/internal/wilds"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// wildsView is a footprint's part of a near read (its epoch, entity
// states, claims and lanterns) with the bodies of its stored chunks.
type wildsView struct {
	near           *contract.WildsNearResult
	Epoch          *contract.WildsEpoch
	Entities       []*contract.WildsEntityState
	PersonalClaims []*contract.WildsPersonalClaim
	Discoveries    []*contract.WildsDiscovery
	Lanterns       []*contract.WildsLantern
	Echoes         []*contract.EchoAssignment
	Materials      map[string]float64
	chunks         []*contract.WorldChunk
	bodies         []*contract.WildsEntity
}

func (v wildsView) kind(t *testing.T, kind string) *contract.WildsEntity {
	t.Helper()
	for _, e := range v.bodies {
		if e.Kind == kind {
			return e
		}
	}
	t.Fatalf("no %s generated", kind)
	return nil
}

func (v wildsView) state(id string) *contract.WildsEntityState {
	for _, e := range v.Entities {
		if e.Id == id {
			return e
		}
	}
	return nil
}

// near is GET /api/wilds/near/<cx>/<cy>.
func (x *rig) near(c *http.Cookie, cx, cy, status int) *contract.WildsNearResult {
	x.t.Helper()
	w := x.rawHTTP("GET", fmt.Sprintf("/api/wilds/near/%d/%d", cx, cy), nil, c)
	if w.Code != status {
		x.t.Fatalf("near read %d,%d: %d %s", cx, cy, w.Code, w.Body.String())
	}
	if status != 200 {
		return nil
	}
	v := &contract.WildsNearResult{}
	if err := protojson.Unmarshal(w.Body.Bytes(), v); err != nil {
		x.t.Fatal(err)
	}
	return v
}

// wilds reads a footprint ("tangle", "whitequiet") through a near read at
// its middle chunk (making the epochs on first read), and its chunks.
func (x *rig) wilds(c *http.Cookie, footprint string) wildsView {
	x.t.Helper()
	f := wilds.Footprint(footprint)
	mx, my := int(f.GetCx()+f.GetWidth()/2), int(f.GetCy()+f.GetHeight()/2)
	n := x.near(c, mx, my, 200)
	v := wildsView{near: n, Epoch: n.Still, Discoveries: n.Discoveries, Lanterns: n.Lanterns, Echoes: n.Echoes, Materials: n.Materials}
	if f.GetEpochKind() == "wick" {
		v.Epoch = n.Wick
	}
	ids := map[string]bool{}
	for cy := f.GetCy(); cy < f.GetCy()+f.GetHeight(); cy++ {
		for cx := f.GetCx(); cx < f.GetCx()+f.GetWidth(); cx++ {
			m := x.chunk(c, v.Epoch.Id, 0, int(cx), int(cy), 200)
			v.chunks = append(v.chunks, m)
			v.bodies = append(v.bodies, m.Entities...)
			for _, e := range m.Entities {
				ids[e.Id] = true
			}
		}
	}
	for _, e := range n.Entities {
		if ids[e.Id] {
			v.Entities = append(v.Entities, e)
		}
	}
	for _, p := range n.PersonalClaims {
		if ids[p.EntityId] {
			v.PersonalClaims = append(v.PersonalClaims, p)
		}
	}
	return v
}

func (x *rig) chunk(c *http.Cookie, epoch string, layer, cx, cy, status int) *contract.WorldChunk {
	x.t.Helper()
	w := x.rawHTTP("GET", fmt.Sprintf("/api/wilds/chunk/%s/%d/%d/%d", epoch, layer, cx, cy), nil, c)
	if w.Code != status {
		x.t.Fatalf("chunk %d,%d: %d %s", cx, cy, w.Code, w.Body.String())
	}
	if status != 200 {
		return nil
	}
	m := &contract.WorldChunk{}
	if err := proto.Unmarshal(w.Body.Bytes(), m); err != nil {
		x.t.Fatal(err)
	}
	return m
}

// entityChunk is the chunk an entity id names.
func entityChunkOf(e *contract.WildsEntity) (int, int) {
	var cx, cy int
	fmt.Sscanf(e.Id, e.Kind+":%d:%d:", &cx, &cy)
	return cx, cy
}

// at is the world-pixel `where` on an entity's tile, dx tiles east.
func at(e *contract.WildsEntity, dx int) *contract.Where {
	cx, cy := entityChunkOf(e)
	S := int(content.WildsRules.GetChunkSize())
	return &contract.Where{Area: outdoorsArea, X: float64((cx*S + int(e.Tx) + dx) * 16), Y: float64((cy*S + int(e.Ty)) * 16)}
}

// atTile is the world-pixel `where` at a world tile's centre.
func atTile(tx, ty int) *contract.Where {
	return &contract.Where{Area: outdoorsArea, X: float64(tx*16 + 8), Y: float64(ty*16 + 8)}
}

func op(lease, key string) *contract.OpHeader { return &contract.OpHeader{Lease: lease, Key: key} }

// call posts an operation and returns its envelope, or its refusal code.
func (x *rig) call(path string, req proto.Message, c *http.Cookie, status int) (*contract.Envelope, string) {
	x.t.Helper()
	raw, err := protojson.Marshal(req)
	if err != nil {
		x.t.Fatal(err)
	}
	w := x.rawHTTP("POST", path, json.RawMessage(raw), c)
	if w.Code != status {
		x.t.Fatalf("%s: got %d %s, want %d", path, w.Code, w.Body.String(), status)
	}
	if status != 200 {
		var e struct{ Error struct{ Code string } }
		_ = json.Unmarshal(w.Body.Bytes(), &e)
		return nil, e.Error.Code
	}
	env := &contract.Envelope{}
	if err := protojson.Unmarshal(w.Body.Bytes(), env); err != nil {
		x.t.Fatal(err)
	}
	return env, ""
}

func (x *rig) claim(c *http.Cookie, s response, key, epoch string, e *contract.WildsEntity, cycle int, where *contract.Where, status int) (*contract.WildsClaimResult, string) {
	x.t.Helper()
	env, code := x.call("/api/wilds/claim", &contract.WildsClaimRequest{Op: op(s.Lease, key), Epoch: epoch, EntityId: e.Id, Cycle: float64(cycle), Where: where}, c, status)
	return env.GetWildsClaim(), code
}

// fall places a fallen hero's lantern through D's port, as lane B's fall
// operation does, in its own transaction.
func (x *rig) fall(subject string, epoch *contract.WildsEpoch, where *contract.Where) ports.FallLantern {
	x.t.Helper()
	tx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	s, err := x.api.Config.State.Load(context.Background(), tx, x.account(subject))
	if err != nil {
		x.t.Fatal(err)
	}
	out, err := x.api.Config.Lanterns.PlaceFallen(context.Background(), tx, &s, epoch, where, x.now.Load())
	if err != nil {
		x.t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		x.t.Fatal(err)
	}
	return out
}

// lanternTile is a walkable world tile (an entity's: entities stand in
// clearings), where fallen lanterns go in these tests.
func lanternTile(v wildsView) (int, int) {
	e := v.bodies[0]
	cx, cy := entityChunkOf(e)
	return cx*24 + int(e.Tx), cy*24 + int(e.Ty)
}

// The near read (open-map.md 2.4) makes the world's two epochs on first
// read (the still one with the Tangle's nine chunks) and the window's
// chunks on demand, and answers every entity in the window, fresh.
func TestWildsNearMakesEpochsAndChunks(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "tangle")
	if v.Epoch.Kind != "still" || v.Epoch.GeneratorVersion != 3 || v.Epoch.Season != "0" || v.Epoch.EndsAt != nil {
		t.Fatalf("still epoch %+v", v.Epoch)
	}
	n := v.near
	day := content.CalendarAt(content.CalendarRules, x.now.Load())
	if n.Wick.Kind != "wick" || n.Wick.Season != fmt.Sprintf("t:%d:%d", day.StartsAt, day.NextTurning) || n.Wick.EndsAt == nil || int64(n.Wick.EndsAt.Value) != day.NextTurning {
		t.Fatalf("wick epoch %+v", n.Wick)
	}
	if n.Center.Cx != 0 || n.Center.Cy != -1 || n.Center.Realm != "hearthwick" || n.Center.Layer != 0 || n.Radius != 2 {
		t.Fatalf("window %+v %d", n.Center, n.Radius)
	}
	if r := n.Border.Rect; r.MinCx != -4096 || r.MinCy != -4096 || r.MaxCx != 4096 || r.MaxCy != 4096 {
		t.Fatalf("border %+v", r)
	}
	// The window around (0,-1) is chunks -2..2 by -3..1: the Tangle's nine
	// (made with the still epoch), the fixed block's top row of five (lots,
	// town, lots: never generated) and eleven wick chunks. It touches the
	// Whitequiet, whose Echoes are dealt over all nine of its chunks, so its
	// other six are made too.
	if a, b := count(t, x.db, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=?", n.Still.Id), count(t, x.db, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=?", n.Wick.Id); a != 9 || b != 11+6 {
		t.Fatal("window chunks not made on read", a, b)
	}
	if len(n.Entities) != 4*20 || len(v.Entities) != len(v.bodies) { // four a chunk, the nine still and eleven wick
		t.Fatal("entity states don't match the chunks' bodies", len(n.Entities))
	}
	for _, e := range n.Entities {
		if e.Cycle != 0 || e.State != "available" || (e.Epoch != n.Still.Id && e.Epoch != n.Wick.Id) {
			t.Fatalf("fresh entity %+v", e)
		}
	}
	for i, m := range v.chunks {
		if chunks.Validate(m) != nil || m.EpochId != v.Epoch.Id || int(m.Cx) != i%3-1 || int(m.Cy) != i/3-2 {
			t.Fatalf("chunk %d", i)
		}
	}
	// The stored chunks are the generator's.
	g, _ := x.gen.Chunk(v.Epoch, 0, -1, nil)
	if !proto.Equal(g, v.chunks[4]) {
		t.Fatal("served chunk differs from the generator's")
	}
	// The same world reads the same epochs; a second read writes nothing.
	sum := "SELECT (SELECT count(*) FROM wild_epochs)+(SELECT count(*) FROM wilds_chunks)+(SELECT count(*) FROM entity_state)+(SELECT sum(version) FROM players)"
	before := count(t, x.db, sum)
	again := x.near(c, 0, -1, 200)
	if again.Still.Id != n.Still.Id || again.Wick.Id != n.Wick.Id || before != count(t, x.db, sum) {
		t.Fatal("a second read wrote")
	}
	// Past sight or the border: refused, and nothing is made.
	x.near(c, 0, 40, 409)
	x.near(c, wilds.BorderChunks()+1, 0, 409)
	for _, path := range []string{"0", "0/-1/2", "x/1", "01/1", "0/-01", ""} {
		if w := x.rawHTTP("GET", "/api/wilds/near/"+path, nil, c); w.Code != 404 {
			t.Fatal(path, w.Code)
		}
	}
	if before != count(t, x.db, sum) {
		t.Fatal("a refused read wrote")
	}
	// In the Commons' fixed footprint: the window lists every chunk on the
	// grid with its source and epoch, and only generated chunks carry state.
	commons := x.near(c, 0, 1, 200)
	listed := map[[2]int32]string{}
	for _, ch := range commons.Chunks {
		listed[[2]int32{ch.Chunk.Cx, ch.Chunk.Cy}] = ch.Source + " " + ch.Epoch
	}
	if len(listed) != 25 || listed[[2]int32{0, 1}] != "fixed fixed:hearthwick@4" || listed[[2]int32{1, 2}] != "fixed fixed:hearthwick@4" || listed[[2]int32{-2, 3}] != "fixed fixed:lots-west@5" || listed[[2]int32{2, 1}] != "fixed fixed:lots-east@5" || listed[[2]int32{0, 0}] != "generated "+n.Still.Id || listed[[2]int32{2, -1}] != "generated "+n.Wick.Id {
		t.Fatal("the window's chunks", listed)
	}
	for _, e := range commons.Entities {
		cx, cy, ok := story.EntityChunk("", e.Id)
		if !ok || location.SourceOf(cx, cy).Kind != location.SourceGenerated {
			t.Fatal("state off generated chunks", e.Id)
		}
	}
	if w := x.rawHTTP("GET", "/api/wilds/region/inner-1", nil, c); w.Code != 404 {
		t.Fatal("the region read is gone", w.Code)
	}
	// Where the frontier's corner was (0.8–0.13): a whole window of
	// generated land, read from where it lies.
	x.putAt(s.AccountID, -4, -8)
	corner := x.near(c, -4, -8, 200)
	if len(corner.Chunks) != 25 || len(corner.Entities) != 25*4 {
		t.Fatal("corner window", len(corner.Chunks), len(corner.Entities))
	}
	for _, ch := range corner.Chunks {
		if ch.Source != location.SourceGenerated.String() {
			t.Fatal("corner chunk", ch)
		}
	}
}

func TestWildsConcurrentFirstReadsMakeOneEpoch(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, _ := x.member("bob", s.WorldID)
	other, err := store.Open(filepath.Join(x.dir, "game.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	api2 := New(other, x.api.Habitica, x.api.Config)
	api2.Config.Lanterns, api2.Config.HomeLand = wildsService{api2}, wildsService{api2}
	var wg sync.WaitGroup
	for i, cookie := range []*http.Cookie{c, bc} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("GET", "/api/wilds/near/0/-4", nil)
			r.Header.Set("X-Glimway-Contract", testContract())
			r.AddCookie(cookie)
			w := httptest.NewRecorder()
			if i == 0 {
				x.api.ServeHTTP(w, r)
			} else {
				api2.ServeHTTP(w, r)
			}
			if w.Code != 200 {
				t.Error(w.Code, w.Body.String())
			}
		}()
	}
	wg.Wait()
	// The window around (0,-4): -2..2 by -6..-2, all inside, three of them
	// the Tangle's (made with its other six when the still epoch was).
	if count(t, x.db, "SELECT count(*) FROM wild_epochs WHERE kind='wick'") != 1 || count(t, x.db, "SELECT count(*) FROM wild_epochs WHERE kind='still'") != 1 || count(t, x.db, "SELECT count(*) FROM wilds_chunks") != 9+(25-3) {
		t.Fatal("concurrent first reads made two epochs or two blobs", count(t, x.db, "SELECT count(*) FROM wilds_chunks"))
	}
}

func TestWildsChunkRoute(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "tangle")
	w := x.rawHTTP("GET", "/api/wilds/chunk/"+v.Epoch.Id+"/0/1/-1", nil, c)
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/x-protobuf" || w.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatal(w.Code, w.Header())
	}
	// A wick chunk nobody has read yet is made by the chunk route too (read
	// from near it: reads answer within sight).
	x.putAt(s.AccountID, 4, -6)
	if m := x.chunk(c, v.near.Wick.Id, 0, 4, -8, 200); m.Cx != 4 || m.Cy != -8 || m.EpochId != v.near.Wick.Id {
		t.Fatal("on-demand chunk", m.Cx, m.Cy)
	}
	for _, path := range []string{"0/2/-1", "0/5/0", "0/0/1", "1/1/-1", "0/1", "0/01/-1", "0/1/-01", "0/1/-1/2", "0/x/1"} {
		if w := x.rawHTTP("GET", "/api/wilds/chunk/"+v.Epoch.Id+"/"+path, nil, c); w.Code != 404 {
			t.Fatal(path, w.Code)
		}
	}
	x.chunk(c, "unknown-epoch", 0, 1, -1, 404)
	if w := x.rawHTTP("GET", "/api/wilds/chunk/"+v.Epoch.Id+"/0/1/-1", nil, nil); w.Code != 401 {
		t.Fatal("no session", w.Code)
	}
	// Another world's epoch is not found, not forbidden: ids don't leak.
	oc, _ := x.ready("outsider")
	x.chunk(oc, v.Epoch.Id, 0, 1, -1, 404)
	if _, err := x.db.DB.Exec("UPDATE wild_epochs SET ends_at=? WHERE id=?", x.now.Load(), v.Epoch.Id); err != nil {
		t.Fatal(err)
	}
	w = x.rawHTTP("GET", "/api/wilds/chunk/"+v.Epoch.Id+"/0/1/-1", nil, c)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "epoch-ended") {
		t.Fatal("ended epoch chunk", w.Code)
	}
}

func TestWildsClaimCyclesProjectionAndRace(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	v := x.wilds(c, "tangle")
	ep := v.Epoch.Id
	camp := v.kind(t, "camp")
	alice, bob := x.account("alice"), x.account("bob")
	// A standing camp has nothing to claim: no fall, no completion.
	if _, code := x.claim(c, s, "standing", ep, camp, 0, at(camp, 0), 409); code != "not-defeated" {
		t.Fatal("claim without a fall", code)
	}
	fellAt := x.now.Load()
	x.campFell(s.WorldID, ep, camp, 0, alice, bob)
	// The fall, not a claim, clears the camp and starts its timer.
	if st := x.wilds(c, "tangle").state(camp.Id); st.Cycle != 0 || st.State != "cleared" || st.AvailableAt != float64(fellAt+int64(content.WildsRules.Timers.CampRespawnSeconds)) || st.By != nil || !st.CampClaimable {
		t.Fatalf("fallen camp %+v", st)
	}
	other, err := store.Open(filepath.Join(x.dir, "game.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	api2 := New(other, x.api.Habitica, x.api.Config)
	// Alice claims twice at once, under two keys, through two servers: one
	// settles, the other is refused. A witness claims a fallen cycle once.
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for i, key := range []string{"race-a", "race-b"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			raw, _ := protojson.Marshal(&contract.WildsClaimRequest{Op: op(s.Lease, key), Epoch: ep, EntityId: camp.Id, Where: at(camp, 0)})
			r := httptest.NewRequest("POST", "/api/wilds/claim", bytes.NewReader(raw))
			r.Header.Set("X-Glimway-Contract", testContract())
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(c)
			w := httptest.NewRecorder()
			if i == 0 {
				x.api.ServeHTTP(w, r)
			} else {
				api2.ServeHTTP(w, r)
			}
			statuses <- w.Code
		}()
	}
	wg.Wait()
	close(statuses)
	wins, losses := 0, 0
	for status := range statuses {
		switch status {
		case 200:
			wins++
		case 409:
			losses++
		default:
			t.Fatal(status)
		}
	}
	if wins != 1 || losses != 1 || count(t, x.db, "SELECT count(*) FROM ledger WHERE currency='glims' AND reason='wilds-claim'") != 1 {
		t.Fatal("claim race", wins, losses)
	}
	if _, code := x.claim(c, s, "again", ep, camp, 0, at(camp, 0), 409); code != "already-claimed" {
		t.Fatal("second claim", code)
	}
	// Bob witnessed it too: his claim is his own, during the cooldown, and
	// moves neither the camp's row nor its timer.
	if !x.wilds(bc, "tangle").state(camp.Id).CampClaimable || x.wilds(c, "tangle").state(camp.Id).CampClaimable {
		t.Fatal("claimable: bob unclaimed, alice claimed")
	}
	got, _ := x.claim(bc, b, "bob", ep, camp, 0, at(camp, 0), 200)
	if got.Entity.Cycle != 0 || got.Entity.State != "cleared" || got.Entity.By != nil || got.Entity.CampClaimable || count(t, x.db, "SELECT available_at FROM entity_state WHERE epoch=? AND entity_id=?", ep, camp.Id) != int(fellAt)+int(content.WildsRules.Timers.CampRespawnSeconds) {
		t.Fatalf("witness claim %+v", got.Entity)
	}
	// The near read names the cycle's claim for its reader only.
	if v := x.wilds(c, "tangle"); len(v.PersonalClaims) != 1 || v.PersonalClaims[0].EntityId != camp.Id {
		t.Fatal("camp claim in the near read", v.PersonalClaims)
	}
	// Long after: exactly one cycle ahead, projected by the read, not written.
	x.now.Add(10 * int64(content.WildsRules.Timers.CampRespawnSeconds))
	next := x.wilds(c, "tangle")
	if st := next.state(camp.Id); st.Cycle != 1 || st.State != "available" || st.By != nil || st.CampClaimable {
		t.Fatalf("projection %+v", st)
	}
	if len(next.PersonalClaims) != 0 {
		t.Fatal("an old cycle's claim shown for the new cycle", next.PersonalClaims)
	}
	if count(t, x.db, "SELECT cycle FROM entity_state WHERE epoch=? AND entity_id=?", ep, camp.Id) != 0 {
		t.Fatal("the read wrote the projection")
	}
	if _, code := x.claim(c, s, "old", ep, camp, 0, at(camp, 0), 409); code != "old-cycle" {
		t.Fatal("old cycle", code)
	}
	if _, code := x.claim(c, s, "ahead", ep, camp, 2, at(camp, 0), 409); code != "old-cycle" {
		t.Fatal("cycle ahead", code)
	}
	// The new cycle's camp stands: the old cycle's fall grants nothing.
	if _, code := x.claim(c, s, "cycle1-early", ep, camp, 1, at(camp, 0), 409); code != "not-defeated" {
		t.Fatal("old fall granted the new cycle", code)
	}
	x.campFell(s.WorldID, ep, camp, 1, alice)
	if !x.wilds(c, "tangle").state(camp.Id).CampClaimable || x.wilds(bc, "tangle").state(camp.Id).CampClaimable {
		t.Fatal("claimable: alice witnessed cycle 1, bob did not")
	}
	if _, code := x.claim(bc, b, "cycle1", ep, camp, 1, at(camp, 0), 409); code != "condition-unmet" {
		t.Fatal("non-witness", code)
	}
	got, _ = x.claim(c, s, "cycle1", ep, camp, 1, at(camp, 0), 200)
	if got.Entity.Cycle != 1 || got.Entity.State != "cleared" || count(t, x.db, "SELECT cycle FROM entity_state WHERE epoch=? AND entity_id=?", ep, camp.Id) != 1 {
		t.Fatal("the fall didn't persist the projected cycle")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE currency='glims' AND reason='wilds-claim' AND ref=?", ep+":"+camp.Id+":1") != 1 {
		t.Fatal("cycle ledger ref")
	}
	node := next.kind(t, "node")
	x.claim(c, s, "node0", ep, node, 0, at(node, 0), 200)
	x.now.Add(int64(content.WildsRules.Timers.NodeRegrowSeconds))
	x.claim(c, s, "node1", ep, node, 1, at(node, 0), 200)
	for _, invalid := range []string{"camp:5:0:0", "camp:0:1:0", "camp:2:-1:0", "camp:0:-1:999", "node:0:-01:1", "node:0:-1:0junk", "camp:1"} {
		e := &contract.WildsEntity{Id: invalid, Kind: "camp"}
		if _, code := x.claim(c, s, invalid, ep, e, 0, at(node, 0), 404); code != "entity-not-found" {
			t.Fatal(invalid, code)
		}
	}
	oc, o := x.ready("outsider")
	x.claim(oc, o, "other-world", ep, camp, 1, at(camp, 0), 403)
	if _, err = x.db.DB.Exec("UPDATE wild_epochs SET ends_at=? WHERE id=?", x.now.Load(), ep); err != nil {
		t.Fatal(err)
	}
	if _, code := x.claim(c, s, "ended", ep, camp, 2, at(camp, 0), 409); code != "epoch-ended" {
		t.Fatal("ended epoch", code)
	}
	// The still epoch never ends by itself; one ended by hand is not reopened.
	if w := x.rawHTTP("GET", "/api/wilds/near/0/-1", nil, c); w.Code != 409 || !strings.Contains(w.Body.String(), "epoch-ended") {
		t.Fatal("ended read reopened", w.Code)
	}
}

func TestWildsClaimReach(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "tangle")
	x.campFell(s.WorldID, v.Epoch.Id, v.kind(t, "camp"), 0, x.account("alice"))
	for _, kind := range []string{"node", "camp", "chest", "poi"} {
		e := v.kind(t, kind)
		if _, code := x.claim(c, s, kind+"-village", v.Epoch.Id, e, 0, &contract.Where{Area: "in:village:library", X: 10, Y: 10}, 409); code != "not-in-wilds" {
			t.Fatal(kind, code)
		}
		wrong := at(e, 0)
		wrong.Area = "wilds:inner-1"
		if _, code := x.claim(c, s, kind+"-region", v.Epoch.Id, e, 0, wrong, 409); code != "invalid-position" {
			t.Fatal(kind, code)
		}
		beyond := at(e, 0)
		beyond.X = float64((wilds.BorderChunks()+1)*24*16 + 8)
		if _, code := x.claim(c, s, kind+"-beyond", v.Epoch.Id, e, 0, beyond, 409); code != "beyond-border" {
			t.Fatal(kind, code)
		}
		if _, code := x.claim(c, s, kind+"-far", v.Epoch.Id, e, 0, at(e, 4), 409); code != "too-far-away" {
			t.Fatal(kind, code)
		}
		// Chunk-local pixels never stand for world pixels.
		local := &contract.Where{Area: "outdoors", X: float64(e.Tx * 16), Y: float64(e.Ty * 16)}
		if !strings.HasPrefix(e.Id, kind+":0:0:") && !strings.HasPrefix(e.Id, kind+":0:-1:") {
			x.claim(c, s, kind+"-local", v.Epoch.Id, e, 0, local, 409)
		}
		x.claim(c, s, kind+"-near", v.Epoch.Id, e, 0, at(e, 2), 200)
	}
	// A refusal still moved nobody: the last committed place is the claim's.
	state := x.expect("GET", "/api/state", nil, c, 200)
	if state.State.Area != "outdoors" {
		t.Fatal("place", state.State.Area)
	}
}

func TestWildsPersonalClaimsDiscoveryAndReplay(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	v := x.wilds(c, "tangle")
	ep := v.Epoch.Id
	chest, poi := v.kind(t, "chest"), v.kind(t, "poi")
	req := &contract.WildsClaimRequest{Op: op(s.Lease, "chest"), Epoch: ep, EntityId: chest.Id, Where: at(chest, 0)}
	grant, _ := x.call("/api/wilds/claim", req, c, 200)
	loot, err := wilds.RollEntityLoot(generationOf(v.Epoch), wilds.EntityFromProto(chest), 0)
	if err != nil || !proto.Equal(grant.GetWildsClaim().Loot, lootProto(loot)) {
		t.Fatal("deterministic loot")
	}
	replay, _ := x.call("/api/wilds/claim", req, c, 200)
	if !proto.Equal(replay.GetWildsClaim(), grant.GetWildsClaim()) || count(t, x.db, "SELECT count(*) FROM ledger WHERE currency='glims' AND reason='wilds-claim'") != 1 {
		t.Fatal("claim replay")
	}
	req.EntityId = poi.Id
	if _, code := x.call("/api/wilds/claim", req, c, 409); code != "idempotency-mismatch" {
		t.Fatal("key mismatch", code)
	}
	x.claim(bc, b, "chest", ep, chest, 0, at(chest, 0), 200)
	if _, code := x.claim(c, s, "chest-again", ep, chest, 0, at(chest, 0), 409); code != "already-claimed" {
		t.Fatal(code)
	}
	x.claim(c, s, "poi", ep, poi, 0, at(poi, 0), 200)
	x.claim(bc, b, "poi", ep, poi, 0, at(poi, 0), 200)
	v = x.wilds(c, "tangle")
	if len(v.PersonalClaims) != 2 || len(v.Discoveries) != 1 || v.Discoveries[0].DiscovererId != x.account("alice") || v.Discoveries[0].DisplayName != "Hero" {
		t.Fatal("discovery ownership")
	}
	if st := v.state(poi.Id); st.State != "charted" || st.By.GetValue() != x.account("alice") {
		t.Fatal("charted", st)
	}
	if v.Materials["amber"]+v.Materials["fiber"]+v.Materials["stone"]+v.Materials["timber"] < 0 {
		t.Fatal("materials")
	}
}

func TestWildsClaimRateIsDurableAtomicAndReplayExempt(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "tangle")
	limit := int(content.Rules.GetWildsLimits().GetClaimsPerMinute())
	if len(v.bodies) <= limit {
		t.Fatal("insufficient entities for limit")
	}
	// Every camp among them fell this cycle with alice there.
	for _, e := range v.bodies[:limit+1] {
		if e.Kind == "camp" {
			x.campFell(s.WorldID, v.Epoch.Id, e, 0, x.account("alice"))
		}
	}
	var last *contract.WildsClaimRequest
	for i := 0; i < limit; i++ {
		e := v.bodies[i]
		last = &contract.WildsClaimRequest{Op: op(s.Lease, fmt.Sprintf("claim%d", i)), Epoch: v.Epoch.Id, EntityId: e.Id, Where: at(e, 0)}
		x.call("/api/wilds/claim", last, c, 200)
	}
	x.call("/api/wilds/claim", last, c, 200)
	e := v.bodies[limit]
	if _, code := x.claim(c, s, "limited", v.Epoch.Id, e, 0, at(e, 0), 429); code != "claim-rate-limited" {
		t.Fatal("rate limiter", code)
	}
	if count(t, x.db, "SELECT qty FROM claim_rate WHERE account_id=?", x.account("alice")) != limit || count(t, x.db, "SELECT count(*) FROM idempotency WHERE key='limited'") != 0 {
		t.Fatal("rate rejection committed")
	}
	x.now.Add(60)
	x.claim(c, s, "limited", v.Epoch.Id, e, 0, at(e, 0), 200)
	if count(t, x.db, "SELECT qty FROM claim_rate WHERE account_id=?", x.account("alice")) != 1 {
		t.Fatal("window reset")
	}
}

func TestWildsPOIUpdateFailureRollsBack(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "tangle")
	e := v.kind(t, "poi")
	if _, err := x.db.DB.Exec("CREATE TRIGGER fail_chart BEFORE INSERT ON entity_state WHEN NEW.state='charted' BEGIN SELECT RAISE(FAIL,'chart failed'); END"); err != nil {
		t.Fatal(err)
	}
	x.claim(c, s, "poi", v.Epoch.Id, e, 0, at(e, 0), 500)
	for _, table := range []string{"personal_claims", "discoveries", "claim_rate", "entity_state"} {
		if count(t, x.db, "SELECT count(*) FROM "+table) != 0 {
			t.Fatal("failed claim committed", table)
		}
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='wilds-claim'") != 0 {
		t.Fatal("failed claim granted loot")
	}
	x.db.DB.Exec("DROP TRIGGER fail_chart")
	x.claim(c, s, "poi", v.Epoch.Id, e, 0, at(e, 0), 200)
}

func TestWildsFallenLanterns(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	v := x.wilds(c, "tangle")
	tx, ty := lanternTile(v)
	here := atTile(tx, ty)
	for _, tc := range []struct {
		name   string
		epoch  *contract.WildsEpoch
		where  *contract.Where
		reason string
	}{
		{"curated", v.Epoch, &contract.Where{Area: "in:village:library", X: 100, Y: 100}, "not-wilds"},
		{"no epoch", nil, here, "epoch-missing"},
		{"wick land on the still epoch", v.Epoch, atTile(2*24+1, -24+1), "invalid-place"},
		{"outside the frontier", v.Epoch, atTile(6*24, -10), "invalid-place"},
		{"a chunk never made", v.near.Wick, atTile(4*24+1, -8*24+1), "epoch-missing"},
		{"wall", v.Epoch, atTile(fakegen.Thicket[0], -24+fakegen.Thicket[1]), "invalid-place"},
	} {
		if got := x.fall("alice", tc.epoch, tc.where); got.Lantern != "none" || got.Reason != tc.reason || got.ID != "" {
			t.Fatalf("%s: %+v", tc.name, got)
		}
	}
	first := x.fall("alice", v.Epoch, here)
	second := x.fall("alice", v.Epoch, here)
	if first.Lantern != "placed" || first.Reason != "" || first.Epoch != v.Epoch.Id || first.ID == second.ID || count(t, x.db, "SELECT count(*) FROM lanterns") != 1 {
		t.Fatal("replacement", first, second)
	}
	if got := x.fall("alice", v.Epoch, here); got.Reason != "daily-cap" {
		t.Fatal("cap", got)
	}
	read := x.wilds(c, "tangle")
	if len(read.Lanterns) != 1 || read.Lanterns[0].Id != second.ID || int(read.Lanterns[0].X) != tx || int(read.Lanterns[0].Y) != ty {
		t.Fatal("lantern view", read.Lanterns)
	}
	// UTC midnight resets the cap.
	x.now.Store(time.Unix(x.now.Load(), 0).UTC().Truncate(24 * time.Hour).Add(24 * time.Hour).Unix())
	if got := x.fall("alice", v.Epoch, here); got.Lantern != "placed" {
		t.Fatal("cap reset", got)
	}
	// An ended epoch takes no lantern.
	if _, err := x.db.DB.Exec("UPDATE wild_epochs SET ends_at=? WHERE id=?", x.now.Load(), v.Epoch.Id); err != nil {
		t.Fatal(err)
	}
	if got := x.fall("alice", v.Epoch, here); got.Reason != "epoch-missing" {
		t.Fatal("ended", got)
	}
}

func TestWildsRelight(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	v := x.wilds(c, "tangle")
	ep := v.Epoch.Id
	tx, ty := lanternTile(v)
	here := atTile(tx, ty)
	relight := func(cookie *http.Cookie, r response, key, owner, id string, where *contract.Where, status int) (*contract.WildsLanternResult, string) {
		env, code := x.call("/api/wilds/lantern", &contract.WildsLanternRequest{Op: op(r.Lease, key), Epoch: ep, OwnerId: x.account(owner), LanternId: id, Where: where}, cookie, status)
		return env.GetWildsLantern(), code
	}
	first := x.fall("alice", v.Epoch, here)
	second := x.fall("alice", v.Epoch, here)
	relight(bc, b, "obsolete", "alice", first.ID, here, 404)
	if _, code := relight(bc, b, "in:village:library", "alice", second.ID, &contract.Where{Area: "in:village:library", X: 1, Y: 1}, 409); code != "not-in-wilds" {
		t.Fatal(code)
	}
	if _, code := relight(bc, b, "far", "alice", second.ID, atTile(tx+4, ty), 409); code != "too-far-away" {
		t.Fatal(code)
	}
	own, _ := relight(c, s, "own", "alice", second.ID, here, 200)
	if own.Rewarded || len(own.Loot.Materials) != 0 || own.Lanterns[0].LitBy.GetValue() != x.account("alice") {
		t.Fatal("own relight", own)
	}
	if _, code := relight(bc, b, "already-lit", "alice", second.ID, here, 409); code != "already-lit" {
		t.Fatal(code)
	}
	oc, o := x.ready("outsider")
	relight(oc, o, "other-world", "alice", second.ID, here, 403)
	limit := int(content.Rules.GetWildsLimits().GetLanternRelightsPerDay())
	for i := 0; i <= limit; i++ {
		owner := fmt.Sprintf("fallen%d", i)
		x.member(owner, s.WorldID)
		fallen := x.fall(owner, v.Epoch, here)
		req := &contract.WildsLanternRequest{Op: op(b.Lease, fmt.Sprintf("light%d", i)), Epoch: ep, OwnerId: x.account(owner), LanternId: fallen.ID, Where: here}
		lit, _ := x.call("/api/wilds/lantern", req, bc, 200)
		if lit.GetWildsLantern().Rewarded != (i < limit) {
			t.Fatal("daily reward cap")
		}
		replay, _ := x.call("/api/wilds/lantern", req, bc, 200)
		if !proto.Equal(lit.GetWildsLantern(), replay.GetWildsLantern()) {
			t.Fatal("relight replay")
		}
	}
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner=? AND item_def='amber'", x.account("bob")) != limit*int(content.Rules.GetWildsLimits().GetLanternReward().GetQty()) {
		t.Fatal("relight balance")
	}
	x.now.Store(time.Unix(x.now.Load(), 0).UTC().Truncate(24 * time.Hour).Add(24 * time.Hour).Unix())
	next := x.fall("alice", v.Epoch, here)
	if lit, _ := relight(bc, b, "tomorrow", "alice", next.ID, here, 200); !lit.Rewarded {
		t.Fatal("UTC reward reset")
	}
}

// fakeEcho assigns `member` to the first Echo site of the epoch and checks
// it was given every site with its chunk.
func fakeEcho(t *testing.T, member string, seen *ports.EchoInput) portstest.FakeStory {
	return portstest.FakeStory{
		Assign: func(_ context.Context, tx *sql.Tx, s store.Snapshot, in ports.EchoInput) ([]*contract.EchoAssignment, error) {
			if tx == nil {
				t.Error("story rules called outside the transaction")
			}
			*seen = in
			for _, site := range in.Sites {
				if site.Site.Kind == contract.SiteKind_SITE_KIND_ECHO {
					return []*contract.EchoAssignment{{Site: site.Site.Id, Member: member, Settled: slices.Contains(s.State.Flags, "echo:"+member)}}, nil
				}
			}
			return nil, nil
		},
		Check: func(_ context.Context, _ *sql.Tx, _ store.Snapshot, in ports.PaperInput) (bool, error) {
			return in.Paper == "tams-ox-words" && in.Site != "" || in.Paper == "failed-grid-of-sector-4" && in.Entity != "", nil
		},
		Give: func(_ context.Context, _ *sql.Tx, s *store.Snapshot, paper string, _ int64) (ports.Grant, error) {
			mark := "paper:" + paper
			if slices.Contains(s.State.Flags, mark) {
				return ports.Grant{Paper: paper}, nil
			}
			s.State.Flags = append(s.State.Flags, mark)
			return ports.Grant{Added: true, Paper: paper}, nil
		},
	}
}

func TestWildsEchoesAndSettle(t *testing.T) {
	x := newRig(t)
	var seen ports.EchoInput
	x.api.Config.Story = fakeEcho(t, "tam", &seen)
	c, s := x.ready("alice")
	v := x.wilds(c, "whitequiet")
	if len(seen.Sites) != 7 || seen.Epoch.GetId() != v.Epoch.Id {
		t.Fatalf("echo rule input: %d sites", len(seen.Sites))
	}
	var site ports.EchoSite
	for _, es := range seen.Sites {
		if es.Site.Kind == contract.SiteKind_SITE_KIND_ECHO {
			site = es
			break
		}
	}
	if len(v.Echoes) != 1 || v.Echoes[0].Site != site.Site.Id || v.Echoes[0].Member != "tam" || v.Echoes[0].Settled {
		t.Fatal("Whitequiet echoes", v.Echoes)
	}
	where := atTile(int(site.CX)*24+int(site.Site.Tx), int(site.CY)*24+int(site.Site.Ty))
	settle := func(key, member string, w *contract.Where, status int) (*contract.SettleEchoResult, string) {
		env, code := x.call("/api/wilds/echo", &contract.SettleEchoRequest{Op: op(s.Lease, key), Epoch: v.Epoch.Id, Site: site.Site.Id, Member: member, Where: w}, c, status)
		return env.GetSettleEcho(), code
	}
	if _, code := settle("wrong-member", "the-twins", where, 409); code != "echo-not-here" {
		t.Fatal(code)
	}
	far := atTile(int(site.CX)*24+int(site.Site.Tx)+5, int(site.CY)*24+int(site.Site.Ty))
	if _, code := settle("far", "tam", far, 409); code != "echo-not-here" {
		t.Fatal(code)
	}
	got, _ := settle("tam", "tam", where, 200)
	if got.Member != "tam" || got.Site != site.Site.Id || got.Paper != "tams-ox-words" {
		t.Fatal(got)
	}
	state := x.expect("GET", "/api/state", nil, c, 200)
	if !slices.Contains(state.State.Flags, "echo:tam") || !slices.Contains(state.State.Flags, "paper:tams-ox-words") {
		t.Fatal("settle marks", state.State.Flags)
	}
	replay, _ := settle("tam", "tam", where, 200)
	if !proto.Equal(replay, got) {
		t.Fatal("settle replay")
	}
	if _, code := settle("again", "tam", where, 409); code != "echo-not-here" {
		t.Fatal("settled twice", code)
	}
	if v = x.wilds(c, "whitequiet"); !v.Echoes[0].Settled {
		t.Fatal("settled echo shown unsettled")
	}
}

func TestWildsClaimGrantsPapersThroughTheRules(t *testing.T) {
	x := newRig(t)
	var seen ports.EchoInput
	x.api.Config.Story = fakeEcho(t, "tam", &seen)
	c, s := x.ready("alice")
	v := x.wilds(c, "tangle")
	poi := v.kind(t, "poi")
	got, _ := x.claim(c, s, "poi", v.Epoch.Id, poi, 0, at(poi, 0), 200)
	if !slices.Equal(got.Papers, []string{"failed-grid-of-sector-4"}) {
		t.Fatal(got.Papers)
	}
	node := v.kind(t, "node")
	if got, _ = x.claim(c, s, "node", v.Epoch.Id, node, 0, at(node, 0), 200); len(got.Papers) != 0 {
		t.Fatal("a second grant of the same paper", got.Papers)
	}
}

// A calendar retuned under a live Whitequiet never reopens the ended epoch.
func TestWildsCalendarRetuningDoesNotReuseEndedEpoch(t *testing.T) {
	for _, change := range []string{"wick-days", "epoch", "same-start-new-end"} {
		t.Run(change, func(t *testing.T) {
			saved := content.CalendarRules
			// A clone: the subtest retunes its own calendar, and the
			// restore hands the shared table back untouched.
			content.CalendarRules = proto.Clone(saved).(*content.Calendar)
			defer func() { content.CalendarRules = saved }()
			epoch, _ := time.Parse(time.RFC3339, saved.Epoch)
			x := newRig(t)
			firstDay, nextDay := int64(70), int64(140)
			if change == "same-start-new-end" {
				firstDay, nextDay = 0, 10
			}
			x.now.Store(epoch.Unix() + firstDay*86400)
			c, _ := x.ready("alice")
			old := x.wilds(c, "whitequiet")
			if change == "epoch" {
				content.CalendarRules.Epoch = epoch.Add(70 * 24 * time.Hour).Format(time.RFC3339)
			} else {
				content.CalendarRules.WickDays = 14
			}
			x.now.Store(epoch.Unix() + nextDay*86400)
			c, s := x.again("alice")
			current := x.wilds(c, "whitequiet")
			day := content.CalendarAt(content.CalendarRules, x.now.Load())
			if current.Epoch.Id == old.Epoch.Id || int64(current.Epoch.StartsAt) != day.StartsAt || int64(current.Epoch.EndsAt.GetValue()) != day.NextTurning {
				t.Fatal("retuned calendar reused old interval", current.Epoch)
			}
			// Refused either way: ended, or gone when it ended before this
			// wick began.
			node := old.kind(t, "node")
			raw, _ := protojson.Marshal(&contract.WildsClaimRequest{Op: op(s.Lease, "ended"), Epoch: old.Epoch.Id, EntityId: node.Id, Where: at(node, 0)})
			if w := x.rawHTTP("POST", "/api/wilds/claim", json.RawMessage(raw), c); w.Code != 409 && w.Code != 404 || !strings.Contains(w.Body.String(), "epoch-ended") && !strings.Contains(w.Body.String(), "epoch-not-found") {
				t.Fatal("old epoch reopened", w.Code, w.Body.String())
			}
		})
	}
}

func TestWildsOuterTurning(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	inner := x.wilds(c, "tangle")
	outer := x.wilds(c, "whitequiet")
	day := content.CalendarAt(content.CalendarRules, x.now.Load())
	node := outer.kind(t, "node")
	x.claim(c, s, "outer-node", outer.Epoch.Id, node, 0, at(node, 0), 200)
	x.now.Store(day.NextTurning - 86400)
	if x.wilds(c, "whitequiet").Epoch.Id != outer.Epoch.Id {
		t.Fatal("early Turning")
	}
	x.now.Store(day.NextTurning)
	c, s = x.again("alice")
	if _, code := x.claim(c, s, "ended", outer.Epoch.Id, node, 1, at(node, 0), 409); code != "epoch-ended" {
		t.Fatal("old epoch accepted", code)
	}
	next := x.wilds(c, "whitequiet")
	if next.Epoch.Id == outer.Epoch.Id || next.Epoch.Season == outer.Epoch.Season || next.Epoch.EndsAt == nil {
		t.Fatal("no new epoch")
	}
	if x.wilds(c, "tangle").Epoch.Id != inner.Epoch.Id {
		t.Fatal("inner turned")
	}
	// The wick that just ended stays until the next turning.
	if count(t, x.db, "SELECT count(*) FROM wild_epochs WHERE kind='wick'") != 2 {
		t.Fatal("wick epoch count")
	}
	// A build without this generator makes no new epoch, and stored ones
	// of another version are never served.
	x.now.Store(int64(next.Epoch.EndsAt.GetValue()) + 10)
	c, _ = x.again("alice")
	x.api.Config.Epochs.(*store.Chunks).Generator = nil
	if w := x.rawHTTP("GET", "/api/wilds/near/0/-4", nil, c); w.Code != 503 || !strings.Contains(w.Body.String(), "generator-unavailable") {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestWardenSliverClaimGrantCapReplayAndLedger(t *testing.T) {
	x := newRig(t)
	seedCookie, seed := x.ready("probe")
	v := x.wilds(seedCookie, "tangle")
	deep := []*contract.WildsEntity{}
	for _, entity := range v.bodies {
		cx, cy := entityChunkOf(entity)
		if (entity.Kind == "node" || entity.Kind == "chest") && deepCountry(cx, cy) {
			deep = append(deep, entity)
		}
	}
	if len(deep) < 2 {
		t.Fatal("expected at least two entities in deep Tangle")
	}
	player := "sliver-hunter"
	x.member(player, seed.WorldID)
	account := x.account(player)
	week := int(x.now.Load() / (7 * 86400))
	var first *contract.WildsEntity
	for n := 0; n < 10000 && first == nil; n++ {
		for _, entity := range deep {
			var cx, cy int
			fmt.Sscanf(entity.Id, entity.Kind+":%d:%d:", &cx, &cy)
			if wilds.Hash(account, entity.Id, week, "warden-sliver", cx, cy)%1000 < 2 {
				first = entity
				break
			}
		}
		if first == nil {
			week++
		}
	}
	if first == nil {
		t.Fatal("no deterministic rare roll for actual random account")
	}
	x.now.Store(int64(week)*7*86400 + 3600)
	c, s := x.again(player)
	v = x.wilds(c, "tangle")
	var second *contract.WildsEntity
	for _, e := range deep {
		if e.Id != first.Id {
			second = e
			break
		}
	}
	req := &contract.WildsClaimRequest{Op: op(s.Lease, "rare-find"), Epoch: v.Epoch.Id, EntityId: first.Id, Where: at(first, 0)}
	grant, _ := x.call("/api/wilds/claim", req, c, 200)
	if !grant.GetWildsClaim().WardenSliverFound {
		t.Fatal("expected claim response to report the warden sliver")
	}
	replay, _ := x.call("/api/wilds/claim", req, c, 200)
	if !proto.Equal(replay.GetWildsClaim(), grant.GetWildsClaim()) {
		t.Fatal("claim replay changed the response")
	}
	blocked, _ := x.claim(c, s, "weekly-cap", v.Epoch.Id, second, 0, at(second, 0), 200)
	if blocked.WardenSliverFound || count(t, x.db, "SELECT count(*) FROM warden_finds WHERE account_id=?", account) != 1 {
		t.Fatal("weekly cap granted a second sliver")
	}
	if count(t, x.db, "SELECT count(*) FROM item_instances WHERE location='pack' AND owner=? AND item_def='warden-sliver'", account) != 1 {
		t.Fatal("expected exactly one sliver instance")
	}
	x.conserved(account)
}

func TestHomesteadLandServed(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	w := x.rawHTTP("GET", "/api/homestead/land/0", nil, c)
	var got contract.HomesteadLand
	if w.Code != 200 || protojson.Unmarshal(w.Body.Bytes(), &got) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	cfg := content.HomeRules.Land
	want := land.Generate(land.Seed(s.WorldID, 0, cfg), cfg)
	if got.GeneratorVersion != 2 || int(got.Width) != want.Width || int(got.Height) != want.Height || len(got.Cells) != len(want.Tiles) {
		t.Fatal("land shape", got.Width, got.Height, len(got.Cells))
	}
	for i, k := range want.Tiles {
		if got.Cells[i] != land.CellNames[k] {
			t.Fatalf("cell %d: %s, want %s", i, got.Cells[i], land.CellNames[k])
		}
	}
	for _, gate := range []string{"999", "-1", "01", "x", ""} {
		if w := x.rawHTTP("GET", "/api/homestead/land/"+gate, nil, c); w.Code != 404 {
			t.Fatal(gate, w.Code)
		}
	}
	if w := x.rawHTTP("GET", "/api/homestead/land/0", nil, nil); w.Code != 401 {
		t.Fatal("no session", w.Code)
	}
}

// Deep country (rare finds): tier 2 and past, or the Tangle's far corners
// from its middle chunk.
func TestDeepCountryByTier(t *testing.T) {
	for _, c := range []struct {
		cx, cy int
		deep   bool
	}{{0, -1, false}, {0, 0, false}, {1, -1, false}, {-1, 0, true}, {1, -2, true}, {0, -4, true}, {3, -7, true}, {-4, 0, true}} {
		if deepCountry(c.cx, c.cy) != c.deep {
			t.Errorf("%d,%d", c.cx, c.cy)
		}
	}
}
