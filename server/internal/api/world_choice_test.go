package api

import (
	"context"
	"fingersnap/server/internal/store"
	"net/http"
	"strings"
	"testing"
)

// signInAsked: a first sign-in that should come back as the world question.
func (x *rig) signInAsked(id, party, invite string) (worldChoiceView, *http.Cookie) {
	x.t.Helper()
	st, v, e, c := x.request("POST", "/api/session", map[string]any{"userId": id, "token": secret, "party": party, "invite": invite}, nil)
	if st != 200 || v.WorldChoice == nil || c == nil {
		x.t.Fatalf("sign-in not held for a choice: %d %s %+v", st, e, v)
	}
	return *v.WorldChoice, c
}

func (x *rig) players(id string) int {
	x.t.Helper()
	return count(x.t, x.db, "SELECT count(*) FROM players WHERE habitica_id=?", id)
}

// Nothing a held sign-in stored carries the token.
func (x *rig) tokenNowhere() {
	x.t.Helper()
	for _, q := range []string{"SELECT count(*) FROM pending_sessions WHERE instr(checkpoint_json,?)>0 OR instr(id_hash,?)>0", "SELECT count(*) FROM sessions WHERE instr(checkpoint_json,?)>0 OR instr(id_hash,?)>0", "SELECT count(*) FROM sync_baselines WHERE instr(checkpoint_json,?)>0 OR instr(profile_json,?)>0"} {
		if count(x.t, x.db, q, secret, secret) != 0 {
			x.t.Fatal("the token was stored", q)
		}
	}
}

func TestWorldChoiceHeldUntilChosenThenParty(t *testing.T) {
	x := newRig(t)
	// Olive, let in by the operator, is the first of her party here: she may
	// open its world, so she is asked (and nothing is made yet).
	x.hero("olive", "Olive", "p1")
	if err := x.db.Allow(context.Background(), "olive", true); err != nil {
		t.Fatal(err)
	}
	q, c := x.signInAsked("olive", "p1", "")
	if q.HabiticaID != "olive" || q.DisplayName != "Olive" || q.PartyWorld != nil || !q.PartyCanOpen {
		t.Fatalf("question %+v", q)
	}
	if x.players("olive") != 0 || x.partyWorldOf("p1") != "" || count(t, x.db, "SELECT count(*) FROM worlds") != 0 {
		t.Fatal("a world or player made before the choice")
	}
	x.tokenNowhere()
	// Everything else waits.
	for _, r := range []struct{ method, path string }{{"GET", "/api/state"}, {"GET", "/api/world"}, {"POST", "/api/origin"}, {"POST", "/api/play"}, {"POST", "/api/world/party"}, {"GET", "/api/invites"}} {
		body := map[string]any{"choice": "fresh", "key": "origin", "clientId": "tab-a"}
		if r.path == "/api/world/party" || r.path == "/api/invites" {
			body = map[string]any{}
		}
		if st, _, e, _ := x.request(r.method, r.path, body, c); st != 409 || e != "world-choice-required" {
			t.Fatal(r.path, st, e)
		}
	}
	// Presence too (no player to stand anywhere).
	if _, err := x.api.presenceIdentity(context.Background(), store.Hash(c.Value), false); err == nil {
		t.Fatal("presence admitted a held sign-in")
	}
	// A reload (or a tab closed and opened again) asks again, with the same cookie.
	x.now.Add(3600)
	st, v, e, c2 := x.request("GET", "/api/world/choice", nil, c)
	if st != 200 || v.WorldChoice == nil || !v.WorldChoice.PartyCanOpen || c2 == nil || c2.Value != c.Value {
		t.Fatal("asked again", st, e)
	}
	if st, _, e, _ = x.request("POST", "/api/world/choose", map[string]any{"choice": "elsewhere"}, c); st != 400 || e != "invalid-choice" {
		t.Fatal("bad choice", st, e)
	}
	// The party's world: opened now, by her, and she lives there.
	st, s, e, _ := x.request("POST", "/api/world/choose", map[string]any{"choice": "party"}, c)
	pw := x.partyWorldOf("p1")
	if st != 200 || pw == "" || s.WorldID != pw || s.HabiticaID != "olive" || s.SaveOrigin != nil || count(t, x.db, "SELECT count(*) FROM worlds WHERE id=? AND opened_by='olive'", pw) != 1 {
		t.Fatal("chose the party", st, e, s.WorldID, pw)
	}
	// The same sign-in carries on: no second sign-in, no token.
	if count(t, x.db, "SELECT count(*) FROM pending_sessions") != 0 || count(t, x.db, "SELECT count(*) FROM sessions WHERE habitica_id='olive'") != 1 {
		t.Fatal("session not carried over")
	}
	x.tokenNowhere()
	x.expect("GET", "/api/state", nil, c, 200)
	x.expect("POST", "/api/origin", map[string]any{"choice": "fresh", "key": "origin"}, c, 200)
	// Only once: the question is gone.
	for _, r := range []struct{ method, path string }{{"POST", "/api/world/choose"}, {"GET", "/api/world/choice"}} {
		if st, _, e, _ := x.request(r.method, r.path, map[string]any{"choice": "own"}, c); st != 409 || e != "world-chosen" {
			t.Fatal(r.path, st, e)
		}
	}
	// A later sign-in isn't asked.
	st, v, _, _ = x.request("POST", "/api/session", map[string]any{"userId": "olive", "token": secret}, nil)
	if st != 200 || v.WorldChoice != nil || v.WorldID != pw {
		t.Fatal("asked again after choosing", st)
	}
	// No cookie at all: unauthorized, as ever.
	if st, _, e, _ := x.request("GET", "/api/world/choice", nil, nil); st != 401 || e != "unauthorized" {
		t.Fatal(st, e)
	}
}

func TestWorldChoiceOwnWorldThenMoveLater(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	x.ready("olive")
	pw := x.partyWorldOf("p1")
	// Rue comes in through the party (no code, no allowlist entry) and is
	// asked: the party's world, with one traveler, or her own.
	x.hero("rue", "Rue", "p1")
	q, c := x.signInAsked("rue", "p1", "")
	if q.PartyWorld == nil || q.PartyWorld.ID != pw || q.PartyWorld.Members != 1 || !q.PartyWorld.Party || q.PartyCanOpen {
		t.Fatalf("question %+v", q)
	}
	st, s, e, _ := x.request("POST", "/api/world/choose", map[string]any{"choice": "own"}, c)
	if st != 200 || s.WorldID == pw || count(t, x.db, "SELECT count(*) FROM worlds WHERE id=? AND owner_id='rue'", s.WorldID) != 1 {
		t.Fatal("own world", st, e, s.WorldID)
	}
	if count(t, x.db, "SELECT count(*) FROM allowlist WHERE habitica_id='rue' AND added_by='party'") != 1 {
		t.Fatal("admission not kept")
	}
	// The offer stays in the Menu, but she isn't prompted again right away.
	x.expect("POST", "/api/origin", map[string]any{"choice": "fresh", "key": "origin"}, c, 200)
	v := x.worldReq("GET", "/api/world", nil, c, 200)
	if v.PartyWorld == nil || v.PartyWorld.ID != pw || v.Prompt || !v.IsOwner || v.MoveOpensAt != 0 {
		t.Fatal("after choosing her own", v.raw)
	}
	// Reversible through the move, and the cooldown counts from that move.
	r := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
	moved := x.worldReq("POST", "/api/world/move", moveBody(r, "join", pw, "village"), c, 200)
	if moved.Result.World.World.ID != pw || x.worldOf("rue") != pw {
		t.Fatal("moved", moved.raw)
	}
	r.Snapshot = moved.Snapshot
	if st, _, e, _ := x.request("POST", "/api/world/move", moveBody(r, "back", s.WorldID, "village"), c); st != 409 || e != "move-cooldown" {
		t.Fatal("cooldown", st, e)
	}
}

func TestWorldChoiceNotAskedWhenAnInviteNamesAWorld(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	x.ready("olive")
	pw := x.partyWorldOf("p1")
	x.hero("ann", "Ann", "")
	_, a := x.ready("ann")
	// Ivo is in the party, but Ann's code names her world: it decides.
	x.hero("ivo", "Ivo", "p1")
	code, err := x.db.Invite(context.Background(), a.WorldID)
	if err != nil {
		t.Fatal(err)
	}
	st, v, e, _ := x.request("POST", "/api/session", map[string]any{"userId": "ivo", "token": secret, "invite": code}, nil)
	if st != 200 || v.WorldChoice != nil || v.WorldID != a.WorldID || x.worldOf("ivo") == pw {
		t.Fatal("the code decides", st, e, v.WorldID)
	}
	// A code that names no world still asks a party member.
	x.hero("ida", "Ida", "p1")
	open, err := x.db.Invite(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	q, _ := x.signInAsked("ida", "", open)
	if q.PartyWorld == nil || q.PartyWorld.ID != pw {
		t.Fatalf("question %+v", q)
	}
	// No party, no question: a world of their own, as before.
	x.hero("solo", "Solo", "")
	if err := x.db.Allow(context.Background(), "solo", true); err != nil {
		t.Fatal(err)
	}
	st, v, e, _ = x.request("POST", "/api/session", map[string]any{"userId": "solo", "token": secret}, nil)
	if st != 200 || v.WorldChoice != nil || count(t, x.db, "SELECT count(*) FROM worlds WHERE id=? AND owner_id='solo'", v.WorldID) != 1 {
		t.Fatal("solo", st, e)
	}
	// A party account let in through a party can't open one, and its party
	// has none: nothing to ask.
	x.hero("pat", "Pat", "p2")
	if err := x.db.Allow(context.Background(), "pat", true); err != nil {
		t.Fatal(err)
	}
	if _, err := x.db.DB.Exec("UPDATE allowlist SET added_by='party' WHERE habitica_id='pat'"); err != nil {
		t.Fatal(err)
	}
	st, v, _, _ = x.request("POST", "/api/session", map[string]any{"userId": "pat", "token": secret}, nil)
	if st != 200 || v.WorldChoice != nil || x.partyWorldOf("p2") != "" {
		t.Fatal("pat", st)
	}
}

func TestWorldChoiceAcrossDevicesLogoutAndRemoval(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	x.ready("olive")
	x.hero("rue", "Rue", "p1")
	_, phone := x.signInAsked("rue", "p1", "")
	_, desk := x.signInAsked("rue", "p1", "")
	// The desk chooses; the phone's held sign-in becomes a session in that world.
	x.expect("POST", "/api/world/choose", map[string]any{"choice": "party"}, desk, 200)
	if s := x.expect("GET", "/api/state", nil, phone, 200); s.WorldID != x.partyWorldOf("p1") {
		t.Fatal("phone's world", s.WorldID)
	}
	if st, _, e, _ := x.request("POST", "/api/world/choose", map[string]any{"choice": "own"}, phone); st != 409 || e != "world-chosen" {
		t.Fatal(st, e)
	}

	// Signing out of a held sign-in ends it.
	x.hero("sam", "Sam", "p1")
	_, c := x.signInAsked("sam", "p1", "")
	x.expect("DELETE", "/api/session", nil, c, 200)
	if st, _, e, _ := x.request("GET", "/api/world/choice", nil, c); st != 401 || e != "unauthorized" {
		t.Fatal("logged out", st, e)
	}
	// So does losing access.
	_, c = x.signInAsked("sam", "p1", "")
	if err := x.db.Allow(context.Background(), "sam", false); err != nil {
		t.Fatal(err)
	}
	if st, _, e, _ := x.request("POST", "/api/world/choose", map[string]any{"choice": "own"}, c); st != 401 || e != "unauthorized" || x.players("sam") != 0 {
		t.Fatal("removed", st, e)
	}
	// And an idle week.
	x.hero("tess", "Tess", "p1")
	_, c = x.signInAsked("tess", "p1", "")
	x.now.Add(int64(SessionIdleTTL.Seconds()) + 1)
	if st, _, e, _ := x.request("GET", "/api/state", nil, c); st != 401 || e != "unauthorized" {
		t.Fatal("expired", st, e)
	}
	if strings.Contains(x.logs.String(), secret) {
		t.Fatal("token logged")
	}
}

// Choosing the party's world when it has closed since the question: refused,
// and the question stands (their own world is still there to choose).
func TestWorldChoicePartyClosedMeanwhile(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	if err := x.db.Allow(context.Background(), "olive", true); err != nil {
		t.Fatal(err)
	}
	_, c := x.signInAsked("olive", "p1", "")
	if _, err := x.db.DB.Exec("INSERT INTO party_closures VALUES('p1',?)", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	if st, _, e, _ := x.request("POST", "/api/world/choose", map[string]any{"choice": "party"}, c); st != 409 || e != "party-closed" || x.players("olive") != 0 {
		t.Fatal(st, e)
	}
	st, v, _, _ := x.request("GET", "/api/world/choice", nil, c)
	if st != 200 || v.WorldChoice.PartyCanOpen || v.WorldChoice.PartyWorld != nil {
		t.Fatal("asked again", st)
	}
	x.expect("POST", "/api/world/choose", map[string]any{"choice": "own"}, c, 200)
}
