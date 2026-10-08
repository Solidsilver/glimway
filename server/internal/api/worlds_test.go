package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"glimway/content"
	"glimway/server/internal/store"
	"net/http"
	"reflect"
	"testing"
	"time"
)

// Party worlds and moving between worlds (docs/home-server.md "Party worlds
// and world moves"): a party's world belongs to the party, its members walk
// in with no code, an invite code still wins, the join prompt shows once, a
// move is one keyed transaction, and moves are a day apart.

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
	v, w := httpResponse[worldResponse](x, method, path, b, c, status)
	v.raw = w.Body.String()
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
	if err := x.db.DB.QueryRow("SELECT world_id FROM players WHERE account_id=(SELECT account_id FROM sign_ins WHERE method='habitica' AND subject=?)", id).Scan(&w); err != nil {
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

// partyWorldOf: the party's world (owned by no one), or "".
func (x *rig) partyWorldOf(party string) string {
	x.t.Helper()
	var w string
	if err := x.db.DB.QueryRow("SELECT id FROM worlds WHERE habitica_party_id=? AND owner_id=''", party).Scan(&w); err != nil && err != sql.ErrNoRows {
		x.t.Fatal(err)
	}
	return w
}

// signIn: a sign-in with no code and no allowlist entry added for it,
// saying which party the client expects ("" for none).
func (x *rig) signIn(id, party string) (int, string, *http.Cookie) {
	st, v, e, c := x.request("POST", "/api/session", map[string]any{"userId": id, "token": secret, "party": party}, nil)
	if st == 200 {
		x.chooseIfAsked(v, c)
	}
	return st, e, c
}

func TestPartyWorldBelongsToTheParty(t *testing.T) {
	x := newRig(t)
	// No party world anywhere: an unknown account is turned away before
	// Habitica is asked.
	x.hero("ned", "Ned", "p1")
	if st, e, _ := x.signIn("ned", "p1"); st != 403 || e != "access-denied" || x.calls.Load() != 0 {
		t.Fatal("unknown account without a code", st, e, x.calls.Load())
	}
	// The first (operator-admitted) member to sign in makes the party's
	// world, and lands in it.
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
	pw := x.partyWorldOf("p1")
	if pw == "" || o.WorldID != pw || count(t, x.db, "SELECT count(*) FROM worlds") != 1 || count(t, x.db, "SELECT count(*) FROM worlds WHERE opened_by='"+x.account("olive")+"'") != 1 {
		t.Fatal("the party's world", o.WorldID, pw)
	}
	v := x.worldReq("GET", "/api/world", nil, oc, 200)
	if !v.World.Party || v.World.OwnerID != "" || v.World.OwnerName != "" || v.IsOwner || !v.PartyHome || !v.InParty || v.PartyWorld != nil || v.OwnWorld != nil || v.Prompt || v.MoveOpensAt != 0 || v.Leaver != nil || v.PartyCanOpen {
		t.Fatal("olive's view", v.raw)
	}

	// A member walks in with no code and no allowlist entry, and stays allowed.
	x.now.Add(10)
	x.hero("rue", "Rue", "p1")
	st, e, rc := x.signIn("rue", "p1")
	if st != 200 || x.worldOf("rue") != pw || count(t, x.db, "SELECT count(*) FROM allowlist WHERE habitica_id='rue' AND added_by='party'") != 1 {
		t.Fatal("party member without a code", st, e)
	}
	if v = x.worldReq("GET", "/api/world", nil, rc, 200); v.World.ID != pw || v.World.Members != 2 || !v.PartyHome || v.Prompt {
		t.Fatal("rue's view", v.raw)
	}
	// The client must say which party it expects, and Habitica must agree.
	x.hero("tam", "Tam", "p1")
	if st, e, _ := x.signIn("tam", ""); st != 403 || e != "access-denied" {
		t.Fatal("no party claimed", st, e)
	}
	x.hero("tam", "Tam", "p9")
	if st, e, _ := x.signIn("tam", "p1"); st != 403 || e != "access-denied" {
		t.Fatal("claimed party not the verified one", st, e)
	}
	// Someone in another party, or none, still needs a code.
	x.hero("stranger", "Stranger", "p9")
	if st, e, _ := x.signIn("stranger", "p9"); st != 403 || e != "access-denied" {
		t.Fatal("non-member signed in", st, e)
	}
	x.hero("loner", "Loner", "")
	if st, e, _ := x.signIn("loner", ""); st != 403 || e != "access-denied" {
		t.Fatal("no-party account signed in", st, e)
	}
	if count(t, x.db, "SELECT count(*) FROM sign_ins WHERE method='habitica' AND subject IN ('stranger','loner','tam')") != 0 || count(t, x.db, "SELECT count(*) FROM allowlist WHERE habitica_id IN ('stranger','loner','tam')") != 0 || x.partyWorldOf("p9") != "" {
		t.Fatal("a refused sign-in left something behind")
	}

	// Leaving the party removes no one; the CLI does, and the party doesn't
	// let them back.
	x.hero("rue", "Rue", "")
	if st, e, _ := x.signIn("rue", ""); st != 200 || x.worldOf("rue") != pw {
		t.Fatal("left the party, lost access", st, e)
	}
	x.hero("rue", "Rue", "p1")
	if err := x.db.Allow(context.Background(), "rue", false); err != nil {
		t.Fatal(err)
	}
	if st, e, _ := x.signIn("rue", "p1"); st != 403 || e != "access-denied" {
		t.Fatal("removed member came back by the party", st, e)
	}

	// A code that names a world wins; one that names none lands a party
	// member in the party's world, and a newcomer with no party in a world
	// of their own.
	x.hero("hal", "Hal", "")
	hc, h := x.ready("hal")
	if h.WorldID == pw || count(t, x.db, "SELECT count(*) FROM worlds WHERE id=? AND owner_id='"+x.account("hal")+"' AND habitica_party_id IS NULL", h.WorldID) != 1 {
		t.Fatal("hal's own world")
	}
	code := inviteReq(t, x, "POST", "/api/invites", hc, 200).Code
	x.hero("sage", "Sage", "p1")
	x.login("sage", code)
	if x.worldOf("sage") != h.WorldID {
		t.Fatal("a code for hal's world didn't win")
	}
	cli, err := x.db.Invite(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	x.hero("pip", "Pip", "p1")
	x.login("pip", cli)
	if x.worldOf("pip") != pw {
		t.Fatal("a world-less code didn't land a member in the party's world")
	}

	// One world per party, however many sign in or ask.
	x.hero("hal", "Hal", "p1")
	hc = x.login("hal", "")
	if v = x.worldReq("POST", "/api/world/party", map[string]any{}, hc, 200); v.PartyWorld == nil || v.PartyWorld.ID != pw || !v.PartyWorld.Party {
		t.Fatal("asking again made another", v.raw)
	}
	if count(t, x.db, "SELECT count(*) FROM worlds WHERE habitica_party_id='p1' AND owner_id=''") != 1 {
		t.Fatal("more than one world for the party")
	}
	// Without a party there's nothing to make.
	x.hero("vic", "Vic", "")
	vc, _ := x.ready("vic")
	x.worldReq("POST", "/api/world/party", map[string]any{}, vc, 409)
	if v = x.worldReq("GET", "/api/world", nil, vc, 200); v.InParty || v.PartyWorld != nil || v.Prompt || v.PartyHome || v.PartyCanOpen {
		t.Fatal("no-party view", v.raw)
	}
}

// Admission through a party never chains: an account let in through one
// party, now in another, makes no world for it, by signing in or by asking,
// and that party's members stay out. Once the operator adds the account
// itself, it may open one.
func TestPartyAdmissionDoesNotChain(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	x.ready("olive")
	x.hero("rue", "Rue", "p1")
	if st, e, _ := x.signIn("rue", "p1"); st != 200 {
		t.Fatal("setup", st, e)
	}
	// Rue leaves p1 for a party of her own, and signs in.
	x.hero("rue", "Rue", "p2")
	st, e, rc := x.signIn("rue", "p2")
	if st != 200 || x.partyWorldOf("p2") != "" {
		t.Fatal("a party-admitted account made a world", st, e)
	}
	if e := x.worldReq("POST", "/api/world/party", map[string]any{}, rc, 403).Error.Code; e != "party-open-denied" || x.partyWorldOf("p2") != "" {
		t.Fatal("a party-admitted account asked for a world", e)
	}
	if v := x.worldReq("GET", "/api/world", nil, rc, 200); v.PartyCanOpen || v.PartyWorld != nil {
		t.Fatal("offered to open", v.raw)
	}
	// So p2's members are turned away before Habitica is asked.
	calls := x.calls.Load()
	x.hero("zed", "Zed", "p2")
	if st, e, _ := x.signIn("zed", "p2"); st != 403 || e != "access-denied" || x.calls.Load() != calls || count(t, x.db, "SELECT count(*) FROM sign_ins WHERE method='habitica' AND subject='zed'") != 0 {
		t.Fatal("a stranger rode a party-admitted account in", st, e)
	}
	// The operator adds Rue: she's theirs now, and her next sign-in opens p2.
	if err := x.db.Allow(context.Background(), "rue", true); err != nil {
		t.Fatal(err)
	}
	if count(t, x.db, "SELECT count(*) FROM allowlist WHERE habitica_id='rue' AND added_by='cli'") != 1 {
		t.Fatal("allowlist add didn't make the account the operator's")
	}
	if st, e, _ := x.signIn("rue", "p2"); st != 200 || x.partyWorldOf("p2") == "" || count(t, x.db, "SELECT count(*) FROM worlds WHERE opened_by='"+x.account("rue")+"'") != 1 {
		t.Fatal("an operator-admitted account didn't open its party", st, e)
	}
	if st, e, _ := x.signIn("zed", "p2"); st != 200 {
		t.Fatal("p2 member once p2 is open", st, e)
	}
}

// The operator's controls: a closed party admits no one and gets no world,
// members already in keep playing, and opening it again restores it; with
// party admission off, no one comes in through a party and no world is made.
func TestPartyAdmissionControls(t *testing.T) {
	x := newRig(t)
	ctx := context.Background()
	x.hero("olive", "Olive", "p1")
	oc, _ := x.ready("olive")
	pw := x.partyWorldOf("p1")
	if err := x.db.SetPartyOpen(ctx, "p1", false); err != nil {
		t.Fatal(err)
	}
	calls := x.calls.Load()
	x.hero("rue", "Rue", "p1")
	if st, e, _ := x.signIn("rue", "p1"); st != 403 || e != "access-denied" || x.calls.Load() != calls {
		t.Fatal("closed party admitted", st, e)
	}
	if x.login("olive", "") == nil || x.worldOf("olive") != pw {
		t.Fatal("a member of a closed party lost their world")
	}
	// Closed before it had a world: none is made, by sign-in or by asking.
	if err := x.db.SetPartyOpen(ctx, "p2", false); err != nil {
		t.Fatal(err)
	}
	x.hero("bea", "Bea", "p2")
	bc, _ := x.ready("bea")
	if x.partyWorldOf("p2") != "" {
		t.Fatal("a world made for a closed party")
	}
	if e := x.worldReq("POST", "/api/world/party", map[string]any{}, bc, 409).Error.Code; e != "party-closed" {
		t.Fatal(e)
	}
	parties, err := x.db.Parties(ctx)
	if err != nil || len(parties) != 2 || parties[0].PartyID != "p1" || parties[0].WorldID == nil || *parties[0].WorldID != pw || parties[0].Members != 1 || parties[0].OpenedBy == nil || *parties[0].OpenedBy != x.account("olive") || parties[0].ClosedAt == nil || parties[1].PartyID != "p2" || parties[1].WorldID != nil {
		t.Fatal("parties", store.JSON(parties), err)
	}
	if err = x.db.SetPartyOpen(ctx, "p1", true); err != nil {
		t.Fatal(err)
	}
	if st, e, _ := x.signIn("rue", "p1"); st != 200 || x.worldOf("rue") != pw {
		t.Fatal("reopened party", st, e)
	}
	if parties, _ = x.db.Parties(ctx); parties[0].ClosedAt != nil || parties[0].Admitted != 1 || parties[0].Members != 2 {
		t.Fatal("parties after reopening", store.JSON(parties))
	}

	// Party admission off: members wait outside, and no world is made.
	x.api.Config.PartyAdmissionOff = true
	calls = x.calls.Load()
	x.hero("sam", "Sam", "p1")
	if st, e, _ := x.signIn("sam", "p1"); st != 403 || e != "access-denied" || x.calls.Load() != calls {
		t.Fatal("admitted with party admission off", st, e)
	}
	x.hero("cal", "Cal", "p3")
	cc, _ := x.ready("cal")
	if x.partyWorldOf("p3") != "" {
		t.Fatal("a party world made with party admission off")
	}
	x.worldReq("POST", "/api/world/party", map[string]any{}, cc, 409)
	// Worlds already made still work for those in them.
	if v := x.worldReq("GET", "/api/world", nil, oc, 200); !v.PartyHome {
		t.Fatal("party world gone", v.raw)
	}
}

// Sign-ins only a party could admit draw on their own, smaller Habitica
// budget, so strangers can't spend the one listed players need; a random id
// claiming no party (or one with no world) never reaches Habitica.
func TestPartySignInBudget(t *testing.T) {
	x := newRig(t)
	ctx := context.Background()
	if x.api.loginParty.rate != max(1, x.api.Config.LoginGlobalRate/4) {
		t.Fatal("party bucket", x.api.loginParty.rate, x.api.Config.LoginGlobalRate)
	}
	x.hero("olive", "Olive", "p1")
	x.ready("olive")
	for _, c := range []struct{ id, invite, party, want string }{
		{"olive", "", "", "listed"},
		{"random", "", "", ""},
		{"random", "", "p9", ""},
		{"random", "", "p1", "party"}} {
		if got, err := x.api.precheck(ctx, c.id, c.invite, c.party); err != nil || got != c.want {
			t.Fatal(c, got, err)
		}
	}
	// A party bucket of one a minute: the second party-only sign-in waits,
	// while a listed player still signs in.
	x.api.loginParty = &loginLimiter{buckets: map[string]loginBucket{}, rate: 1, window: time.Minute}
	x.hero("rue", "Rue", "p1")
	x.hero("pip", "Pip", "p1")
	if st, e, _ := x.signIn("rue", "p1"); st != 200 {
		t.Fatal("first party sign-in", st, e)
	}
	if st, e, _ := x.signIn("pip", "p1"); st != 429 || e != "login-global-rate-limited" {
		t.Fatal("second party sign-in", st, e)
	}
	if st, e, _ := x.signIn("olive", ""); st != 200 {
		t.Fatal("a listed player paid for the party bucket", st, e)
	}
	// Rue is listed now, so her next sign-in spends the shared budget.
	if st, e, _ := x.signIn("rue", "p1"); st != 200 {
		t.Fatal("a party-admitted account still on the party bucket", st, e)
	}
	calls := x.calls.Load()
	for i := range 5 {
		if st, _, _ := x.signIn(fmt.Sprintf("nobody-%d", i), ""); st != 403 {
			t.Fatal("random id", st)
		}
	}
	if x.calls.Load() != calls {
		t.Fatal("random ids reached Habitica")
	}
}

// A member whose session predates the party's world (sessions outlive the
// sign-in that read the party) asks for it, and it is made then.
func TestPartyWorldOnRequest(t *testing.T) {
	x := newRig(t)
	x.hero("hal", "Hal", "")
	hc, h := x.ready("hal")
	// As if a sign-in from before party worlds read the party.
	if _, err := x.db.DB.Exec("UPDATE players SET habitica_party_id='p1' WHERE account_id='" + x.account("hal") + "'"); err != nil {
		t.Fatal(err)
	}
	if v := x.worldReq("GET", "/api/world", nil, hc, 200); !v.InParty || v.PartyWorld != nil || v.PartyHome || !v.IsOwner {
		t.Fatal("before", v.raw)
	}
	v := x.worldReq("POST", "/api/world/party", map[string]any{}, hc, 200)
	if v.PartyWorld == nil || !v.PartyWorld.Party || v.PartyWorld.Members != 0 || v.PartyWorld.ID != x.partyWorldOf("p1") || !v.Prompt || x.worldOf("hal") != h.WorldID {
		t.Fatal("asked for the party's world", v.raw)
	}
}

func TestPartyPromptShownOnce(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	_, o := x.ready("olive")
	// Settled before joining the party: a world of their own.
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
	if !v.Prompt || v.PartyWorld == nil || v.PartyWorld.ID != o.WorldID || !v.PartyWorld.Party || v.PartyWorld.Members != 1 || v.World.ID != h.WorldID || !v.IsOwner || v.OwnWorld != nil {
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
	if count(t, x.db, "SELECT count(*) FROM party_prompts WHERE account_id='"+x.account("hal")+"'") != 1 {
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
	x.seedAssets(x.account("hal"))
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
	stale["baseRev"] = h.Version - 1
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
	sent := x.p5("POST", "/api/mail", body(h, "send", map[string]any{"toId": x.account("bob"), "asset": content.Asset{Kind: "material", ID: "timber", Qty: 5}}), hc, 200)
	h.Snapshot = sent.Snapshot
	if v := x.worldReq("GET", "/api/world", nil, hc, 200); v.Leaving.Outgoing != 1 {
		t.Fatal("outgoing", v.raw)
	}
	if e := x.worldReq("POST", "/api/world/move", moveBody(h, "mail", o.WorldID, "village"), hc, 409).Error.Code; e != "mail-in-flight" {
		t.Fatal(e)
	}
	after := x.worldReq("GET", "/api/state", nil, hc, 200).Snapshot
	if x.worldOf("hal") != h.WorldID || after.Version != sent.Version || after.State.Area != before.State.Area {
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
	x.hero("hal", "Hal", "")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	hc, h := x.again("hal")
	from := h.WorldID
	bc, b := x.member("bob", from)
	x.seedAssets(x.account("bob"))
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
	sent := x.p5("POST", "/api/mail", body(b, "gift", map[string]any{"toId": x.account("hal"), "asset": content.Asset{Kind: "material", ID: "fiber", Qty: 3}}), bc, 200)
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
	pack, personal, shared := stacks("pack", x.account("hal")), stacks("personal", x.account("hal")), stacks("storage", home.ID)
	packTools := instances("pack", x.account("hal"))
	placed := count(t, x.db, "SELECT count(*) FROM homestead_items WHERE homestead_id=? AND location='placed'", home.ID)
	if len(personal) == 0 || len(shared) == 0 || placed != 1 {
		t.Fatal("setup", personal, shared, placed)
	}
	embers, quest := h.State.Embers, h.State.Quest
	bobFiber := stacks("pack", x.account("bob"))
	x.conserved(x.account("hal"))
	x.conserved(x.account("bob"))

	req := moveBody(h, "move-1", o.WorldID, "commons")
	moved := x.worldReq("POST", "/api/world/move", req, hc, 200)
	if moved.WorldID != o.WorldID || moved.Version != h.Version+1 || !moved.Result.LeftHome || moved.Result.Returned != 1 || moved.Result.From != from || moved.Result.World.World.ID != o.WorldID {
		t.Fatal("move answer", moved.raw)
	}
	// Comes with them: character, story, embers, pack and personal chest.
	if moved.State.Embers != embers || moved.State.Quest != quest || moved.State.Area != "commons" {
		t.Fatal("character changed")
	}
	if !reflect.DeepEqual(stacks("pack", x.account("hal")), pack) || instances("pack", x.account("hal")) != packTools || !reflect.DeepEqual(stacks("personal", x.account("hal")), personal) {
		t.Fatal("pack or personal chest changed")
	}
	// Stays behind: membership (the last one out: the land goes vacant), the
	// placed stool and the shared chest.
	if count(t, x.db, "SELECT count(*) FROM homestead_members WHERE account_id='"+x.account("hal")+"'") != 0 {
		t.Fatal("still homesteaded")
	}
	if count(t, x.db, "SELECT count(*) FROM homesteads WHERE id=? AND world_id=? AND vacant_since IS NOT NULL", home.ID, from) != 1 {
		t.Fatal("the home didn't start to go quiet")
	}
	if !reflect.DeepEqual(stacks("storage", home.ID), shared) || count(t, x.db, "SELECT count(*) FROM homestead_items WHERE homestead_id=? AND location='placed'", home.ID) != placed {
		t.Fatal("the homestead's goods moved")
	}
	if count(t, x.db, "SELECT count(*) FROM mail WHERE id=? AND return_reason='recipient-removed'", sent.Result.MailID) != 1 || !reflect.DeepEqual(stacks("pack", x.account("bob")), mergeStacks(bobFiber, "fiber", 3)) {
		t.Fatal("waiting parcel not returned")
	}
	// The ledger balances for both of them.
	x.conserved(x.account("hal"))
	x.conserved(x.account("bob"))
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id='"+x.account("hal")+"' AND reason='world-move' AND ref=?", from+">"+o.WorldID) != 1 {
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
	if !sameJSONResult(replay.raw, moved.raw) || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='world-move'") != 1 {
		t.Fatal("replay moved twice")
	}

	// Moving back is the same flow, a day later; the old key's replay still
	// doesn't move.
	x.now.Add(MoveCooldown)
	h.Snapshot = moved.Snapshot
	back := x.worldReq("POST", "/api/world/move", moveBody(h, "move-2", from, "village"), hc, 200)
	if x.worldOf("hal") != from || back.Result.LeftHome {
		t.Fatal("move back")
	}
	if !sameJSONResult(x.worldReq("POST", "/api/world/move", req, hc, 200).raw, moved.raw) || x.worldOf("hal") != from {
		t.Fatal("old replay moved again")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='world-move'") != 2 {
		t.Fatal("moves in the ledger")
	}
	// The old home isn't theirs again: rejoining is a fresh start.
	if x.exp("GET", "/api/commons", nil, hc, 200).Mine != nil {
		t.Fatal("homestead restored")
	}
	x.conserved(x.account("hal"))
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
	x.hero("hal", "Hal", "")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	hc, h := x.again("hal")
	bc, b := x.member("bob", h.WorldID)

	olive := wsConnect(t, ts, oc, o.Lease)
	olive.join("commons")
	bob := wsConnect(t, ts, bc, b.Lease)
	bob.join("commons")
	hal := wsConnect(t, ts, hc, h.Lease)
	if r := hal.join("commons"); len(r.Players) != 1 || r.Players[0].AccountID != x.account("bob") {
		t.Fatal("before", r.Raw)
	}
	bob.expect("join")

	x.worldReq("POST", "/api/world/move", moveBody(h, "go", o.WorldID, "commons"), hc, 200)
	if bob.expect("leave").AccountID != x.account("hal") {
		t.Fatal("old room still has them")
	}
	if r := hal.expect("room"); r.Area != "commons" || len(r.Players) != 1 || r.Players[0].AccountID != x.account("olive") {
		t.Fatal("new room", r.Raw)
	}
	if j := olive.expect("join"); j.Player.AccountID != x.account("hal") {
		t.Fatal("arrival", j.Raw)
	}
	hal.send(positionMessage(12))
	if olive.expect("pos").AccountID != x.account("hal") {
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
	// Bob lives there too, through the party (no code leads into it).
	x.hero("bob", "Bob", "p1")
	bc, b := x.ready("bob")
	id := fmt.Sprintf("thanks-%d", x.now.Load())
	if _, err := x.db.DB.Exec("INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES(?,?,?,?,'thanks','',0,'[]','[]',?)", id, o.WorldID, x.account("hal"), x.account("bob"), x.now.Load()); err != nil {
		t.Fatal(err)
	}
	// Hal joined the party's world at first sign-in; give them one of their own to go to.
	own := "hal-own"
	if _, err := x.db.DB.Exec("INSERT INTO worlds(id,owner_id,seed,created_at) VALUES(?,?,?,?)", own, x.account("hal"), "seed", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	// And one to Hal, still unread when they go.
	toHal := id + "-to-hal"
	if _, err := x.db.DB.Exec("INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES(?,?,?,?,'thanks','',0,'[]','[]',?)", toHal, o.WorldID, x.account("bob"), x.account("hal"), x.now.Load()); err != nil {
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

// At most one move a day: a second is refused until 24 hours after the
// first, the world view says when, and a replay of the first still answers.
func TestWorldMoveCooldown(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	x.ready("olive")
	pw := x.partyWorldOf("p1")
	x.now.Add(10)
	x.hero("hal", "Hal", "")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	hc, h := x.again("hal")
	own := h.WorldID
	if v := x.worldReq("GET", "/api/world", nil, hc, 200); v.MoveOpensAt != 0 {
		t.Fatal("never moved, yet waiting", v.raw)
	}
	at := x.now.Load()
	first := moveBody(h, "go", pw, "village")
	moved := x.worldReq("POST", "/api/world/move", first, hc, 200)
	if moved.Result.World.MoveOpensAt != at+MoveCooldown {
		t.Fatal("the move's answer doesn't say when the next opens", moved.raw)
	}
	h.Snapshot = moved.Snapshot
	x.now.Add(MoveCooldown - 1)
	if v := x.worldReq("GET", "/api/world", nil, hc, 200); v.MoveOpensAt != at+MoveCooldown || v.OwnWorld == nil || v.OwnWorld.ID != own {
		t.Fatal("view during the cooldown", v.raw)
	}
	if e := x.worldReq("POST", "/api/world/move", moveBody(h, "back-early", own, "village"), hc, 409).Error.Code; e != "move-cooldown" {
		t.Fatal(e)
	}
	after := x.worldReq("GET", "/api/state", nil, hc, 200).Snapshot
	if x.worldOf("hal") != pw || after.Version != h.Version || count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='world-move'") != 1 {
		t.Fatal("a refused move changed something")
	}
	// The first move's replay answers as it did, even now.
	if r := x.worldReq("POST", "/api/world/move", first, hc, 200); !sameJSONResult(r.raw, moved.raw) {
		t.Fatal("replay during the cooldown", r.raw)
	}
	x.now.Add(1)
	if v := x.worldReq("GET", "/api/world", nil, hc, 200); v.MoveOpensAt != 0 {
		t.Fatal("still waiting after a day", v.raw)
	}
	back := x.worldReq("POST", "/api/world/move", moveBody(h, "back", own, "village"), hc, 200)
	if x.worldOf("hal") != own || back.Result.World.MoveOpensAt != x.now.Load()+MoveCooldown {
		t.Fatal("move after the cooldown", back.raw)
	}
	x.conserved(x.account("hal"))
}

// Worlds people own keep working: their residents stay, the owner can go to
// the party's world and back, codes still lead into them, and a person's
// world never counts as a party's, whatever party id it carries.
func TestPersonOwnedWorldsKeepWorking(t *testing.T) {
	x := newRig(t)
	x.hero("bob", "Bob", "")
	bc, b := x.ready("bob")
	bobWorld := b.WorldID
	code := inviteReq(t, x, "POST", "/api/invites", bc, 200).Code
	x.hero("rue", "Rue", "")
	rc := x.login("rue", code)
	if x.worldOf("rue") != bobWorld {
		t.Fatal("setup")
	}
	// As if an old link survived: still not the party's world.
	if _, err := x.db.DB.Exec("UPDATE worlds SET habitica_party_id='p1' WHERE id=?", bobWorld); err != nil {
		t.Fatal(err)
	}
	x.hero("ned", "Ned", "p1")
	if st, e, _ := x.signIn("ned", "p1"); st != 403 || e != "access-denied" {
		t.Fatal("a person's world opened the party", st, e)
	}
	// Bob joins a party: its world is made (the old link doesn't stand in
	// the way) and offered in the Menu, but no prompt asks him or Rue to
	// leave the world it was linked to; he stays put.
	x.hero("bob", "Bob", "p1")
	bc, b = x.again("bob")
	pw := x.partyWorldOf("p1")
	v := x.worldReq("GET", "/api/world", nil, bc, 200)
	if pw == "" || x.worldOf("bob") != bobWorld || !v.IsOwner || v.World.Party || v.World.Members != 2 || v.PartyWorld == nil || v.PartyWorld.ID != pw || v.Prompt {
		t.Fatal("bob's view", v.raw)
	}
	// Rue, who came by Bob's code and has no party, can't follow there.
	var r response
	rc, r = x.again("rue")
	if e := x.worldReq("POST", "/api/world/move", moveBody(r, "follow", pw, "village"), rc, 403).Error.Code; e != "world-access-denied" {
		t.Fatal(e)
	}
	// Bob goes to the party's world and, a day later, home again; Rue's
	// still there, and Bob's codes lead to where he is.
	moved := x.worldReq("POST", "/api/world/move", moveBody(b, "party", pw, "village"), bc, 200)
	b.Snapshot = moved.Snapshot
	if mv := moved.Result.World; !mv.PartyHome || mv.OwnWorld == nil || mv.OwnWorld.ID != bobWorld || mv.OwnWorld.Members != 1 || mv.OwnWorld.OwnerHere {
		t.Fatal("in the party's world", moved.raw)
	}
	x.now.Add(MoveCooldown)
	x.worldReq("POST", "/api/world/move", moveBody(b, "home", bobWorld, "village"), bc, 200)
	if x.worldOf("bob") != bobWorld || x.worldOf("rue") != bobWorld {
		t.Fatal("home again")
	}
	code = inviteReq(t, x, "POST", "/api/invites", bc, 200).Code
	x.hero("cal", "Cal", "")
	x.login("cal", code)
	if x.worldOf("cal") != bobWorld {
		t.Fatal("a code for bob's world")
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
	// Into the party's world, which takes no codes: Hal's keep naming his own.
	moved := x.worldReq("POST", "/api/world/move", moveBody(h, "go", o.WorldID, "village"), hc, 200)
	if count(t, x.db, "SELECT count(*) FROM invites WHERE code_hash IN (?,?,?) AND world_id=?", waiting.ID, revoked.ID, used.ID, from) != 3 {
		t.Fatal("codes followed Hal into the party's world")
	}
	x.login("friend", waiting.Code)
	if x.worldOf("friend") != from {
		t.Fatal("a friend with Hal's code didn't land in Hal's own world")
	}
	// Between worlds of his own, they follow him.
	if _, err := x.db.DB.Exec("INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('hal-2','" + x.account("hal") + "','s',1)"); err != nil {
		t.Fatal(err)
	}
	h.Snapshot = moved.Snapshot
	x.now.Add(MoveCooldown)
	h.Snapshot = x.worldReq("POST", "/api/world/move", moveBody(h, "back", from, "village"), hc, 200).Snapshot
	next := inviteReq(t, x, "POST", "/api/invites", hc, 200)
	x.now.Add(MoveCooldown)
	x.worldReq("POST", "/api/world/move", moveBody(h, "on", "hal-2", "village"), hc, 200)
	if count(t, x.db, "SELECT count(*) FROM invites WHERE code_hash=? AND world_id='hal-2'", next.ID) != 1 || count(t, x.db, "SELECT count(*) FROM invites WHERE code_hash IN (?,?) AND world_id=?", revoked.ID, used.ID, from) != 2 {
		t.Fatal("waiting code didn't follow, or used and revoked ones changed")
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
	axe := x.instance(x.account("hal"), "bench-axe", -1, "")
	sliver := x.instance(x.account("hal"), "warden-sliver", -1, "")
	x.opRefreshing(hc, &h, "fit", map[string]any{"tool": axe, "instance": sliver}, 200)
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

func sameJSONResult(a, b string) bool {
	var left, right map[string]any
	if json.Unmarshal([]byte(a), &left) != nil || json.Unmarshal([]byte(b), &right) != nil {
		return false
	}
	return store.JSON(left["result"]) == store.JSON(right["result"])
}
