package api

import (
	"context"
	"fmt"
	"glimway/content"
	"glimway/server/internal/land"
	"net/http"
	"testing"
)

// Homesteads v2 (docs/hands-on-design.md section 1): gates, shared deeds,
// lantern light, leaving and lost deeds.

// stand puts a player's presence somewhere (as the hub would after a socket
// joined a room and sent a position); room "" removes them.
func (x *rig) stand(id, world, room string, px, py float64) {
	h := x.api.presence
	h.mu.Lock()
	defer h.mu.Unlock()
	if room == "" {
		delete(h.peers, id)
		return
	}
	// A socket's peer carries its queue and cancellation (avatar changes and
	// presence broadcasts enqueue on it).
	h.peers[id] = &presencePeer{identity: presenceIdentity{ID: id, World: world}, account: &presenceAccount{}, ctx: context.Background(), cancel: func() {}, queue: make(chan []byte, 8), area: room, pos: &presencePosition{X: px, Y: py}}
}
func (x *rig) atTable(id, world string) {
	t := content.HomeRules.GetCommons().GetSilasTable()
	x.stand(id, world, "commons", float64(int(t.GetX())+4), float64(int(t.GetY())-4))
}

// home is the caller's homestead as the server shows it.
func (x *rig) home(c *http.Cookie) homeView {
	x.t.Helper()
	lane := x.exp("GET", "/api/commons", nil, c, 200)
	if lane.Mine == nil {
		x.t.Fatal("no homestead")
	}
	v := x.exp("GET", fmt.Sprintf("/api/homestead/gate/%d", lane.Mine.Gate), nil, c, 200)
	return *v.Home
}

// homeOpRefreshing reads the current revision, then runs a homestead mutation.
func (x *rig) homeOpRefreshing(c *http.Cookie, s *response, op string, fields map[string]any, status int) expansionResponse {
	x.t.Helper()
	x.refresh(c, s)
	v := x.exp("POST", "/api/homestead/"+op, body(*s, fmt.Sprintf("%s-%d-%d-%d", op, s.Version, x.now.Load(), keySeq()), fields), c, status)
	if status == 200 {
		update(s, v)
	}
	return v
}

// share signs a joint deed: from (a member) invites to, both at Silas's table.
func (x *rig) share(fc *http.Cookie, f *response, tc *http.Cookie, to *response) {
	x.t.Helper()
	h := x.home(fc)
	x.homeOpRefreshing(fc, f, "invite", map[string]any{"to": to.AccountID}, 200)
	x.atTable(f.AccountID, f.WorldID)
	x.atTable(to.AccountID, to.WorldID)
	if v := x.homeOpRefreshing(fc, f, "joint", map[string]any{"homeId": h.ID, "to": to.AccountID}, 200); v.Result.Status != "waiting" {
		x.t.Fatal("first signature", v.Result.Status)
	}
	if v := x.homeOpRefreshing(tc, to, "joint", map[string]any{"homeId": h.ID, "to": to.AccountID}, 200); v.Result.Status != "joined" || v.Result.Home == nil || v.Result.Home.ID != h.ID {
		x.t.Fatal("second signature", v.Result.Status)
	}
}

func placed(h homeView, id string) *homeInstance {
	for i := range h.Items {
		if h.Items[i].ID == id && h.Items[i].Scene != nil {
			return &h.Items[i]
		}
	}
	return nil
}

func TestHomes2JointDeedNeedsBothAtTheTableWithinTheWindow(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	h := x.claimGate(ac, &a, 0)
	joint := map[string]any{"homeId": h.ID, "to": x.account("bob")}
	if x.homeOpRefreshing(bc, &b, "joint", joint, 404).Error.Code != "invite-not-found" {
		t.Fatal("joint without invite")
	}
	if x.homeOpRefreshing(ac, &a, "invite", map[string]any{"to": x.account("alice")}, 400).Error.Code != "self-invite" {
		t.Fatal("self invite")
	}
	if v := x.homeOpRefreshing(ac, &a, "invite", map[string]any{"to": x.account("bob")}, 200); v.Result.Status != "invited" {
		t.Fatal("invite")
	}
	lane := x.exp("GET", "/api/commons", nil, bc, 200)
	if len(lane.Invites) != 1 || lane.Invites[0].From.ID != x.account("alice") || lane.Invites[0].To.ID != x.account("bob") || lane.Invites[0].Gate != 0 {
		t.Fatal("invite listing")
	}
	// Neither at the table, then only one of them, then one in another room.
	if x.homeOpRefreshing(bc, &b, "joint", joint, 409).Error.Code != "not-at-table" {
		t.Fatal("invitee away")
	}
	x.atTable(x.account("bob"), b.WorldID)
	if x.homeOpRefreshing(bc, &b, "joint", joint, 409).Error.Code != "partner-not-at-table" {
		t.Fatal("partner away")
	}
	x.stand(x.account("alice"), a.WorldID, "village", 824, 344)
	if x.homeOpRefreshing(bc, &b, "joint", joint, 409).Error.Code != "partner-not-at-table" {
		t.Fatal("partner in another room")
	}
	x.stand(x.account("alice"), a.WorldID, "commons", 100, 100)
	if x.homeOpRefreshing(bc, &b, "joint", joint, 409).Error.Code != "partner-not-at-table" {
		t.Fatal("partner too far from Silas")
	}
	x.stand(x.account("alice"), "another-world", "commons", 824, 344)
	if x.homeOpRefreshing(bc, &b, "joint", joint, 409).Error.Code != "partner-not-at-table" {
		t.Fatal("partner in another world")
	}
	x.atTable(x.account("alice"), a.WorldID)
	if x.homeOpRefreshing(bc, &b, "joint", joint, 200).Result.Status != "waiting" {
		t.Fatal("first signature")
	}
	// The second signature comes too late: it waits for a fresh one.
	x.now.Add(int64(content.HomeRules.GetJointDeed().GetConfirmWindowSeconds()) + 1)
	if x.homeOpRefreshing(ac, &a, "joint", joint, 200).Result.Status != "waiting" {
		t.Fatal("stale signature joined")
	}
	if count(t, x.db, "SELECT count(*) FROM homestead_members") != 1 {
		t.Fatal("joined outside the window")
	}
	v := x.homeOpRefreshing(bc, &b, "joint", joint, 200)
	if v.Result.Status != "joined" || v.Result.Home == nil || len(v.Result.Home.Members) != 2 || !v.Result.Home.Member {
		t.Fatal("joined", v.Result.Status)
	}
	if count(t, x.db, "SELECT count(*) FROM homestead_invites") != 0 || count(t, x.db, "SELECT deeds FROM player_deeds WHERE account_id='"+x.account("bob")+"'") != 1 {
		t.Fatal("deed amended")
	}
	if x.homeOpRefreshing(bc, &b, "joint", joint, 404).Error.Code != "invite-not-found" {
		t.Fatal("invite reused")
	}
	if x.homeOpRefreshing(ac, &a, "invite", map[string]any{"to": x.account("bob")}, 409).Error.Code != "already-member" {
		t.Fatal("invite a member")
	}
	// An invitee who settled elsewhere meanwhile cannot also join.
	cc, c := x.member("carol", a.WorldID)
	x.homeOpRefreshing(ac, &a, "invite", map[string]any{"to": x.account("carol")}, 200)
	x.claimGate(cc, &c, 1)
	x.atTable(x.account("carol"), c.WorldID)
	carol := map[string]any{"homeId": h.ID, "to": x.account("carol")}
	x.homeOpRefreshing(cc, &c, "joint", carol, 200)
	if x.homeOpRefreshing(ac, &a, "joint", carol, 409).Error.Code != "already-homesteaded" {
		t.Fatal("two homesteads")
	}
}

func TestHomes2MembershipInvariantsAndEqualMembers(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	x.seedAssets(x.account("alice"))
	x.seedAssets(x.account("bob"))
	h := x.claimGate(ac, &a, 0)
	if x.homeOpRefreshing(ac, &a, "claim", map[string]any{"gate": 1}, 409).Error.Code != "already-homesteaded" {
		t.Fatal("second claim")
	}
	if x.homeOpRefreshing(bc, &b, "claim", map[string]any{"gate": 0}, 409).Error.Code != "gate-taken" {
		t.Fatal("taken gate")
	}
	if x.homeOpRefreshing(bc, &b, "claim", map[string]any{"gate": 3}, 404).Error.Code != "invalid-gate" {
		t.Fatal("gate past the lane")
	}
	if x.homeOpRefreshing(bc, &b, "buy", map[string]any{"itemDef": "wooden-stool"}, 409).Error.Code != "not-a-member" {
		t.Fatal("visitor bought into a home")
	}
	// The database refuses a second membership even if a handler slipped.
	if _, err := x.db.DB.Exec("INSERT INTO homesteads(id,world_id,gate,claimed_at) VALUES('"+"other"+"',?,5,0)", a.WorldID); err != nil {
		t.Fatal(err)
	}
	if _, err := x.db.DB.Exec("INSERT INTO homestead_members VALUES('" + x.account("alice") + "','" + "other" + "',0)"); err == nil {
		t.Fatal("two memberships")
	}
	if _, err := x.db.DB.Exec("DELETE FROM homesteads WHERE id='" + "other" + "'"); err != nil {
		t.Fatal(err)
	}
	stool := x.homeOpRefreshing(ac, &a, "buy", map[string]any{"itemDef": "wooden-stool"}, 200).Result.ItemID
	spots := litSpots(h)
	p0, p1 := spots[0], spots[len(spots)-1]
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": stool, "scene": "outdoor", "x": p0[0], "y": p0[1], "rotation": 0}, 200)
	// A visitor sees it but cannot touch it.
	if x.homeOpRefreshing(bc, &b, "move", map[string]any{"itemId": stool, "scene": "outdoor", "x": p1[0], "y": p1[1], "rotation": 0}, 409).Error.Code != "not-a-member" {
		t.Fatal("visitor moved")
	}
	x.share(ac, &a, bc, &b)
	// Equal partners: bob moves and puts away what alice set out, and carries it.
	x.homeOpRefreshing(bc, &b, "move", map[string]any{"itemId": stool, "scene": "outdoor", "x": p1[0], "y": p1[1], "rotation": 0}, 200)
	if p := placed(x.home(ac), stool); p == nil || *p.X != p1[0] {
		t.Fatal("partner move")
	}
	x.homeOpRefreshing(bc, &b, "remove", map[string]any{"itemId": stool}, 200)
	if x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": stool, "scene": "outdoor", "x": p0[0], "y": p0[1], "rotation": 0}, 404).Error.Code != "item-not-owned" {
		t.Fatal("placed from another's pack")
	}
	x.homeOpRefreshing(bc, &b, "place", map[string]any{"itemId": stool, "scene": "outdoor", "x": p0[0], "y": p0[1], "rotation": 0}, 200)
	x.homeOpRefreshing(bc, &b, "upgrade", map[string]any{"tier": 1}, 200)
	if x.home(ac).Tier != 1 {
		t.Fatal("partner upgrade")
	}
	if count(t, x.db, "SELECT sum(delta) FROM ledger WHERE account_id='"+x.account("bob")+"' AND currency='decoration:wooden-stool'") != 0 || count(t, x.db, "SELECT sum(delta) FROM ledger WHERE account_id='"+x.account("alice")+"' AND currency='decoration:wooden-stool'") != 0 {
		t.Fatal("pack ledger follows the pieces")
	}
}

func TestHomes2DeedPrices(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	lane := x.exp("GET", "/api/commons", nil, ac, 200)
	if *lane.Gates[0].Price != 0 {
		t.Fatal("first deed free")
	}
	x.claimGate(ac, &a, 0)
	x.homeOpRefreshing(ac, &a, "leave", nil, 200)
	lane = x.exp("GET", "/api/commons", nil, ac, 200)
	price := int(content.HomeRules.GetDeeds().GetGlims())
	if lane.Mine != nil || lane.Gates[1].Price == nil || *lane.Gates[1].Price != price {
		t.Fatal("second deed price")
	}
	if x.homeOpRefreshing(ac, &a, "claim", map[string]any{"gate": 1}, 409).Error.Code != "insufficient-glims" {
		t.Fatal("unpaid deed")
	}
	x.fund(x.account("alice"), price, 0)
	x.refresh(ac, &a)
	before := a.State.Glims
	x.claimGate(ac, &a, 1)
	if a.State.Glims != before-price {
		t.Fatal("deed debit", a.State.Glims, before)
	}
}

// A home good priced in embers *and* materials charges both (home_item.price
// — the stable is the first such row), and a shortfall in either refuses the
// buy with that currency's error, keeping neither.
func TestHomes2BuyChargesEmbersAndMaterials(t *testing.T) {
	x := newRig(t)
	def, ok := content.HomeItemFor("stable")
	if !ok || def.GetGlims() <= 0 || len(def.GetMaterials()) == 0 {
		t.Fatal("the stable is priced in both currencies", def)
	}
	tiers := content.HomeRules.GetTiers()
	upgradeGlims := int(tiers[1].GetGlims()) + int(tiers[2].GetGlims())

	ac, a := x.ready("alice")
	a = x.openWorkshop(ac, a)
	h := x.home(ac)
	m0 := x.exp("GET", fmt.Sprintf("/api/homestead/gate/%d", h.Gate), nil, ac, 200).Materials
	e0 := a.State.Glims
	buy := x.homeOpRefreshing(ac, &a, "buy", map[string]any{"itemDef": "stable"}, 200)
	if buy.Result.ItemID == "" || buy.Result.Home == nil {
		t.Fatal("no stable")
	}
	if a.State.Glims != e0-int(def.GetGlims()) {
		t.Fatal("stable embers", a.State.Glims, e0)
	}
	for m, n := range def.GetMaterials() {
		if int(buy.Result.Materials[m]) != int(m0[m])-int(n) {
			t.Fatal("stable materials", m, buy.Result.Materials[m], m0[m])
		}
	}

	// Short of the materials: the purse is refused and kept.
	bc, b := x.ready("bob")
	x.fund(x.account("bob"), upgradeGlims+int(def.GetGlims()), 0)
	for m, n := range tiers[2].GetMaterials() {
		x.stack(x.account("bob"), m, "", int(n))
	}
	x.claimGate(bc, &b, 0)
	x.homeOpRefreshing(bc, &b, "upgrade", map[string]any{"tier": 1}, 200)
	x.homeOpRefreshing(bc, &b, "upgrade", map[string]any{"tier": 2}, 200)
	if r := x.homeOpRefreshing(bc, &b, "buy", map[string]any{"itemDef": "stable"}, 409); r.Error.Code != "insufficient-materials" {
		t.Fatal("stable without materials", r.Error.Code)
	}
	x.refresh(bc, &b)
	if b.State.Glims != int(def.GetGlims()) {
		t.Fatal("a refused buy kept the purse", b.State.Glims)
	}

	// Short of the embers: the materials are refused and kept.
	cc, c := x.ready("carol")
	x.fund(x.account("carol"), upgradeGlims, 0)
	for m, n := range tiers[2].GetMaterials() {
		x.stack(x.account("carol"), m, "", int(n))
	}
	for m, n := range def.GetMaterials() {
		x.stack(x.account("carol"), m, "", int(n))
	}
	x.claimGate(cc, &c, 0)
	x.homeOpRefreshing(cc, &c, "upgrade", map[string]any{"tier": 1}, 200)
	x.homeOpRefreshing(cc, &c, "upgrade", map[string]any{"tier": 2}, 200)
	if r := x.homeOpRefreshing(cc, &c, "buy", map[string]any{"itemDef": "stable"}, 409); r.Error.Code != "insufficient-glims" {
		t.Fatal("stable without embers", r.Error.Code)
	}
	x.refresh(cc, &c)
	m1 := x.exp("GET", "/api/homestead/gate/0", nil, cc, 200).Materials
	for m, n := range def.GetMaterials() {
		if int(m1[m]) != int(n) {
			t.Fatal("a refused buy kept the materials", m, m1[m])
		}
	}
	x.conserved(x.account("alice"))
	x.conserved(x.account("bob"))
	x.conserved(x.account("carol"))
}

func TestHomes2LeavingKeepsPackAndPersonalChest(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	a = x.openWorkshop(ac, a)
	x.seedAssets(x.account("bob"))
	x.share(ac, &a, bc, &b)
	h := x.home(ac)
	stools := x.p5("POST", "/api/craft", body(a, "stools", map[string]any{"recipeId": "craft-wooden-stool", "qty": 2}), ac, 200)
	a.Snapshot = stools.Snapshot
	spot := litSpots(h)[0]
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": stools.Result.InstanceIDs[0], "scene": "outdoor", "x": spot[0], "y": spot[1], "rotation": 0}, 200)
	x.refresh(bc, &b)
	bstool := x.p5("POST", "/api/craft", body(b, "bob-stool", map[string]any{"recipeId": "craft-wooden-stool", "qty": 1}), bc, 200)
	b.Snapshot = bstool.Snapshot
	timber := map[string]any{"kind": "material", "id": "timber", "qty": 7}
	b.Snapshot = x.p5("POST", "/api/storage", body(b, "shared", map[string]any{"direction": "deposit", "chest": "shared", "asset": timber}), bc, 200).Snapshot
	personal := x.p5("POST", "/api/storage", body(b, "personal", map[string]any{"direction": "deposit", "chest": "personal", "asset": map[string]any{"kind": "material", "id": "stone", "qty": 5}}), bc, 200)
	b.Snapshot = personal.Snapshot
	if personal.Result.Personal.Materials["stone"] != 5 || personal.Result.Storage.Materials["timber"] != 7 {
		t.Fatal("chests")
	}
	// The personal chest is small.
	if x.p5("POST", "/api/storage", body(b, "too-much", map[string]any{"direction": "deposit", "chest": "personal", "asset": map[string]any{"kind": "material", "id": "stone", "qty": content.HomeRules.PersonalChest.MaxUnits}}), bc, 409).Error.Code != "chest-full" {
		t.Fatal("personal cap")
	}
	if x.p5("POST", "/api/storage", body(b, "bad-chest", map[string]any{"direction": "deposit", "chest": "attic", "asset": timber}), bc, 400).Error.Code != "invalid-chest" {
		t.Fatal("chest name")
	}
	// Partners share the home chest but not each other's personal one.
	if v := x.p5("GET", "/api/storage", nil, ac, 200); v.Storage.Materials["timber"] != 7 || v.Personal.Materials["stone"] != 0 {
		t.Fatal("partner chests")
	}
	if v := x.homeOpRefreshing(bc, &b, "leave", nil, 200); v.Result.Home != nil {
		t.Fatal("left home answer")
	}
	if count(t, x.db, "SELECT count(*) FROM homestead_items WHERE id=? AND account_id='"+x.account("bob")+"' AND location='inventory'", bstool.Result.InstanceIDs[0]) != 1 ||
		count(t, x.db, "SELECT qty FROM item_stacks WHERE location='personal' AND owner='"+x.account("bob")+"' AND item_def='stone'") != 5 {
		t.Fatal("leaver lost their pack or personal chest")
	}
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='storage' AND owner=? AND item_def='timber'", h.ID) != 7 || count(t, x.db, "SELECT count(*) FROM homestead_items WHERE homestead_id=? AND location='placed'", h.ID) != 1 {
		t.Fatal("shared chest or placed pieces left with the leaver")
	}
	if count(t, x.db, "SELECT count(*) FROM homesteads WHERE vacant_since IS NOT NULL") != 0 {
		t.Fatal("vacant with a member left")
	}
	// The personal chest goes with him: readable and emptied anywhere, even
	// with no home at all; only putting things in needs a home.
	if v := x.p5("GET", "/api/storage", nil, bc, 200); v.Personal.Materials["stone"] != 5 || v.Storage != nil || v.Home != nil || v.Shared != "not-a-member" {
		t.Fatal("homeless personal chest", v.Shared)
	}
	x.refresh(bc, &b)
	stone := map[string]any{"kind": "material", "id": "stone", "qty": 2}
	if v := x.p5("POST", "/api/storage", body(b, "homeless-withdraw", map[string]any{"direction": "withdraw", "chest": "personal", "asset": stone}), bc, 200); v.Result.Personal.Materials["stone"] != 3 {
		t.Fatal("withdraw without a home")
	} else {
		b.Snapshot = v.Snapshot
	}
	if x.p5("POST", "/api/storage", body(b, "homeless-deposit", map[string]any{"direction": "deposit", "chest": "personal", "asset": stone}), bc, 409).Error.Code != "not-a-member" {
		t.Fatal("deposit without a home")
	}
	if x.p5("POST", "/api/storage", body(b, "homeless-shared", map[string]any{"direction": "withdraw", "chest": "shared", "asset": timber}), bc, 409).Error.Code != "not-a-member" {
		t.Fatal("a shared chest without a home")
	}
	// Bob takes his personal chest to his next home, at any tier.
	x.claimGate(bc, &b, 1)
	x.refresh(bc, &b)
	if v := x.p5("POST", "/api/storage", body(b, "tier0-deposit", map[string]any{"direction": "deposit", "chest": "personal", "asset": stone}), bc, 200); v.Result.Personal.Materials["stone"] != 5 || v.Result.Storage != nil || v.Result.Shared != "tier-required" {
		t.Fatal("personal chest at a tier-0 home")
	}
	if _, err := x.db.DB.Exec("UPDATE homesteads SET tier=2 WHERE gate=1"); err != nil {
		t.Fatal(err)
	}
	if v := x.p5("GET", "/api/storage", nil, bc, 200); v.Personal.Materials["stone"] != 5 || v.Storage == nil || v.Storage.Materials["timber"] != 0 {
		t.Fatal("personal chest moved with bob")
	}
	x.homeOpRefreshing(ac, &a, "leave", nil, 200)
	if count(t, x.db, "SELECT count(*) FROM homesteads WHERE id=? AND vacant_since=?", h.ID, x.now.Load()) != 1 {
		t.Fatal("last one out leaves it vacant")
	}
	if x.homeOpRefreshing(ac, &a, "leave", nil, 409).Error.Code != "not-a-member" {
		t.Fatal("leave twice")
	}
}

func TestHomes2DesolationAndLostDeeds(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	a = x.openWorkshop(ac, a)
	h := x.home(ac)
	stools := x.p5("POST", "/api/craft", body(a, "stools", map[string]any{"recipeId": "craft-wooden-stool", "qty": 1}), ac, 200)
	a.Snapshot = stools.Snapshot
	spot := litSpots(h)[0]
	x.homeOpRefreshing(ac, &a, "place", map[string]any{"itemId": stools.Result.InstanceIDs[0], "scene": "outdoor", "x": spot[0], "y": spot[1], "rotation": 0}, 200)
	a.Snapshot = x.p5("POST", "/api/storage", body(a, "shared", map[string]any{"direction": "deposit", "asset": map[string]any{"kind": "material", "id": "timber", "qty": 3}}), ac, 200).Snapshot
	x.homeOpRefreshing(ac, &a, "leave", nil, 200)
	dc, d := x.member("dora", a.WorldID)
	gate := h.Gate
	check := func(label string, desolate, claimed bool) {
		t.Helper()
		lane := x.exp("GET", "/api/commons", nil, dc, 200)
		g := lane.Gates[gate]
		if g.Desolate != desolate || (g.HomeID != nil) != claimed || len(g.Names) != 0 {
			t.Fatal(label, g.Desolate, g.HomeID != nil)
		}
	}
	check("vacant", false, true)
	if x.homeOpRefreshing(dc, &d, "claim", map[string]any{"gate": gate}, 409).Error.Code != "gate-taken" {
		t.Fatal("vacant land is still under its deed")
	}
	day := int64(86400)
	x.now.Add(int64(content.HomeRules.GetDesolation().GetDesolateAfterDays())*day - 1)
	check("almost desolate", false, true)
	x.now.Add(1)
	check("desolate", true, true)
	if v := x.exp("GET", fmt.Sprintf("/api/homestead/gate/%d", gate), nil, dc, 200); v.Home == nil || !v.Home.Desolate || placed(*v.Home, stools.Result.InstanceIDs[0]) == nil {
		t.Fatal("desolate home keeps its pieces")
	}
	x.now.Add(int64(content.HomeRules.GetDesolation().GetDeedLostAfterDays()-content.HomeRules.GetDesolation().GetDesolateAfterDays())*day - 1)
	// Dora's session idled out over the fortnight: she signs in again.
	dc = x.login("dora", "")
	d = x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, dc, 200)
	check("not yet lost", true, true)
	x.now.Add(1)
	check("lost", false, false)
	if count(t, x.db, "SELECT count(*) FROM homestead_items WHERE location IN ('placed','storage')") != 0 || count(t, x.db, "SELECT count(*) FROM item_stacks WHERE location='storage'") != 0 || count(t, x.db, "SELECT count(*) FROM lost_gates WHERE gate=?", gate) != 1 {
		t.Fatal("lost deed contents")
	}
	// Dora has never held a deed, but this land's was lost: it costs embers.
	lane := x.exp("GET", "/api/commons", nil, dc, 200)
	price := int(content.HomeRules.GetDeeds().GetGlims())
	if *lane.Gates[gate].Price != price || *lane.Gates[gate+1].Price != 0 {
		t.Fatal("lost deed price")
	}
	if x.homeOpRefreshing(dc, &d, "claim", map[string]any{"gate": gate}, 409).Error.Code != "insufficient-glims" {
		t.Fatal("free lost deed")
	}
	x.fund(x.account("dora"), price, 0)
	x.refresh(dc, &d)
	before := d.State.Glims
	nh := x.claimGate(dc, &d, gate)
	if d.State.Glims != before-price || nh.ID == h.ID || len(nh.Items) != 0 || nh.Tier != 0 || count(t, x.db, "SELECT count(*) FROM lost_gates") != 0 {
		t.Fatal("resettled land")
	}
}

// lanternSpots finds, on a home's land, an open lit tile at the edge of the
// home's own light (for a post) and an open tile only that post would light.
func lanternSpots(t *testing.T, h homeView) (post, beyond [2]int) {
	t.Helper()
	g := groundOf(h)
	start := connectedLights(nil, "")
	open := func(x, y int) bool {
		if !land.Buildable(g.land.Effective(g.cleared, x, y)) {
			return false
		}
		for _, r := range content.HomeRules.GetOutdoorReserved() {
			if (rect{x, y, 1, 1}).overlaps(rect{int(r.GetX()), int(r.GetY()), int(r.GetW()), int(r.GetH())}) {
				return false
			}
		}
		return true
	}
	r := int(content.HomeRules.GetLanternPosts().GetRadius())
	for _, p := range litSpots(h) {
		lights := []land.Light{{X: p[0], Y: p[1], Radius: r}}
		for y := 0; y < g.land.Height; y++ {
			for x := 0; x < g.land.Width; x++ {
				if open(x, y) && !land.Lit(start, x, y) && land.Lit(lights, x, y) {
					return p, [2]int{x, y}
				}
			}
		}
	}
	t.Fatal("no lantern spots on this land")
	return
}

func TestHomes2LanternLightAndClearing(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	x.seedAssets(x.account("alice"))
	h := x.claimGate(ac, &a, 0)
	item := content.HomeRules.GetLanternPosts().GetItem()
	// Each post costs more than the last, from shared content.
	m0 := x.exp("GET", "/api/homestead/gate/0", nil, ac, 200).Materials
	post := x.homeOpRefreshing(ac, &a, "buy", map[string]any{"itemDef": item}, 200)
	second := x.homeOpRefreshing(ac, &a, "buy", map[string]any{"itemDef": item}, 200)
	c0, c1 := content.HomePostCost(content.HomeRules, 0), content.HomePostCost(content.HomeRules, 1)
	for m, n := range c0 {
		if int(post.Result.Materials[m]) != int(m0[m])-int(n) || int(second.Result.Materials[m]) != int(m0[m])-int(n)-int(c1[m]) {
			t.Fatal("post price", m)
		}
	}
	if second.Result.Home.PostsBought != 2 || fmt.Sprint(second.Result.Home.NextPost) != fmt.Sprint(content.HomePostCost(content.HomeRules, 2)) {
		t.Fatal("next post price")
	}
	p, beyond := lanternSpots(t, h)
	stool := x.homeOpRefreshing(ac, &a, "buy", map[string]any{"itemDef": "wooden-stool"}, 200).Result.ItemID
	at := func(id string, xy [2]int, extra map[string]any) map[string]any {
		f := map[string]any{"itemId": id, "scene": "outdoor", "x": xy[0], "y": xy[1], "rotation": 0}
		for k, v := range extra {
			f[k] = v
		}
		return f
	}
	if x.homeOpRefreshing(ac, &a, "place", at(stool, beyond, nil), 409).Error.Code != "unlit" {
		t.Fatal("built in the dark")
	}
	postID := post.Result.ItemID
	if x.homeOpRefreshing(ac, &a, "place", at(postID, p, nil), 400).Error.Code != "name-required" {
		t.Fatal("unnamed post")
	}
	if x.homeOpRefreshing(ac, &a, "place", at(postID, p, map[string]any{"name": "   "}), 400).Error.Code != "name-required" {
		t.Fatal("blank name")
	}
	if x.homeOpRefreshing(ac, &a, "place", at(postID, beyond, map[string]any{"name": "Far"}), 409).Error.Code != "unlit" {
		t.Fatal("post in the dark")
	}
	v := x.homeOpRefreshing(ac, &a, "place", at(postID, p, map[string]any{"name": "  The   Wren "}), 200)
	if pp := placed(*v.Result.Home, postID); pp == nil || pp.Name == nil || *pp.Name != "The Wren" {
		t.Fatal("post name")
	}
	x.homeOpRefreshing(ac, &a, "place", at(stool, beyond, nil), 200)
	// The post now holds land: it can't go, or move away from what it lights.
	if x.homeOpRefreshing(ac, &a, "remove", map[string]any{"itemId": postID}, 409).Error.Code != "post-holds-land" {
		t.Fatal("removed a holding post")
	}
	far := litSpots(h)
	away := far[0]
	for _, s := range far {
		lights := []land.Light{{X: s[0], Y: s[1], Radius: int(content.HomeRules.GetLanternPosts().GetRadius())}}
		if !land.Lit(lights, beyond[0], beyond[1]) && s != p {
			away = s
			break
		}
	}
	if x.homeOpRefreshing(ac, &a, "move", at(postID, away, nil), 409).Error.Code != "post-holds-land" {
		t.Fatal("moved a holding post")
	}
	x.homeOpRefreshing(ac, &a, "remove", map[string]any{"itemId": stool}, 200)
	x.homeOpRefreshing(ac, &a, "remove", map[string]any{"itemId": postID}, 200)
	if count(t, x.db, "SELECT count(*) FROM homestead_items WHERE id=? AND name IS NULL AND location='inventory'", postID) != 1 {
		t.Fatal("post put away")
	}
	// Trees take tiles until Silas clears them for glims.
	g := groundOf(h)
	start := connectedLights(nil, "")
	var tree, darkTree, grass [2]int
	found := 0
	for y := 0; y < g.land.Height; y++ {
		for x := 0; x < g.land.Width; x++ {
			k := g.land.At(x, y)
			if land.Clearable(k) && land.Lit(start, x, y) && found&1 == 0 {
				tree, found = [2]int{x, y}, found|1
			}
			if land.Clearable(k) && !land.Lit(start, x, y) && found&2 == 0 {
				darkTree, found = [2]int{x, y}, found|2
			}
			if k == land.Grass && found&4 == 0 {
				grass, found = [2]int{x, y}, found|4
			}
		}
	}
	if found != 7 {
		t.Fatal("land fixture", found)
	}
	if x.homeOpRefreshing(ac, &a, "place", at(stool, tree, nil), 409).Error.Code != "land-blocked" {
		t.Fatal("built on a tree")
	}
	if x.homeOpRefreshing(ac, &a, "clear", map[string]any{"x": grass[0], "y": grass[1]}, 409).Error.Code != "not-clearable" {
		t.Fatal("cleared grass")
	}
	if x.homeOpRefreshing(ac, &a, "clear", map[string]any{"x": darkTree[0], "y": darkTree[1]}, 409).Error.Code != "unlit" {
		t.Fatal("cleared in the dark")
	}
	x.refresh(ac, &a)
	before := a.State.Glims
	cleared := x.homeOpRefreshing(ac, &a, "clear", map[string]any{"x": tree[0], "y": tree[1]}, 200)
	if a.State.Glims != before-int(content.HomeRules.GetClearTileGlims()) || len(cleared.Result.Home.Cleared) != 1 || cleared.Result.Home.Cleared[0] != tree {
		t.Fatal("clear tile")
	}
	if x.homeOpRefreshing(ac, &a, "clear", map[string]any{"x": tree[0], "y": tree[1]}, 409).Error.Code != "already-cleared" {
		t.Fatal("cleared twice")
	}
	x.homeOpRefreshing(ac, &a, "place", at(stool, tree, nil), 200)

	// A free clearing (a price of 0, which content refuses today) is a
	// zero-delta mark, never a 500 (review B finding 2).
	price := content.HomeRules.ClearTileGlims
	content.HomeRules.ClearTileGlims = 0
	defer func() { content.HomeRules.ClearTileGlims = price }()
	var free [2]int
	for y := 0; y < g.land.Height && free == ([2]int{}); y++ {
		for x := 0; x < g.land.Width; x++ {
			if p := [2]int{x, y}; land.Clearable(g.land.At(x, y)) && land.Lit(start, x, y) && p != tree {
				free = p
				break
			}
		}
	}
	if free == ([2]int{}) {
		t.Fatal("land fixture: one lit tree")
	}
	x.refresh(ac, &a)
	before = a.State.Glims
	x.homeOpRefreshing(ac, &a, "clear", map[string]any{"x": free[0], "y": free[1]}, 200)
	if a.State.Glims != before || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='homestead-clear' AND delta=0") != 1 {
		t.Fatal("a free clearing", a.State.Glims, before)
	}
}

func TestHomes2CrossWorldIsolation(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	oc, o := x.ready("outsider")
	if a.WorldID == o.WorldID {
		t.Fatal("fixture worlds")
	}
	h := x.claimGate(ac, &a, 0)
	// Same gate number, another world: separate land, separate deed.
	oh := x.claimGate(oc, &o, 0)
	if oh.ID == h.ID || oh.LandSeed == h.LandSeed || oh.WorldID != o.WorldID {
		t.Fatal("worlds share a gate")
	}
	if v := x.exp("GET", "/api/homestead/gate/0", nil, oc, 200); v.Home.ID != oh.ID || v.LandSeed != land.Seed(o.WorldID, 0, content.HomeRules.Land) {
		t.Fatal("read crossed worlds")
	}
	if x.homeOpRefreshing(ac, &a, "invite", map[string]any{"to": x.account("outsider")}, 403).Error.Code != "world-access-denied" {
		t.Fatal("cross-world invite")
	}
	x.homeOpRefreshing(ac, &a, "invite", map[string]any{"to": "nobody"}, 404)
	// A stray invite row across worlds is never honoured.
	if _, err := x.db.DB.Exec("INSERT INTO homestead_invites(homestead_id,to_id,from_id,created_at,expires_at) VALUES(?,?,?,?,?)", h.ID, x.account("outsider"), x.account("alice"), x.now.Load(), x.now.Load()+3600); err != nil {
		t.Fatal(err)
	}
	x.atTable(x.account("alice"), a.WorldID)
	x.atTable("outsider", o.WorldID)
	x.homeOpRefreshing(oc, &o, "leave", nil, 200)
	if x.homeOpRefreshing(oc, &o, "joint", map[string]any{"homeId": h.ID, "to": x.account("outsider")}, 404).Error.Code != "invite-not-found" {
		t.Fatal("cross-world joint")
	}
	if len(x.exp("GET", "/api/commons", nil, oc, 200).Invites) != 0 {
		t.Fatal("cross-world invites listed")
	}
	if count(t, x.db, "SELECT count(*) FROM homestead_members WHERE homestead_id=?", h.ID) != 1 {
		t.Fatal("joined across worlds")
	}
}
