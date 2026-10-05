package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/land"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"fingersnap/server/internal/wilds"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type expansionResponse struct {
	store.Snapshot
	Home           *homeView       `json:"home"`
	Gate           int             `json:"gate"`
	LandSeed       uint32          `json:"landSeed"`
	Materials      map[string]int  `json:"materials"`
	Epoch          regionEpoch     `json:"epoch"`
	Entities       []entityView    `json:"entities"`
	PersonalClaims []personalClaim `json:"personalClaims"`
	Discoveries    []discovery     `json:"discoveries"`
	Lanterns       []lanternView   `json:"lanterns"`
	Gates          []gateView      `json:"gates"`
	GateCount      int             `json:"gateCount"`
	Mine           *struct {
		HomeID string `json:"homeId"`
		Gate   int    `json:"gate"`
	} `json:"mine"`
	Invites []inviteView `json:"invites"`
	Result  struct {
		Home      *homeView      `json:"home"`
		Status    string         `json:"status"`
		ItemID    string         `json:"itemId"`
		LanternID string         `json:"lanternId"`
		Rewarded  bool           `json:"rewarded"`
		Loot      wilds.LootDrop `json:"loot"`
		Entity    entityView     `json:"entity"`
		Materials map[string]int `json:"materials"`
		Lanterns  []lanternView  `json:"lanterns"`
	} `json:"result"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (x *rig) exp(method, path string, body any, c *http.Cookie, status int) expansionResponse {
	x.t.Helper()
	r := httptest.NewRequest(method, path, bytes.NewBufferString(store.JSON(body)))
	r.Header.Set("Content-Type", "application/json")
	if c != nil {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	var v expansionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		x.t.Fatal(err)
	}
	if w.Code != status {
		x.t.Fatalf("%s %s: got %d %s want %d", method, path, w.Code, w.Body.String(), status)
	}
	return v
}
func body(s response, key string, fields map[string]any) map[string]any {
	out := map[string]any{"lease": s.Lease, "baseRev": s.Rev, "key": key}
	for k, v := range fields {
		out[k] = v
	}
	return out
}
func update(s *response, v expansionResponse) { s.Snapshot = v.Snapshot }
func (x *rig) fund(id string, n, earned int) {
	x.t.Helper()
	tx, err := x.db.DB.Begin()
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	s, err := store.Load(context.Background(), tx, id)
	if err == nil {
		err = store.Credit(context.Background(), tx, &s, n, earned, "test-funding", "", nil, x.now.Load())
	}
	if err == nil {
		err = store.Persist(context.Background(), tx, &s, x.now.Load())
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		x.t.Fatal(err)
	}
}
func (x *rig) member(id, world string) (*http.Cookie, response) {
	x.t.Helper()
	code, err := x.db.Invite(context.Background(), world)
	if err != nil {
		x.t.Fatal(err)
	}
	c := x.login(id, code)
	x.expect("POST", "/api/origin", map[string]any{"choice": "fresh", "key": "origin"}, c, 200)
	return c, x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
}
func (x *rig) region(c *http.Cookie) expansionResponse {
	// Stable fixture generation: every tested entity kind is present in this seed.
	if _, err := x.db.DB.Exec("UPDATE worlds SET seed='phase34-tests' WHERE id NOT IN (SELECT world_id FROM region_epochs)"); err != nil {
		x.t.Fatal(err)
	}
	return x.exp("GET", "/api/wilds/region/inner-1", nil, c, 200)
}
func entityKind(t *testing.T, v expansionResponse, kind string) entityView {
	t.Helper()
	for _, e := range v.Entities {
		if e.Kind == kind {
			return e
		}
	}
	t.Fatalf("no %s generated", kind)
	return entityView{}
}

// claimGate buys the deed to a gate from Silas and returns the caller's home.
func (x *rig) claimGate(c *http.Cookie, s *response, gate int) homeView {
	x.t.Helper()
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	v := x.exp("POST", "/api/homestead/claim", body(*s, fmt.Sprintf("claim-%d-%d", gate, s.Rev), map[string]any{"gate": gate}), c, 200)
	update(s, v)
	if v.Result.Home == nil || v.Result.Home.Gate != gate {
		x.t.Fatal("claim answer")
	}
	return *v.Result.Home
}

// litSpots are open, lit tiles of a home (start light and posts), off the
// reserved site and path, in reading order.
func litSpots(h homeView) [][2]int {
	g := groundOf(h)
	lights := connectedLights(placedItems(h), "")
	out := [][2]int{}
	for y := 0; y < g.land.Height; y++ {
		for x := 0; x < g.land.Width; x++ {
			if !land.Buildable(g.land.Effective(g.cleared, x, y)) || !land.Lit(lights, x, y) {
				continue
			}
			reserved := false
			for _, r := range content.HomeRules.OutdoorReserved {
				if (rect{x, y, 1, 1}).overlaps(rect{r.X, r.Y, r.W, r.H}) {
					reserved = true
				}
			}
			if !reserved {
				out = append(out, [2]int{x, y})
			}
		}
	}
	return out
}

func TestHomesteadClaimAccessAndCommonsRoster(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	doc := s.State
	doc.Area = "commons"
	s.Snapshot = x.expect("PUT", "/api/progress", mutation(s, doc), c, 200).Snapshot
	if count(t, x.db, "SELECT count(*) FROM homesteads") != 0 {
		t.Fatal("visiting the Commons no longer grants a plot")
	}
	rev := s.Rev
	lane := x.exp("GET", "/api/commons", nil, c, 200)
	if lane.Rev != rev || lane.GateCount != content.HomeRules.Lane.SpareGates || lane.Mine != nil || len(lane.Gates) != lane.GateCount || lane.Gates[0].HomeID != nil || lane.Gates[0].Price == nil || *lane.Gates[0].Price != 0 {
		t.Fatal("empty lane", lane.GateCount)
	}
	// An unclaimed gate can be visited: wild land, no home.
	g := x.exp("GET", "/api/homestead/gate/1", nil, c, 200)
	if g.Home != nil || g.LandSeed != land.Seed(s.WorldID, 1, content.HomeRules.Land) || g.Rev != rev {
		t.Fatal("unclaimed land")
	}
	x.exp("GET", "/api/homestead/gate/2", nil, c, 404)
	x.exp("GET", "/api/homestead/gate/01", nil, c, 404)
	h := x.claimGate(c, &s, 1)
	if h.Tier != 0 || h.Indoor != nil || !h.Member || len(h.Members) != 1 || h.Members[0].ID != "alice" || len(h.Items) != 0 {
		t.Fatal("campsite")
	}
	lane = x.exp("GET", "/api/commons", nil, c, 200)
	if lane.GateCount != 3 || lane.Mine == nil || lane.Mine.Gate != 1 || !lane.Gates[1].Mine || len(lane.Gates[1].Names) != 1 || lane.Gates[1].Members[0].ID != "alice" || lane.Gates[0].Price == nil {
		t.Fatal("lane after claim", lane.GateCount)
	}
	bc, b := x.member("bob", s.WorldID)
	visited := x.exp("GET", "/api/homestead/gate/1", nil, bc, 200)
	if visited.Home == nil || visited.Home.Member || visited.HabiticaID != "bob" || visited.Rev != b.Rev {
		t.Fatal("visitor view")
	}
	if v := x.exp("POST", "/api/homestead/claim", body(b, "taken", map[string]any{"gate": 1}), bc, 409); v.Error.Code != "gate-taken" {
		t.Fatal(v.Error.Code)
	}
	oc, _ := x.ready("outsider")
	other := x.exp("GET", "/api/commons", nil, oc, 200)
	if other.Mine != nil || other.Gates[1].HomeID != nil {
		t.Fatal("cross-world lane")
	}
	if x.exp("GET", "/api/homestead/gate/1", nil, oc, 200).Home != nil {
		t.Fatal("cross-world home")
	}
}
func TestHomesteadTransactionsIdempotencyAndPlacement(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fund("alice", 60, 20)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	x.exp("POST", "/api/homestead/buy", body(s, "no-home", map[string]any{"itemDef": "potted-fern"}), c, 409)
	h := x.claimGate(c, &s, 0)
	spots := litSpots(h)
	req := body(s, "fern", map[string]any{"itemDef": "potted-fern"})
	v := x.exp("POST", "/api/homestead/buy", req, c, 200)
	fern := v.Result.ItemID
	update(&s, v)
	duplicate := x.exp("POST", "/api/homestead/buy", req, c, 200)
	if duplicate.Result.ItemID != fern || duplicate.Rev != s.Rev || count(t, x.db, "SELECT count(*) FROM homestead_items") != 1 {
		t.Fatal("purchase replay")
	}
	req["itemDef"] = "wooden-stool"
	x.exp("POST", "/api/homestead/buy", req, c, 409)
	x.exp("POST", "/api/homestead/buy", body(s, "chair-too-soon", map[string]any{"itemDef": "reading-chair"}), c, 409)
	place := func(key, id, scene string, px, py, rotation int, status int) expansionResponse {
		return x.exp("POST", "/api/homestead/place", body(s, key, map[string]any{"itemId": id, "scene": scene, "x": px, "y": py, "rotation": rotation}), c, status)
	}
	place("no-indoor", fern, "indoor", 0, 0, 0, 409)
	place("bounds", fern, "outdoor", content.HomeRules.Land.Width, 0, 0, 409)
	place("rotation", fern, "outdoor", 0, 0, 45, 400)
	site := content.HomeRules.Land.Site
	if v := place("on-the-cottage", fern, "outdoor", site.X+2, site.Y+2, 0, 409); v.Error.Code != "placement-overlap" {
		t.Fatal("reserved cottage tiles", v.Error.Code)
	}
	x.exp("POST", "/api/homestead/place", body(s, "missing-coordinate", map[string]any{"itemId": fern, "scene": "outdoor", "rotation": 0}), c, 400)
	// Outdoors is open from the campsite on (the land is yours from the deed).
	p0 := spots[0]
	update(&s, place("place", fern, "outdoor", p0[0], p0[1], 0, 200))
	place("repeat", fern, "outdoor", p0[0], p0[1], 0, 409)
	v = x.exp("POST", "/api/homestead/buy", body(s, "stool", map[string]any{"itemDef": "wooden-stool"}), c, 200)
	stool := v.Result.ItemID
	update(&s, v)
	place("overlap", stool, "outdoor", p0[0], p0[1], 0, 409)
	p1 := spots[len(spots)-1]
	update(&s, place("elsewhere", stool, "outdoor", p1[0], p1[1], 0, 200))
	p2 := spots[len(spots)/2]
	update(&s, x.exp("POST", "/api/homestead/move", body(s, "move", map[string]any{"itemId": fern, "scene": "outdoor", "x": p2[0], "y": p2[1], "rotation": 0}), c, 200))
	update(&s, x.exp("POST", "/api/homestead/remove", body(s, "remove", map[string]any{"itemId": fern}), c, 200))
	x.exp("POST", "/api/homestead/remove", body(s, "remove-again", map[string]any{"itemId": fern}), c, 409)
	bc, b := x.member("bob", s.WorldID)
	x.exp("POST", "/api/homestead/place", body(b, "steal", map[string]any{"itemId": fern, "scene": "outdoor", "x": p0[0], "y": p0[1], "rotation": 0}), bc, 409)
	update(&s, x.exp("POST", "/api/homestead/upgrade", body(s, "cottage", map[string]any{"tier": 1}), c, 200))
	if s.State.Embers != 40 || s.State.XPEmbers != 20 {
		t.Fatal("gifted first upgrade debit", s.State.Embers, s.State.XPEmbers)
	}
	x.exp("POST", "/api/homestead/upgrade", body(s, "workshop", map[string]any{"tier": 2}), c, 409)
	v = x.exp("POST", "/api/homestead/buy", body(s, "chair", map[string]any{"itemDef": "reading-chair"}), c, 200)
	chair := v.Result.ItemID
	update(&s, v)
	place("chair-outside", chair, "outdoor", p0[0], p0[1], 0, 400)
	place("rotated-bounds", chair, "indoor", 11, 9, 90, 409)
	if v := place("doorway", chair, "indoor", 4, 9, 90, 409); v.Error.Code != "placement-overlap" {
		t.Fatal("reserved doorway", v.Error.Code)
	}
	update(&s, place("rotated-fit", chair, "indoor", 10, 8, 90, 200))
	before := s.Snapshot
	x.exp("POST", "/api/homestead/move", body(s, "collide", map[string]any{"itemId": stool, "scene": "outdoor", "x": site.X, "y": site.Y, "rotation": 0}), c, 409)
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	if count(t, x.db, "SELECT count(*) FROM idempotency WHERE key='collide'") != 0 {
		t.Fatal("failed request cached")
	}
	// Old progress after a purchase cannot restore pre-purchase vitals/balances.
	old := s
	old.Rev--
	doc := s.State
	doc.HP = doc.MaxHP
	doc.Embers = 999
	merged := x.expect("PUT", "/api/progress", mutation(old, doc), c, 200)
	if merged.State.Embers != s.State.Embers || merged.State.HP != s.State.HP {
		t.Fatal("stale purchase progress")
	}
}
func TestHomeRestAndSafeBoundaries(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fund("alice", 5, 0)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	doc := s.State
	doc.Area = "home:0"
	doc.Position = rules.Position{X: 320, Y: 160}
	doc.HP = 1
	if x.exp("POST", "/api/spend", spendBody(s, "home-rest", "", "homeless", doc), c, 409).Error.Code != "not-at-own-plot" {
		t.Fatal("rest without a home")
	}
	x.claimGate(c, &s, 0)
	doc = s.State
	doc.Area = "home:0"
	doc.Position = rules.Position{X: 320, Y: 160}
	doc.HP = 0
	if x.exp("POST", "/api/spend", spendBody(s, "home-rest", "", "gifted", doc), c, 409).Error.Code != "needs-earned" {
		t.Fatal("gifted revival")
	}
	x.fund("alice", 1, 1)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	s0 := s
	x.expect("POST", "/api/spend", spendBody(s, "home-rest", "", "earned", doc), c, 200)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	if s.Rev != s0.Rev+1 || s.State.HP != s.State.MaxHP || s.State.Embers != 5 || s.State.XPEmbers != 0 {
		t.Fatal("home rest")
	}
	for name, area := range map[string]string{"other-home": "home:1", "commons": "commons", "village": "village", "padded": "home:00"} {
		doc = s.State
		doc.HP = 1
		doc.Area = area
		want := 409
		if area == "home:00" {
			want = 400
		}
		v := x.exp("POST", "/api/spend", spendBody(s, "home-rest", "", name, doc), c, want)
		if want == 409 && v.Error.Code != "not-at-own-plot" && v.Error.Code != "not-at-safe-boundary" {
			t.Fatal(name, v.Error.Code)
		}
	}
	p := profile("alice", 1, 0, 20)
	for _, area := range []string{"commons", "home:0", "home:7"} {
		doc = s.State
		doc.Area = area
		s.Snapshot = x.expect("POST", "/api/sync", syncBody(s, p, doc), c, 200).Snapshot
	}
	doc = s.State
	doc.Area = "wilds"
	before := s.Snapshot
	x.expect("POST", "/api/sync", syncBody(s, p, doc), c, 409)
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
}
func TestWildsConcurrentClaimCyclesAndAccess(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	region := x.region(c)
	camp := entityKind(t, region, "camp")
	ep := region.Epoch.ID
	// Competing HTTP handlers use separate database connections to the same file.
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
		go func(i int, pair struct {
			c *http.Cookie
			s response
		}) {
			defer wg.Done()
			req := body(pair.s, "race", map[string]any{"epoch": ep, "entityId": camp.ID, "progress": nearEntity(pair.s, camp), "cycle": 0})
			r := httptest.NewRequest("POST", "/api/wilds/claim", bytes.NewBufferString(store.JSON(req)))
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(pair.c)
			w := httptest.NewRecorder()
			api := x.api
			if i == 1 {
				api = api2
			}
			api.ServeHTTP(w, r)
			statuses <- w.Code
		}(i, pair)
	}
	wg.Wait()
	close(statuses)
	wins := 0
	losses := 0
	for status := range statuses {
		if status == 200 {
			wins++
		} else if status == 409 {
			losses++
		} else {
			t.Fatal(status)
		}
	}
	if wins != 1 || losses != 1 {
		t.Fatal("claim race", wins, losses)
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE currency='embers' AND reason='wilds-claim'") != 1 {
		t.Fatal("duplicate claim ledger")
	}
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	update(&b, x.exp("GET", "/api/state", nil, bc, 200))
	x.now.Add(int64(content.WildsRules.Timers.CampRespawnSeconds))
	next := x.region(c)
	camp = entityKind(t, next, "camp")
	if camp.Cycle != 1 || camp.State != "available" {
		t.Fatal("lazy cycle")
	}
	if x.exp("POST", "/api/wilds/claim", body(s, "old", map[string]any{"epoch": ep, "entityId": camp.ID, "progress": nearEntity(s, camp), "cycle": 0}), c, 409).Error.Code != "old-cycle" {
		t.Fatal("old cycle")
	}
	update(&s, x.exp("POST", "/api/wilds/claim", body(s, "cycle1", map[string]any{"epoch": ep, "entityId": camp.ID, "progress": nearEntity(s, camp), "cycle": 1}), c, 200))
	node := entityKind(t, next, "node")
	update(&s, x.exp("POST", "/api/wilds/claim", body(s, "node0", map[string]any{"epoch": ep, "entityId": node.ID, "progress": nearEntity(s, node), "cycle": 0}), c, 200))
	x.now.Add(int64(content.WildsRules.Timers.NodeRegrowSeconds))
	update(&s, x.exp("POST", "/api/wilds/claim", body(s, "node1", map[string]any{"epoch": ep, "entityId": node.ID, "progress": nearEntity(s, node), "cycle": 1}), c, 200))
	for _, invalid := range []string{"camp:3:0:0", "camp:-1:0:0", "camp:0:0:999", "node:0:0:00", "node:0:0:0junk"} {
		if x.exp("POST", "/api/wilds/claim", body(s, invalid, map[string]any{"epoch": ep, "entityId": invalid, "cycle": 0}), c, 404).Error.Code != "entity-not-found" {
			t.Fatal(invalid)
		}
	}
	oc, o := x.ready("outsider")
	outside := x.region(oc)
	if outside.Epoch.ID == ep {
		t.Fatal("cross-world epoch")
	}
	x.exp("POST", "/api/wilds/claim", body(o, "other-world", map[string]any{"epoch": ep, "entityId": camp.ID, "progress": nearEntity(o, camp), "cycle": 1}), oc, 403)
	x.exp("POST", "/api/wilds/lantern", body(o, "other-lantern", map[string]any{"epoch": ep, "progress": atLantern(o), "ownerId": "alice", "lanternId": "unknown"}), oc, 403)
	x.exp("GET", "/api/wilds/region/not-a-region", nil, c, 404)
	if _, err = x.db.DB.Exec("UPDATE region_epochs SET ends_at=? WHERE id=?", x.now.Load(), ep); err != nil {
		t.Fatal(err)
	}
	if x.exp("POST", "/api/wilds/claim", body(s, "ended", map[string]any{"epoch": ep, "entityId": camp.ID, "progress": nearEntity(s, camp), "cycle": 2}), c, 409).Error.Code != "epoch-ended" {
		t.Fatal("ended epoch")
	}
	if x.exp("GET", "/api/wilds/region/inner-1", nil, c, 409).Error.Code != "epoch-ended" {
		t.Fatal("ended read")
	}
}
func TestWildsPersonalClaimsDiscoveryReplayAndEpochPin(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	v := x.region(c)
	ep := v.Epoch.ID
	chest := entityKind(t, v, "chest")
	poi := entityKind(t, v, "poi")
	req := body(s, "chest", map[string]any{"epoch": ep, "entityId": chest.ID, "progress": nearEntity(s, chest), "cycle": 0})
	grant := x.exp("POST", "/api/wilds/claim", req, c, 200)
	update(&s, grant)
	loot, err := wilds.RollLoot(v.Epoch.Epoch, chest.ID, 0)
	if err != nil || store.JSON(grant.Result.Loot) != store.JSON(loot) {
		t.Fatal("deterministic loot")
	}
	replay := x.exp("POST", "/api/wilds/claim", req, c, 200)
	if store.JSON(replay) != store.JSON(grant) {
		t.Fatal("claim replay")
	}
	req["entityId"] = poi.ID
	if x.exp("POST", "/api/wilds/claim", req, c, 409).Error.Code != "idempotency-mismatch" {
		t.Fatal("key mismatch")
	}
	update(&b, x.exp("POST", "/api/wilds/claim", body(b, "chest", map[string]any{"epoch": ep, "entityId": chest.ID, "progress": nearEntity(b, chest), "cycle": 0}), bc, 200))
	x.exp("POST", "/api/wilds/claim", body(s, "chest-again", map[string]any{"epoch": ep, "entityId": chest.ID, "progress": nearEntity(s, chest), "cycle": 0}), c, 409)
	update(&s, x.exp("POST", "/api/wilds/claim", body(s, "poi", map[string]any{"epoch": ep, "entityId": poi.ID, "progress": nearEntity(s, poi), "cycle": 0}), c, 200))
	update(&b, x.exp("POST", "/api/wilds/claim", body(b, "poi", map[string]any{"epoch": ep, "entityId": poi.ID, "progress": nearEntity(b, poi), "cycle": 0}), bc, 200))
	v = x.region(c)
	if len(v.PersonalClaims) != 2 || len(v.Discoveries) != 1 || v.Discoveries[0].DiscovererID != "alice" || v.Discoveries[0].DisplayName != "Hero" {
		t.Fatal("discovery ownership")
	}
	// Simulate a deployment's new default without rewriting the existing epoch.
	x.api.Config.WildsGeneratorVersion = 2
	pinned := x.region(c)
	if pinned.Epoch.GeneratorVersion != 1 || pinned.Epoch.ID != ep || pinned.Epoch.Season != "0" {
		t.Fatal("epoch changed")
	}
	node := entityKind(t, pinned, "node")
	update(&s, x.exp("POST", "/api/wilds/claim", body(s, "retained-v1", map[string]any{"epoch": ep, "entityId": node.ID, "progress": nearEntity(s, node), "cycle": 0}), c, 200))
	oc, _ := x.ready("new-world")
	if x.exp("GET", "/api/wilds/region/inner-1", nil, oc, 503).Error.Code != "generator-unavailable" {
		t.Fatal("unsupported new version")
	}
}
func TestWildsClaimRateIsDurableAtomicAndReplayExempt(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.region(c)
	limit := content.Rules.WildsLimits.ClaimsPerMinute
	if len(v.Entities) <= limit {
		t.Fatal("insufficient entities for limit")
	}
	var last map[string]any
	for i := 0; i < limit; i++ {
		e := v.Entities[i]
		last = body(s, fmt.Sprintf("claim%d", i), map[string]any{"epoch": v.Epoch.ID, "entityId": e.ID, "progress": nearEntity(s, e), "cycle": 0})
		update(&s, x.exp("POST", "/api/wilds/claim", last, c, 200))
	}
	x.exp("POST", "/api/wilds/claim", last, c, 200)
	e := v.Entities[limit]
	req := body(s, "limited", map[string]any{"epoch": v.Epoch.ID, "entityId": e.ID, "progress": nearEntity(s, e), "cycle": 0})
	before := s.Snapshot
	if x.exp("POST", "/api/wilds/claim", req, c, 429).Error.Code != "claim-rate-limited" {
		t.Fatal("rate limiter")
	}
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	if count(t, x.db, "SELECT qty FROM claim_rate WHERE habitica_id='alice'") != limit || count(t, x.db, "SELECT count(*) FROM idempotency WHERE key='limited'") != 0 {
		t.Fatal("rate rejection committed")
	}
	x.now.Add(60)
	update(&s, x.exp("POST", "/api/wilds/claim", req, c, 200))
	if count(t, x.db, "SELECT qty FROM claim_rate WHERE habitica_id='alice'") != 1 {
		t.Fatal("window reset")
	}
}
func TestWildsLanternReplacementRewardsAndDailyCap(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	v := x.region(c)
	ep := v.Epoch.ID
	defeat := func(key string) string {
		doc := s.State
		doc.Area = "wilds"
		doc.HP = 0
		doc.Position = rules.Position{X: 160, Y: 160}
		v := x.exp("POST", "/api/wilds/defeat", body(s, key, map[string]any{"epoch": ep, "x": 10, "y": 10, "progress": doc}), c, 200)
		update(&s, v)
		found := false
		for _, l := range v.Result.Lanterns {
			if l.OwnerID == "alice" && l.ID == v.Result.LanternID {
				found = true
			}
		}
		if !found {
			return ""
		}
		return v.Result.LanternID
	}
	first := defeat("fall1")
	second := defeat("fall2")
	if first == second || first == "" || second == "" {
		t.Fatal("replacement identity")
	}
	x.exp("POST", "/api/wilds/lantern", body(b, "obsolete", map[string]any{"epoch": ep, "progress": atLantern(b), "ownerId": "alice", "lanternId": first}), bc, 404)
	own := x.exp("POST", "/api/wilds/lantern", body(s, "own", map[string]any{"epoch": ep, "progress": atLantern(s), "ownerId": "alice", "lanternId": second}), c, 200)
	update(&s, own)
	if own.Result.Rewarded || len(own.Result.Loot.Materials) != 0 {
		t.Fatal("own reward")
	}
	x.exp("POST", "/api/wilds/lantern", body(b, "already-lit", map[string]any{"epoch": ep, "progress": atLantern(b), "ownerId": "alice", "lanternId": second}), bc, 409)
	limit := content.Rules.WildsLimits.LanternRelightsPerDay
	for i := 0; i <= limit; i++ {
		owner := fmt.Sprintf("fallen%d", i)
		cc, cs := x.member(owner, s.WorldID)
		doc := atLantern(cs)
		doc.HP = 0
		fallen := x.exp("POST", "/api/wilds/defeat", body(cs, "fall", map[string]any{"epoch": ep, "x": 10, "y": 10, "progress": doc}), cc, 200)
		id := fallen.Result.LanternID
		req := body(b, fmt.Sprintf("light%d", i), map[string]any{"epoch": ep, "progress": atLantern(b), "ownerId": owner, "lanternId": id})
		lit := x.exp("POST", "/api/wilds/lantern", req, bc, 200)
		update(&b, lit)
		if lit.Result.Rewarded != (i < limit) {
			t.Fatal("daily reward cap")
		}
		replay := x.exp("POST", "/api/wilds/lantern", req, bc, 200)
		if store.JSON(lit) != store.JSON(replay) {
			t.Fatal("relight replay")
		}
	}
	if count(t, x.db, "SELECT qty FROM materials WHERE habitica_id='bob' AND material='amber'") != limit*content.Rules.WildsLimits.LanternReward.Qty {
		t.Fatal("relight balance")
	}
	if count(t, x.db, "SELECT sum(qty) FROM lantern_rewards WHERE habitica_id='bob'") != limit {
		t.Fatal("daily count")
	}
	// Reward cap resets at a UTC date boundary, not per session or request.
	tomorrow := time.Unix(x.now.Load(), 0).UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)
	x.now.Store(tomorrow.Unix())
	id := defeat("next-day")
	lit := x.exp("POST", "/api/wilds/lantern", body(b, "tomorrow", map[string]any{"epoch": ep, "progress": atLantern(b), "ownerId": "alice", "lanternId": id}), bc, 200)
	if !lit.Result.Rewarded {
		t.Fatal("UTC reward reset")
	}
	doc := s.State
	doc.HP = 1
	x.exp("POST", "/api/wilds/defeat", body(s, "alive", map[string]any{"epoch": ep, "x": 10, "y": 10, "progress": doc}), c, 409)
	x.exp("POST", "/api/wilds/defeat", body(s, "wrong-location", map[string]any{"epoch": ep, "x": 11, "y": 10}), c, 400)
}
func TestMaterialPurchaseAndExpansionBackupRestore(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.region(c)
	// Gather fiber over deterministic node cycles, then buy a real material item.
	var fiber entityView
	for _, e := range v.Entities {
		if e.Kind == "node" && e.Material == "fiber" {
			fiber = e
			break
		}
	}
	if fiber.ID == "" {
		t.Fatal("missing fiber node")
	}
	for cycle := 0; cycle < 2; cycle++ {
		update(&s, x.exp("POST", "/api/wilds/claim", body(s, fmt.Sprintf("fiber%d", cycle), map[string]any{"epoch": v.Epoch.ID, "entityId": fiber.ID, "progress": nearEntity(s, fiber), "cycle": cycle}), c, 200))
		x.now.Add(int64(content.WildsRules.Timers.NodeRegrowSeconds))
	}
	x.claimGate(c, &s, 0)
	read := x.exp("GET", "/api/homestead/gate/0", nil, c, 200)
	update(&s, read)
	beforeFiber := read.Materials["fiber"]
	req := body(s, "basket", map[string]any{"itemDef": "woven-basket"})
	bought := x.exp("POST", "/api/homestead/buy", req, c, 200)
	update(&s, bought)
	if bought.Result.Materials["fiber"] != beforeFiber-4 {
		t.Fatal("material price")
	}
	x.exp("POST", "/api/homestead/buy", req, c, 200)
	// Multi-currency failure leaves both balance and ledger intact.
	before := s.Snapshot
	ledger := count(t, x.db, "SELECT count(*) FROM ledger")
	x.exp("POST", "/api/homestead/buy", body(s, "hearth", map[string]any{"itemDef": "stone-hearth"}), c, 409)
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	if count(t, x.db, "SELECT count(*) FROM ledger") != ledger {
		t.Fatal("failed purchase ledger")
	}

	// Populate personal/discovery and lantern/reward state before the backup.
	chest := entityKind(t, v, "chest")
	poi := entityKind(t, v, "poi")
	for _, entity := range []entityView{chest, poi} {
		update(&s, x.exp("POST", "/api/wilds/claim", body(s, "backup-"+entity.Kind, map[string]any{"epoch": v.Epoch.ID, "entityId": entity.ID, "progress": nearEntity(s, entity), "cycle": 0}), c, 200))
	}
	bc, b := x.member("bob", s.WorldID)
	doc := s.State
	doc.Area = "wilds"
	doc.HP = 0
	doc.Position = rules.Position{X: 160, Y: 160}
	fallen := x.exp("POST", "/api/wilds/defeat", body(s, "backup-defeat", map[string]any{"epoch": v.Epoch.ID, "x": 10, "y": 10, "progress": doc}), c, 200)
	update(&s, fallen)
	update(&b, x.exp("POST", "/api/wilds/lantern", body(b, "backup-relight", map[string]any{"epoch": v.Epoch.ID, "progress": atLantern(b), "ownerId": "alice", "lanternId": fallen.Result.LanternID}), bc, 200))
	currentMaterials := x.region(c).Materials
	backup := filepath.Join(x.dir, "expansion-backup.sqlite")
	if err := x.db.Backup(context.Background(), backup); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(backup)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	tx, err := restored.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	rs, err := store.Load(context.Background(), tx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	unchanged(t, s.Snapshot, rs)
	tx.Rollback()
	for _, table := range []string{"homesteads", "homestead_members", "player_deeds", "homestead_items", "materials", "region_epochs", "entity_state", "personal_claims", "discoveries", "lanterns", "lantern_rewards", "lantern_creations", "claim_rate", "ledger", "idempotency"} {
		if count(t, x.db, "SELECT count(*) FROM "+table) != count(t, restored, "SELECT count(*) FROM "+table) {
			t.Fatal("backup", table)
		}
	}
	if count(t, restored, "SELECT sum(delta) FROM ledger WHERE habitica_id='alice' AND currency='material:fiber'") != currentMaterials["fiber"] {
		t.Fatal("material ledger sum")
	}
	if count(t, restored, "SELECT sum(delta) FROM ledger WHERE habitica_id='alice' AND currency='decoration:woven-basket'") != 1 {
		t.Fatal("instance ledger sum")
	}
	if count(t, restored, "SELECT sum(delta) FROM ledger WHERE habitica_id='alice' AND currency='embers'") != rs.State.Embers {
		t.Fatal("ember ledger sum")
	}
}
func TestExpansionLeaseRevisionAndConcurrentPurchase(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fund("alice", 30, 0)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	bad := body(s, "missing-revision", map[string]any{"itemDef": "wooden-stool"})
	delete(bad, "baseRev")
	x.exp("POST", "/api/homestead/buy", bad, c, 409)
	if count(t, x.db, "SELECT count(*) FROM homesteads") != 0 {
		t.Fatal("failed mutation granted home")
	}
	x.claimGate(c, &s, 0)
	req := body(s, "same-buy", map[string]any{"itemDef": "wooden-stool"})
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, _, _, _ := x.request("POST", "/api/homestead/buy", req, c)
			statuses <- status
		}()
	}
	wg.Wait()
	close(statuses)
	for status := range statuses {
		if status != 200 {
			t.Fatal(status)
		}
	}
	v := x.exp("POST", "/api/homestead/buy", req, c, 200)
	update(&s, v)
	if count(t, x.db, "SELECT count(*) FROM homestead_items") != 1 || s.State.Embers != 28 {
		t.Fatal("concurrent purchase duplicate")
	}
	stale := body(s, "stale", map[string]any{"itemDef": "wooden-stool"})
	stale["baseRev"] = s.Rev - 1
	x.exp("POST", "/api/homestead/buy", stale, c, 409)
	next := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-b", "takeOver": true}, c, 200)
	if x.exp("POST", "/api/homestead/buy", req, c, 409).Error.Code != "superseded" {
		t.Fatal("old lease replay")
	}
	req["lease"] = next.Lease
	replay := x.exp("POST", "/api/homestead/buy", req, c, 200)
	if replay.Result.ItemID != v.Result.ItemID || replay.Rev != v.Rev {
		t.Fatal("new lease replay")
	}
	region := x.region(c)
	node := entityKind(t, region, "node")
	before := next.Snapshot
	x.exp("POST", "/api/wilds/claim", body(s, "old-lease", map[string]any{"epoch": region.Epoch.ID, "entityId": node.ID, "progress": nearEntity(s, node), "cycle": 0}), c, 409)
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
}
