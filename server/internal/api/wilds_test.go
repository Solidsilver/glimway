package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/land"
	"glimway/server/internal/ports"
	"glimway/server/internal/store"
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

// wildsView is a region read with the bodies of its stored chunks.
type wildsView struct {
	*contract.WildsRegionResult
	chunks []*contract.WildsChunk
	bodies []*contract.WildsEntity
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

// fixtureSeed: every tested entity kind is present in this world seed.
const fixtureSeed = "phase34-tests"

// wilds reads a region (creating its epoch on first read) and its chunks.
func (x *rig) wilds(c *http.Cookie, region string) wildsView {
	x.t.Helper()
	if _, err := x.db.DB.Exec("UPDATE worlds SET seed=? WHERE id NOT IN (SELECT world_id FROM region_epochs)", fixtureSeed); err != nil {
		x.t.Fatal(err)
	}
	w := x.rawHTTP("GET", "/api/wilds/region/"+region, nil, c)
	if w.Code != 200 {
		x.t.Fatalf("region read: %d %s", w.Code, w.Body.String())
	}
	v := wildsView{WildsRegionResult: &contract.WildsRegionResult{}}
	if err := protojson.Unmarshal(w.Body.Bytes(), v.WildsRegionResult); err != nil {
		x.t.Fatal(err)
	}
	def, _ := regionDefinition(region)
	for cy := 0; cy < def.GridHeight; cy++ {
		for cx := 0; cx < def.GridWidth; cx++ {
			m := x.chunk(c, v.Epoch.Id, 0, cx, cy, 200)
			v.chunks = append(v.chunks, m)
			v.bodies = append(v.bodies, m.Entities...)
		}
	}
	return v
}

func (x *rig) chunk(c *http.Cookie, epoch string, layer, cx, cy, status int) *contract.WildsChunk {
	x.t.Helper()
	w := x.rawHTTP("GET", fmt.Sprintf("/api/wilds/chunk/%s/%d/%d/%d", epoch, layer, cx, cy), nil, c)
	if w.Code != status {
		x.t.Fatalf("chunk %d,%d: %d %s", cx, cy, w.Code, w.Body.String())
	}
	if status != 200 {
		return nil
	}
	m := &contract.WildsChunk{}
	if err := proto.Unmarshal(w.Body.Bytes(), m); err != nil {
		x.t.Fatal(err)
	}
	return m
}

// at is the region-pixel `where` on an entity's tile, dx tiles east.
func at(region string, e *contract.WildsEntity, dx int) *contract.Where {
	var cx, cy int
	fmt.Sscanf(e.Id, e.Kind+":%d:%d:", &cx, &cy)
	S := content.WildsRules.ChunkSize
	return &contract.Where{Area: wildsArea(region), X: float64((cx*S + int(e.Tx) + dx) * 16), Y: float64((cy*S + int(e.Ty)) * 16)}
}

// atTile is the region-pixel `where` at a region tile's centre.
func atTile(region string, tx, ty int) *contract.Where {
	return &contract.Where{Area: wildsArea(region), X: float64(tx*16 + 8), Y: float64(ty*16 + 8)}
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

// lanternTile is a walkable region tile beside an entity (entities stand in
// clearings), where fallen lanterns go in these tests.
func lanternTile(v wildsView) (int, int) {
	e := v.bodies[0]
	var cx, cy int
	fmt.Sscanf(e.Id, e.Kind+":%d:%d:", &cx, &cy)
	return cx*24 + int(e.Tx), cy*24 + int(e.Ty)
}

func TestWildsRegionCreatesEpochAndStoresChunks(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	v := x.wilds(c, "inner-1")
	if v.Epoch.GeneratorVersion != 2 || v.Epoch.Season != "0" || v.Epoch.EndsAt != nil {
		t.Fatalf("epoch %+v", v.Epoch)
	}
	if count(t, x.db, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=?", v.Epoch.Id) != 9 {
		t.Fatal("nine chunks not stored at creation")
	}
	if len(v.Entities) != len(v.bodies) || len(v.Entities) == 0 {
		t.Fatal("entity states don't match the chunks' bodies")
	}
	for _, e := range v.Entities {
		if e.Cycle != 0 || e.State != "available" || e.Epoch != v.Epoch.Id {
			t.Fatalf("fresh entity %+v", e)
		}
	}
	for i, m := range v.chunks {
		if chunks.Validate(m) != nil || m.EpochId != v.Epoch.Id || int(m.Cx) != i%3 || int(m.Cy) != i/3 {
			t.Fatalf("chunk %d", i)
		}
	}
	// The stored chunks are the generator's, packed.
	g, _ := wilds.GenerateChunk(generationOf(v.Epoch), 1, 1)
	if !proto.Equal(wilds.ToProto(g, v.Epoch.Id), v.chunks[4]) {
		t.Fatal("served chunk differs from the generator's")
	}
	// The same world reads the same epoch; the read writes nothing more.
	before := count(t, x.db, "SELECT (SELECT count(*) FROM region_epochs)+(SELECT count(*) FROM wilds_chunks)+(SELECT count(*) FROM entity_state)+(SELECT sum(version) FROM players)")
	again := x.wilds(c, "inner-1")
	if again.Epoch.Id != v.Epoch.Id || before != count(t, x.db, "SELECT (SELECT count(*) FROM region_epochs)+(SELECT count(*) FROM wilds_chunks)+(SELECT count(*) FROM entity_state)+(SELECT sum(version) FROM players)") {
		t.Fatal("a second read wrote")
	}
	outer := x.wilds(c, "outer-1")
	day := content.CalendarAt(content.CalendarRules, x.now.Load())
	if outer.Epoch.Season != fmt.Sprintf("t:%d:%d", day.StartsAt, day.NextTurning) || outer.Epoch.EndsAt == nil || int64(outer.Epoch.EndsAt.Value) != day.NextTurning {
		t.Fatalf("outer epoch %+v", outer.Epoch)
	}
	x.rawHTTP("GET", "/api/wilds/region/not-a-region", nil, c)
	if w := x.rawHTTP("GET", "/api/wilds/region/not-a-region", nil, c); w.Code != 404 {
		t.Fatal("unknown region", w.Code)
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
	api2.Config.Regions, api2.Config.Lanterns, api2.Config.HomeLand = wildsService{api2}, wildsService{api2}, wildsService{api2}
	var wg sync.WaitGroup
	for i, cookie := range []*http.Cookie{c, bc} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("GET", "/api/wilds/region/outer-1", nil)
			r.Header.Set("X-Glimway-Contract", "4")
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
	if count(t, x.db, "SELECT count(*) FROM region_epochs WHERE region_id='outer-1'") != 1 || count(t, x.db, "SELECT count(*) FROM wilds_chunks") != 9 {
		t.Fatal("concurrent first reads made two epochs")
	}
}

func TestWildsChunkRoute(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	v := x.wilds(c, "inner-1")
	w := x.rawHTTP("GET", "/api/wilds/chunk/"+v.Epoch.Id+"/0/1/1", nil, c)
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/x-protobuf" || w.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatal(w.Code, w.Header())
	}
	for _, path := range []string{"0/3/1", "1/1/1", "0/1", "0/01/1", "0/1/1/2", "0/x/1"} {
		if w := x.rawHTTP("GET", "/api/wilds/chunk/"+v.Epoch.Id+"/"+path, nil, c); w.Code != 404 {
			t.Fatal(path, w.Code)
		}
	}
	x.chunk(c, "unknown-epoch", 0, 1, 1, 404)
	if w := x.rawHTTP("GET", "/api/wilds/chunk/"+v.Epoch.Id+"/0/1/1", nil, nil); w.Code != 401 {
		t.Fatal("no session", w.Code)
	}
	// Another world's epoch is not found, not forbidden: ids don't leak.
	oc, _ := x.ready("outsider")
	x.chunk(oc, v.Epoch.Id, 0, 1, 1, 404)
	if _, err := x.db.DB.Exec("UPDATE region_epochs SET ends_at=? WHERE id=?", x.now.Load(), v.Epoch.Id); err != nil {
		t.Fatal(err)
	}
	w = x.rawHTTP("GET", "/api/wilds/chunk/"+v.Epoch.Id+"/0/1/1", nil, c)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "epoch-ended") {
		t.Fatal("ended epoch chunk", w.Code)
	}
}

func TestWildsClaimCyclesProjectionAndRace(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	v := x.wilds(c, "inner-1")
	ep := v.Epoch.Id
	camp := v.kind(t, "camp")
	other, err := store.Open(filepath.Join(x.dir, "game.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	api2 := New(other, x.api.Habitica, x.api.Config)
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for i, pair := range []struct {
		c *http.Cookie
		s response
	}{{c, s}, {bc, b}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			raw, _ := protojson.Marshal(&contract.WildsClaimRequest{Op: op(pair.s.Lease, "race"), Epoch: ep, EntityId: camp.Id, Where: at("inner-1", camp, 0)})
			r := httptest.NewRequest("POST", "/api/wilds/claim", bytes.NewReader(raw))
			r.Header.Set("X-Glimway-Contract", "4")
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(pair.c)
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
	if wins != 1 || losses != 1 || count(t, x.db, "SELECT count(*) FROM ledger WHERE currency='embers' AND reason='wilds-claim'") != 1 {
		t.Fatal("claim race", wins, losses)
	}
	// Long after: exactly one cycle ahead, projected by the read, not written.
	x.now.Add(10 * int64(content.WildsRules.Timers.CampRespawnSeconds))
	next := x.wilds(c, "inner-1")
	if st := next.state(camp.Id); st.Cycle != 1 || st.State != "available" || st.By != nil {
		t.Fatalf("projection %+v", st)
	}
	if count(t, x.db, "SELECT cycle FROM entity_state WHERE epoch=? AND entity_id=?", ep, camp.Id) != 0 {
		t.Fatal("the read wrote the projection")
	}
	if _, code := x.claim(c, s, "old", ep, camp, 0, at("inner-1", camp, 0), 409); code != "old-cycle" {
		t.Fatal("old cycle", code)
	}
	if _, code := x.claim(c, s, "ahead", ep, camp, 2, at("inner-1", camp, 0), 409); code != "old-cycle" {
		t.Fatal("cycle ahead", code)
	}
	got, _ := x.claim(c, s, "cycle1", ep, camp, 1, at("inner-1", camp, 0), 200)
	if got.Entity.Cycle != 1 || got.Entity.State != "cleared" || count(t, x.db, "SELECT cycle FROM entity_state WHERE epoch=? AND entity_id=?", ep, camp.Id) != 1 {
		t.Fatal("the claim didn't persist the projected cycle")
	}
	node := next.kind(t, "node")
	x.claim(c, s, "node0", ep, node, 0, at("inner-1", node, 0), 200)
	x.now.Add(int64(content.WildsRules.Timers.NodeRegrowSeconds))
	x.claim(c, s, "node1", ep, node, 1, at("inner-1", node, 0), 200)
	for _, invalid := range []string{"camp:3:0:0", "camp:-1:0:0", "camp:0:0:999", "node:0:0:00", "node:0:0:0junk", "camp:1"} {
		e := &contract.WildsEntity{Id: invalid, Kind: "camp"}
		if _, code := x.claim(c, s, invalid, ep, e, 0, at("inner-1", node, 0), 404); code != "entity-not-found" {
			t.Fatal(invalid, code)
		}
	}
	oc, o := x.ready("outsider")
	x.claim(oc, o, "other-world", ep, camp, 1, at("inner-1", camp, 0), 403)
	if _, err = x.db.DB.Exec("UPDATE region_epochs SET ends_at=? WHERE id=?", x.now.Load(), ep); err != nil {
		t.Fatal(err)
	}
	if _, code := x.claim(c, s, "ended", ep, camp, 2, at("inner-1", camp, 0), 409); code != "epoch-ended" {
		t.Fatal("ended epoch", code)
	}
	if w := x.rawHTTP("GET", "/api/wilds/region/inner-1", nil, c); w.Code != 409 || !strings.Contains(w.Body.String(), "epoch-ended") {
		t.Fatal("ended read reopened", w.Code)
	}
}

func TestWildsClaimReach(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "inner-1")
	for _, kind := range []string{"node", "camp", "chest", "poi"} {
		e := v.kind(t, kind)
		if _, code := x.claim(c, s, kind+"-village", v.Epoch.Id, e, 0, &contract.Where{Area: "village", X: 10, Y: 10}, 409); code != "not-in-wilds" {
			t.Fatal(kind, code)
		}
		wrong := at("inner-1", e, 0)
		wrong.Area = "wilds:outer-1"
		if _, code := x.claim(c, s, kind+"-region", v.Epoch.Id, e, 0, wrong, 409); code != "not-in-wilds" {
			t.Fatal(kind, code)
		}
		if _, code := x.claim(c, s, kind+"-far", v.Epoch.Id, e, 0, at("inner-1", e, 4), 409); code != "too-far-away" {
			t.Fatal(kind, code)
		}
		// Chunk-local pixels never stand for region pixels.
		local := &contract.Where{Area: "wilds:inner-1", X: float64(e.Tx * 16), Y: float64(e.Ty * 16)}
		if !strings.HasPrefix(e.Id, kind+":0:0:") {
			x.claim(c, s, kind+"-local", v.Epoch.Id, e, 0, local, 409)
		}
		x.claim(c, s, kind+"-near", v.Epoch.Id, e, 0, at("inner-1", e, 2), 200)
	}
	// A refusal still moved nobody: the last committed place is the claim's.
	state := x.expect("GET", "/api/state", nil, c, 200)
	if state.State.Area != "wilds:inner-1" {
		t.Fatal("place", state.State.Area)
	}
}

func TestWildsPersonalClaimsDiscoveryAndReplay(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	v := x.wilds(c, "inner-1")
	ep := v.Epoch.Id
	chest, poi := v.kind(t, "chest"), v.kind(t, "poi")
	req := &contract.WildsClaimRequest{Op: op(s.Lease, "chest"), Epoch: ep, EntityId: chest.Id, Where: at("inner-1", chest, 0)}
	grant, _ := x.call("/api/wilds/claim", req, c, 200)
	loot, err := wilds.RollEntityLoot(generationOf(v.Epoch), wilds.EntityFromProto(chest), 0)
	if err != nil || !proto.Equal(grant.GetWildsClaim().Loot, lootProto(loot)) {
		t.Fatal("deterministic loot")
	}
	replay, _ := x.call("/api/wilds/claim", req, c, 200)
	if !proto.Equal(replay.GetWildsClaim(), grant.GetWildsClaim()) || count(t, x.db, "SELECT count(*) FROM ledger WHERE currency='embers' AND reason='wilds-claim'") != 1 {
		t.Fatal("claim replay")
	}
	req.EntityId = poi.Id
	if _, code := x.call("/api/wilds/claim", req, c, 409); code != "idempotency-mismatch" {
		t.Fatal("key mismatch", code)
	}
	x.claim(bc, b, "chest", ep, chest, 0, at("inner-1", chest, 0), 200)
	if _, code := x.claim(c, s, "chest-again", ep, chest, 0, at("inner-1", chest, 0), 409); code != "already-claimed" {
		t.Fatal(code)
	}
	x.claim(c, s, "poi", ep, poi, 0, at("inner-1", poi, 0), 200)
	x.claim(bc, b, "poi", ep, poi, 0, at("inner-1", poi, 0), 200)
	v = x.wilds(c, "inner-1")
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
	v := x.wilds(c, "inner-1")
	limit := content.Rules.WildsLimits.ClaimsPerMinute
	if len(v.bodies) <= limit {
		t.Fatal("insufficient entities for limit")
	}
	var last *contract.WildsClaimRequest
	for i := 0; i < limit; i++ {
		e := v.bodies[i]
		last = &contract.WildsClaimRequest{Op: op(s.Lease, fmt.Sprintf("claim%d", i)), Epoch: v.Epoch.Id, EntityId: e.Id, Where: at("inner-1", e, 0)}
		x.call("/api/wilds/claim", last, c, 200)
	}
	x.call("/api/wilds/claim", last, c, 200)
	e := v.bodies[limit]
	if _, code := x.claim(c, s, "limited", v.Epoch.Id, e, 0, at("inner-1", e, 0), 429); code != "claim-rate-limited" {
		t.Fatal("rate limiter", code)
	}
	if count(t, x.db, "SELECT qty FROM claim_rate WHERE account_id=?", x.account("alice")) != limit || count(t, x.db, "SELECT count(*) FROM idempotency WHERE key='limited'") != 0 {
		t.Fatal("rate rejection committed")
	}
	x.now.Add(60)
	x.claim(c, s, "limited", v.Epoch.Id, e, 0, at("inner-1", e, 0), 200)
	if count(t, x.db, "SELECT qty FROM claim_rate WHERE account_id=?", x.account("alice")) != 1 {
		t.Fatal("window reset")
	}
}

func TestWildsPOIUpdateFailureRollsBack(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "inner-1")
	e := v.kind(t, "poi")
	if _, err := x.db.DB.Exec("CREATE TRIGGER fail_chart BEFORE INSERT ON entity_state WHEN NEW.state='charted' BEGIN SELECT RAISE(FAIL,'chart failed'); END"); err != nil {
		t.Fatal(err)
	}
	x.claim(c, s, "poi", v.Epoch.Id, e, 0, at("inner-1", e, 0), 500)
	for _, table := range []string{"personal_claims", "discoveries", "claim_rate", "entity_state"} {
		if count(t, x.db, "SELECT count(*) FROM "+table) != 0 {
			t.Fatal("failed claim committed", table)
		}
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='wilds-claim'") != 0 {
		t.Fatal("failed claim granted loot")
	}
	x.db.DB.Exec("DROP TRIGGER fail_chart")
	x.claim(c, s, "poi", v.Epoch.Id, e, 0, at("inner-1", e, 0), 200)
}

func TestWildsFallenLanterns(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	v := x.wilds(c, "inner-1")
	tx, ty := lanternTile(v)
	here := atTile("inner-1", tx, ty)
	for _, tc := range []struct {
		name   string
		epoch  *contract.WildsEpoch
		where  *contract.Where
		reason string
	}{
		{"curated", v.Epoch, &contract.Where{Area: "village", X: 100, Y: 100}, "not-wilds"},
		{"no epoch", nil, here, "epoch-missing"},
		{"other region", v.Epoch, atTile("outer-1", tx, ty), "invalid-place"},
		{"outside the grid", v.Epoch, atTile("inner-1", 72, 10), "invalid-place"},
		{"negative", v.Epoch, &contract.Where{Area: "wilds:inner-1", X: -3, Y: 10}, "invalid-place"},
		{"wall", v.Epoch, atTile("inner-1", 0, 0), "invalid-place"},
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
	read := x.wilds(c, "inner-1")
	if len(read.Lanterns) != 1 || read.Lanterns[0].Id != second.ID || int(read.Lanterns[0].X) != tx || int(read.Lanterns[0].Y) != ty {
		t.Fatal("lantern view", read.Lanterns)
	}
	// UTC midnight resets the cap.
	x.now.Store(time.Unix(x.now.Load(), 0).UTC().Truncate(24 * time.Hour).Add(24 * time.Hour).Unix())
	if got := x.fall("alice", v.Epoch, here); got.Lantern != "placed" {
		t.Fatal("cap reset", got)
	}
	// An ended epoch takes no lantern.
	if _, err := x.db.DB.Exec("UPDATE region_epochs SET ends_at=? WHERE id=?", x.now.Load(), v.Epoch.Id); err != nil {
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
	v := x.wilds(c, "inner-1")
	ep := v.Epoch.Id
	tx, ty := lanternTile(v)
	here := atTile("inner-1", tx, ty)
	relight := func(cookie *http.Cookie, r response, key, owner, id string, where *contract.Where, status int) (*contract.WildsLanternResult, string) {
		env, code := x.call("/api/wilds/lantern", &contract.WildsLanternRequest{Op: op(r.Lease, key), Epoch: ep, OwnerId: x.account(owner), LanternId: id, Where: where}, cookie, status)
		return env.GetWildsLantern(), code
	}
	first := x.fall("alice", v.Epoch, here)
	second := x.fall("alice", v.Epoch, here)
	relight(bc, b, "obsolete", "alice", first.ID, here, 404)
	if _, code := relight(bc, b, "village", "alice", second.ID, &contract.Where{Area: "village", X: 1, Y: 1}, 409); code != "not-in-wilds" {
		t.Fatal(code)
	}
	if _, code := relight(bc, b, "far", "alice", second.ID, atTile("inner-1", tx+4, ty), 409); code != "too-far-away" {
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
	limit := content.Rules.WildsLimits.LanternRelightsPerDay
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
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner=? AND item_def='amber'", x.account("bob")) != limit*content.Rules.WildsLimits.LanternReward.Qty {
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
func fakeEcho(t *testing.T, member string, seen *ports.EchoInput) ports.FakeStory {
	return ports.FakeStory{
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
	v := x.wilds(c, "outer-1")
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
		t.Fatal("region echoes", v.Echoes)
	}
	where := atTile("outer-1", int(site.CX)*24+int(site.Site.Tx), int(site.CY)*24+int(site.Site.Ty))
	settle := func(key, member string, w *contract.Where, status int) (*contract.SettleEchoResult, string) {
		env, code := x.call("/api/wilds/echo", &contract.SettleEchoRequest{Op: op(s.Lease, key), Epoch: v.Epoch.Id, Site: site.Site.Id, Member: member, Where: w}, c, status)
		return env.GetSettleEcho(), code
	}
	if _, code := settle("wrong-member", "the-twins", where, 409); code != "echo-not-here" {
		t.Fatal(code)
	}
	far := atTile("outer-1", int(site.CX)*24+int(site.Site.Tx)+5, int(site.CY)*24+int(site.Site.Ty))
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
	if v = x.wilds(c, "outer-1"); !v.Echoes[0].Settled {
		t.Fatal("settled echo shown unsettled")
	}
}

func TestWildsClaimGrantsPapersThroughTheRules(t *testing.T) {
	x := newRig(t)
	var seen ports.EchoInput
	x.api.Config.Story = fakeEcho(t, "tam", &seen)
	c, s := x.ready("alice")
	v := x.wilds(c, "inner-1")
	poi := v.kind(t, "poi")
	got, _ := x.claim(c, s, "poi", v.Epoch.Id, poi, 0, at("inner-1", poi, 0), 200)
	if !slices.Equal(got.Papers, []string{"failed-grid-of-sector-4"}) {
		t.Fatal(got.Papers)
	}
	node := v.kind(t, "node")
	if got, _ = x.claim(c, s, "node", v.Epoch.Id, node, 0, at("inner-1", node, 0), 200); len(got.Papers) != 0 {
		t.Fatal("a second grant of the same paper", got.Papers)
	}
}

// A calendar retuned under a live Whitequiet never reopens the ended epoch.
func TestWildsCalendarRetuningDoesNotReuseEndedEpoch(t *testing.T) {
	for _, change := range []string{"wick-days", "epoch", "same-start-new-end"} {
		t.Run(change, func(t *testing.T) {
			saved := content.CalendarRules
			defer func() { content.CalendarRules = saved }()
			epoch, _ := time.Parse(time.RFC3339, saved.Epoch)
			x := newRig(t)
			firstDay, nextDay := int64(70), int64(140)
			if change == "same-start-new-end" {
				firstDay, nextDay = 0, 10
			}
			x.now.Store(epoch.Unix() + firstDay*86400)
			c, _ := x.ready("alice")
			old := x.wilds(c, "outer-1")
			if change == "epoch" {
				content.CalendarRules.Epoch = epoch.Add(70 * 24 * time.Hour).Format(time.RFC3339)
			} else {
				content.CalendarRules.WickDays = 14
			}
			x.now.Store(epoch.Unix() + nextDay*86400)
			c, s := x.again("alice")
			current := x.wilds(c, "outer-1")
			day := content.CalendarAt(content.CalendarRules, x.now.Load())
			if current.Epoch.Id == old.Epoch.Id || int64(current.Epoch.StartsAt) != day.StartsAt || int64(current.Epoch.EndsAt.GetValue()) != day.NextTurning {
				t.Fatal("retuned calendar reused old interval", current.Epoch)
			}
			node := old.kind(t, "node")
			if _, code := x.claim(c, s, "ended", old.Epoch.Id, node, 0, at("outer-1", node, 0), 409); code != "epoch-ended" {
				t.Fatal("old epoch reopened", code)
			}
		})
	}
}

func TestWildsOuterTurning(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	inner := x.wilds(c, "inner-1")
	outer := x.wilds(c, "outer-1")
	day := content.CalendarAt(content.CalendarRules, x.now.Load())
	node := outer.kind(t, "node")
	x.claim(c, s, "outer-node", outer.Epoch.Id, node, 0, at("outer-1", node, 0), 200)
	x.now.Store(day.NextTurning - 86400)
	if x.wilds(c, "outer-1").Epoch.Id != outer.Epoch.Id {
		t.Fatal("early Turning")
	}
	x.now.Store(day.NextTurning)
	c, s = x.again("alice")
	if _, code := x.claim(c, s, "ended", outer.Epoch.Id, node, 1, at("outer-1", node, 0), 409); code != "epoch-ended" {
		t.Fatal("old epoch accepted", code)
	}
	next := x.wilds(c, "outer-1")
	if next.Epoch.Id == outer.Epoch.Id || next.Epoch.Season == outer.Epoch.Season || next.Epoch.EndsAt == nil {
		t.Fatal("no new epoch")
	}
	if x.wilds(c, "inner-1").Epoch.Id != inner.Epoch.Id {
		t.Fatal("inner turned")
	}
	if count(t, x.db, "SELECT count(*) FROM region_epochs WHERE region_id='outer-1'") != 2 {
		t.Fatal("outer epoch count")
	}
	// A build without this generator makes no new epoch, and stored ones
	// of another version are never served.
	x.now.Store(int64(next.Epoch.EndsAt.GetValue()) + 10)
	c, _ = x.again("alice")
	x.api.Config.Epochs.(*store.Chunks).GeneratorVersion = 3
	if w := x.rawHTTP("GET", "/api/wilds/region/outer-1", nil, c); w.Code != 503 || !strings.Contains(w.Body.String(), "generator-unavailable") {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestWardenSliverClaimGrantCapReplayAndLedger(t *testing.T) {
	x := newRig(t)
	seedCookie, seed := x.ready("probe")
	v := x.wilds(seedCookie, "inner-1")
	deep := []*contract.WildsEntity{}
	for _, entity := range v.bodies {
		var cx, cy int
		fmt.Sscanf(entity.Id, entity.Kind+":%d:%d:", &cx, &cy)
		if (entity.Kind == "node" || entity.Kind == "chest") && deepCountry("inner-1", cx, cy) {
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
	v = x.wilds(c, "inner-1")
	var second *contract.WildsEntity
	for _, e := range deep {
		if e.Id != first.Id {
			second = e
			break
		}
	}
	req := &contract.WildsClaimRequest{Op: op(s.Lease, "rare-find"), Epoch: v.Epoch.Id, EntityId: first.Id, Where: at("inner-1", first, 0)}
	grant, _ := x.call("/api/wilds/claim", req, c, 200)
	if !grant.GetWildsClaim().WardenSliverFound {
		t.Fatal("expected claim response to report the warden sliver")
	}
	replay, _ := x.call("/api/wilds/claim", req, c, 200)
	if !proto.Equal(replay.GetWildsClaim(), grant.GetWildsClaim()) {
		t.Fatal("claim replay changed the response")
	}
	blocked, _ := x.claim(c, s, "weekly-cap", v.Epoch.Id, second, 0, at("inner-1", second, 0), 200)
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
