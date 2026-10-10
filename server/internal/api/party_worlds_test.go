package api

import (
	"context"
	"encoding/json"
	"glimway/content"
	"glimway/server/internal/store"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

// A party's world is for that party only (docs/home-server.md "Party worlds
// and world moves"): no invite code leads into it, an older linked world
// joins its party only when the operator adopts it, and a resident who has
// left the party is warned, may leave at once, and is moved out after the
// grace period.

func jsonInto(raw string, v any) error { return json.Unmarshal([]byte(raw), v) }

// rawGet: a GET's body as it came.
func (x *rig) rawGet(path string, c *http.Cookie) string {
	x.t.Helper()
	r := httptest.NewRequest("GET", path, nil)
	r.Header.Set("X-Glimway-Contract", "5")
	r.AddCookie(c)
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	if w.Code != 200 {
		x.t.Fatalf("GET %s: %d %s", path, w.Code, w.Body.String())
	}
	return w.Body.String()
}

// playAs: a sign-in (no code, saying the party) that then takes the lease.
func (x *rig) playAs(id, party string) (*http.Cookie, response) {
	x.t.Helper()
	st, e, c := x.signIn(id, party)
	if st != 200 {
		x.t.Fatalf("sign-in %s: %d %s", id, st, e)
	}
	return c, x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a", "takeOver": true}, c, 200)
}

func TestNoInviteCodesIntoAPartyWorld(t *testing.T) {
	x := newRig(t)
	ctx := context.Background()
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
	// A resident invites no one, and the Menu is told why.
	if e := x.worldReq("POST", "/api/invites", map[string]any{}, oc, 409).Error.Code; e != "party-world-invites" {
		t.Fatal(e)
	}
	var list struct {
		PartyWorld bool `json:"partyWorld"`
	}
	if raw := x.rawGet("/api/invites", oc); jsonInto(raw, &list) != nil || !list.PartyWorld {
		t.Fatal("invite list doesn't say party world", raw)
	}
	// The CLI can't name it either.
	if _, err := x.db.Invite(ctx, o.WorldID, x.now.Load()); err == nil {
		t.Fatal("a CLI code named a party's world")
	}
	// An older code that names it admits no one (and doesn't reach Habitica).
	x.hero("hal", "Hal", "")
	hc, _ := x.ready("hal")
	old := inviteReq(t, x, "POST", "/api/invites", hc, 200)
	var hl struct {
		PartyWorld bool `json:"partyWorld"`
	}
	if err := jsonInto(x.rawGet("/api/invites", hc), &hl); err != nil || hl.PartyWorld {
		t.Fatal("hal's own world counted as a party's")
	}
	if _, err := x.db.DB.Exec("UPDATE invites SET world_id=? WHERE code_hash=?", o.WorldID, old.ID); err != nil {
		t.Fatal(err)
	}
	calls := x.calls.Load()
	x.hero("ned", "Ned", "")
	if st, _, e, _ := x.request("POST", "/api/session", map[string]any{"userId": "ned", "token": secret, "invite": old.Code}, nil); st != 403 || e != "access-denied" || x.calls.Load() != calls {
		t.Fatal("an old code into a party's world", st, e)
	}
	// Allowlisted, the newcomer's code is still refused (it isn't used up),
	// and they land in a world of their own.
	if err := x.db.Allow(ctx, "ned", true, x.now.Load()); err != nil {
		t.Fatal(err)
	}
	if st, _, e, _ := x.request("POST", "/api/session", map[string]any{"userId": "ned", "token": secret, "invite": old.Code}, nil); st != 200 {
		t.Fatal(st, e)
	}
	if x.worldOf("ned") == o.WorldID || count(t, x.db, "SELECT count(*) FROM invites WHERE code_hash=? AND used_by IS NULL", old.ID) != 1 {
		t.Fatal("an old code led into a party's world")
	}
}

// The operator folds a group living in a world an older link tied to its
// party into that party's world: the world becomes the party's (no owner),
// an empty party world made meanwhile is set aside, and a lived-in one is
// never replaced.
func TestPartyAdopt(t *testing.T) {
	x := newRig(t)
	ctx := context.Background()
	x.hero("bob", "Bob", "")
	bc, b := x.ready("bob")
	bobWorld := b.WorldID
	code := inviteReq(t, x, "POST", "/api/invites", bc, 200).Code
	x.hero("rue", "Rue", "")
	rc := x.login("rue", code)
	// An older link (022) to p1, kept by 023 as a record.
	if _, err := x.db.DB.Exec("UPDATE worlds SET habitica_party_id='p1' WHERE id=?", bobWorld); err != nil {
		t.Fatal(err)
	}
	if _, err := x.db.AdoptWorld(ctx, "nowhere"); err == nil {
		t.Fatal("adopted nothing")
	}
	x.hero("hal", "Hal", "")
	_, h := x.ready("hal")
	if _, err := x.db.AdoptWorld(ctx, h.WorldID); err == nil {
		t.Fatal("adopted a world with no link")
	}
	// Bob's sign-in in p1 makes an empty party world; adopting sets it aside.
	x.hero("bob", "Bob", "p1")
	bc, _ = x.again("bob")
	empty := x.partyWorldOf("p1")
	if empty == "" || empty == bobWorld {
		t.Fatal("setup")
	}
	party, err := x.db.AdoptWorld(ctx, bobWorld)
	if err != nil || party != "p1" || x.partyWorldOf("p1") != bobWorld || count(t, x.db, "SELECT count(*) FROM worlds WHERE id=? AND habitica_party_id IS NULL", empty) != 1 {
		t.Fatal("adopt", party, err)
	}
	v := x.worldReq("GET", "/api/world", nil, bc, 200)
	if !v.World.Party || !v.PartyHome || v.IsOwner || v.World.Members != 2 || v.PartyWorld != nil || v.Prompt {
		t.Fatal("bob after adopt", v.raw)
	}
	parties, err := x.db.Parties(ctx, x.now.Load())
	if err != nil || len(parties) != 1 || parties[0].WorldID == nil || *parties[0].WorldID != bobWorld || parties[0].OpenedBy == nil || *parties[0].OpenedBy != x.account("bob") || parties[0].Members != 2 {
		t.Fatal("parties", store.JSON(parties), err)
	}
	if _, err = x.db.AdoptWorld(ctx, bobWorld); err == nil {
		t.Fatal("adopted twice")
	}
	// Rue isn't in p1: her next sign-in warns her she'll be moved out.
	rc = x.login("rue", "")
	if v = x.worldReq("GET", "/api/world", nil, rc, 200); v.Leaver == nil {
		t.Fatal("non-member in an adopted world not warned", v.raw)
	}
	// A party whose world is lived in keeps it.
	x.hero("cal", "Cal", "")
	_, c := x.ready("cal")
	if _, err := x.db.DB.Exec("UPDATE worlds SET habitica_party_id='p1' WHERE id=?", c.WorldID); err != nil {
		t.Fatal(err)
	}
	if _, err = x.db.AdoptWorld(ctx, c.WorldID); err == nil || x.partyWorldOf("p1") != bobWorld {
		t.Fatal("a lived-in party world replaced", err)
	}
}

// Leaving the party whose world you live in: a warning from the next
// sign-in, cleared by rejoining; "Leave now" at any time, cooldown or not.
func TestPartyLeaverWarnedAndLeavesNow(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
	pw := o.WorldID
	x.hero("rue", "Rue", "p1")
	rc, r := x.playAs("rue", "p1")
	x.refresh(rc, &r)
	// Still in the party: nothing to leave.
	x.refresh(oc, &o)
	if e := x.worldReq("POST", "/api/world/leave", body(o, "stay", nil), oc, 409).Error.Code; e != "still-in-party" {
		t.Fatal(e)
	}
	// Rue leaves p1; her next sign-in sees it.
	x.now.Add(10)
	left := x.now.Load()
	x.hero("rue", "Rue", "")
	rc, r = x.playAs("rue", "")
	v := x.worldReq("GET", "/api/world", nil, rc, 200)
	if v.Leaver == nil || v.Leaver.LeftAt != left || v.Leaver.MoveOutAt != left+PartyGrace || v.Leaver.MoveOutIn != PartyGrace || v.Leaver.HasOwn || x.worldOf("rue") != pw {
		t.Fatal("leaver view", v.raw)
	}
	// A later sign-in keeps the first sighting.
	x.now.Add(100)
	rc, r = x.playAs("rue", "")
	if v = x.worldReq("GET", "/api/world", nil, rc, 200); v.Leaver == nil || v.Leaver.LeftAt != left || v.Leaver.MoveOutIn != PartyGrace-100 {
		t.Fatal("warning restarted", v.raw)
	}
	// Rejoining clears it.
	x.hero("rue", "Rue", "p1")
	rc, r = x.playAs("rue", "p1")
	if v = x.worldReq("GET", "/api/world", nil, rc, 200); v.Leaver != nil || count(t, x.db, "SELECT count(*) FROM players WHERE account_id='"+x.account("rue")+"' AND party_left_at IS NULL") != 1 {
		t.Fatal("rejoined, still warned", v.raw)
	}
	// Left again: "Leave now" makes her a world of her own and moves her there.
	x.hero("rue", "Rue", "")
	rc, r = x.playAs("rue", "")
	doc := r.State
	doc.Area = "woodland"
	if e := x.worldReq("POST", "/api/world/leave", body(r, "woods", map[string]any{"progress": doc}), rc, 409).Error.Code; e != "not-at-safe-boundary" {
		t.Fatal(e)
	}
	doc.Area = "village"
	x.conserved(x.account("rue"))
	out := x.worldReq("POST", "/api/world/leave", body(r, "leave", map[string]any{"progress": doc}), rc, 200)
	own := x.worldOf("rue")
	if own == pw || out.WorldID != own || out.Result.From != pw || count(t, x.db, "SELECT count(*) FROM worlds WHERE id=? AND owner_id='"+x.account("rue")+"'", own) != 1 || out.Result.World.Leaver != nil || !out.Result.World.IsOwner {
		t.Fatal("leave now", out.raw)
	}
	x.conserved(x.account("rue"))

	// Hal moved in today (cooldown running), left the party: he may still go.
	x.hero("hal", "Hal", "")
	x.ready("hal")
	x.hero("hal", "Hal", "p1")
	hc, h := x.again("hal")
	home := h.WorldID
	h.Snapshot = x.worldReq("POST", "/api/world/move", moveBody(h, "in", pw, "village"), hc, 200).Snapshot
	x.hero("hal", "Hal", "")
	hc, h = x.playAs("hal", "")
	if v = x.worldReq("GET", "/api/world", nil, hc, 200); v.MoveOpensIn == 0 || v.Leaver == nil || !v.Leaver.HasOwn {
		t.Fatal("hal's view", v.raw)
	}
	x.worldReq("POST", "/api/world/leave", body(h, "out", map[string]any{"progress": h.State}), hc, 200)
	if x.worldOf("hal") != home {
		t.Fatal("hal didn't go home")
	}
}

// After the grace period, the first sign-in moves a leaver out, as leaving
// a deed does: pack and personal chest come along, the homestead and its
// chest stay, the ledger balances, and the next screen can say so.
func TestPartyLeaverMovedOutAfterGrace(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	x.ready("olive")
	pw := x.partyWorldOf("p1")
	x.hero("sage", "Sage", "p1")
	sc, s := x.ready("sage")
	if s.WorldID != pw {
		t.Fatal("setup")
	}
	x.seedAssets(x.account("sage"))
	x.refresh(sc, &s)
	s = x.openWorkshop(sc, s)
	s.Snapshot = x.p5("POST", "/api/storage", body(s, "shared", map[string]any{"direction": "deposit", "asset": content.Asset{Kind: "material", Id: "timber", Qty: 3}}), sc, 200).Snapshot
	s.Snapshot = x.p5("POST", "/api/storage", body(s, "personal", map[string]any{"direction": "deposit", "chest": "personal", "asset": content.Asset{Kind: "material", Id: "stone", Qty: 2}}), sc, 200).Snapshot
	home := x.home(sc)
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
	pack, personal, shared := stacks("pack", "sage"), stacks("personal", "sage"), stacks("storage", home.ID)
	x.conserved(x.account("sage"))

	// Sage leaves p1, and is warned; she wanders off into the woods.
	x.hero("sage", "Sage", "")
	x.login("sage", "")
	if _, err := x.db.DB.Exec("UPDATE player_place SET area='woodland' WHERE account_id='" + x.account("sage") + "'"); err != nil {
		t.Fatal(err)
	}
	x.now.Add(PartyGrace - 1)
	sc = x.login("sage", "")
	if x.worldOf("sage") != pw {
		t.Fatal("moved out before the grace period ran out")
	}
	x.now.Add(1)
	st, after, e, sc := x.request("POST", "/api/session", map[string]any{"userId": "sage", "token": secret}, nil)
	own := x.worldOf("sage")
	if st != 200 || own == pw || after.WorldID != own || after.State.Area != "village" || count(t, x.db, "SELECT count(*) FROM worlds WHERE id=? AND owner_id='"+x.account("sage")+"'", own) != 1 {
		t.Fatal("moved out", st, e, after.WorldID, after.State.Area)
	}
	// What comes along and what stays.
	if !reflect.DeepEqual(stacks("pack", "sage"), pack) || !reflect.DeepEqual(stacks("personal", "sage"), personal) || !reflect.DeepEqual(stacks("storage", home.ID), shared) {
		t.Fatal("goods moved wrongly")
	}
	if count(t, x.db, "SELECT count(*) FROM homestead_members WHERE account_id='"+x.account("sage")+"'") != 0 || count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id='"+x.account("sage")+"' AND reason='world-move' AND ref=?", pw+">"+own) != 1 {
		t.Fatal("homestead kept, or the move not in the ledger")
	}
	x.conserved(x.account("sage"))
	// The next screen says what happened, once.
	v := x.worldReq("GET", "/api/world", nil, sc, 200)
	if v.MovedOutAt != x.now.Load() || v.Leaver != nil || !v.IsOwner {
		t.Fatal("moved-out view", v.raw)
	}
	if v = x.worldReq("POST", "/api/world/notice", map[string]any{}, sc, 200); v.MovedOutAt != 0 {
		t.Fatal("notice not cleared", v.raw)
	}
	// A later sign-in doesn't move her again.
	x.login("sage", "")
	if x.worldOf("sage") != own || count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id='"+x.account("sage")+"' AND reason='world-move'") != 1 {
		t.Fatal("moved twice")
	}
}
