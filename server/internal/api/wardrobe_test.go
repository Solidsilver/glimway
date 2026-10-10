package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/types/known/structpb"
)

// The wardrobe (docs/design/purse-and-wardrobe.md 4): a choice per slot from
// what the account owns on Habitica, checked against the owned list the
// server's own reads fill (never a browser's report). A lapsed piece reads as
// Habitica's and its row waits for it to come back.

// ownGear fills player_gear the way the server's own Habitica reads do (4.3):
// the sorted keys the account owns, and when they were last checked.
func (x *rig) ownGear(account string, keys ...string) {
	x.t.Helper()
	if _, err := x.db.DB.Exec("INSERT INTO player_gear(account_id,owned_json,checked_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET owned_json=excluded.owned_json,checked_at=excluded.checked_at", account, store.JSON(keys), x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
}

// chooseWardrobe posts the wardrobe operation with a whole choice (6.2).
func (x *rig) chooseWardrobe(c *http.Cookie, s response, key string, chosen map[string]string, status int) (*contract.Envelope, string) {
	x.t.Helper()
	return x.call("/api/wardrobe", &contract.WardrobeRequest{Op: op(s.Lease, key), Chosen: chosen}, c, status)
}

type wardrobeReadView struct {
	Result struct {
		Owned    []string `json:"owned"`
		Wardrobe struct {
			Chosen map[string]string `json:"chosen"`
		} `json:"wardrobe"`
		CheckedAt *float64 `json:"checkedAt"`
	} `json:"result"`
}

// wardrobeRead answers GET /api/wardrobe and checks the read's shape is the
// strict one the picker decodes (owned, wardrobe and checkedAt all present).
func (x *rig) wardrobeRead(c *http.Cookie, status int) wardrobeReadView {
	x.t.Helper()
	w := x.rawHTTP("GET", "/api/wardrobe", nil, c)
	if w.Code != status {
		x.t.Fatalf("GET /api/wardrobe: %d != %d %s", w.Code, status, w.Body.String())
	}
	var shape struct {
		Result map[string]json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &shape); err != nil {
		x.t.Fatal(err)
	}
	for _, field := range []string{"owned", "wardrobe", "checkedAt"} {
		if _, ok := shape.Result[field]; !ok {
			x.t.Fatalf("GET /api/wardrobe omits %q: %s", field, w.Body.String())
		}
	}
	return decodeDomainHTTP[wardrobeReadView](x, w)
}

// TestWardrobeChoosesOwnedGearAndRefusesTheRest (4.2): each key must be
// owned, catalogued, of that slot's type and not a none-piece; "none" is
// always allowed; the whole choice is written at once.
func TestWardrobeChoosesOwnedGearAndRefusesTheRest(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	alice := x.account("alice")
	// The last key is owned but uncatalogued (a piece the catalog never
	// knew): only the catalogue check can refuse it.
	x.ownGear(alice, "weapon_warrior_1", "head_armoire_admiralsBicorne", "headAccessory_base_0", "head_armoire_futurePiece")

	// The sign-in read stores the owned list (4.3), so a fresh sign-in
	// reads as checked. Before the first check (an account that signed in
	// before 0.6, so no row) there's no list at all: the picker offers only
	// As on Habitica and Nothing, and the read says so.
	empty := newRig(t)
	ec, _ := empty.ready("alice")
	if v := empty.wardrobeRead(ec, 200); v.Result.CheckedAt == nil {
		t.Fatal("the sign-in stored no owned list", v.Result)
	}
	if _, err := empty.db.DB.Exec("DELETE FROM player_gear WHERE account_id=?", empty.account("alice")); err != nil {
		t.Fatal(err)
	}
	if v := empty.wardrobeRead(ec, 200); len(v.Result.Owned) != 0 || v.Result.CheckedAt != nil || len(v.Result.Wardrobe.Chosen) != 0 {
		t.Fatal("an unchecked account", v.Result)
	}

	// A slot that isn't one of the drawn eight is refused, and so is one
	// that is never drawn at all.
	if _, code := x.chooseWardrobe(c, s, "slot", map[string]string{"hat": "head_armoire_admiralsBicorne"}, 400); code != "invalid-slot" {
		t.Fatal("an unknown slot", code)
	}
	if _, code := x.chooseWardrobe(c, s, "special", map[string]string{"weaponSpecial": "weapon_warrior_1"}, 400); code != "invalid-slot" {
		t.Fatal("a never-drawn slot", code)
	}
	// Keys: owned and catalogued and of the slot's type, or refused.
	for name, chosen := range map[string]map[string]string{
		"not owned":      {"head": "head_armoire_astronomersHat"},
		"not catalogued": {"head": "head_armoire_futurePiece"},
		"the wrong slot": {"head": "weapon_warrior_1"},
		"a slot's piece": {"weapon": "headAccessory_base_0"},
		"a none piece":   {"headAccessory": "headAccessory_base_0"},
	} {
		if _, code := x.chooseWardrobe(c, s, "refuse-"+fmt.Sprint(keySeq()), chosen, 409); code != "gear-not-owned" {
			t.Fatal(name, code)
		}
	}

	// The whole choice at once: a key and Nothing, and the answer is the
	// resolved choice on the result and on the state.
	env, _ := x.chooseWardrobe(c, s, "pick", map[string]string{"head": "head_armoire_admiralsBicorne", "armor": "none"}, 200)
	got := env.GetWardrobe().GetWardrobe().GetChosen()
	if got["head"] != "head_armoire_admiralsBicorne" || got["armor"] != "none" || len(got) != 2 {
		t.Fatal("the choice", got)
	}
	if state := env.GetState().GetWardrobe().GetChosen(); state["head"] != "head_armoire_admiralsBicorne" || state["armor"] != "none" {
		t.Fatal("the state's choice", state)
	}
	read := x.wardrobeRead(c, 200)
	if read.Result.Wardrobe.Chosen["head"] != "head_armoire_admiralsBicorne" || read.Result.CheckedAt == nil {
		t.Fatal("the read", read.Result)
	}
	// The owned list is what the picker shows: sorted, catalogued keys.
	if len(read.Result.Owned) != 2 || read.Result.Owned[0] != "head_armoire_admiralsBicorne" || read.Result.Owned[1] != "weapon_warrior_1" {
		t.Fatal("the owned list", read.Result.Owned)
	}

	// A slot left out goes back to As on Habitica; {} is "Wear Habitica's
	// look", and the stored rows go with the choice.
	x.chooseWardrobe(c, s, "again", map[string]string{"head": "head_armoire_admiralsBicorne"}, 200)
	if n := count(t, x.db, "SELECT count(*) FROM player_wardrobe WHERE account_id=?", alice); n != 1 {
		t.Fatal("rows", n)
	}
	env, _ = x.chooseWardrobe(c, s, "clear", map[string]string{}, 200)
	if len(env.GetWardrobe().GetWardrobe().GetChosen()) != 0 || count(t, x.db, "SELECT count(*) FROM player_wardrobe WHERE account_id=?", alice) != 0 {
		t.Fatal("Wear Habitica's look")
	}

	// No Habitica, no wardrobe (section 5).
	if _, err := x.db.DB.Exec("UPDATE players SET profile_source='none' WHERE account_id=?", alice); err != nil {
		t.Fatal(err)
	}
	if _, code := x.chooseWardrobe(c, s, "guest", map[string]string{"head": "head_armoire_admiralsBicorne"}, 409); code != "needs-habitica" {
		t.Fatal("a guest dressed from Habitica", code)
	}
}

// TestAWardrobeKeyThatLapsesReadsAsHabiticaAndComesBack (4.2): a key the
// account no longer owns drops out of the resolved choice and reads as
// Habitica's piece, while its stored row waits for it to come back.
func TestAWardrobeKeyThatLapsesReadsAsHabiticaAndComesBack(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	alice := x.account("alice")
	x.ownGear(alice, "head_armoire_admiralsBicorne", "armor_warrior_1")
	x.chooseWardrobe(c, s, "pick", map[string]string{"head": "head_armoire_admiralsBicorne", "armor": "armor_warrior_1"}, 200)

	// The head piece lapses (a warrior's death penalty): the slot reads As
	// on Habitica again…
	x.ownGear(alice, "armor_warrior_1")
	read := x.wardrobeRead(c, 200)
	if _, ok := read.Result.Wardrobe.Chosen["head"]; ok || read.Result.Wardrobe.Chosen["armor"] != "armor_warrior_1" {
		t.Fatal("a lapsed key still reads as chosen", read.Result.Wardrobe.Chosen)
	}
	// …and its row is kept, so a piece that comes back comes back to its
	// place.
	if count(t, x.db, "SELECT count(*) FROM player_wardrobe WHERE account_id=? AND slot='head'", alice) != 1 {
		t.Fatal("the stored row was rewritten")
	}
	x.ownGear(alice, "head_armoire_admiralsBicorne", "armor_warrior_1")
	if read = x.wardrobeRead(c, 200); read.Result.Wardrobe.Chosen["head"] != "head_armoire_admiralsBicorne" {
		t.Fatal("the piece did not come back", read.Result.Wardrobe.Chosen)
	}
}

// A wardrobe edit leaves the row of a lapsed piece in another slot alone
// (4.2): the client only ever sees the resolved choice, so it cannot send
// that slot back — leaving it out means "I didn't touch it" — and the piece
// comes back to its place when it is owned again. Wear Habitica's look ({})
// still clears every row.
func TestAWardrobeEditKeepsTheLapsedRowsSlot(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	alice := x.account("alice")
	x.ownGear(alice, "head_armoire_admiralsBicorne", "armor_warrior_1", "armor_warrior_2")
	x.chooseWardrobe(c, s, "pick", map[string]string{"head": "head_armoire_admiralsBicorne", "armor": "armor_warrior_1"}, 200)

	// The head piece lapses; the player changes the armor.
	x.ownGear(alice, "armor_warrior_1", "armor_warrior_2")
	x.chooseWardrobe(c, s, "change", map[string]string{"armor": "armor_warrior_2"}, 200)
	if count(t, x.db, "SELECT count(*) FROM player_wardrobe WHERE account_id=? AND slot='head'", alice) != 1 {
		t.Fatal("the edit dropped the lapsed piece's row")
	}

	// The piece comes back to its own slot.
	x.ownGear(alice, "head_armoire_admiralsBicorne", "armor_warrior_1", "armor_warrior_2")
	read := x.wardrobeRead(c, 200)
	if read.Result.Wardrobe.Chosen["head"] != "head_armoire_admiralsBicorne" || read.Result.Wardrobe.Chosen["armor"] != "armor_warrior_2" {
		t.Fatal("the piece did not come back to its slot", read.Result.Wardrobe.Chosen)
	}

	// Wear Habitica's look clears every row, lapsed ones included.
	x.chooseWardrobe(c, s, "clear", map[string]string{}, 200)
	if count(t, x.db, "SELECT count(*) FROM player_wardrobe WHERE account_id=?", alice) != 0 {
		t.Fatal("Wear Habitica's look kept rows")
	}
}

// TestWardrobeLookGoesOutAsTheCostume (4.4): presence carries the resolved
// look as the costume map with use_costume set — a friend's screen draws it
// with today's code. Nothing chosen keeps the profile's own costume.
func TestWardrobeLookGoesOutAsTheCostume(t *testing.T) {
	null := func(v *structpb.Value) bool {
		_, ok := v.Kind.(*structpb.Value_NullValue)
		return ok
	}
	p := profile("alice", 1, 0, 20)
	p.Equipped = map[string]*string{"weapon": strPtr("weapon_warrior_1"), "shield": strPtr("shield_warrior_1")}

	// Nothing chosen: the profile's own costume and its setting, as before.
	v := visualAvatar(p, store.Companions{}, nil)
	if v.UseCostume || !null(v.Costume["weapon"]) {
		t.Fatal("nothing chosen", store.JSON(v))
	}
	// A chosen piece beats the costume, "none" is nothing worn there, and
	// the rest falls back to Habitica's look (the battle gear here).
	v = visualAvatar(p, store.Companions{}, map[string]string{"head": "head_armoire_admiralsBicorne", "shield": "none"})
	if !v.UseCostume || v.Costume["head"].GetStringValue() != "head_armoire_admiralsBicorne" || !null(v.Costume["shield"]) || v.Costume["weapon"].GetStringValue() != "weapon_warrior_1" {
		t.Fatal("the resolved look", store.JSON(v))
	}
	if v.Equipped["weapon"].GetStringValue() != "weapon_warrior_1" {
		t.Fatal("the battle gear moved", store.JSON(v))
	}

	// And it is what presence sends, from the stored choice.
	x := newRig(t)
	c, s := x.ready("alice")
	alice := x.account("alice")
	x.ownGear(alice, "head_armoire_admiralsBicorne")
	// The player and a friend in one room: the friend's screen updates
	// mid-visit when the choice changes.
	x.stand(alice, s.WorldID, "village", 100, 100)
	x.stand("friend", s.WorldID, "village", 130, 110)
	avatar := func() *presenceAvatarMsg {
		who, err := x.api.presenceIdentity(context.Background(), store.Hash(c.Value), true)
		if err != nil {
			t.Fatal(err)
		}
		return who.Avatar
	}
	if avatar().UseCostume {
		t.Fatal("no choice yet")
	}
	x.chooseWardrobe(c, s, "pick", map[string]string{"head": "head_armoire_admiralsBicorne", "shield": "none"}, 200)
	if v := avatar(); !v.UseCostume || v.Costume["head"].GetStringValue() != "head_armoire_admiralsBicorne" || !null(v.Costume["shield"]) {
		t.Fatal("presence's avatar", store.JSON(v))
	}
	// The room hears the avatar change with the resolved look on it.
	h := x.api.presence
	h.mu.Lock()
	friend := h.peers["friend"]
	h.mu.Unlock()
	select {
	case raw := <-friend.queue:
		m, err := decodePresence(raw)
		if err != nil || m.GetAvatarChange() == nil || m.GetAvatarChange().GetAccountId() != alice || !m.GetAvatarChange().GetAvatar().GetUseCostume() || m.GetAvatarChange().GetAvatar().GetCostume()["head"].GetStringValue() != "head_armoire_admiralsBicorne" {
			t.Fatal("the avatar change", m, err)
		}
	default:
		t.Fatal("the room heard nothing")
	}
	x.chooseWardrobe(c, s, "clear", map[string]string{}, 200)
	if avatar().UseCostume {
		t.Fatal("cleared back to Habitica's look")
	}
}

// TestALapsedPieceReachesFriendsScreens (4.3, 4.4): a player_gear write
// that changes the resolved look tells the room once it commits, as the
// wardrobe operation does. A lapsed slot falls back to Habitica's piece on
// the friend's screen, and a piece that comes back (here at sign-in) returns.
func TestALapsedPieceReachesFriendsScreens(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	alice, lease := x.account("alice"), s.Lease
	// Habitica's own look wears the warrior's helm.
	p := profile("alice", 2, 5, 30)
	p.Equipped = map[string]*string{"head": strPtr("head_warrior_1")}
	x.expect("POST", "/api/profile", x.profileBody(s, p, s.State), c, 200)
	worn := map[string]bool{"head_armoire_admiralsBicorne": true, "armor_warrior_1": true}
	x.setOwned(worn)
	if status, out := x.checkGear(lease, secret, c); status != 200 {
		t.Fatalf("check: %d %v", status, out.Error)
	}
	x.chooseWardrobe(c, s, "wear", map[string]string{"head": "head_armoire_admiralsBicorne", "armor": "armor_warrior_1"}, 200)

	x.stand(alice, s.WorldID, "village", 100, 100)
	x.stand("friend", s.WorldID, "village", 130, 110)
	h := x.api.presence
	h.mu.Lock()
	friend := h.peers["friend"]
	h.mu.Unlock()
	heard := func() []*presenceAvatarMsg {
		var out []*presenceAvatarMsg
		for {
			select {
			case raw := <-friend.queue:
				m, err := decodePresence(raw)
				if err != nil {
					t.Fatal(err)
				}
				if ch := m.GetAvatarChange(); ch != nil && ch.GetAccountId() == alice {
					out = append(out, ch.GetAvatar())
				}
			default:
				return out
			}
		}
	}
	heard()

	// A check that changes nothing says nothing.
	x.checkGear(lease, secret, c)
	if got := heard(); len(got) != 0 {
		t.Fatal("an unchanged check told the room", got)
	}

	// The bicorne lapses: the friend's screen draws Habitica's helm in its
	// slot, and the chosen armor stays.
	x.setOwned(map[string]bool{"head_armoire_admiralsBicorne": false, "armor_warrior_1": true})
	if status, out := x.checkGear(lease, secret, c); status != 200 {
		t.Fatalf("check: %d %v", status, out.Error)
	}
	got := heard()
	if len(got) != 1 {
		t.Fatal("the room heard", got)
	}
	look := got[0]
	if !look.GetUseCostume() || look.GetCostume()["head"].GetStringValue() != "head_warrior_1" || look.GetCostume()["armor"].GetStringValue() != "armor_warrior_1" {
		t.Fatal("the lapsed look", store.JSON(look))
	}

	// It comes back with a top-up's read (the settle tells the room)…
	lapsed := map[string]bool{"head_armoire_admiralsBicorne": false, "armor_warrior_1": true}
	x.setOwned(worn)
	x.setGold(100)
	if row := x.topUpOK(s, "back", 10, c); row.State != "moved" {
		t.Fatal("top-up", row.State)
	}
	got = heard()
	if len(got) != 1 || got[0].GetCostume()["head"].GetStringValue() != "head_armoire_admiralsBicorne" {
		t.Fatal("the piece came back", got)
	}
	// …and lapses again at the next sign-in, whose read tells the room too.
	x.setOwned(lapsed)
	x.login("alice", "")
	got = heard()
	if len(got) != 1 || got[0].GetCostume()["head"].GetStringValue() == "head_armoire_admiralsBicorne" || got[0].GetCostume()["armor"].GetStringValue() != "armor_warrior_1" {
		t.Fatal("the sign-in's lapse", got)
	}
}

// The look's fallbacks come from the shared vectors (content/vectors/
// wardrobe.json), replayed in the rules package; this checks the two halves
// agree where the avatar draws (rules.Slots still spells weaponSpecial, which
// is never drawn).
func TestWardrobeSlotsAreTheDrawnOnes(t *testing.T) {
	for _, slot := range rules.DrawnSlots {
		if slot == "weaponSpecial" {
			t.Fatal("weaponSpecial is drawn")
		}
	}
	if len(rules.DrawnSlots) != 8 {
		t.Fatal(rules.DrawnSlots)
	}
}
