// Companions (docs/design/crafts.md 2.2–2.4): the choices and their lazy
// validity, and the presence fields a friend's screen draws (3.4).
package api

import (
	"context"
	"encoding/json"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"math"
	"net/http"
	"testing"
)

// companionsWire is Companions as the wire spells it (glimway.v1).
type companionsWire struct {
	FollowPet string   `json:"followPet"`
	YardPets  []string `json:"yardPets"`
	MountOut  string   `json:"mountOut"`
	MountHome string   `json:"mountHome"`
}

// companionOp is a companions/stable answer: its typed result, beside the
// state's snapshot fields (state_bridge_test.go projects them to the top).
type companionOp struct {
	store.Snapshot
	Result struct {
		Companions companionsWire `json:"companions"`
		Home       *homeView      `json:"home"`
		Materials  map[string]int `json:"materials"`
	} `json:"result"`
	Error struct{ Code string } `json:"error"`
}

func (x *rig) companionOp(method, path string, body any, c *http.Cookie, status int) companionOp {
	x.t.Helper()
	v, _ := httpResponse[companionOp](x, method, path, body, c, status)
	return v
}

// companionsInState: the state's companions as the wire spells them (the
// Snapshot projection keeps none).
func (x *rig) companionsInState(c *http.Cookie) companionsWire {
	x.t.Helper()
	w := x.rawHTTP("GET", "/api/state", nil, c)
	var doc struct {
		State struct {
			Companions *companionsWire `json:"companions"`
		} `json:"state"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		x.t.Fatal(err)
	}
	if doc.State.Companions == nil {
		x.t.Fatal("state carries no companions", w.Body.String())
	}
	return *doc.State.Companions
}

// companionSync is a profile sync whose raw carries the owned lists (the
// shared fixture maps none): what a lapse or a re-hatch looks like to the
// server's stored profile.
func (x *rig) companionSync(s response, p rules.Profile, doc rules.State, c *http.Cookie) {
	x.t.Helper()
	body := x.profileBody(s, p, doc)
	pets, mounts := map[string]any{}, map[string]any{}
	for _, key := range p.Pets {
		pets[key] = 1
	}
	for _, key := range p.Mounts {
		mounts[key] = true
	}
	items := map[string]any{"gear": map[string]any{"equipped": p.Equipped}, "pets": pets, "mounts": mounts}
	if p.SelectedPet != nil {
		items["currentPet"] = *p.SelectedPet
	}
	class := ""
	if p.Class != nil {
		class = *p.Class
	}
	half := math.Floor(math.Min(100, p.Level) / 2)
	raw := map[string]any{"_id": p.ID, "profile": map[string]any{"name": p.Name}, "flags": map[string]any{"classSelected": p.Class != nil}, "stats": map[string]any{"lvl": p.Level, "exp": p.Exp, "hp": p.HP, "mp": p.MP, "class": class, "str": p.Stats.Str - half, "int": p.Stats.Int - half, "con": p.Stats.Con - half, "per": p.Stats.Per - half}, "items": items}
	b, _ := json.Marshal(raw)
	body["raw"] = json.RawMessage(b)
	x.expect("POST", "/api/profile", body, c, 200)
}

// chooseBody is the client's `companions` request: no where (it moves
// nothing), the choice in slot order.
func chooseBody(s response, key, follow string, yard []string) map[string]any {
	return map[string]any{"op": map[string]any{"lease": s.Lease, "key": key}, "followPet": follow, "yardPets": yard}
}

// heroCompanions: an allowlisted hero who owns these pets and mounts.
func (x *rig) heroCompanions(id string, pets, mounts []string) {
	x.t.Helper()
	p := profile(id, 1, 0, 20)
	p.Pets, p.Mounts = pets, mounts
	x.set(p)
}

func TestCompanionsChoiceGatesAndLazyValidity(t *testing.T) {
	x := newRig(t)
	x.heroCompanions("alice", []string{"Cat-Siamese", "Fox-Golden"}, []string{"Wolf-Shade"})
	ac, a := x.ready("alice")

	// Before a deed the choice is gated away and nothing is written.
	if r := x.companionOp("POST", "/api/companions", chooseBody(a, "no-home", "Fox-Golden", nil), ac, 404); r.Error.Code != "homestead-not-found" {
		t.Fatal("choice without a deed", r.Error.Code)
	}
	x.claimGate(ac, &a, 0)

	// The choice holds at once (no where in the request, like the client's).
	choose := x.companionOp("POST", "/api/companions", chooseBody(a, "pick", "Fox-Golden", []string{"Cat-Siamese"}), ac, 200)
	if choose.Result.Companions.FollowPet != "Fox-Golden" || len(choose.Result.Companions.YardPets) != 1 || choose.Result.Companions.YardPets[0] != "Cat-Siamese" {
		t.Fatal("choice answer", choose.Result.Companions)
	}
	if c := x.companionsInState(ac); c.FollowPet != "Fox-Golden" || c.YardPets[0] != "Cat-Siamese" {
		t.Fatal("state keeps the choice", c)
	}
	// The homestead shows the yard to visitors too (2.4).
	if y := x.home(ac).YardPets; len(y) != 1 || y[0].Pet != "Cat-Siamese" || y[0].Slot != 1 || y[0].OwnerID != x.account("alice") {
		t.Fatal("the yard shows the pet", y)
	}

	// Keys the account doesn't own are refused; the yard takes three, once
	// each.
	if r := x.companionOp("POST", "/api/companions", chooseBody(a, "stranger", "Wolf-Cubic", nil), ac, 409); r.Error.Code != "companion-not-owned" {
		t.Fatal("unowned follower", r.Error.Code)
	}
	if r := x.companionOp("POST", "/api/companions", chooseBody(a, "four", "", []string{"Cat-Siamese", "Fox-Golden", "Cat-Siamese", "Fox-Golden"}), ac, 400); r.Error.Code != "invalid-request" {
		t.Fatal("yard repeats", r.Error.Code)
	}
	// The repeat rule fires on its own, inside the size limit.
	if r := x.companionOp("POST", "/api/companions", chooseBody(a, "repeat", "", []string{"Cat-Siamese", "Fox-Golden", "Cat-Siamese"}), ac, 400); r.Error.Code != "invalid-request" {
		t.Fatal("a repeated yard pet", r.Error.Code)
	}
	if c := x.companionsInState(ac); c.FollowPet != "Fox-Golden" {
		t.Fatal("a refused choice changed nothing", c)
	}

	// A lapsed key reads as its fallback, and its stored row waits: a pet
	// that comes back comes back to its place.
	lapsed := profile("alice", 1, 0, 20)
	lapsed.Pets, lapsed.Mounts = []string{"Cat-Siamese"}, nil
	x.companionSync(a, lapsed, a.State, ac)
	if c := x.companionsInState(ac); c.FollowPet != "" || len(c.YardPets) != 1 || c.YardPets[0] != "Cat-Siamese" {
		t.Fatal("lapsed keys read as their fallback", c)
	}
	back := profile("alice", 1, 0, 20)
	back.Pets, back.Mounts = []string{"Cat-Siamese", "Fox-Golden"}, nil
	x.companionSync(a, back, a.State, ac)
	if c := x.companionsInState(ac); c.FollowPet != "Fox-Golden" || len(c.YardPets) != 1 {
		t.Fatal("a pet that comes back comes back", c)
	}

	// A deed left gates the choices away; the stored choice waits for the
	// next deed, unchanged.
	x.homeOpRefreshing(ac, &a, "leave", nil, 200)
	if c := x.companionsInState(ac); c.FollowPet != "" || len(c.YardPets) != 0 {
		t.Fatal("no deed, no choices", c)
	}
	x.fund(x.account("alice"), 500, 0)
	x.claimGate(ac, &a, 1)
	if c := x.companionsInState(ac); c.FollowPet != "Fox-Golden" {
		t.Fatal("the next deed gets the same choice", c)
	}
}

// The companions the presence room sees (2.4, 3.4): the resolved follower —
// the chosen pet, or Habitica's current pet — and the mount that is out.
func TestPresenceAvatarCarriesResolvedCompanions(t *testing.T) {
	x := newRig(t)
	p := profile("alice", 1, 0, 20)
	p.Pets, p.Mounts = []string{"Fox-Golden"}, []string{"Wolf-Shade"}
	p.SelectedPet = strPtr("Fox-Golden")
	x.set(p)
	ac, a := x.ready("alice")
	avatar := func(cookie *http.Cookie) *presenceAvatarMsg {
		v, err := x.api.presenceIdentity(context.Background(), store.Hash(cookie.Value), true)
		if err != nil {
			t.Fatal(err)
		}
		return v.Avatar
	}
	// Before any choice: Habitica's current pet, and no mount out.
	if v := avatar(ac); v.SelectedPet == nil || v.SelectedPet.Value != "Fox-Golden" || v.SelectedMount != nil {
		t.Fatal("no choice yet", v.SelectedPet, v.SelectedMount)
	}
	x.claimGate(ac, &a, 0)
	x.companionOp("POST", "/api/companions", chooseBody(a, "pick", "Fox-Golden", nil), ac, 200)
	if v := avatar(ac); v.SelectedPet == nil || v.SelectedPet.Value != "Fox-Golden" {
		t.Fatal("follower after the choice", v.SelectedPet)
	}
	// A hero with no companions draws none (never a stand-in).
	x.set(profile("rowan", 1, 0, 20))
	rc, _ := x.ready("rowan")
	if v := avatar(rc); v.SelectedPet != nil || v.SelectedMount != nil {
		t.Fatal("a hero with no companions shows none", v.SelectedPet, v.SelectedMount)
	}
}

// avatarChanged reaches the room (mid-visit), and only the room.
func TestAvatarChangeReachesTheRoom(t *testing.T) {
	x := newRig(t)
	_, a := x.ready("alice")
	x.ready("bob")
	x.ready("carol")
	me := x.peerAt(x.account("alice"), a.WorldID, "village")
	friend := x.peerAt(x.account("bob"), a.WorldID, "village")
	elsewhere := x.peerAt(x.account("carol"), a.WorldID, "commons")
	avatar := &presenceAvatarMsg{SelectedPet: wrapperspb.String("Fox-Golden")}
	x.api.avatarChanged(x.account("alice"), avatar)
	if me.identity.Avatar != avatar || len(me.queue) != 0 {
		t.Fatal("the sender keeps its own avatar and hears nothing")
	}
	select {
	case b := <-friend.queue:
		m, err := decodePresence(b)
		if err != nil || m.GetAvatarChange() == nil || m.GetAvatarChange().GetAccountId() != x.account("alice") || m.GetAvatarChange().GetAvatar().GetSelectedPet().GetValue() != "Fox-Golden" {
			t.Fatal("avatar change to the room", m, err)
		}
	default:
		t.Fatal("the room heard nothing")
	}
	select {
	case b := <-elsewhere.queue:
		t.Fatal("another room heard it", b)
	default:
	}
}

// peerAt registers a presence peer with its queue, as a socket would leave
// it in a room.
func (x *rig) peerAt(id, world, room string) *presencePeer {
	h := x.api.presence
	h.mu.Lock()
	defer h.mu.Unlock()
	p := &presencePeer{identity: presenceIdentity{ID: id, World: world}, account: &presenceAccount{}, ctx: context.Background(), cancel: func() {}, queue: make(chan []byte, 8)}
	p.area = room
	h.peers[id] = p
	return p
}

// strPtr is a habitica string field.
func strPtr(v string) *string { return &v }

// A yard pet that lapses reads as an empty spot and comes back to its own
// slot when it is re-hatched (2.2).
func TestYardPetComesBackToItsSlot(t *testing.T) {
	x := newRig(t)
	x.heroCompanions("alice", []string{"Cat-Siamese", "Fox-Golden", "Owl-Spooky"}, nil)
	ac, a := x.ready("alice")
	x.claimGate(ac, &a, 0)
	x.companionOp("POST", "/api/companions", chooseBody(a, "yard", "", []string{"Cat-Siamese", "Fox-Golden", "Owl-Spooky"}), ac, 200)
	if y := x.home(ac).YardPets; len(y) != 3 || y[1].Pet != "Fox-Golden" || y[1].Slot != 2 {
		t.Fatal("three pets in their slots", y)
	}
	// The middle one lapses: its spot reads empty, and the row keeps the
	// slot (the state's list compacts).
	lapsed := profile("alice", 1, 0, 20)
	lapsed.Pets = []string{"Cat-Siamese", "Owl-Spooky"}
	x.companionSync(a, lapsed, a.State, ac)
	if c := x.companionsInState(ac); len(c.YardPets) != 2 || c.YardPets[0] != "Cat-Siamese" || c.YardPets[1] != "Owl-Spooky" {
		t.Fatal("a lapsed yard pet reads empty", c)
	}
	if y := x.home(ac).YardPets; len(y) != 2 || y[0].Slot != 1 || y[1].Slot != 3 {
		t.Fatal("the spots keep their slots", y)
	}
	// Re-hatched: it comes back to its place.
	back := profile("alice", 1, 0, 20)
	back.Pets = []string{"Cat-Siamese", "Fox-Golden", "Owl-Spooky"}
	x.companionSync(a, back, a.State, ac)
	if y := x.home(ac).YardPets; len(y) != 3 || y[1].Pet != "Fox-Golden" || y[1].Slot != 2 {
		t.Fatal("a re-hatched pet comes back to its slot", y)
	}
}

// The real operations change the room's avatar after each commit (2.4): a
// friend hears the choice, the Saddle up and the Go home.
func TestCompanionOpsChangeTheRoomsAvatar(t *testing.T) {
	x := newRig(t)
	alice := profile("alice", 1, 0, 20)
	alice.Pets, alice.Mounts = []string{"Fox-Golden"}, []string{"Wolf-Shade"}
	x.set(alice)
	ac, a := x.ready("alice")
	x.pinWorld(&a)
	h, x0, y0 := standingStable(x, ac, &a, 1)
	x.companionOp("POST", "/api/stable/stall", body(a, "in", map[string]any{"homeId": h.ID, "stall": 1, "mount": "Wolf-Shade"}), ac, 200)
	me := x.peerAt(x.account("alice"), a.WorldID, "village")
	friend := x.peerAt("friend", a.WorldID, "village")
	change := func() *presenceAvatarMsg {
		x.t.Helper()
		select {
		case b := <-friend.queue:
			m, err := decodePresence(b)
			if err != nil || m.GetAvatarChange() == nil {
				x.t.Fatal("no avatar change in the room", m, err)
			}
			return m.GetAvatarChange().GetAvatar()
		default:
			x.t.Fatal("the room heard nothing")
		}
		return nil
	}
	// A choice...
	x.companionOp("POST", "/api/companions", chooseBody(a, "pick", "Fox-Golden", nil), ac, 200)
	if v := change(); v.SelectedPet == nil || v.SelectedPet.Value != "Fox-Golden" {
		t.Fatal("the follower change", v)
	}
	// ...a Saddle up...
	at := body(a, "up", map[string]any{"homeId": h.ID, "stall": 1})
	at["where"] = atBay(h, x0, y0, 1)
	x.companionOp("POST", "/api/stable/out", at, ac, 200)
	if v := change(); v.SelectedMount == nil || v.SelectedMount.Value != "Wolf-Shade" {
		t.Fatal("the mount-out change", v)
	}
	// ...and Go home.
	x.companionOp("POST", "/api/stable/home", map[string]any{"op": map[string]any{"lease": a.Lease, "key": "home"}}, ac, 200)
	if v := change(); v.SelectedMount != nil {
		t.Fatal("the mount-home change", v)
	}
	if me.identity.Avatar == nil || me.identity.Avatar.SelectedPet == nil {
		t.Fatal("the sender keeps its own avatar")
	}
}
