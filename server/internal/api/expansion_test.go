package api

import (
	"context"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/land"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
)

type expansionResponse struct {
	store.Snapshot
	Home      *homeView      `json:"home"`
	Gate      int            `json:"gate"`
	LandSeed  uint32         `json:"landSeed"`
	Materials map[string]int `json:"materials"`
	Gates     []gateView     `json:"gates"`
	GateCount int            `json:"gateCount"`
	Mine      *struct {
		HomeID string `json:"homeId"`
		Gate   int    `json:"gate"`
	} `json:"mine"`
	Invites []inviteView `json:"invites"`
	Result  struct {
		Home      *homeView      `json:"home"`
		Status    string         `json:"status"`
		ItemID    string         `json:"itemId"`
		Materials map[string]int `json:"materials"`
	} `json:"result"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (x *rig) exp(method, path string, body any, c *http.Cookie, status int) expansionResponse {
	x.t.Helper()
	v, _ := httpResponse[expansionResponse](x, method, path, body, c, status)
	return v
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
	return c, x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
}

// claimGate buys the deed to a gate from Silas and returns the caller's home.
func (x *rig) claimGate(c *http.Cookie, s *response, gate int) homeView {
	x.t.Helper()
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	v := x.exp("POST", "/api/homestead/claim", body(*s, fmt.Sprintf("claim-%d-%d", gate, s.Version), map[string]any{"gate": gate}), c, 200)
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
	rev := s.Version
	lane := x.exp("GET", "/api/commons", nil, c, 200)
	if lane.Version != rev || lane.GateCount != content.HomeRules.Lane.SpareGates || lane.Mine != nil || len(lane.Gates) != lane.GateCount || lane.Gates[0].HomeID != nil || lane.Gates[0].Price == nil || *lane.Gates[0].Price != 0 {
		t.Fatal("empty lane", lane.GateCount)
	}
	// An unclaimed gate can be visited: wild land, no home.
	g := x.exp("GET", "/api/homestead/gate/1", nil, c, 200)
	if g.Home != nil || g.LandSeed != land.Seed(s.WorldID, 1, content.HomeRules.Land) || g.Version != rev {
		t.Fatal("unclaimed land")
	}
	x.exp("GET", "/api/homestead/gate/2", nil, c, 404)
	x.exp("GET", "/api/homestead/gate/01", nil, c, 404)
	h := x.claimGate(c, &s, 1)
	if h.Tier != 0 || h.Indoor != nil || !h.Member || len(h.Members) != 1 || h.Members[0].ID != x.account("alice") || len(h.Items) != 0 {
		t.Fatal("campsite")
	}
	lane = x.exp("GET", "/api/commons", nil, c, 200)
	if lane.GateCount != 3 || lane.Mine == nil || lane.Mine.Gate != 1 || !lane.Gates[1].Mine || len(lane.Gates[1].Names) != 1 || lane.Gates[1].Members[0].ID != x.account("alice") || lane.Gates[0].Price == nil {
		t.Fatal("lane after claim", lane.GateCount)
	}
	bc, b := x.member("bob", s.WorldID)
	visited := x.exp("GET", "/api/homestead/gate/1", nil, bc, 200)
	if visited.Home == nil || visited.Home.Member || visited.AccountID != x.account("bob") || visited.Version != b.Version {
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
	x.fund(x.account("alice"), 60, 20)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	x.exp("POST", "/api/homestead/buy", body(s, "no-home", map[string]any{"itemDef": "potted-fern"}), c, 409)
	h := x.claimGate(c, &s, 0)
	spots := litSpots(h)
	req := body(s, "fern", map[string]any{"itemDef": "potted-fern"})
	v := x.exp("POST", "/api/homestead/buy", req, c, 200)
	fern := v.Result.ItemID
	update(&s, v)
	duplicate := x.exp("POST", "/api/homestead/buy", req, c, 200)
	if duplicate.Result.ItemID != fern || duplicate.Version != s.Version || count(t, x.db, "SELECT count(*) FROM homestead_items") != 1 {
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
	old.Version--
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
	x.fund(x.account("alice"), 5, 0)
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
	x.fund(x.account("alice"), 1, 1)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	s0 := s
	x.expect("POST", "/api/spend", spendBody(s, "home-rest", "", "earned", doc), c, 200)
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
	if s.Version != s0.Version+1 || s.State.HP != s.State.MaxHP || s.State.Embers != 5 || s.State.XPEmbers != 0 {
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
func TestMaterialPurchaseAndExpansionBackupRestore(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "inner-1")
	// Gather fiber over deterministic node cycles, then buy a real material item.
	var fiber *contract.WildsEntity
	for _, e := range v.bodies {
		if e.Kind == "node" && e.Material == "fiber" {
			fiber = e
			break
		}
	}
	if fiber == nil {
		t.Fatal("missing fiber node")
	}
	for cycle := 0; cycle < 2; cycle++ {
		x.claim(c, s, fmt.Sprintf("fiber%d", cycle), v.Epoch.Id, fiber, cycle, at("inner-1", fiber, 0), 200)
		x.now.Add(int64(content.WildsRules.Timers.NodeRegrowSeconds))
	}
	x.refresh(c, &s)
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
	for _, entity := range []*contract.WildsEntity{v.kind(t, "chest"), v.kind(t, "poi")} {
		x.claim(c, s, "backup-"+entity.Kind, v.Epoch.Id, entity, 0, at("inner-1", entity, 0), 200)
	}
	x.refresh(c, &s)
	bc, b := x.member("bob", s.WorldID)
	lx, ly := lanternTile(v)
	fallen := x.fall("alice", v.Epoch, atTile("inner-1", lx, ly))
	x.call("/api/wilds/lantern", &contract.WildsLanternRequest{Op: op(b.Lease, "backup-relight"), Epoch: v.Epoch.Id, OwnerId: x.account("alice"), LanternId: fallen.ID, Where: atTile("inner-1", lx, ly)}, bc, 200)
	currentMaterials := map[string]int{}
	for id, qty := range x.wilds(c, "inner-1").Materials {
		currentMaterials[id] = int(qty)
	}
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
	rs, err := store.Load(context.Background(), tx, x.account("alice"))
	if err != nil {
		t.Fatal(err)
	}
	unchanged(t, s.Snapshot, rs)
	tx.Rollback()
	for _, table := range []string{"homesteads", "homestead_members", "player_deeds", "homestead_items", "item_stacks", "region_epochs", "entity_state", "personal_claims", "discoveries", "lanterns", "lantern_rewards", "lantern_creations", "claim_rate", "ledger", "idempotency"} {
		if count(t, x.db, "SELECT count(*) FROM "+table) != count(t, restored, "SELECT count(*) FROM "+table) {
			t.Fatal("backup", table)
		}
	}
	if count(t, restored, "SELECT sum(delta) FROM ledger WHERE account_id='"+x.account("alice")+"' AND currency='material:fiber'") != currentMaterials["fiber"] {
		t.Fatal("material ledger sum")
	}
	if count(t, restored, "SELECT sum(delta) FROM ledger WHERE account_id='"+x.account("alice")+"' AND currency='decoration:woven-basket'") != 1 {
		t.Fatal("instance ledger sum")
	}
	if count(t, restored, "SELECT sum(delta) FROM ledger WHERE account_id='"+x.account("alice")+"' AND currency='embers'") != rs.State.Embers {
		t.Fatal("ember ledger sum")
	}
}
func TestExpansionLeaseRevisionAndConcurrentPurchase(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fund(x.account("alice"), 30, 0)
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
	stale["baseRev"] = s.Version - 1
	x.exp("POST", "/api/homestead/buy", stale, c, 409)
	next := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-b", "takeOver": true}, c, 200)
	if x.exp("POST", "/api/homestead/buy", req, c, 409).Error.Code != "superseded" {
		t.Fatal("old lease replay")
	}
	req["lease"] = next.Lease
	replay := x.exp("POST", "/api/homestead/buy", req, c, 200)
	if replay.Result.ItemID != v.Result.ItemID || replay.Version != next.Version {
		t.Fatal("new lease replay")
	}
	region := x.wilds(c, "inner-1")
	node := region.kind(t, "node")
	before := next.Snapshot
	x.claim(c, s, "old-lease", region.Epoch.Id, node, 0, at("inner-1", node, 0), 409)
	unchanged(t, before, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
}
