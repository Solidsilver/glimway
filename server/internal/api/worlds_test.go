package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/store"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

// Party-linked worlds and moving between worlds (docs/expansion-design.md
// "Worlds"): the party counts as an invite, an invite code still wins, the
// join prompt shows once, and a move is one keyed transaction.

type worldResponse struct {
	store.Snapshot
	worldView
	Result struct {
		World    worldView `json:"world"`
		From     string    `json:"from"`
		LeftHome bool      `json:"leftHome"`
		Returned int       `json:"returned"`
	} `json:"result"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
	raw string
}

func (x *rig) worldReq(method, path string, b any, c *http.Cookie, status int) worldResponse {
	x.t.Helper()
	r := httptest.NewRequest(method, path, bytes.NewBufferString(store.JSON(b)))
	r.Header.Set("Content-Type", "application/json")
	if c != nil {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	var v worldResponse
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		x.t.Fatal(err)
	}
	v.raw = w.Body.String()
	if w.Code != status {
		x.t.Fatalf("%s %s: got %d %s want %d", method, path, w.Code, w.Body.String(), status)
	}
	return v
}

// hero: what the fake Habitica reports for id (name, and party when given).
func (x *rig) hero(id, name, party string) {
	p := profile(id, 1, 0, 20)
	p.Name = name
	if party != "" {
		p.PartyID = &party
	}
	x.set(p)
}

// again: a later sign-in (the party is read again) that takes the lease back.
func (x *rig) again(id string) (*http.Cookie, response) {
	x.t.Helper()
	c := x.login(id, "")
	return c, x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a", "takeOver": true}, c, 200)
}

func (x *rig) worldOf(id string) string {
	x.t.Helper()
	var w string
	if err := x.db.DB.QueryRow("SELECT world_id FROM players WHERE habitica_id=?", id).Scan(&w); err != nil {
		x.t.Fatal(err)
	}
	return w
}

// moveBody: a move from a safe spot (or the given area), with the current
// lease, revision and progress.
func moveBody(s response, key, world, area string) map[string]any {
	doc := s.State
	doc.Area = area
	return body(s, key, map[string]any{"worldId": world, "progress": doc})
}

func TestPartyFirstSignInJoinsThePartyWorld(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
	var party string
	if err := x.db.DB.QueryRow("SELECT habitica_party_id FROM worlds WHERE id=?", o.WorldID).Scan(&party); err != nil || party != "p1" {
		t.Fatal("new world not linked to the creator's party", party, err)
	}

	// A code that names no world still decides: a world of their own, not
	// linked (the party already has Olive's: a party links one world).
	x.now.Add(10)
	x.hero("pip", "Pip", "p1")
	code, err := x.db.Invite(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	x.login("pip", code)
	pipWorld := x.worldOf("pip")
	if pipWorld == o.WorldID {
		t.Fatal("a world-less invite joined the party world")
	}
	if count(t, x.db, "SELECT count(*) FROM worlds WHERE id=? AND habitica_party_id IS NULL", pipWorld) != 1 {
		t.Fatal("a second world took the party's link")
	}

	// Allowlisted, no code: the party's world.
	x.now.Add(10)
	x.hero("rue", "Rue", "p1")
	rc, _ := x.ready("rue")
	if x.worldOf("rue") != o.WorldID {
		t.Fatal("party member didn't join the party world")
	}
	v := x.worldReq("GET", "/api/world", nil, rc, 200)
	if v.World.ID != o.WorldID || v.World.OwnerName != "Olive" || v.World.Members != 2 || v.IsOwner || !v.LinkedToMine || v.Prompt || v.PartyWorld != nil {
		t.Fatal("rue's world view", v.raw)
	}

	// An invite code still wins: with a code for Pip's world, a party member
	// joins Pip's, whether or not they were allowlisted already.
	x.hero("sage", "Sage", "p1")
	code, _ = x.db.Invite(context.Background(), pipWorld)
	x.login("sage", code)
	if x.worldOf("sage") != pipWorld {
		t.Fatal("invite didn't win over the party")
	}
	x.hero("tam", "Tam", "p1")
	if err = x.db.Allow(context.Background(), "tam", true); err != nil {
		t.Fatal(err)
	}
	code, _ = x.db.Invite(context.Background(), pipWorld)
	if st, _, e, _ := x.request("POST", "/api/session", map[string]any{"userId": "tam", "token": secret, "invite": code}, nil); st != 200 {
		t.Fatal("allowlisted login with a code", st, e)
	}
	if x.worldOf("tam") != pipWorld || count(t, x.db, "SELECT count(*) FROM invites WHERE used_by='tam'") != 1 {
		t.Fatal("allowlisted newcomer's code didn't count")
	}

	// The allowlist still decides who plays at all.
	x.hero("ned", "Ned", "p1")
	if st, _, e, _ := x.request("POST", "/api/session", map[string]any{"userId": "ned", "token": secret}, nil); st != 403 || e != "access-denied" {
		t.Fatal("party member without access signed in", st, e)
	}
	if count(t, x.db, "SELECT count(*) FROM players WHERE habitica_id='ned'") != 0 {
		t.Fatal("refused player created")
	}

	// Only the owner links or unlinks. Unlinked, the party has no world: the
	// next newcomer starts one, and it becomes the party's.
	x.worldReq("POST", "/api/world/party", map[string]any{"link": false}, rc, 403)
	x.worldReq("POST", "/api/world/party", map[string]any{}, oc, 400)
	if v = x.worldReq("POST", "/api/world/party", map[string]any{"link": false}, oc, 200); v.Linked || v.LinkedToMine {
		t.Fatal("unlink", v.raw)
	}
	x.hero("uma", "Uma", "p1")
	x.ready("uma")
	umaWorld := x.worldOf("uma")
	if umaWorld == o.WorldID || umaWorld == pipWorld || count(t, x.db, "SELECT count(*) FROM worlds WHERE id=? AND habitica_party_id='p1'", umaWorld) != 1 {
		t.Fatal("unlinked world still drew the party, or the new world wasn't linked")
	}
	// Linking is exclusive: Olive's link takes the party back from Uma's world.
	if v = x.worldReq("POST", "/api/world/party", map[string]any{"link": true}, oc, 200); !v.Linked || !v.LinkedToMine {
		t.Fatal("relink", v.raw)
	}
	if count(t, x.db, "SELECT count(*) FROM worlds WHERE habitica_party_id='p1'") != 1 || count(t, x.db, "SELECT count(*) FROM worlds WHERE id=? AND habitica_party_id='p1'", o.WorldID) != 1 {
		t.Fatal("link not exclusive")
	}
	// An owner with no party has nothing to link.
	x.hero("vic", "Vic", "")
	vc, _ := x.ready("vic")
	x.worldReq("POST", "/api/world/party", map[string]any{"link": true}, vc, 409)
	if count(t, x.db, "SELECT count(*) FROM worlds WHERE owner_id='vic' AND habitica_party_id IS NULL") != 1 {
		t.Fatal("no-party world linked")
	}
	if v = x.worldReq("GET", "/api/world", nil, vc, 200); v.InParty || v.PartyWorld != nil || v.Prompt {
		t.Fatal("no-party view", v.raw)
	}
}

func TestPartyPromptShownOnce(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	_, o := x.ready("olive")
	// Settled before joining the party: a world of their own, unlinked.
	x.now.Add(10)
	x.hero("hal", "Hal", "")
	hc, h := x.ready("hal")
	if v := x.worldReq("GET", "/api/world", nil, hc, 200); v.Prompt || v.PartyWorld != nil {
		t.Fatal("prompt without a party", v.raw)
	}
	// The party is read at the next sign-in, never in between.
	x.hero("hal", "Hal", "p1")
	if v := x.worldReq("GET", "/api/world", nil, hc, 200); v.Prompt {
		t.Fatal("party read outside sign-in")
	}
	hc = x.login("hal", "")
	v := x.worldReq("GET", "/api/world", nil, hc, 200)
	if !v.Prompt || v.PartyWorld == nil || v.PartyWorld.ID != o.WorldID || v.PartyWorld.OwnerName != "Olive" || v.World.ID != h.WorldID || !v.IsOwner || v.OwnWorld != nil {
		t.Fatal("prompt", v.raw)
	}
	x.worldReq("POST", "/api/world/prompt", map[string]any{"worldId": "nowhere"}, hc, 404)
	if v = x.worldReq("POST", "/api/world/prompt", map[string]any{"worldId": o.WorldID}, hc, 200); v.Prompt {
		t.Fatal("prompt after seen")
	}
	x.worldReq("POST", "/api/world/prompt", map[string]any{"worldId": o.WorldID}, hc, 200)
	hc = x.login("hal", "")
	v = x.worldReq("GET", "/api/world", nil, hc, 200)
	if v.Prompt || v.PartyWorld == nil || v.PartyWorld.ID != o.WorldID {
		t.Fatal("prompt shown twice, or the party world lost from settings", v.raw)
	}
	if count(t, x.db, "SELECT count(*) FROM party_prompts WHERE habitica_id='hal'") != 1 {
		t.Fatal("prompt rows")
	}
}

func TestWorldMoveRefusedWhenUnsafe(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	_, o := x.ready("olive")
	x.hero("stranger", "Stranger", "p9")
	_, stranger := x.ready("stranger")
	x.now.Add(10)
	x.hero("hal", "Hal", "")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	hc, h := x.again("hal")
	_, b := x.member("bob", h.WorldID)
	x.seedAssets("hal")
	x.refresh(hc, &h)
	before := x.worldReq("GET", "/api/state", nil, hc, 200).Snapshot

	// Only from the village or the Commons.
	for _, area := range []string{"woodland", "wilds", "home:0"} {
		if e := x.worldReq("POST", "/api/world/move", moveBody(h, "unsafe-"+area, o.WorldID, area), hc, 409).Error.Code; e != "not-at-safe-boundary" {
			t.Fatal(area, e)
		}
	}
	// The lease and revision rules hold.
	stale := moveBody(h, "stale", o.WorldID, "village")
	stale["baseRev"] = h.Rev - 1
	if e := x.worldReq("POST", "/api/world/move", stale, hc, 409).Error.Code; e != "stale-revision" {
		t.Fatal(e)
	}
	old := moveBody(h, "lease", o.WorldID, "village")
	old["lease"] = "old"
	if e := x.worldReq("POST", "/api/world/move", old, hc, 409).Error.Code; e != "superseded" {
		t.Fatal(e)
	}
	// Not their party's world, not theirs, not anywhere.
	if e := x.worldReq("POST", "/api/world/move", moveBody(h, "stranger", stranger.WorldID, "village"), hc, 403).Error.Code; e != "world-access-denied" {
		t.Fatal(e)
	}
	x.worldReq("POST", "/api/world/move", moveBody(h, "nowhere", "nowhere", "village"), hc, 404)
	x.worldReq("POST", "/api/world/move", moveBody(h, "here", h.WorldID, "village"), hc, 409)

	// Parcels on the road from them must come home first.
	sent := x.p5("POST", "/api/mail", body(h, "send", map[string]any{"toId": "bob", "asset": content.Asset{Kind: "material", ID: "timber", Qty: 5}}), hc, 200)
	h.Snapshot = sent.Snapshot
	if v := x.worldReq("GET", "/api/world", nil, hc, 200); v.Leaving.Outgoing != 1 {
		t.Fatal("outgoing", v.raw)
	}
	if e := x.worldReq("POST", "/api/world/move", moveBody(h, "mail", o.WorldID, "village"), hc, 409).Error.Code; e != "mail-in-flight" {
		t.Fatal(e)
	}
	after := x.worldReq("GET", "/api/state", nil, hc, 200).Snapshot
	if x.worldOf("hal") != h.WorldID || after.Rev != sent.Rev || after.State.Area != before.State.Area {
		t.Fatal("a refused move changed something")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='world-move'") != 0 {
		t.Fatal("refused move in the ledger")
	}
	recalled := x.p5("POST", "/api/mail/"+sent.Result.MailID+"/recall", body(h, "recall", nil), hc, 200)
	h.Snapshot = recalled.Snapshot
	moved := x.worldReq("POST", "/api/world/move", moveBody(h, "go", o.WorldID, "commons"), hc, 200)
	if x.worldOf("hal") != o.WorldID || moved.WorldID != o.WorldID || moved.Result.From != b.WorldID {
		t.Fatal("move after recall", moved.raw)
	}
}

func TestWorldMoveCarriesPackAndChestAndLeavesTheRest(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
	x.now.Add(10)
	x.hero("hal", "Hal", "p2")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	hc, h := x.again("hal")
	from := h.WorldID
	bc, b := x.member("bob", from)
	x.seedAssets("bob")
	x.refresh(bc, &b)

	// Hal's homestead with a workshop, a stool placed, timber in the shared
	// chest and in the personal chest, and a trinket carried.
	h = x.openWorkshop(hc, h)
	crafted := x.p5("POST", "/api/craft", body(h, "stools", map[string]any{"recipeId": "craft-wooden-stool", "qty": 1}), hc, 200)
	h.Snapshot = crafted.Snapshot
	spot := litSpots(*crafted.Result.Home)[0]
	update(&h, x.exp("POST", "/api/homestead/place", body(h, "place", map[string]any{"itemId": crafted.Result.InstanceIDs[0], "scene": "outdoor", "x": spot[0], "y": spot[1], "rotation": 0}), hc, 200))
	h.Snapshot = x.p5("POST", "/api/storage", body(h, "shared", map[string]any{"direction": "deposit", "asset": content.Asset{Kind: "material", ID: "timber", Qty: 7}}), hc, 200).Snapshot
	h.Snapshot = x.p5("POST", "/api/storage", body(h, "personal", map[string]any{"direction": "deposit", "chest": "personal", "asset": content.Asset{Kind: "material", ID: "stone", Qty: 4}}), hc, 200).Snapshot
	home := x.home(hc)

	// Bob's parcel waiting for Hal goes back to Bob.
	sent := x.p5("POST", "/api/mail", body(b, "gift", map[string]any{"toId": "hal", "asset": content.Asset{Kind: "material", ID: "fiber", Qty: 3}}), bc, 200)
	b.Snapshot = sent.Snapshot

	x.refresh(hc, &h)
	v := x.worldReq("GET", "/api/world", nil, hc, 200)
	if v.Leaving.Gate != home.Gate || !v.Leaving.Last || v.Leaving.Incoming != 1 || v.Leaving.Outgoing != 0 || v.PartyWorld == nil || v.PartyWorld.ID != o.WorldID {
		t.Fatal("leaving view", v.raw)
	}

	stacks := func(location, owner string) map[string]int {
		rows, err := x.db.DB.Query("SELECT item_def,maker_id,qty FROM item_stacks WHERE location=? AND owner=?", location, owner)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := map[string]int{}
		for rows.Next() {
			var d, m string
			var n int
			rows.Scan(&d, &m, &n)
			out[d+"/"+m] = n
		}
		return out
	}
	instances := func(location, owner string) int {
		return count(t, x.db, "SELECT count(*) FROM item_instances WHERE location=? AND owner=?", location, owner)
	}
	pack, personal, shared := stacks("pack", "hal"), stacks("personal", "hal"), stacks("storage", home.ID)
	packTools := instances("pack", "hal")
	placed := count(t, x.db, "SELECT count(*) FROM homestead_items WHERE homestead_id=? AND location='placed'", home.ID)
	if len(personal) == 0 || len(shared) == 0 || placed != 1 {
		t.Fatal("setup", personal, shared, placed)
	}
	embers, quest := h.State.Embers, h.State.Quest
	bobFiber := stacks("pack", "bob")
	x.conserved("hal")
	x.conserved("bob")

	req := moveBody(h, "move-1", o.WorldID, "commons")
	moved := x.worldReq("POST", "/api/world/move", req, hc, 200)
	if moved.WorldID != o.WorldID || moved.Rev != h.Rev+1 || !moved.Result.LeftHome || moved.Result.Returned != 1 || moved.Result.From != from || moved.Result.World.World.ID != o.WorldID {
		t.Fatal("move answer", moved.raw)
	}
	// Comes with them: character, story, embers, pack and personal chest.
	if moved.State.Embers != embers || moved.State.Quest != quest || moved.State.Area != "commons" {
		t.Fatal("character changed")
	}
	if !reflect.DeepEqual(stacks("pack", "hal"), pack) || instances("pack", "hal") != packTools || !reflect.DeepEqual(stacks("personal", "hal"), personal) {
		t.Fatal("pack or personal chest changed")
	}
	// Stays behind: membership (the last one out: the land goes vacant), the
	// placed stool and the shared chest.
	if count(t, x.db, "SELECT count(*) FROM homestead_members WHERE habitica_id='hal'") != 0 {
		t.Fatal("still homesteaded")
	}
	if count(t, x.db, "SELECT count(*) FROM homesteads WHERE id=? AND world_id=? AND vacant_since IS NOT NULL", home.ID, from) != 1 {
		t.Fatal("the home didn't start to go quiet")
	}
	if !reflect.DeepEqual(stacks("storage", home.ID), shared) || count(t, x.db, "SELECT count(*) FROM homestead_items WHERE homestead_id=? AND location='placed'", home.ID) != placed {
		t.Fatal("the homestead's goods moved")
	}
	if count(t, x.db, "SELECT count(*) FROM mail WHERE id=? AND return_reason='recipient-removed'", sent.Result.MailID) != 1 || !reflect.DeepEqual(stacks("pack", "bob"), mergeStacks(bobFiber, "fiber", 3)) {
		t.Fatal("waiting parcel not returned")
	}
	// The ledger balances for both of them.
	x.conserved("hal")
	x.conserved("bob")
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE habitica_id='hal' AND reason='world-move' AND ref=?", from+">"+o.WorldID) != 1 {
		t.Fatal("move not in the ledger")
	}

	// In the new world: Olive's lane, no homestead yet, Olive sees them.
	lane := x.exp("GET", "/api/commons", nil, hc, 200)
	if lane.Mine != nil {
		t.Fatal("homestead followed")
	}
	if v = x.worldReq("GET", "/api/world", nil, oc, 200); v.World.Members != 2 {
		t.Fatal("members", v.raw)
	}
	if v = x.worldReq("GET", "/api/world", nil, hc, 200); v.World.ID != o.WorldID || v.PartyWorld != nil || v.OwnWorld == nil || v.OwnWorld.ID != from || v.Leaving.Gate != -1 {
		t.Fatal("view after the move", v.raw)
	}

	// A replay answers the same and moves nothing.
	replay := x.worldReq("POST", "/api/world/move", req, hc, 200)
	if replay.raw != moved.raw || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='world-move'") != 1 {
		t.Fatal("replay moved twice")
	}

	// Moving back is the same flow; the old key's replay still doesn't move.
	h.Snapshot = moved.Snapshot
	back := x.worldReq("POST", "/api/world/move", moveBody(h, "move-2", from, "village"), hc, 200)
	if x.worldOf("hal") != from || back.Result.LeftHome {
		t.Fatal("move back")
	}
	if x.worldReq("POST", "/api/world/move", req, hc, 200).raw != moved.raw || x.worldOf("hal") != from {
		t.Fatal("old replay moved again")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='world-move'") != 2 {
		t.Fatal("moves in the ledger")
	}
	// The old home isn't theirs again: rejoining is a fresh start.
	if x.exp("GET", "/api/commons", nil, hc, 200).Mine != nil {
		t.Fatal("homestead restored")
	}
	x.conserved("hal")
}

func mergeStacks(m map[string]int, def string, n int) map[string]int {
	out := map[string]int{}
	for k, v := range m {
		out[k] = v
	}
	for k := range out {
		if len(k) > len(def) && k[:len(def)+1] == def+"/" {
			out[k] += n
			return out
		}
	}
	out[def+"/"] += n
	return out
}

func TestWorldMoveTakesPresenceAlong(t *testing.T) {
	x := newRig(t)
	ts := startPresence(t, x, presenceTestConfig())
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
	x.now.Add(10)
	x.hero("hal", "Hal", "p2")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	hc, h := x.again("hal")
	bc, b := x.member("bob", h.WorldID)

	olive := wsConnect(t, ts, oc, o.Lease)
	olive.join("commons")
	bob := wsConnect(t, ts, bc, b.Lease)
	bob.join("commons")
	hal := wsConnect(t, ts, hc, h.Lease)
	if r := hal.join("commons"); len(r.Players) != 1 || r.Players[0].HabiticaID != "bob" {
		t.Fatal("before", r.Raw)
	}
	bob.expect("join")

	x.worldReq("POST", "/api/world/move", moveBody(h, "go", o.WorldID, "commons"), hc, 200)
	if bob.expect("leave").HabiticaID != "hal" {
		t.Fatal("old room still has them")
	}
	if r := hal.expect("room"); r.Area != "commons" || len(r.Players) != 1 || r.Players[0].HabiticaID != "olive" {
		t.Fatal("new room", r.Raw)
	}
	if j := olive.expect("join"); j.Player.HabiticaID != "hal" {
		t.Fatal("arrival", j.Raw)
	}
	hal.send(positionMessage(12))
	if olive.expect("pos").HabiticaID != "hal" {
		t.Fatal("position in the new world")
	}
	bob.none()
}

// A thank-you note stays readable after its sender moves on.
func TestThanksReadableAfterSenderMoves(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	_, o := x.ready("olive")
	x.now.Add(10)
	x.hero("hal", "Hal", "p1")
	hc, h := x.ready("hal")
	if h.WorldID != o.WorldID {
		t.Fatal("setup")
	}
	x.hero("bob", "Bob", "")
	bc, b := x.member("bob", o.WorldID)
	id := fmt.Sprintf("thanks-%d", x.now.Load())
	if _, err := x.db.DB.Exec("INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES(?,?,?,?,'thanks','',0,'[]','[]',?)", id, o.WorldID, "hal", "bob", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	// Hal joined the party's world at first sign-in; give them one of their own to go to.
	own := "hal-own"
	if _, err := x.db.DB.Exec("INSERT INTO worlds(id,owner_id,seed,created_at) VALUES(?,?,?,?)", own, "hal", "seed", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	// And one to Hal, still unread when they go.
	toHal := id + "-to-hal"
	if _, err := x.db.DB.Exec("INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES(?,?,?,?,'thanks','',0,'[]','[]',?)", toHal, o.WorldID, "bob", "hal", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	moved := x.worldReq("POST", "/api/world/move", moveBody(h, "home", own, "village"), hc, 200)
	if moved.Result.Returned != 0 || count(t, x.db, "SELECT count(*) FROM mail WHERE id=? AND returned_at IS NULL", toHal) != 1 {
		t.Fatal("a thank-you note was sent back")
	}
	x.refresh(bc, &b)
	x.p5("POST", "/api/mail/"+id+"/claim", body(b, "read", nil), bc, 200)
	// Hal still finds Bob's note in the new world, and can read it.
	h.Snapshot = moved.Snapshot
	box := x.p5("GET", "/api/mail", nil, hc, 200)
	found := false
	for _, m := range box.Mail {
		found = found || m.ID == toHal
	}
	if !found {
		t.Fatal("thank-you note lost in the move", store.JSON(box.Mail))
	}
	x.p5("POST", "/api/mail/"+toHal+"/claim", body(h, "read-hal", nil), hc, 200)
}

// The party's world is one someone lives in, its owner's first. Stale links
// never draw newcomers, an owner can unlink a world they left, and a move
// goes only to the party's world (or a world you own).
func TestPartyWorldIsLivedIn(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
	x.now.Add(10)
	// Bob settled before the party; his world carries an old link to it
	// (from before links were exclusive).
	x.hero("bob", "Bob", "")
	x.ready("bob")
	x.hero("bob", "Bob", "p1")
	bc, b := x.again("bob")
	bobWorld := b.WorldID
	if _, err := x.db.DB.Exec("UPDATE worlds SET habitica_party_id='p1' WHERE id=?", bobWorld); err != nil {
		t.Fatal(err)
	}
	// Both linked and lived in by their owners: the oldest wins.
	if v := x.worldReq("GET", "/api/world", nil, bc, 200); v.PartyWorld == nil || v.PartyWorld.ID != o.WorldID || !v.PartyWorld.OwnerHere {
		t.Fatal("party world", v.raw)
	}
	// Bob can't move into his party's other linked world unless he owns it,
	// and Hal can't move into Bob's at all.
	x.now.Add(10)
	x.hero("hal", "Hal", "")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	hc, h := x.again("hal")
	if e := x.worldReq("POST", "/api/world/move", moveBody(h, "into-bob", bobWorld, "village"), hc, 403).Error.Code; e != "world-access-denied" {
		t.Fatal(e)
	}
	// Bob moves into Olive's world; his own is left linked but empty.
	moved := x.worldReq("POST", "/api/world/move", moveBody(b, "join", o.WorldID, "village"), bc, 200)
	b.Snapshot = moved.Snapshot
	// Olive moves away to a world of her own: hers still has Bob in it, but
	// a lived-in world whose owner is home comes first.
	if _, err := x.db.DB.Exec("INSERT INTO worlds(id,owner_id,seed,created_at,habitica_party_id) VALUES('olive-2','olive','seed',?,'p1')", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	x.refresh(oc, &o)
	x.worldReq("POST", "/api/world/move", moveBody(o, "away", "olive-2", "village"), oc, 200)
	v := x.worldReq("GET", "/api/world", nil, hc, 200)
	if v.PartyWorld == nil || v.PartyWorld.ID != "olive-2" {
		t.Fatal("owner-at-home world not preferred", v.raw)
	}
	// Olive unlinks the world she left (she owns it); Bob can unlink his.
	x.worldReq("POST", "/api/world/party", map[string]any{"link": false, "worldId": o.WorldID}, oc, 200)
	x.worldReq("POST", "/api/world/party", map[string]any{"link": false, "worldId": o.WorldID}, bc, 403)
	x.worldReq("POST", "/api/world/party", map[string]any{"link": false, "worldId": "nowhere"}, bc, 404)
	bv := x.worldReq("GET", "/api/world", nil, bc, 200)
	if bv.OwnWorld == nil || bv.OwnWorld.ID != bobWorld || !bv.OwnWorld.Linked {
		t.Fatal("bob's own world", bv.raw)
	}
	if bv = x.worldReq("POST", "/api/world/party", map[string]any{"link": false, "worldId": bobWorld}, bc, 200); bv.OwnWorld == nil || bv.OwnWorld.Linked {
		t.Fatal("unlink a world left behind", bv.raw)
	}
	// Olive also unlinks her new world: nothing linked has anyone in it, so a
	// newcomer starts a world, and it becomes the party's.
	x.worldReq("POST", "/api/world/party", map[string]any{"link": false}, oc, 200)
	if _, err := x.db.DB.Exec("UPDATE worlds SET habitica_party_id='p1' WHERE id=?", bobWorld); err != nil {
		t.Fatal(err)
	}
	x.hero("cal", "Cal", "p1")
	x.ready("cal")
	if w := x.worldOf("cal"); w == bobWorld || w == o.WorldID || w == "olive-2" {
		t.Fatal("an empty linked world drew a newcomer", w)
	}
	if count(t, x.db, "SELECT count(*) FROM worlds WHERE habitica_party_id='p1'") != 1 {
		t.Fatal("the new party world's link isn't exclusive")
	}
}

// A mover's unused codes now admit friends to the world they moved to.
func TestWorldMoveRetargetsInvites(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	_, o := x.ready("olive")
	x.now.Add(10)
	x.hero("hal", "Hal", "")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	hc, h := x.again("hal")
	from := h.WorldID
	waiting := inviteReq(t, x, "POST", "/api/invites", hc, 200)
	revoked := inviteReq(t, x, "POST", "/api/invites", hc, 200)
	inviteReq(t, x, "DELETE", "/api/invites/"+revoked.ID, hc, 200)
	used := inviteReq(t, x, "POST", "/api/invites", hc, 200)
	x.login("early", used.Code)
	if x.worldOf("early") != from {
		t.Fatal("setup")
	}
	x.worldReq("POST", "/api/world/move", moveBody(h, "go", o.WorldID, "village"), hc, 200)
	if count(t, x.db, "SELECT count(*) FROM invites WHERE code_hash=? AND world_id=?", waiting.ID, o.WorldID) != 1 {
		t.Fatal("waiting code still points at the old world")
	}
	if count(t, x.db, "SELECT count(*) FROM invites WHERE code_hash IN (?,?) AND world_id=?", revoked.ID, used.ID, from) != 2 {
		t.Fatal("used or revoked codes changed")
	}
	x.login("friend", waiting.Code)
	if x.worldOf("friend") != o.WorldID {
		t.Fatal("a friend with Hal's code didn't join Hal")
	}
}

// The confirmation warns about warden-set tools left in the shared chest,
// and says a deed in the next world costs embers once you've had one.
func TestWorldMoveLeavingWarnings(t *testing.T) {
	x := newRig(t)
	x.hero("hal", "Hal", "")
	hc, h := x.ready("hal")
	if v := x.worldReq("GET", "/api/world", nil, hc, 200); v.Leaving.DeedCost != 0 || v.Leaving.WardenTools != 0 {
		t.Fatal("first deed free", v.raw)
	}
	h = x.openWorkshop(hc, h)
	axe := x.instance("hal", "bench-axe", -1, "")
	sliver := x.instance("hal", "warden-sliver", -1, "")
	x.op(hc, &h, "fit", map[string]any{"tool": axe, "instance": sliver}, 200)
	h.Snapshot = x.p5("POST", "/api/storage", body(h, "rack", map[string]any{"direction": "deposit", "asset": content.Asset{Kind: "instance", ID: "bench-axe", Qty: 1, Instance: axe}}), hc, 200).Snapshot
	v := x.worldReq("GET", "/api/world", nil, hc, 200)
	if v.Leaving.WardenTools != 1 || v.Leaving.DeedCost != content.HomeRules.Deeds.Embers || v.Leaving.DeedCost == 0 {
		t.Fatal("leaving warnings", v.raw)
	}
}

// A mover whose new room is full is told it's empty there, not left with
// the old world's players.
func TestWorldMoveIntoAFullRoom(t *testing.T) {
	x := newRig(t)
	cfg := presenceTestConfig()
	cfg.MaxRoomPlayers = 1
	ts := startPresence(t, x, cfg)
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
	x.now.Add(10)
	x.hero("hal", "Hal", "")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	hc, h := x.again("hal")
	olive := wsConnect(t, ts, oc, o.Lease)
	olive.join("village")
	hal := wsConnect(t, ts, hc, h.Lease)
	hal.join("village")
	x.worldReq("POST", "/api/world/move", moveBody(h, "go", o.WorldID, "village"), hc, 200)
	if r := hal.expect("room"); r.Area != "village" || len(r.Players) != 0 {
		t.Fatal("full room", r.Raw)
	}
	olive.none()
}
