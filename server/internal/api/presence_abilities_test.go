package api

import (
	"context"
	"encoding/json"
	"glimway/content"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"math"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	contract "glimway/server/internal/gen/glimway/v1"
	v2 "glimway/server/internal/gen/glimway/v2"
	"google.golang.org/protobuf/encoding/protojson"
)

// The hub's PresenceAbility relay and ward credit (docs/design/crafts.md
// 4.5), driven through the real socket and the real report.

type abilityEvent struct {
	Type      string  `json:"type"`
	Ability   string  `json:"ability"`
	AccountID string  `json:"accountId"`
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
}

func (w *wsClient) expectAbility() abilityEvent {
	w.t.Helper()
	e := w.expect("ability")
	var out abilityEvent
	if err := json.Unmarshal([]byte(e.Raw), &out); err != nil {
		w.t.Fatal(err)
	}
	return out
}

func castMessage(id string, x, y float64) map[string]any {
	return map[string]any{"type": "ability", "ability": id, "x": x, "y": y}
}

func position(x, y float64) map[string]any {
	return map[string]any{"type": "pos", "x": x, "y": y, "facing": map[string]any{"x": 0, "y": 1}, "moving": false}
}

// playResponse resumes the tab's lease (the same client id keeps it).
func (x *rig) playResponse(c *http.Cookie) *contract.PlayResponse {
	x.t.Helper()
	w := x.rawHTTP("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c)
	var p contract.PlayResponse
	if e := protojson.Unmarshal(w.Body.Bytes(), &p); e != nil {
		x.t.Fatal(e)
	}
	return &p
}

func mustAbility(t *testing.T, id string) *content.Ability {
	t.Helper()
	a, ok := content.AbilityFor(id)
	if !ok {
		t.Fatal("missing ability", id)
	}
	return a
}

func TestPresenceAbilityRelayAndCooldown(t *testing.T) {
	x := newRig(t)
	p := profile("alice", 20, 0, 20)
	class := "mage"
	p.Class = &class
	x.set(p)
	c, s := x.ready("alice")
	bc, bs := x.member("bob", s.WorldID)
	ts := startPresence(t, x, presenceTestConfig())
	alice := wsConnect(t, ts, c, s.Lease)
	alice.join("village")
	bob := wsConnect(t, ts, bc, bs.Lease)
	bob.join("village")
	alice.expect("join")

	// Signatures relay too (lane F sends every cast), account_id filled in.
	alice.send(castMessage("fingersnap", 100, 200))
	got := bob.expectAbility()
	if got.Ability != "fingersnap" || got.AccountID != x.account("alice") {
		t.Fatal("signature relay", got)
	}
	// The table's cooldown holds the next one back; nothing else is sent.
	alice.send(castMessage("fingersnap", 100, 200))
	bob.none()
	// The hub reads the server's clock (review finding 12), so a test moves
	// time instead of waiting out a cooldown.
	x.now.Add(2)
	alice.send(castMessage("fingersnap", 100, 200))
	if bob.expectAbility().Ability != "fingersnap" {
		t.Fatal("no relay past the cooldown")
	}
	// The level-20 move relays at level 20; a cast never closes a socket.
	alice.send(castMessage("kindle", 120, 200))
	if bob.expectAbility().Ability != "kindle" {
		t.Fatal("move relay")
	}
	// An unknown move, another class's move and one beyond the level mark
	// are dropped.
	alice.send(castMessage("fireball", 100, 200))
	alice.send(castMessage("ward-light", 100, 200))
	alice.send(castMessage("ward-light", 100, 200))
	bob.none()
	// A hero with no craft casts nothing.
	bob.send(castMessage("mend", 100, 200))
	bob.none()
	// A client may not name who cast.
	bob.send(map[string]any{"type": "ability", "ability": "mend", "x": 0, "y": 0, "accountId": "mallory"})
	bob.closeStatus(websocket.StatusPolicyViolation)
}

func TestPresenceCastChecks(t *testing.T) {
	// The hub's own checks against its injected clock (review findings 4, 5,
	// 10 and 11): a cast belongs where its sender stands, arrives with the
	// client's throttle allowed for, and a reconnect never resets cooldowns.
	now := time.Unix(1_000_000, 0)
	h := newPresenceHub(presenceTestConfig(), func() time.Time { return now })
	caster := &presencePeer{identity: presenceIdentity{ID: "a", Magic: presenceMagic{Class: "mage", LevelMark: 30}}, area: "village", pos: &presencePosition{X: 320, Y: 320}}
	cast := func(x, y float64) bool {
		return h.allowAbility(caster, h.now(), &v2.PresenceAbility{Ability: "kindle", X: x, Y: y})
	}
	if cooldownTolerance(time.Second) != 150*time.Millisecond || cooldownTolerance(8*time.Second) != 250*time.Millisecond || cooldownTolerance(time.Millisecond) != 150*time.Millisecond {
		t.Fatal("cooldown tolerance is 150 ms or a tenth, capped at 250 ms")
	}
	// Kindle lands up to two tiles ahead (plus a tile of slack), and its
	// cooldown is 5 s.
	base := now
	if !cast(320, 320) {
		t.Fatal("a cast at the sender's feet was refused")
	}
	now = base.Add(5 * time.Second)
	if !cast(320+2*16, 320) {
		t.Fatal("a cast two tiles ahead was refused")
	}
	now = base.Add(10 * time.Second)
	if cast(320+4*16, 320) {
		t.Fatal("a cast across the room was taken")
	}
	// The client's throttle lands inside the tolerance (150 ms–250 ms).
	now = base.Add(5*time.Second + 4800*time.Millisecond)
	if !cast(320, 320) {
		t.Fatal("a cast inside the jitter tolerance was refused")
	}
	now = now.Add(100 * time.Millisecond)
	if cast(320, 320) {
		t.Fatal("a cast before its cooldown was taken")
	}
	// Nothing is accepted before joining an area.
	noRoom := &presencePeer{identity: caster.identity, pos: caster.pos}
	if h.allowAbility(noRoom, h.now(), &v2.PresenceAbility{Ability: "kindle", X: 320, Y: 320}) {
		t.Fatal("a cast before joining was taken")
	}
	// A reconnect keeps the cooldown (review finding 4).
	res, err := h.reserve("session", "a")
	if err != nil {
		t.Fatal(err)
	}
	h.release(res)
	if cast(320, 320) {
		t.Fatal("a reconnect reset the cooldown")
	}
	// The memory goes only once every timestamp is older than the table's
	// longest cooldown.
	h.pruneAbilityReady(h.now())
	if h.abilityReady["a"] == nil {
		t.Fatal("fresh cooldown memory was pruned")
	}
	now = now.Add(maxAbilityCooldown() + time.Second)
	h.pruneAbilityReady(h.now())
	if h.abilityReady["a"] != nil {
		t.Fatal("stale cooldown memory was kept")
	}
}

func TestPresenceWardCreditHealsAFriend(t *testing.T) {
	x := newRig(t)
	healer := profile("alice", 20, 0, 20)
	class := "healer"
	healer.Class = &class
	x.set(healer)
	c, s := x.ready("alice")
	bc, bs := x.member("bob", s.WorldID)
	cc, cs := x.member("carol", s.WorldID)
	ts := startPresence(t, x, presenceTestConfig())
	alice := wsConnect(t, ts, c, s.Lease)
	alice.join("village")
	bob := wsConnect(t, ts, bc, bs.Lease)
	bob.join("village")
	alice.expect("join")
	carol := wsConnect(t, ts, cc, cs.Lease)
	carol.join("village")
	alice.expect("join")
	bob.expect("join")
	carol.send(position(500, 500))
	alice.expect("pos")
	bob.expect("pos")
	// Bob stands at (320, 320) and then says nothing more: an idle hero's
	// last position is what the hub keeps.
	bob.send(position(320, 320))
	alice.expect("pos")
	carol.expect("pos")

	ward := mustAbility(t, "ward-light")
	pulse := rules.WardPulseHeal(&healer, ward)
	oneWard := rules.WardHeal(&healer, ward)
	alicePlay, bobPlay, carolPlay := x.playResponse(c), x.playResponse(bc), x.playResponse(cc)

	// A ward at Bob's feet relays to the room, and its pulses credit him.
	alice.send(castMessage("ward-light", 320, 320))
	if bob.expectAbility().Ability != "ward-light" || carol.expectAbility().Ability != "ward-light" {
		t.Fatal("ward relay")
	}
	time.Sleep(4200 * time.Millisecond)
	healed := x.abilityReport(bc, bobPlay, 1, bobPlay.State.Version, 20+oneWard, 50, 0, nil)
	if math.Abs(healed.GetReport().AllyHeal-oneWard) > 1e-9 {
		t.Fatal("ward credit", healed.GetReport().AllyHeal, oneWard, pulse)
	}
	if math.Abs(healed.State.Vitals.Hp-(20+oneWard)) > 1e-9 {
		t.Fatal("credit refused the rise", healed.State.Vitals.Hp)
	}
	// It is spent: the next report has none.
	next := x.abilityReport(bc, bobPlay, 2, healed.State.Version, 40, 50, 0, nil)
	if next.GetReport().AllyHeal != 0 {
		t.Fatal("credit reused", next.GetReport().AllyHeal)
	}
	// Carol stood outside the circle: drawn, but mended nobody out there.
	outside := x.abilityReport(cc, carolPlay, 1, carolPlay.State.Version, 40, 50, 0, nil)
	if outside.GetReport().AllyHeal != 0 || outside.State.Vitals.Hp != 20 {
		t.Fatal("a ward reached outside its circle", outside.GetReport().AllyHeal, outside.State.Vitals.Hp)
	}
	// The caster's own heal comes with their report, never as credit.
	mine := x.abilityReport(c, alicePlay, 1, alicePlay.State.Version, 50, 50, 0, map[string]float64{"ward-light": 1})
	if mine.GetReport().AllyHeal != 0 {
		t.Fatal("the caster was credited", mine.GetReport().GetAllyHeal())
	}

	// The hub's checks refresh with the account's state (revalidateMs): a
	// classless sync leaves Alice with no craft, so the same cast drops.
	x.expect("POST", "/api/profile", x.profileBody(s, profile("alice", 20, 0, 20), s.State), c, 200)
	deadline := time.Now().Add(2 * time.Second)
	for {
		x.api.presence.mu.Lock()
		magic := x.api.presence.peers[x.account("alice")].identity.Magic
		x.api.presence.mu.Unlock()
		if magic.Class == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the hub kept stale state", magic)
		}
		time.Sleep(20 * time.Millisecond)
	}
	alice.send(castMessage("mend", 320, 320))
	bob.none()
}

func TestWardCreditSpendsOnlyWhatTheReportNeeded(t *testing.T) {
	// Review findings 2, 3 and 13: two healers inside one report window
	// leave no pulse uncredited, and a report spends only what its HP took.
	x := newRig(t)
	for _, id := range []string{"alice", "carol"} {
		p := profile(id, 20, 0, 20)
		class := "healer"
		p.Class = &class
		x.set(p)
	}
	c, s := x.ready("alice")
	bc, bs := x.member("bob", s.WorldID)
	cc, cs := x.member("carol", s.WorldID)
	ts := startPresence(t, x, presenceTestConfig())
	alice := wsConnect(t, ts, c, s.Lease)
	alice.join("village")
	bob := wsConnect(t, ts, bc, bs.Lease)
	bob.join("village")
	alice.expect("join")
	carol := wsConnect(t, ts, cc, cs.Lease)
	carol.join("village")
	alice.expect("join")
	bob.expect("join")
	for _, w := range []*wsClient{alice, bob, carol} {
		w.send(position(320, 320))
	}
	alice.expect("pos")
	alice.expect("pos")
	bob.expect("pos")
	bob.expect("pos")
	carol.expect("pos")
	carol.expect("pos")

	healer := profile("alice", 20, 0, 20)
	ward := mustAbility(t, "ward-light")
	twoWards := 2 * rules.WardHeal(&healer, ward)
	// Two healers, one circle: six pulses inside one report window.
	alice.send(castMessage("ward-light", 320, 320))
	carol.send(castMessage("ward-light", 320, 320))
	bob.expectAbility()
	bob.expectAbility()
	time.Sleep(4200 * time.Millisecond)
	bobPlay := x.playResponse(bc)

	// A report that kept its old HP spends nothing: the pulses wait for the
	// report that raises it.
	kept := x.abilityReport(bc, bobPlay, 1, bobPlay.State.Version, 20, 50, 0, nil)
	if kept.GetReport().AllyHeal != 0 || kept.State.Vitals.Hp != 20 {
		t.Fatal("a report that raised nothing spent credit", kept.GetReport().AllyHeal, kept.State.Vitals.Hp)
	}
	// A duplicate and a stale-basis report spend nothing either.
	dup := x.abilityReport(bc, bobPlay, 1, kept.State.Version, 30, 50, 0, nil)
	if dup.GetReport().AllyHeal != 0 {
		t.Fatal("a duplicate spent credit", dup.GetReport().AllyHeal)
	}
	staleAt := setVitals(t, x, "bob", 20, 50)
	stale := x.abilityReport(bc, bobPlay, 2, kept.State.Version, 30, 50, 0, nil)
	if !stale.GetReport().StaleBasis || stale.GetReport().AllyHeal != 0 {
		t.Fatal("a stale report spent credit", stale.GetReport().AllyHeal)
	}
	// The report that raises the HP takes both wards' pulses whole: no
	// pulse is lost to the window (the old one-ward cap cut this in half).
	healed := x.abilityReport(bc, bobPlay, 3, staleAt, 20+twoWards, 50, 0, nil)
	if math.Abs(healed.GetReport().AllyHeal-twoWards) > 1e-9 {
		t.Fatal("credit lost between two wards", healed.GetReport().AllyHeal, twoWards)
	}
	if math.Abs(healed.State.Vitals.Hp-(20+twoWards)) > 1e-9 {
		t.Fatal("the raise", healed.State.Vitals.Hp)
	}
}

func TestWardCreditExpiryAndZeroHP(t *testing.T) {
	x := newRig(t)
	healer := profile("alice", 20, 0, 20)
	class := "healer"
	healer.Class = &class
	x.set(healer)
	c, s := x.ready("alice")
	bc, bs := x.member("bob", s.WorldID)
	ts := startPresence(t, x, presenceTestConfig())
	alice := wsConnect(t, ts, c, s.Lease)
	alice.join("village")
	bob := wsConnect(t, ts, bc, bs.Lease)
	bob.join("village")
	alice.expect("join")
	alice.send(position(320, 320))
	bob.expect("pos")
	// Bob stands at (320, 320) and goes quiet.
	bob.send(position(320, 320))
	alice.expect("pos")

	// A friend at 0 HP stays at 0: the zero-HP lock holds for wards too.
	basis := setVitals(t, x, "bob", 0, 50)
	alice.send(castMessage("ward-light", 320, 320))
	bob.expectAbility()
	time.Sleep(4200 * time.Millisecond)
	bobPlay := x.playResponse(bc)
	down := x.abilityReport(bc, bobPlay, 1, basis, 10, 50, 0, nil)
	if down.State.Vitals.Hp != 0 || down.GetReport().AllyHeal != 0 {
		t.Fatal("a ward lifted the dead", down.State.Vitals.Hp, down.GetReport().AllyHeal)
	}

	// Pulses wait a minute for their report (4.5), on the server's clock.
	x.now.Add(8)
	basis = setVitals(t, x, "bob", 20, 50)
	alice.send(castMessage("ward-light", 320, 320))
	bob.expectAbility()
	time.Sleep(4200 * time.Millisecond)
	x.now.Add(61)
	lapsed := x.abilityReport(bc, bobPlay, 2, basis, 30, 50, 0, nil)
	if lapsed.GetReport().AllyHeal != 0 || lapsed.State.Vitals.Hp != 20 {
		t.Fatal("credit outlived its minute", lapsed.GetReport().AllyHeal, lapsed.State.Vitals.Hp)
	}
}

func TestWardPulseScheduleMatchesTheTable(t *testing.T) {
	ward := mustAbility(t, "ward-light")
	if len(wardPulseOffsets) != int(ward.GetNumbers().GetPulses()) {
		t.Fatal("pulse schedule", wardPulseOffsets, ward.GetNumbers().GetPulses())
	}
	for i, want := range []time.Duration{time.Second, 2500 * time.Millisecond, 4 * time.Second} {
		if wardPulseOffsets[i] != want {
			t.Fatal("pulse times are 1, 2.5 and 4 s", wardPulseOffsets)
		}
	}
}

// The hub's unlocks read the level mark, which syncs raise too — not the
// sign-in-only rebirth history (migration 031).
func TestPresenceIdentityReadsTheLevelMark(t *testing.T) {
	x := newRig(t)
	reborn := profile("alice", 1, 0, 50)
	class := "wizard"
	reborn.Class = &class
	x.set(reborn)
	c, _ := x.ready("alice")
	if _, err := x.db.DB.Exec("UPDATE sync_baselines SET level_mark=20,verified_high_level=1 WHERE account_id=?", x.account("alice")); err != nil {
		t.Fatal(err)
	}
	v, err := x.api.presenceIdentity(context.Background(), store.Hash(c.Value), false)
	if err != nil || v.Magic.LevelMark != 20 {
		t.Fatal("the hub read the wrong mark", v.Magic, err)
	}
}
